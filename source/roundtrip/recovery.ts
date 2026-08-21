import { readFile, readdir } from 'fs/promises';
import { canonicalStringify, parseCanonicalJson, sha256 } from './canonical-json';
import { readLedgerEntry, roundtripStatePath } from './ledger';
import {
    acquireExclusiveFileLockWithin,
    atomicReplaceWithin,
    removeOwnedFileLockWithin,
    restoreExactBackupWithin,
} from './storage-primitives';
import type { RoundtripReimporter, TransactionJournal, TransactionReceipt } from './transaction';

function errno(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

function validateJournal(value: unknown): asserts value is TransactionJournal {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('恢复 journal 顶层无效。');
    const journal = value as Record<string, unknown>;
    if (journal.schemaVersion !== 1 || typeof journal.txnId !== 'string' ||
        !['prepared', 'committed', 'rolled-back'].includes(String(journal.state))) throw new Error('恢复 journal schema/state 无效。');
    for (const field of [
        'prefabPath', 'metaPath', 'prefabBackupPath', 'metaBackupPath', 'prefabPreimageHash',
        'metaPreimageHash', 'assetUrl', 'lockPath', 'lockOwner',
    ]) {
        if (typeof journal[field] !== 'string' || !(journal[field] as string)) throw new Error(`恢复 journal.${field} 无效。`);
    }
    if (!Number.isInteger(journal.expectedLedgerGeneration) || (journal.expectedLedgerGeneration as number) < 1) {
        throw new Error('恢复 journal.expectedLedgerGeneration 无效。');
    }
    if (journal.prefabPostimageHash !== undefined &&
        (typeof journal.prefabPostimageHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(journal.prefabPostimageHash))) {
        throw new Error('恢复 journal.prefabPostimageHash 无效。');
    }
    if (!Array.isArray(journal.applied) || journal.identity === null || typeof journal.identity !== 'object') {
        throw new Error('恢复 journal identity/applied 无效。');
    }
}

function ownerPid(lockOwner: string, txnId: string): number {
    const owner = parseCanonicalJson(lockOwner) as unknown;
    if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) throw new Error('恢复 lock owner 无效。');
    const value = owner as Record<string, unknown>;
    if (value.txnId !== txnId || !Number.isInteger(value.pid) || (value.pid as number) <= 0) throw new Error('恢复 lock owner 与 journal 不一致。');
    return value.pid as number;
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errno(error) !== 'ESRCH';
    }
}

export interface RecoveryResult {
    txnId: string;
    status: 'recovered' | 'finalized-commit' | 'active-owner';
}

async function finalizeCommittedTransaction(
    projectRoot: string,
    journalPath: string,
    journal: TransactionJournal,
): Promise<void> {
    if (!journal.prefabPostimageHash) throw new Error(`事务 ${journal.txnId} 已进入 ledger，但 journal 缺少 postimage。`);
    const ledger = await readLedgerEntry(projectRoot, journal.identity);
    if (!ledger || ledger.entry.lastTxnId !== journal.txnId ||
        ledger.entry.generation !== journal.expectedLedgerGeneration + 1 ||
        ledger.entry.cocosPostimageHash !== journal.prefabPostimageHash) {
        throw new Error(`事务 ${journal.txnId} ledger 提交证据不一致。`);
    }
    const [prefabBytes, metaBytes] = await Promise.all([readFile(journal.prefabPath), readFile(journal.metaPath)]);
    if (sha256(prefabBytes) !== journal.prefabPostimageHash || sha256(metaBytes) !== journal.metaPreimageHash) {
        throw new Error(`事务 ${journal.txnId} 已提交内容与 ledger/journal 不一致。`);
    }
    const receipt: TransactionReceipt = {
        schemaVersion: 1,
        txnId: journal.txnId,
        identity: journal.identity,
        status: 'committed',
        prefabPreimageHash: journal.prefabPreimageHash,
        prefabPostimageHash: journal.prefabPostimageHash,
        metaHash: journal.metaPreimageHash,
        applied: journal.applied,
        completedAt: new Date().toISOString(),
    };
    await atomicReplaceWithin(
        projectRoot,
        roundtripStatePath(projectRoot, 'receipts', `${journal.txnId}.json`),
        Buffer.from(canonicalStringify(receipt), 'utf8'),
    );
    journal.state = 'committed';
    await atomicReplaceWithin(projectRoot, journalPath, Buffer.from(canonicalStringify(journal), 'utf8'));
}

export async function recoverInterruptedTransactions(
    projectRoot: string,
    reimporter: RoundtripReimporter,
): Promise<RecoveryResult[]> {
    const journalsRoot = roundtripStatePath(projectRoot, 'journals');
    let names: string[];
    try {
        names = (await readdir(journalsRoot)).filter((name) => /^[a-zA-Z0-9_-]{8,80}\.json$/.test(name)).sort();
    } catch (error) {
        if (errno(error) === 'ENOENT') return [];
        throw error;
    }
    const results: RecoveryResult[] = [];
    for (const name of names) {
        const journalPath = roundtripStatePath(projectRoot, 'journals', name);
        const text = (await readFile(journalPath)).toString('utf8');
        const journal = parseCanonicalJson(text) as unknown;
        validateJournal(journal);
        if (journal.state !== 'prepared') continue;
        const pid = ownerPid(journal.lockOwner, journal.txnId);
        let lockExists = true;
        try {
            await readFile(journal.lockPath);
        } catch (error) {
            if (errno(error) === 'ENOENT') lockExists = false;
            else throw error;
        }
        if (lockExists && processAlive(pid)) {
            results.push({ txnId: journal.txnId, status: 'active-owner' });
            continue;
        }
        if (lockExists) {
            await removeOwnedFileLockWithin(projectRoot, journal.lockPath, Buffer.from(journal.lockOwner, 'utf8'));
        }
        const recoveryOwner = Buffer.from(canonicalStringify({ txnId: journal.txnId, pid: process.pid, recovery: true }), 'utf8');
        const lock = await acquireExclusiveFileLockWithin(projectRoot, journal.lockPath, recoveryOwner);
        try {
            const ledger = await readLedgerEntry(projectRoot, journal.identity);
            if (ledger?.entry.lastTxnId === journal.txnId) {
                await finalizeCommittedTransaction(projectRoot, journalPath, journal);
                results.push({ txnId: journal.txnId, status: 'finalized-commit' });
                continue;
            }
            if (!ledger || ledger.entry.generation !== journal.expectedLedgerGeneration) {
                throw new Error(`事务 ${journal.txnId} 无法安全回滚：ledger generation 已变化。`);
            }
            await restoreExactBackupWithin(projectRoot, journal.prefabBackupPath, journal.prefabPath);
            await restoreExactBackupWithin(projectRoot, journal.metaBackupPath, journal.metaPath);
            await reimporter.reimportAsset(journal.assetUrl);
            const [prefabBytes, metaBytes] = await Promise.all([readFile(journal.prefabPath), readFile(journal.metaPath)]);
            if (sha256(prefabBytes) !== journal.prefabPreimageHash || sha256(metaBytes) !== journal.metaPreimageHash) {
                throw new Error(`事务 ${journal.txnId} 启动恢复后字节校验失败。`);
            }
            journal.state = 'rolled-back';
            await atomicReplaceWithin(projectRoot, journalPath, Buffer.from(canonicalStringify(journal), 'utf8'));
            const receipt: TransactionReceipt = {
                schemaVersion: 1,
                txnId: journal.txnId,
                identity: journal.identity,
                status: 'rolled-back',
                prefabPreimageHash: journal.prefabPreimageHash,
                prefabPostimageHash: journal.prefabPreimageHash,
                metaHash: journal.metaPreimageHash,
                applied: journal.applied,
                completedAt: new Date().toISOString(),
                error: 'startup crash recovery',
            };
            await atomicReplaceWithin(
                projectRoot,
                roundtripStatePath(projectRoot, 'receipts', `${journal.txnId}.json`),
                Buffer.from(canonicalStringify(receipt), 'utf8'),
            );
            results.push({ txnId: journal.txnId, status: 'recovered' });
        } finally {
            await lock.release();
        }
    }
    return results;
}
