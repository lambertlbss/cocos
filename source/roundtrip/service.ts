import { randomBytes } from 'crypto';
import { canonicalStringify } from './canonical-json';
import { editorAssetDb, readCocosPrefabByUuid, type CocosAssetDb, type ResolvedCocosPrefab } from './cocos-reader';
import { createDiff3Plan, type Diff3Plan, type RoundtripNodeState } from './diff3';
import { fetchRoundtripFile, managedRootIds, parseRoundtripSource, selectManagedRoot, sharedValue, type RoundtripFigmaClient } from './figma-reader';
import { parseManagedDocument } from './figma-projector';
import { createGenesisLedger, ledgerIdentityKey, readLedgerEntry, roundtripStatePath, type LedgerIdentity } from './ledger';
import { ROOT_HEADER_KEY, parseRootHeader, type CanonicalBaseline, type CanonicalNode } from './protocol';
import { acquireExclusiveFileLockWithin } from './storage-primitives';
import { applyRoundtripTransaction, editorReimporter, type RoundtripReimporter, type TransactionReceipt } from './transaction';

const TOKEN_TTL_MS = 5 * 60 * 1000;

interface PreviewContext {
    txnId: string;
    sourceUrl: string;
    rootNodeId: string;
    figmaVersion: string;
    identity: LedgerIdentity;
    baseline: CanonicalBaseline;
    target: ResolvedCocosPrefab;
    plan: Diff3Plan;
    ledgerGeneration: number;
}

interface PairContext {
    sourceUrl: string;
    rootNodeId: string;
    figmaVersion: string;
    identity: LedgerIdentity;
    baseline: CanonicalBaseline;
    target: ResolvedCocosPrefab;
}

interface StoredToken<T> {
    expiresAt: number;
    value: T;
    state: 'fresh' | 'applying' | 'consumed';
    result?: unknown;
    error?: string;
}

const previewTokens = new Map<string, StoredToken<PreviewContext>>();
const pairTokens = new Map<string, StoredToken<PairContext>>();

function issueToken<T>(store: Map<string, StoredToken<T>>, value: T): string {
    const now = Date.now();
    for (const [token, stored] of store) if (stored.expiresAt <= now) store.delete(token);
    const token = randomBytes(32).toString('base64url');
    store.set(token, { expiresAt: now + TOKEN_TTL_MS, value, state: 'fresh' });
    return token;
}

function claimPreviewToken(token: string): StoredToken<PreviewContext> {
    const stored = previewTokens.get(token);
    if (!stored || stored.expiresAt <= Date.now()) {
        previewTokens.delete(token);
        throw new Error('Preview token 已过期或无效，请重新生成。');
    }
    if (stored.state === 'applying') throw new Error('该 Preview token 正在应用中。');
    if (stored.state === 'consumed' && stored.error) throw new Error(stored.error);
    return stored;
}

export interface RoundtripTargetSafety {
    check(prefabUuid: string): Promise<{ safe: boolean; blocker?: string }>;
}

export const editorRoundtripTargetSafety: RoundtripTargetSafety = {
    async check(prefabUuid: string): Promise<{ safe: boolean; blocker?: string }> {
        try {
            const ready = await Editor.Message.request('scene', 'query-is-ready');
            if (!ready) return { safe: false, blocker: 'TARGET_EDITOR_STATE_UNAVAILABLE' };
            const loadedNodes = await Editor.Message.request('scene', 'query-nodes-by-asset-uuid', prefabUuid);
            if (!Array.isArray(loadedNodes)) return { safe: false, blocker: 'TARGET_EDITOR_STATE_UNAVAILABLE' };
            if (loadedNodes.length > 0) return { safe: false, blocker: 'TARGET_PREFAB_LOADED_IN_EDITOR' };
            return { safe: true };
        } catch {
            return { safe: false, blocker: 'TARGET_EDITOR_STATE_UNAVAILABLE' };
        }
    },
};

function consumeToken<T>(store: Map<string, StoredToken<T>>, token: string, label: string): T {
    const stored = store.get(token);
    store.delete(token);
    if (!stored || stored.expiresAt <= Date.now()) throw new Error(`${label} 已过期或已使用，请重新生成。`);
    return stored.value;
}

function baselineStates(nodes: readonly CanonicalNode[]): RoundtripNodeState[] {
    return nodes.map((node) => ({
        syncId: node.syncId,
        ...(node.position ? { position: { ...node.position } } : {}),
        ...(node.contentSize ? { contentSize: { ...node.contentSize } } : {}),
        ...(node.spriteFrameUuid !== undefined ? { spriteFrameUuid: node.spriteFrameUuid } : {}),
    }));
}

function pairCocosMatches(baseline: CanonicalBaseline, target: ResolvedCocosPrefab): boolean {
    const plan = createDiff3Plan({
        baseline: baseline.nodes,
        figma: baselineStates(baseline.nodes),
        cocos: target.nodes,
    });
    return plan.apply.length === 0 && plan.applyLeaves.length === 0 && plan.preserveCocos.length === 0 &&
        plan.conflicts.length === 0 && plan.unsupported.length === 0;
}

export interface RoundtripDetectResult {
    fileKey: string;
    figmaVersion: string;
    managedRoots: Array<{
        nodeId: string;
        name: string;
        surfaceId?: string;
        prefabUuid?: string;
        producer?: string;
        error?: string;
    }>;
    selectedRootId?: string;
}

export interface RoundtripPreviewResult {
    txnId: string;
    previewToken?: string;
    pairToken?: string;
    pairRequired: boolean;
    pairEligible: boolean;
    figmaVersion: string;
    fileKey: string;
    managedRootNodeId: string;
    surfaceId: string;
    prefabUuid: string;
    assetUrl: string;
    prefabPreimageHash: string;
    metaPreimageHash: string;
    baselineHash: string;
    ledgerGeneration: number;
    plan: Diff3Plan;
    blockers: string[];
}

export class RoundtripService {
    constructor(private readonly dependencies: {
        client: RoundtripFigmaClient;
        projectRoot: string;
        creatorVersion: string;
        assetDb?: CocosAssetDb;
        reimporter?: RoundtripReimporter;
        targetSafety?: RoundtripTargetSafety;
    }) {}

    async detect(sourceUrl: string, explicitRootId?: string): Promise<RoundtripDetectResult> {
        const source = parseRoundtripSource(sourceUrl);
        const index = await fetchRoundtripFile(this.dependencies.client, source);
        const roots = managedRootIds(index).map((nodeId) => {
            const node = index.nodes.get(nodeId)!;
            try {
                const header = parseRootHeader(sharedValue(node, ROOT_HEADER_KEY)!);
                return {
                    nodeId,
                    name: node.name ?? nodeId,
                    surfaceId: header.surfaceId,
                    prefabUuid: header.prefab.uuid,
                    producer: `${header.producer.name}@${header.producer.version}`,
                };
            } catch (error) {
                return {
                    nodeId,
                    name: node.name ?? nodeId,
                    error: error instanceof Error ? error.message : 'invalid managed root',
                };
            }
        });
        const selected = explicitRootId
            ? selectManagedRoot(index, { explicitRootId })
            : source.nodeId
                ? selectManagedRoot(index, { descendantNodeId: source.nodeId })
                : roots.length === 1
                    ? selectManagedRoot(index)
                    : undefined;
        return { fileKey: source.fileKey, figmaVersion: index.version, managedRoots: roots, selectedRootId: selected?.id };
    }

    async preview(sourceUrl: string, explicitRootId?: string): Promise<RoundtripPreviewResult> {
        const source = parseRoundtripSource(sourceUrl);
        const index = await fetchRoundtripFile(this.dependencies.client, source);
        const root = selectManagedRoot(index, explicitRootId
            ? { explicitRootId }
            : { descendantNodeId: source.nodeId });
        const managed = parseManagedDocument(index, root);
        const identity: LedgerIdentity = {
            fileKey: source.fileKey,
            surfaceId: managed.header.surfaceId,
            prefabUuid: managed.header.prefab.uuid,
        };
        const ledger = await readLedgerEntry(this.dependencies.projectRoot, identity);
        if (ledger && ledger.entry.managedRootNodeId !== root.id) throw new Error('当前 managed root 与已 Pair 的 root 不一致。');
        const baseline = ledger?.baseline ?? managed.baseline;
        const target = await readCocosPrefabByUuid({
            assetDb: this.dependencies.assetDb ?? editorAssetDb,
            projectRoot: this.dependencies.projectRoot,
            prefabUuid: identity.prefabUuid,
            baseline: baseline.nodes,
        });
        const plan = createDiff3Plan({
            baseline: baseline.nodes,
            figma: managed.figmaProjection,
            cocos: target.nodes,
            resourceBindings: managed.resources,
        });
        const pairRequired = ledger === null;
        const pairEligible = pairRequired && managed.header.prefab.sourceHash === target.sourceHash &&
            managed.header.prefab.metaSourceHash === target.metaSourceHash && pairCocosMatches(managed.baseline, target);
        const targetSafety = await (this.dependencies.targetSafety ?? editorRoundtripTargetSafety).check(identity.prefabUuid);
        const blockers: string[] = [];
        if (pairRequired) blockers.push(pairEligible ? 'PAIR_REQUIRED' : 'PAIR_EVIDENCE_MISMATCH');
        if (plan.conflicts.length > 0) blockers.push('DIFF3_CONFLICT');
        if (plan.unsupported.length > 0) blockers.push('UNSUPPORTED_CHANGE');
        if (this.dependencies.creatorVersion !== '3.8.7') blockers.push('CREATOR_VERSION_UNVERIFIED');
        if (!targetSafety.safe) blockers.push(targetSafety.blocker ?? 'TARGET_EDITOR_STATE_UNAVAILABLE');
        const txnId = randomBytes(16).toString('hex');
        const context: PreviewContext = {
            txnId,
            sourceUrl,
            rootNodeId: root.id,
            figmaVersion: index.version,
            identity,
            baseline,
            target,
            plan,
            ledgerGeneration: ledger?.entry.generation ?? 0,
        };
        const previewToken = blockers.length === 0 && plan.apply.length > 0
            ? issueToken(previewTokens, context)
            : undefined;
        const pairToken = pairEligible && this.dependencies.creatorVersion === '3.8.7' && targetSafety.safe
            ? issueToken(pairTokens, {
                sourceUrl,
                rootNodeId: root.id,
                figmaVersion: index.version,
                identity,
                baseline: managed.baseline,
                target,
            })
            : undefined;
        return {
            txnId,
            previewToken,
            pairToken,
            pairRequired,
            pairEligible,
            figmaVersion: index.version,
            fileKey: source.fileKey,
            managedRootNodeId: root.id,
            surfaceId: identity.surfaceId,
            prefabUuid: identity.prefabUuid,
            assetUrl: target.assetUrl,
            prefabPreimageHash: target.sourceHash,
            metaPreimageHash: target.metaSourceHash,
            baselineHash: managed.header.baseline.sha256,
            ledgerGeneration: ledger?.entry.generation ?? 0,
            plan,
            blockers,
        };
    }

    async pair(token: string): Promise<{ generation: number; baselineHash: string }> {
        const context = consumeToken(pairTokens, token, 'Pair token');
        if (this.dependencies.creatorVersion !== '3.8.7') throw new Error('Round-trip Pair 仅允许 Cocos Creator 3.8.7。');
        const lockPath = roundtripStatePath(
            this.dependencies.projectRoot,
            'locks',
            `${ledgerIdentityKey(context.identity)}.pair.lock`,
        );
        const lock = await acquireExclusiveFileLockWithin(
            this.dependencies.projectRoot,
            lockPath,
            Buffer.from(canonicalStringify({ purpose: 'pair', pid: process.pid }), 'utf8'),
        );
        try {
            if (await readLedgerEntry(this.dependencies.projectRoot, context.identity)) throw new Error('Pair 已由其他操作完成。');
            const source = parseRoundtripSource(context.sourceUrl);
            const index = await fetchRoundtripFile(this.dependencies.client, source);
            if (index.version !== context.figmaVersion) throw new Error('Figma version 已变化，请重新检测。');
            const root = selectManagedRoot(index, { explicitRootId: context.rootNodeId });
            const managed = parseManagedDocument(index, root);
            const target = await readCocosPrefabByUuid({
                assetDb: this.dependencies.assetDb ?? editorAssetDb,
                projectRoot: this.dependencies.projectRoot,
                prefabUuid: context.identity.prefabUuid,
                baseline: context.baseline.nodes,
            });
            const targetSafety = await (this.dependencies.targetSafety ?? editorRoundtripTargetSafety).check(context.identity.prefabUuid);
            if (!targetSafety.safe) throw new Error(targetSafety.blocker ?? 'TARGET_EDITOR_STATE_UNAVAILABLE');
            if (target.sourceHash !== managed.header.prefab.sourceHash ||
                target.metaSourceHash !== managed.header.prefab.metaSourceHash ||
                !pairCocosMatches(context.baseline, target)) throw new Error('Pair 证据已变化。');
            const entry = await createGenesisLedger({
                projectRoot: this.dependencies.projectRoot,
                identity: context.identity,
                managedRootNodeId: context.rootNodeId,
                baseline: context.baseline,
                figmaVersion: context.figmaVersion,
                cocosPostimageHash: target.sourceHash,
                txnId: `pair-${randomBytes(12).toString('hex')}`,
            });
            return { generation: entry.generation, baselineHash: entry.baselineHash };
        } finally {
            await lock.release();
        }
    }

    async apply(token: string): Promise<TransactionReceipt> {
        const stored = claimPreviewToken(token);
        if (stored.state === 'consumed') return stored.result as TransactionReceipt;
        stored.state = 'applying';
        const context = stored.value;
        try {
        const source = parseRoundtripSource(context.sourceUrl);
        const index = await fetchRoundtripFile(this.dependencies.client, source);
        if (index.version !== context.figmaVersion) throw new Error('Figma version 已变化，请重新预览。');
        const root = selectManagedRoot(index, { explicitRootId: context.rootNodeId });
        const managed = parseManagedDocument(index, root);
        const ledger = await readLedgerEntry(this.dependencies.projectRoot, context.identity);
        if (!ledger || ledger.entry.generation !== context.ledgerGeneration ||
            ledger.entry.managedRootNodeId !== context.rootNodeId) throw new Error('Ledger 已变化，请重新预览。');
        const target = await readCocosPrefabByUuid({
            assetDb: this.dependencies.assetDb ?? editorAssetDb,
            projectRoot: this.dependencies.projectRoot,
            prefabUuid: context.identity.prefabUuid,
            baseline: ledger.baseline.nodes,
        });
        const targetSafety = await (this.dependencies.targetSafety ?? editorRoundtripTargetSafety).check(context.identity.prefabUuid);
        if (!targetSafety.safe) throw new Error(targetSafety.blocker ?? 'TARGET_EDITOR_STATE_UNAVAILABLE');
        const freshPlan = createDiff3Plan({
            baseline: ledger.baseline.nodes,
            figma: managed.figmaProjection,
            cocos: target.nodes,
            resourceBindings: managed.resources,
        });
        if (canonicalStringify(freshPlan) !== canonicalStringify(context.plan)) throw new Error('PatchPlan 已变化，请重新预览。');
        const receipt = await applyRoundtripTransaction({
            projectRoot: this.dependencies.projectRoot,
            creatorVersion: this.dependencies.creatorVersion,
            assetDb: this.dependencies.assetDb ?? editorAssetDb,
            reimporter: this.dependencies.reimporter ?? editorReimporter,
            identity: context.identity,
            managedRootNodeId: context.rootNodeId,
            figmaVersion: context.figmaVersion,
            expectedLedgerGeneration: context.ledgerGeneration,
            target,
            baseline: ledger.baseline,
            plan: freshPlan,
            txnId: context.txnId,
            assertTargetSafe: async () => {
                const safety = await (this.dependencies.targetSafety ?? editorRoundtripTargetSafety).check(context.identity.prefabUuid);
                if (!safety.safe) throw new Error(safety.blocker ?? 'TARGET_EDITOR_STATE_UNAVAILABLE');
            },
        });
        stored.state = 'consumed';
        stored.result = receipt;
        stored.expiresAt = Date.now() + TOKEN_TTL_MS;
        return receipt;
        } catch (error) {
            stored.state = 'consumed';
            stored.error = error instanceof Error ? error.message : 'Round-trip 应用失败。';
            stored.expiresAt = Date.now() + TOKEN_TTL_MS;
            throw error;
        }
    }
}
