import { readFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { canonicalStringify, sha256 } from './canonical-json';
import { projectCocosPrefab, type CocosAssetDb, type ResolvedCocosPrefab } from './cocos-reader';
import type { Diff3Plan, PatchOperation, RoundtripNodeState } from './diff3';
import { advanceLedger, ledgerIdentityKey, roundtripStatePath, type LedgerIdentity } from './ledger';
import { advancedBaseline, writePatchedPrefab } from './raw-writer';
import type { CanonicalBaseline, Sha256, SyncId } from './protocol';
import {
    acquireExclusiveFileLockWithin,
    atomicReplaceWithin,
    createExactBackupWithin,
    restoreExactBackupWithin,
    writeNewFileWithin,
} from './storage-primitives';
import { normalizeCocosUuid } from './uuid';

export interface RoundtripReimporter {
    reimportAsset(assetUrl: string): Promise<void>;
}

export const editorReimporter: RoundtripReimporter = {
    async reimportAsset(assetUrl: string): Promise<void> {
        await Editor.Message.request('asset-db', 'reimport-asset', assetUrl);
    },
};

export interface TransactionReceipt {
    schemaVersion: 1;
    txnId: string;
    identity: LedgerIdentity;
    status: 'committed' | 'rolled-back';
    prefabPreimageHash: Sha256;
    prefabPostimageHash: Sha256;
    metaHash: Sha256;
    applied: PatchOperation[];
    completedAt: string;
    error?: string;
}

export interface TransactionJournal {
    schemaVersion: 1;
    txnId: string;
    state: 'prepared' | 'committed' | 'rolled-back';
    prefabPath: string;
    metaPath: string;
    prefabBackupPath: string;
    metaBackupPath: string;
    prefabPreimageHash: Sha256;
    prefabPostimageHash?: Sha256;
    metaPreimageHash: Sha256;
    expectedLedgerGeneration: number;
    assetUrl: string;
    identity: LedgerIdentity;
    applied: PatchOperation[];
    lockPath: string;
    lockOwner: string;
}

function operationTargets(plan: Diff3Plan): string[] {
    return plan.apply.map((operation) => `${operation.syncId}\0${operation.kind}`);
}

function assertPlanApplicable(plan: Diff3Plan): void {
    if (plan.apply.length === 0) throw new Error('PatchPlan 没有可应用操作。');
    if (plan.conflicts.length > 0 || plan.unsupported.length > 0) throw new Error('PatchPlan 含 conflict/unsupported，禁止部分应用。');
    if (new Set(operationTargets(plan)).size !== plan.apply.length) throw new Error('PatchPlan 含重复操作。');
}

async function validateSpriteFrameTargets(assetDb: CocosAssetDb, operations: readonly PatchOperation[]): Promise<void> {
    for (const operation of operations) {
        if (operation.kind !== 'set-sprite-frame') continue;
        const uuid = normalizeCocosUuid(operation.toUuid);
        const info = await assetDb.queryAssetInfo(uuid);
        if (!info || normalizeCocosUuid(info.uuid) !== uuid || !info.imported || info.invalid ||
            (info.type !== 'cc.SpriteFrame' && info.importer !== 'sprite-frame')) {
            throw new Error(`目标 UUID 不是可用 cc.SpriteFrame：${uuid}`);
        }
    }
}

function stateById(states: readonly RoundtripNodeState[]): Map<SyncId, RoundtripNodeState> {
    return new Map(states.map((state) => [state.syncId, state]));
}

function assertPostimage(plan: Diff3Plan, states: readonly RoundtripNodeState[]): void {
    const byId = stateById(states);
    for (const operation of plan.apply) {
        const state = byId.get(operation.syncId);
        if (!state) throw new Error(`Post-audit 缺少 ${operation.syncId}`);
        if (operation.kind === 'set-position-xy') {
            if (state.position?.x !== operation.to.x || state.position?.y !== operation.to.y) throw new Error('set-position-xy post-audit 失败。');
        } else if (operation.kind === 'set-content-size') {
            if (state.contentSize?.width !== operation.to.width || state.contentSize?.height !== operation.to.height) throw new Error('set-content-size post-audit 失败。');
        } else if (normalizeCocosUuid(state.spriteFrameUuid ?? '') !== normalizeCocosUuid(operation.toUuid)) {
            throw new Error('set-sprite-frame post-audit 失败。');
        }
    }
}

function journalBytes(value: TransactionJournal): Buffer {
    return Buffer.from(canonicalStringify(value), 'utf8');
}

function receiptBytes(value: TransactionReceipt): Buffer {
    return Buffer.from(canonicalStringify(value), 'utf8');
}

export async function applyRoundtripTransaction(input: {
    projectRoot: string;
    creatorVersion: string;
    assetDb: CocosAssetDb;
    reimporter: RoundtripReimporter;
    identity: LedgerIdentity;
    managedRootNodeId: string;
    figmaVersion: string;
    expectedLedgerGeneration: number;
    txnId?: string;
    target: ResolvedCocosPrefab;
    baseline: CanonicalBaseline;
    plan: Diff3Plan;
    assertTargetSafe?: () => Promise<void>;
}): Promise<TransactionReceipt> {
    if (input.creatorVersion !== '3.8.7') throw new Error('Round-trip Writer P0 仅允许 Cocos Creator 3.8.7。');
    assertPlanApplicable(input.plan);
    const txnId = input.txnId ?? randomBytes(16).toString('hex');
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(txnId)) throw new Error('txnId 无效。');
    const identityKey = ledgerIdentityKey(input.identity);
    const lockPath = roundtripStatePath(input.projectRoot, 'locks', `${identityKey}.lock`);
    const lockOwner = canonicalStringify({ txnId, pid: process.pid });
    const lock = await acquireExclusiveFileLockWithin(
        input.projectRoot,
        lockPath,
        Buffer.from(lockOwner, 'utf8'),
    );
    const backupDirectory = roundtripStatePath(input.projectRoot, 'backups', txnId);
    const prefabBackupPath = join(backupDirectory, 'target.prefab');
    const metaBackupPath = join(backupDirectory, 'target.prefab.meta');
    const journalPath = roundtripStatePath(input.projectRoot, 'journals', `${txnId}.json`);
    const receiptPath = roundtripStatePath(input.projectRoot, 'receipts', `${txnId}.json`);
    let journal: TransactionJournal | undefined;
    let committed = false;
    try {
        await input.assertTargetSafe?.();
        await validateSpriteFrameTargets(input.assetDb, input.plan.apply);
        const [prefabBytes, metaBytes] = await Promise.all([readFile(input.target.prefabPath), readFile(input.target.metaPath)]);
        if (sha256(prefabBytes) !== input.target.sourceHash || sha256(metaBytes) !== input.target.metaSourceHash) {
            throw new Error('Prefab/meta preimage 已变化，请重新预览。');
        }
        const current = projectCocosPrefab(prefabBytes, metaBytes, input.baseline.nodes, input.identity.prefabUuid);
        if (current.preserveProjectionHash !== input.target.preserveProjectionHash) throw new Error('Prefab preserve projection 已变化。');
        await createExactBackupWithin(input.projectRoot, input.target.prefabPath, prefabBackupPath);
        await createExactBackupWithin(input.projectRoot, input.target.metaPath, metaBackupPath);
        journal = {
            schemaVersion: 1,
            txnId,
            state: 'prepared',
            prefabPath: input.target.prefabPath,
            metaPath: input.target.metaPath,
            prefabBackupPath,
            metaBackupPath,
            prefabPreimageHash: current.sourceHash,
            metaPreimageHash: current.metaSourceHash,
            expectedLedgerGeneration: input.expectedLedgerGeneration,
            assetUrl: input.target.assetUrl,
            identity: input.identity,
            applied: input.plan.apply,
            lockPath,
            lockOwner,
        };
        await atomicReplaceWithin(input.projectRoot, journalPath, journalBytes(journal));

        const patchedBytes = writePatchedPrefab({
            serialized: current.serialized,
            baseline: input.baseline.nodes,
            operations: input.plan.apply,
        });
        await atomicReplaceWithin(input.projectRoot, input.target.prefabPath, patchedBytes);
        await input.reimporter.reimportAsset(input.target.assetUrl);
        const postBytes = await readFile(input.target.prefabPath);
        const post = projectCocosPrefab(postBytes, metaBytes, input.baseline.nodes, input.identity.prefabUuid);
        if (post.preserveProjectionHash !== current.preserveProjectionHash) throw new Error('Semantic preserve post-audit 失败。');
        assertPostimage(input.plan, post.nodes);

        // Persist the audited postimage before advancing the ledger. Recovery can
        // then distinguish a fully committed ledger from a pre-commit crash.
        journal.prefabPostimageHash = post.sourceHash;
        await atomicReplaceWithin(input.projectRoot, journalPath, journalBytes(journal));

        const advancedNodes = advancedBaseline(
            input.baseline.nodes,
            [...input.plan.applyLeaves, ...input.plan.converged],
        );
        const advanced: CanonicalBaseline = { ...input.baseline, nodes: advancedNodes };
        await advanceLedger({
            projectRoot: input.projectRoot,
            identity: input.identity,
            expectedGeneration: input.expectedLedgerGeneration,
            managedRootNodeId: input.managedRootNodeId,
            baseline: advanced,
            figmaVersion: input.figmaVersion,
            cocosPostimageHash: post.sourceHash,
            txnId,
        });
        committed = true;
        const receipt: TransactionReceipt = {
            schemaVersion: 1,
            txnId,
            identity: input.identity,
            status: 'committed',
            prefabPreimageHash: current.sourceHash,
            prefabPostimageHash: post.sourceHash,
            metaHash: current.metaSourceHash,
            applied: input.plan.apply,
            completedAt: new Date().toISOString(),
        };
        await writeNewFileWithin(input.projectRoot, receiptPath, receiptBytes(receipt));
        journal.state = 'committed';
        await atomicReplaceWithin(input.projectRoot, journalPath, journalBytes(journal));
        return receipt;
    } catch (error) {
        if (!committed && journal) {
            await restoreExactBackupWithin(input.projectRoot, prefabBackupPath, input.target.prefabPath);
            await restoreExactBackupWithin(input.projectRoot, metaBackupPath, input.target.metaPath);
            await input.reimporter.reimportAsset(input.target.assetUrl);
            const restored = await readFile(input.target.prefabPath);
            if (sha256(restored) !== journal.prefabPreimageHash) throw new Error('事务失败且 rollback 字节校验失败。');
            journal.state = 'rolled-back';
            await atomicReplaceWithin(input.projectRoot, journalPath, journalBytes(journal));
            const rollbackReceipt: TransactionReceipt = {
                schemaVersion: 1,
                txnId,
                identity: input.identity,
                status: 'rolled-back',
                prefabPreimageHash: journal.prefabPreimageHash,
                prefabPostimageHash: journal.prefabPreimageHash,
                metaHash: journal.metaPreimageHash,
                applied: input.plan.apply,
                completedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : 'unknown transaction error',
            };
            await writeNewFileWithin(input.projectRoot, receiptPath, receiptBytes(rollbackReceipt));
        }
        throw error;
    } finally {
        await lock.release();
    }
}
