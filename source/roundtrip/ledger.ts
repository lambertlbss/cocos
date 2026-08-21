import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { canonicalStringify, parseCanonicalJson, sha256 } from './canonical-json';
import { canonicalBaselineJson, validateBaseline, type CanonicalBaseline, type Sha256 } from './protocol';
import { atomicReplaceWithin, writeNewFileWithin } from './storage-primitives';

export const ROUNDTRIP_STATE_DIRECTORY = '.cocos-figma-sync';

export interface LedgerIdentity {
    fileKey: string;
    surfaceId: string;
    prefabUuid: string;
}

export interface LedgerEntry extends LedgerIdentity {
    schemaVersion: 1;
    managedRootNodeId: string;
    baselineHash: Sha256;
    baselineFile: string;
    figmaVersion: string;
    cocosPostimageHash: Sha256;
    protocolVersion: 1;
    generation: number;
    lastTxnId: string;
}

interface LedgerFile {
    schemaVersion: 1;
    entries: Record<string, LedgerEntry>;
}

function errno(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

function stateRoot(projectRoot: string): string {
    return resolve(projectRoot, ROUNDTRIP_STATE_DIRECTORY);
}

function ledgerPath(projectRoot: string): string {
    return join(stateRoot(projectRoot), 'ledger.json');
}

export function ledgerIdentityKey(identity: LedgerIdentity): string {
    return sha256(canonicalStringify({
        fileKey: identity.fileKey,
        surfaceId: identity.surfaceId,
        prefabUuid: identity.prefabUuid,
    })).slice('sha256:'.length);
}

function validateSha(value: unknown, label: string): asserts value is Sha256 {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} 无效。`);
}

function validateEntry(key: string, value: unknown): asserts value is LedgerEntry {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`ledger entry ${key} 无效。`);
    const entry = value as Record<string, unknown>;
    const keys = Object.keys(entry).sort();
    const expected = [
        'baselineFile', 'baselineHash', 'cocosPostimageHash', 'figmaVersion', 'fileKey', 'generation',
        'lastTxnId', 'managedRootNodeId', 'prefabUuid', 'protocolVersion', 'schemaVersion', 'surfaceId',
    ].sort();
    if (keys.join('\0') !== expected.join('\0')) throw new Error(`ledger entry ${key} 字段不完整。`);
    for (const field of ['fileKey', 'surfaceId', 'prefabUuid', 'managedRootNodeId', 'baselineFile', 'figmaVersion', 'lastTxnId']) {
        if (typeof entry[field] !== 'string' || !(entry[field] as string)) throw new Error(`ledger entry ${key}.${field} 无效。`);
    }
    if (entry.schemaVersion !== 1 || entry.protocolVersion !== 1 ||
        !Number.isInteger(entry.generation) || (entry.generation as number) < 1) throw new Error(`ledger entry ${key} 版本或 generation 无效。`);
    validateSha(entry.baselineHash, `ledger entry ${key}.baselineHash`);
    validateSha(entry.cocosPostimageHash, `ledger entry ${key}.cocosPostimageHash`);
    if (entry.baselineFile !== `baselines/${(entry.baselineHash as string).slice('sha256:'.length)}.json`) {
        throw new Error(`ledger entry ${key} baselineFile 与 hash 不一致。`);
    }
    if (ledgerIdentityKey(entry as unknown as LedgerIdentity) !== key) throw new Error(`ledger entry ${key} identity key 不一致。`);
}

function validateLedger(value: unknown): asserts value is LedgerFile {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('ledger.json 顶层无效。');
    const ledger = value as Record<string, unknown>;
    if (Object.keys(ledger).sort().join('\0') !== ['entries', 'schemaVersion'].sort().join('\0') ||
        ledger.schemaVersion !== 1 || ledger.entries === null || typeof ledger.entries !== 'object' || Array.isArray(ledger.entries)) {
        throw new Error('ledger.json schema 无效。');
    }
    for (const [key, entry] of Object.entries(ledger.entries as Record<string, unknown>)) validateEntry(key, entry);
}

async function loadLedger(projectRoot: string): Promise<LedgerFile> {
    let bytes: Buffer;
    try {
        bytes = await readFile(ledgerPath(projectRoot));
    } catch (error) {
        if (errno(error) === 'ENOENT') return { schemaVersion: 1, entries: {} };
        throw error;
    }
    const text = bytes.toString('utf8');
    const value = parseCanonicalJson(text) as unknown;
    validateLedger(value);
    return value;
}

async function storeLedger(projectRoot: string, ledger: LedgerFile): Promise<void> {
    validateLedger(ledger);
    await atomicReplaceWithin(projectRoot, ledgerPath(projectRoot), Buffer.from(canonicalStringify(ledger), 'utf8'));
}

async function ensureBaseline(projectRoot: string, baseline: CanonicalBaseline): Promise<{ hash: Sha256; file: string }> {
    const canonical = canonicalBaselineJson(baseline);
    const hash = sha256(canonical);
    const file = `baselines/${hash.slice('sha256:'.length)}.json`;
    const path = join(stateRoot(projectRoot), ...file.split('/'));
    try {
        await writeNewFileWithin(projectRoot, path, Buffer.from(canonical, 'utf8'));
    } catch (error) {
        if (errno(error) !== 'EEXIST') throw error;
        if ((await readFile(path)).toString('utf8') !== canonical) throw new Error('已存在的 baseline 内容与其 hash 不一致。');
    }
    return { hash, file };
}

export async function readLedgerEntry(
    projectRoot: string,
    identity: LedgerIdentity,
): Promise<{ entry: LedgerEntry; baseline: CanonicalBaseline } | null> {
    const ledger = await loadLedger(projectRoot);
    const entry = ledger.entries[ledgerIdentityKey(identity)];
    if (!entry) return null;
    const text = (await readFile(join(stateRoot(projectRoot), ...entry.baselineFile.split('/')))).toString('utf8');
    if (sha256(text) !== entry.baselineHash) throw new Error('ledger baseline hash 校验失败。');
    const baseline = parseCanonicalJson(text) as unknown;
    validateBaseline(baseline);
    if (canonicalBaselineJson(baseline) !== text) throw new Error('ledger baseline domain normalization 失败。');
    return { entry, baseline };
}

export async function createGenesisLedger(input: {
    projectRoot: string;
    identity: LedgerIdentity;
    managedRootNodeId: string;
    baseline: CanonicalBaseline;
    figmaVersion: string;
    cocosPostimageHash: Sha256;
    txnId: string;
}): Promise<LedgerEntry> {
    const ledger = await loadLedger(input.projectRoot);
    const key = ledgerIdentityKey(input.identity);
    if (ledger.entries[key]) throw new Error('该 Figma surface 已完成 Pair，拒绝重复建立 genesis。');
    const stored = await ensureBaseline(input.projectRoot, input.baseline);
    const entry: LedgerEntry = {
        schemaVersion: 1,
        ...input.identity,
        managedRootNodeId: input.managedRootNodeId,
        baselineHash: stored.hash,
        baselineFile: stored.file,
        figmaVersion: input.figmaVersion,
        cocosPostimageHash: input.cocosPostimageHash,
        protocolVersion: 1,
        generation: 1,
        lastTxnId: input.txnId,
    };
    ledger.entries[key] = entry;
    await storeLedger(input.projectRoot, ledger);
    return entry;
}

export async function advanceLedger(input: {
    projectRoot: string;
    identity: LedgerIdentity;
    expectedGeneration: number;
    managedRootNodeId: string;
    baseline: CanonicalBaseline;
    figmaVersion: string;
    cocosPostimageHash: Sha256;
    txnId: string;
}): Promise<LedgerEntry> {
    const ledger = await loadLedger(input.projectRoot);
    const key = ledgerIdentityKey(input.identity);
    const current = ledger.entries[key];
    if (!current || current.generation !== input.expectedGeneration) throw new Error('ledger generation 已变化，请重新预览。');
    if (current.managedRootNodeId !== input.managedRootNodeId) throw new Error('managed root 与 Pair 记录不一致。');
    const stored = await ensureBaseline(input.projectRoot, input.baseline);
    const next: LedgerEntry = {
        ...current,
        baselineHash: stored.hash,
        baselineFile: stored.file,
        figmaVersion: input.figmaVersion,
        cocosPostimageHash: input.cocosPostimageHash,
        generation: current.generation + 1,
        lastTxnId: input.txnId,
    };
    ledger.entries[key] = next;
    await storeLedger(input.projectRoot, ledger);
    return next;
}

export function roundtripStatePath(projectRoot: string, ...segments: string[]): string {
    if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) {
        throw new Error('Round-trip state path segment 无效。');
    }
    return join(stateRoot(projectRoot), ...segments);
}
