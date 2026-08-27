"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoundtripService = exports.editorRoundtripTargetSafety = void 0;
const crypto_1 = require("crypto");
const canonical_json_1 = require("./canonical-json");
const cocos_reader_1 = require("./cocos-reader");
const diff3_1 = require("./diff3");
const figma_reader_1 = require("./figma-reader");
const figma_projector_1 = require("./figma-projector");
const ledger_1 = require("./ledger");
const protocol_1 = require("./protocol");
const storage_primitives_1 = require("./storage-primitives");
const transaction_1 = require("./transaction");
const TOKEN_TTL_MS = 5 * 60 * 1000;
const previewTokens = new Map();
const pairTokens = new Map();
function issueToken(store, value) {
    const now = Date.now();
    for (const [token, stored] of store)
        if (stored.expiresAt <= now)
            store.delete(token);
    const token = (0, crypto_1.randomBytes)(32).toString('base64url');
    store.set(token, { expiresAt: now + TOKEN_TTL_MS, value, state: 'fresh' });
    return token;
}
function claimPreviewToken(token) {
    const stored = previewTokens.get(token);
    if (!stored || stored.expiresAt <= Date.now()) {
        previewTokens.delete(token);
        throw new Error('Preview token 已过期或无效，请重新生成。');
    }
    if (stored.state === 'applying')
        throw new Error('该 Preview token 正在应用中。');
    if (stored.state === 'consumed' && stored.error)
        throw new Error(stored.error);
    return stored;
}
exports.editorRoundtripTargetSafety = {
    async check(prefabUuid) {
        try {
            const ready = await Editor.Message.request('scene', 'query-is-ready');
            if (!ready)
                return { safe: false, blocker: 'TARGET_EDITOR_STATE_UNAVAILABLE' };
            const loadedNodes = await Editor.Message.request('scene', 'query-nodes-by-asset-uuid', prefabUuid);
            if (!Array.isArray(loadedNodes))
                return { safe: false, blocker: 'TARGET_EDITOR_STATE_UNAVAILABLE' };
            if (loadedNodes.length > 0)
                return { safe: false, blocker: 'TARGET_PREFAB_LOADED_IN_EDITOR' };
            return { safe: true };
        }
        catch {
            return { safe: false, blocker: 'TARGET_EDITOR_STATE_UNAVAILABLE' };
        }
    },
};
function consumeToken(store, token, label) {
    const stored = store.get(token);
    store.delete(token);
    if (!stored || stored.expiresAt <= Date.now())
        throw new Error(`${label} 已过期或已使用，请重新生成。`);
    return stored.value;
}
function baselineStates(nodes) {
    return nodes.map((node) => ({
        syncId: node.syncId,
        ...(node.position ? { position: { ...node.position } } : {}),
        ...(node.contentSize ? { contentSize: { ...node.contentSize } } : {}),
        ...(node.spriteFrameUuid !== undefined ? { spriteFrameUuid: node.spriteFrameUuid } : {}),
    }));
}
function pairCocosMatches(baseline, target) {
    const plan = (0, diff3_1.createDiff3Plan)({
        baseline: baseline.nodes,
        figma: baselineStates(baseline.nodes),
        cocos: target.nodes,
    });
    return plan.apply.length === 0 && plan.applyLeaves.length === 0 && plan.preserveCocos.length === 0 &&
        plan.conflicts.length === 0 && plan.unsupported.length === 0;
}
class RoundtripService {
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async detect(sourceUrl, explicitRootId) {
        const source = (0, figma_reader_1.parseRoundtripSource)(sourceUrl);
        const index = await (0, figma_reader_1.fetchRoundtripFile)(this.dependencies.client, source);
        const roots = (0, figma_reader_1.managedRootIds)(index).map((nodeId) => {
            var _a, _b;
            const node = index.nodes.get(nodeId);
            try {
                const header = (0, protocol_1.parseRootHeader)((0, figma_reader_1.sharedValue)(node, protocol_1.ROOT_HEADER_KEY));
                return {
                    nodeId,
                    name: (_a = node.name) !== null && _a !== void 0 ? _a : nodeId,
                    surfaceId: header.surfaceId,
                    prefabUuid: header.prefab.uuid,
                    producer: `${header.producer.name}@${header.producer.version}`,
                };
            }
            catch (error) {
                return {
                    nodeId,
                    name: (_b = node.name) !== null && _b !== void 0 ? _b : nodeId,
                    error: error instanceof Error ? error.message : 'invalid managed root',
                };
            }
        });
        const selected = explicitRootId
            ? (0, figma_reader_1.selectManagedRoot)(index, { explicitRootId })
            : source.nodeId
                ? (0, figma_reader_1.selectManagedRoot)(index, { descendantNodeId: source.nodeId })
                : roots.length === 1
                    ? (0, figma_reader_1.selectManagedRoot)(index)
                    : undefined;
        return { fileKey: source.fileKey, figmaVersion: index.version, managedRoots: roots, selectedRootId: selected === null || selected === void 0 ? void 0 : selected.id };
    }
    async preview(sourceUrl, explicitRootId) {
        var _a, _b, _c, _d, _e, _f;
        const source = (0, figma_reader_1.parseRoundtripSource)(sourceUrl);
        const index = await (0, figma_reader_1.fetchRoundtripFile)(this.dependencies.client, source);
        const root = (0, figma_reader_1.selectManagedRoot)(index, explicitRootId
            ? { explicitRootId }
            : { descendantNodeId: source.nodeId });
        const managed = (0, figma_projector_1.parseManagedDocument)(index, root);
        const identity = {
            fileKey: source.fileKey,
            surfaceId: managed.header.surfaceId,
            prefabUuid: managed.header.prefab.uuid,
        };
        const ledger = await (0, ledger_1.readLedgerEntry)(this.dependencies.projectRoot, identity);
        if (ledger && ledger.entry.managedRootNodeId !== root.id)
            throw new Error('当前 managed root 与已 Pair 的 root 不一致。');
        const baseline = (_a = ledger === null || ledger === void 0 ? void 0 : ledger.baseline) !== null && _a !== void 0 ? _a : managed.baseline;
        const target = await (0, cocos_reader_1.readCocosPrefabByUuid)({
            assetDb: (_b = this.dependencies.assetDb) !== null && _b !== void 0 ? _b : cocos_reader_1.editorAssetDb,
            projectRoot: this.dependencies.projectRoot,
            prefabUuid: identity.prefabUuid,
            baseline: baseline.nodes,
        });
        const plan = (0, diff3_1.createDiff3Plan)({
            baseline: baseline.nodes,
            figma: managed.figmaProjection,
            cocos: target.nodes,
            resourceBindings: managed.resources,
        });
        const pairRequired = ledger === null;
        const pairEligible = pairRequired && managed.header.prefab.sourceHash === target.sourceHash &&
            managed.header.prefab.metaSourceHash === target.metaSourceHash && pairCocosMatches(managed.baseline, target);
        const targetSafety = await ((_c = this.dependencies.targetSafety) !== null && _c !== void 0 ? _c : exports.editorRoundtripTargetSafety).check(identity.prefabUuid);
        const blockers = [];
        if (pairRequired)
            blockers.push(pairEligible ? 'PAIR_REQUIRED' : 'PAIR_EVIDENCE_MISMATCH');
        if (plan.conflicts.length > 0)
            blockers.push('DIFF3_CONFLICT');
        if (plan.unsupported.length > 0)
            blockers.push('UNSUPPORTED_CHANGE');
        if (this.dependencies.creatorVersion !== '3.8.7')
            blockers.push('CREATOR_VERSION_UNVERIFIED');
        if (!targetSafety.safe)
            blockers.push((_d = targetSafety.blocker) !== null && _d !== void 0 ? _d : 'TARGET_EDITOR_STATE_UNAVAILABLE');
        const txnId = (0, crypto_1.randomBytes)(16).toString('hex');
        const context = {
            txnId,
            sourceUrl,
            rootNodeId: root.id,
            figmaVersion: index.version,
            identity,
            baseline,
            target,
            plan,
            ledgerGeneration: (_e = ledger === null || ledger === void 0 ? void 0 : ledger.entry.generation) !== null && _e !== void 0 ? _e : 0,
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
            ledgerGeneration: (_f = ledger === null || ledger === void 0 ? void 0 : ledger.entry.generation) !== null && _f !== void 0 ? _f : 0,
            plan,
            blockers,
        };
    }
    async pair(token) {
        var _a, _b, _c;
        const context = consumeToken(pairTokens, token, 'Pair token');
        if (this.dependencies.creatorVersion !== '3.8.7')
            throw new Error('Round-trip Pair 仅允许 Cocos Creator 3.8.7。');
        const lockPath = (0, ledger_1.roundtripStatePath)(this.dependencies.projectRoot, 'locks', `${(0, ledger_1.ledgerIdentityKey)(context.identity)}.pair.lock`);
        const lock = await (0, storage_primitives_1.acquireExclusiveFileLockWithin)(this.dependencies.projectRoot, lockPath, Buffer.from((0, canonical_json_1.canonicalStringify)({ purpose: 'pair', pid: process.pid }), 'utf8'));
        try {
            if (await (0, ledger_1.readLedgerEntry)(this.dependencies.projectRoot, context.identity))
                throw new Error('Pair 已由其他操作完成。');
            const source = (0, figma_reader_1.parseRoundtripSource)(context.sourceUrl);
            const index = await (0, figma_reader_1.fetchRoundtripFile)(this.dependencies.client, source);
            if (index.version !== context.figmaVersion)
                throw new Error('Figma version 已变化，请重新检测。');
            const root = (0, figma_reader_1.selectManagedRoot)(index, { explicitRootId: context.rootNodeId });
            const managed = (0, figma_projector_1.parseManagedDocument)(index, root);
            const target = await (0, cocos_reader_1.readCocosPrefabByUuid)({
                assetDb: (_a = this.dependencies.assetDb) !== null && _a !== void 0 ? _a : cocos_reader_1.editorAssetDb,
                projectRoot: this.dependencies.projectRoot,
                prefabUuid: context.identity.prefabUuid,
                baseline: context.baseline.nodes,
            });
            const targetSafety = await ((_b = this.dependencies.targetSafety) !== null && _b !== void 0 ? _b : exports.editorRoundtripTargetSafety).check(context.identity.prefabUuid);
            if (!targetSafety.safe)
                throw new Error((_c = targetSafety.blocker) !== null && _c !== void 0 ? _c : 'TARGET_EDITOR_STATE_UNAVAILABLE');
            if (target.sourceHash !== managed.header.prefab.sourceHash ||
                target.metaSourceHash !== managed.header.prefab.metaSourceHash ||
                !pairCocosMatches(context.baseline, target))
                throw new Error('Pair 证据已变化。');
            const entry = await (0, ledger_1.createGenesisLedger)({
                projectRoot: this.dependencies.projectRoot,
                identity: context.identity,
                managedRootNodeId: context.rootNodeId,
                baseline: context.baseline,
                figmaVersion: context.figmaVersion,
                cocosPostimageHash: target.sourceHash,
                txnId: `pair-${(0, crypto_1.randomBytes)(12).toString('hex')}`,
            });
            return { generation: entry.generation, baselineHash: entry.baselineHash };
        }
        finally {
            await lock.release();
        }
    }
    async apply(token) {
        var _a, _b, _c, _d, _e;
        const stored = claimPreviewToken(token);
        if (stored.state === 'consumed')
            return stored.result;
        stored.state = 'applying';
        const context = stored.value;
        try {
            const source = (0, figma_reader_1.parseRoundtripSource)(context.sourceUrl);
            const index = await (0, figma_reader_1.fetchRoundtripFile)(this.dependencies.client, source);
            if (index.version !== context.figmaVersion)
                throw new Error('Figma version 已变化，请重新预览。');
            const root = (0, figma_reader_1.selectManagedRoot)(index, { explicitRootId: context.rootNodeId });
            const managed = (0, figma_projector_1.parseManagedDocument)(index, root);
            const ledger = await (0, ledger_1.readLedgerEntry)(this.dependencies.projectRoot, context.identity);
            if (!ledger || ledger.entry.generation !== context.ledgerGeneration ||
                ledger.entry.managedRootNodeId !== context.rootNodeId)
                throw new Error('Ledger 已变化，请重新预览。');
            const target = await (0, cocos_reader_1.readCocosPrefabByUuid)({
                assetDb: (_a = this.dependencies.assetDb) !== null && _a !== void 0 ? _a : cocos_reader_1.editorAssetDb,
                projectRoot: this.dependencies.projectRoot,
                prefabUuid: context.identity.prefabUuid,
                baseline: ledger.baseline.nodes,
            });
            const targetSafety = await ((_b = this.dependencies.targetSafety) !== null && _b !== void 0 ? _b : exports.editorRoundtripTargetSafety).check(context.identity.prefabUuid);
            if (!targetSafety.safe)
                throw new Error((_c = targetSafety.blocker) !== null && _c !== void 0 ? _c : 'TARGET_EDITOR_STATE_UNAVAILABLE');
            const freshPlan = (0, diff3_1.createDiff3Plan)({
                baseline: ledger.baseline.nodes,
                figma: managed.figmaProjection,
                cocos: target.nodes,
                resourceBindings: managed.resources,
            });
            if ((0, canonical_json_1.canonicalStringify)(freshPlan) !== (0, canonical_json_1.canonicalStringify)(context.plan))
                throw new Error('PatchPlan 已变化，请重新预览。');
            const receipt = await (0, transaction_1.applyRoundtripTransaction)({
                projectRoot: this.dependencies.projectRoot,
                creatorVersion: this.dependencies.creatorVersion,
                assetDb: (_d = this.dependencies.assetDb) !== null && _d !== void 0 ? _d : cocos_reader_1.editorAssetDb,
                reimporter: (_e = this.dependencies.reimporter) !== null && _e !== void 0 ? _e : transaction_1.editorReimporter,
                identity: context.identity,
                managedRootNodeId: context.rootNodeId,
                figmaVersion: context.figmaVersion,
                expectedLedgerGeneration: context.ledgerGeneration,
                target,
                baseline: ledger.baseline,
                plan: freshPlan,
                txnId: context.txnId,
                assertTargetSafe: async () => {
                    var _a, _b;
                    const safety = await ((_a = this.dependencies.targetSafety) !== null && _a !== void 0 ? _a : exports.editorRoundtripTargetSafety).check(context.identity.prefabUuid);
                    if (!safety.safe)
                        throw new Error((_b = safety.blocker) !== null && _b !== void 0 ? _b : 'TARGET_EDITOR_STATE_UNAVAILABLE');
                },
            });
            stored.state = 'consumed';
            stored.result = receipt;
            stored.expiresAt = Date.now() + TOKEN_TTL_MS;
            return receipt;
        }
        catch (error) {
            stored.state = 'consumed';
            stored.error = error instanceof Error ? error.message : 'Round-trip 应用失败。';
            stored.expiresAt = Date.now() + TOKEN_TTL_MS;
            throw error;
        }
    }
}
exports.RoundtripService = RoundtripService;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NvdXJjZS9yb3VuZHRyaXAvc2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBcUM7QUFDckMscURBQXNEO0FBQ3RELGlEQUFtSDtBQUNuSCxtQ0FBbUY7QUFDbkYsaURBQXFKO0FBQ3JKLHVEQUF5RDtBQUN6RCxxQ0FBNEg7QUFDNUgseUNBQTBHO0FBQzFHLDZEQUFzRTtBQUN0RSwrQ0FBK0g7QUFFL0gsTUFBTSxZQUFZLEdBQUcsQ0FBQyxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUM7QUErQm5DLE1BQU0sYUFBYSxHQUFHLElBQUksR0FBRyxFQUF1QyxDQUFDO0FBQ3JFLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxFQUFvQyxDQUFDO0FBRS9ELFNBQVMsVUFBVSxDQUFJLEtBQWtDLEVBQUUsS0FBUTtJQUMvRCxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDdkIsS0FBSyxNQUFNLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxJQUFJLEtBQUs7UUFBRSxJQUFJLE1BQU0sQ0FBQyxTQUFTLElBQUksR0FBRztZQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDdEYsTUFBTSxLQUFLLEdBQUcsSUFBQSxvQkFBVyxFQUFDLEVBQUUsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNwRCxLQUFLLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxFQUFFLFNBQVMsRUFBRSxHQUFHLEdBQUcsWUFBWSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLENBQUMsQ0FBQztJQUMzRSxPQUFPLEtBQUssQ0FBQztBQUNqQixDQUFDO0FBRUQsU0FBUyxpQkFBaUIsQ0FBQyxLQUFhO0lBQ3BDLE1BQU0sTUFBTSxHQUFHLGFBQWEsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUM7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LE1BQU0sQ0FBQyxJQUFJO3dCQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsTUFBQSxNQUFNLENBQUMsT0FBTyxtQ0FBSSxpQ0FBaUMsQ0FBQyxDQUFDO2dCQUMzRixDQUFDO2FBQ0osQ0FBQyxDQUFDO1lBQ0gsTUFBTSxDQUFDLEtBQUssR0FBRyxVQUFVLENBQUM7WUFDMUIsTUFBTSxDQUFDLE1BQU0sR0FBRyxPQUFPLENBQUM7WUFDeEIsTUFBTSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsWUFBWSxDQUFDO1lBQzdDLE9BQU8sT0FBTyxDQUFDO1FBQ2YsQ0FBQztRQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFDYixNQUFNLENBQUMsS0FBSyxHQUFHLFVBQVUsQ0FBQztZQUMxQixNQUFNLENBQUMsS0FBSyxHQUFHLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLGtCQUFrQixDQUFDO1lBQzNFLE1BQU0sQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLFlBQVksQ0FBQztZQUM3QyxNQUFNLEtBQUssQ0FBQztRQUNoQixDQUFDO0lBQ0wsQ0FBQztDQUNKO0FBck9ELDRDQXFPQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJhbmRvbUJ5dGVzIH0gZnJvbSAnY3J5cHRvJztcclxuaW1wb3J0IHsgY2Fub25pY2FsU3RyaW5naWZ5IH0gZnJvbSAnLi9jYW5vbmljYWwtanNvbic7XHJcbmltcG9ydCB7IGVkaXRvckFzc2V0RGIsIHJlYWRDb2Nvc1ByZWZhYkJ5VXVpZCwgdHlwZSBDb2Nvc0Fzc2V0RGIsIHR5cGUgUmVzb2x2ZWRDb2Nvc1ByZWZhYiB9IGZyb20gJy4vY29jb3MtcmVhZGVyJztcclxuaW1wb3J0IHsgY3JlYXRlRGlmZjNQbGFuLCB0eXBlIERpZmYzUGxhbiwgdHlwZSBSb3VuZHRyaXBOb2RlU3RhdGUgfSBmcm9tICcuL2RpZmYzJztcclxuaW1wb3J0IHsgZmV0Y2hSb3VuZHRyaXBGaWxlLCBtYW5hZ2VkUm9vdElkcywgcGFyc2VSb3VuZHRyaXBTb3VyY2UsIHNlbGVjdE1hbmFnZWRSb290LCBzaGFyZWRWYWx1ZSwgdHlwZSBSb3VuZHRyaXBGaWdtYUNsaWVudCB9IGZyb20gJy4vZmlnbWEtcmVhZGVyJztcclxuaW1wb3J0IHsgcGFyc2VNYW5hZ2VkRG9jdW1lbnQgfSBmcm9tICcuL2ZpZ21hLXByb2plY3Rvcic7XHJcbmltcG9ydCB7IGNyZWF0ZUdlbmVzaXNMZWRnZXIsIGxlZGdlcklkZW50aXR5S2V5LCByZWFkTGVkZ2VyRW50cnksIHJvdW5kdHJpcFN0YXRlUGF0aCwgdHlwZSBMZWRnZXJJZGVudGl0eSB9IGZyb20gJy4vbGVkZ2VyJztcclxuaW1wb3J0IHsgUk9PVF9IRUFERVJfS0VZLCBwYXJzZVJvb3RIZWFkZXIsIHR5cGUgQ2Fub25pY2FsQmFzZWxpbmUsIHR5cGUgQ2Fub25pY2FsTm9kZSB9IGZyb20gJy4vcHJvdG9jb2wnO1xyXG5pbXBvcnQgeyBhY3F1aXJlRXhjbHVzaXZlRmlsZUxvY2tXaXRoaW4gfSBmcm9tICcuL3N0b3JhZ2UtcHJpbWl0aXZlcyc7XHJcbmltcG9ydCB7IGFwcGx5Um91bmR0cmlwVHJhbnNhY3Rpb24sIGVkaXRvclJlaW1wb3J0ZXIsIHR5cGUgUm91bmR0cmlwUmVpbXBvcnRlciwgdHlwZSBUcmFuc2FjdGlvblJlY2VpcHQgfSBmcm9tICcuL3RyYW5zYWN0aW9uJztcclxuXHJcbmNvbnN0IFRPS0VOX1RUTF9NUyA9IDUgKiA2MCAqIDEwMDA7XHJcblxyXG5pbnRlcmZhY2UgUHJldmlld0NvbnRleHQge1xyXG4gICAgdHhuSWQ6IHN0cmluZztcclxuICAgIHNvdXJjZVVybDogc3RyaW5nO1xyXG4gICAgcm9vdE5vZGVJZDogc3RyaW5nO1xyXG4gICAgZmlnbWFWZXJzaW9uOiBzdHJpbmc7XHJcbiAgICBpZGVudGl0eTogTGVkZ2VySWRlbnRpdHk7XHJcbiAgICBiYXNlbGluZTogQ2Fub25pY2FsQmFzZWxpbmU7XHJcbiAgICB0YXJnZXQ6IFJlc29sdmVkQ29jb3NQcmVmYWI7XHJcbiAgICBwbGFuOiBEaWZmM1BsYW47XHJcbiAgICBsZWRnZXJHZW5lcmF0aW9uOiBudW1iZXI7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQYWlyQ29udGV4dCB7XHJcbiAgICBzb3VyY2VVcmw6IHN0cmluZztcclxuICAgIHJvb3ROb2RlSWQ6IHN0cmluZztcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgaWRlbnRpdHk6IExlZGdlcklkZW50aXR5O1xyXG4gICAgYmFzZWxpbmU6IENhbm9uaWNhbEJhc2VsaW5lO1xyXG4gICAgdGFyZ2V0OiBSZXNvbHZlZENvY29zUHJlZmFiO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU3RvcmVkVG9rZW48VD4ge1xyXG4gICAgZXhwaXJlc0F0OiBudW1iZXI7XHJcbiAgICB2YWx1ZTogVDtcclxuICAgIHN0YXRlOiAnZnJlc2gnIHwgJ2FwcGx5aW5nJyB8ICdjb25zdW1lZCc7XHJcbiAgICByZXN1bHQ/OiB1bmtub3duO1xyXG4gICAgZXJyb3I/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmNvbnN0IHByZXZpZXdUb2tlbnMgPSBuZXcgTWFwPHN0cmluZywgU3RvcmVkVG9rZW48UHJldmlld0NvbnRleHQ+PigpO1xyXG5jb25zdCBwYWlyVG9rZW5zID0gbmV3IE1hcDxzdHJpbmcsIFN0b3JlZFRva2VuPFBhaXJDb250ZXh0Pj4oKTtcclxuXHJcbmZ1bmN0aW9uIGlzc3VlVG9rZW48VD4oc3RvcmU6IE1hcDxzdHJpbmcsIFN0b3JlZFRva2VuPFQ+PiwgdmFsdWU6IFQpOiBzdHJpbmcge1xyXG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcclxuICAgIGZvciAoY29uc3QgW3Rva2VuLCBzdG9yZWRdIG9mIHN0b3JlKSBpZiAoc3RvcmVkLmV4cGlyZXNBdCA8PSBub3cpIHN0b3JlLmRlbGV0ZSh0b2tlbik7XHJcbiAgICBjb25zdCB0b2tlbiA9IHJhbmRvbUJ5dGVzKDMyKS50b1N0cmluZygnYmFzZTY0dXJsJyk7XHJcbiAgICBzdG9yZS5zZXQodG9rZW4sIHsgZXhwaXJlc0F0OiBub3cgKyBUT0tFTl9UVExfTVMsIHZhbHVlLCBzdGF0ZTogJ2ZyZXNoJyB9KTtcclxuICAgIHJldHVybiB0b2tlbjtcclxufVxyXG5cclxuZnVuY3Rpb24gY2xhaW1QcmV2aWV3VG9rZW4odG9rZW46IHN0cmluZyk6IFN0b3JlZFRva2VuPFByZXZpZXdDb250ZXh0PiB7XHJcbiAgICBjb25zdCBzdG9yZWQgPSBwcmV2aWV3VG9rZW5zLmdldCh0b2tlbik7XHJcbiAgICBpZiAoIXN0b3JlZCB8fCBzdG9yZWQuZXhwaXJlc0F0IDw9IERhdGUubm93KCkpIHtcclxuICAgICAgICBwcmV2aWV3VG9rZW5zLmRlbGV0ZSh0b2tlbik7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmV2aWV3IHRva2VuIOW3sui/h+acn+aIluaXoOaViO+8jOivt+mHjeaWsOeUn+aIkOOAgicpO1xyXG4gICAgfVxyXG4gICAgaWYgKHN0b3JlZC5zdGF0ZSA9PT0gJ2FwcGx5aW5nJykgdGhyb3cgbmV3IEVycm9yKCfor6UgUHJldmlldyB0b2tlbiDmraPlnKjlupTnlKjkuK3jgIInKTtcclxuICAgIGlmIChzdG9yZWQuc3RhdGUgPT09ICdjb25zdW1lZCcgJiYgc3RvcmVkLmVycm9yKSB0aHJvdyBuZXcgRXJyb3Ioc3RvcmVkLmVycm9yKTtcclxuICAgIHJldHVybiBzdG9yZWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUm91bmR0cmlwVGFyZ2V0U2FmZXR5IHtcclxuICAgIGNoZWNrKHByZWZhYlV1aWQ6IHN0cmluZyk6IFByb21pc2U8eyBzYWZlOiBib29sZWFuOyBibG9ja2VyPzogc3RyaW5nIH0+O1xyXG59XHJcblxyXG5leHBvcnQgY29uc3QgZWRpdG9yUm91bmR0cmlwVGFyZ2V0U2FmZXR5OiBSb3VuZHRyaXBUYXJnZXRTYWZldHkgPSB7XHJcbiAgICBhc3luYyBjaGVjayhwcmVmYWJVdWlkOiBzdHJpbmcpOiBQcm9taXNlPHsgc2FmZTogYm9vbGVhbjsgYmxvY2tlcj86IHN0cmluZyB9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgcmVhZHkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1pcy1yZWFkeScpO1xyXG4gICAgICAgICAgICBpZiAoIXJlYWR5KSByZXR1cm4geyBzYWZlOiBmYWxzZSwgYmxvY2tlcjogJ1RBUkdFVF9FRElUT1JfU1RBVEVfVU5BVkFJTEFCTEUnIH07XHJcbiAgICAgICAgICAgIGNvbnN0IGxvYWRlZE5vZGVzID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktbm9kZXMtYnktYXNzZXQtdXVpZCcsIHByZWZhYlV1aWQpO1xyXG4gICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkobG9hZGVkTm9kZXMpKSByZXR1cm4geyBzYWZlOiBmYWxzZSwgYmxvY2tlcjogJ1RBUkdFVF9FRElUT1JfU1RBVEVfVU5BVkFJTEFCTEUnIH07XHJcbiAgICAgICAgICAgIGlmIChsb2FkZWROb2Rlcy5sZW5ndGggPiAwKSByZXR1cm4geyBzYWZlOiBmYWxzZSwgYmxvY2tlcjogJ1RBUkdFVF9QUkVGQUJfTE9BREVEX0lOX0VESVRPUicgfTtcclxuICAgICAgICAgICAgcmV0dXJuIHsgc2FmZTogdHJ1ZSB9O1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICByZXR1cm4geyBzYWZlOiBmYWxzZSwgYmxvY2tlcjogJ1RBUkdFVF9FRElUT1JfU1RBVEVfVU5BVkFJTEFCTEUnIH07XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxufTtcclxuXHJcbmZ1bmN0aW9uIGNvbnN1bWVUb2tlbjxUPihzdG9yZTogTWFwPHN0cmluZywgU3RvcmVkVG9rZW48VD4+LCB0b2tlbjogc3RyaW5nLCBsYWJlbDogc3RyaW5nKTogVCB7XHJcbiAgICBjb25zdCBzdG9yZWQgPSBzdG9yZS5nZXQodG9rZW4pO1xyXG4gICAgc3RvcmUuZGVsZXRlKHRva2VuKTtcclxuICAgIGlmICghc3RvcmVkIHx8IHN0b3JlZC5leHBpcmVzQXQgPD0gRGF0ZS5ub3coKSkgdGhyb3cgbmV3IEVycm9yKGAke2xhYmVsfSDlt7Lov4fmnJ/miJblt7Lkvb/nlKjvvIzor7fph43mlrDnlJ/miJDjgIJgKTtcclxuICAgIHJldHVybiBzdG9yZWQudmFsdWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhc2VsaW5lU3RhdGVzKG5vZGVzOiByZWFkb25seSBDYW5vbmljYWxOb2RlW10pOiBSb3VuZHRyaXBOb2RlU3RhdGVbXSB7XHJcbiAgICByZXR1cm4gbm9kZXMubWFwKChub2RlKSA9PiAoe1xyXG4gICAgICAgIHN5bmNJZDogbm9kZS5zeW5jSWQsXHJcbiAgICAgICAgLi4uKG5vZGUucG9zaXRpb24gPyB7IHBvc2l0aW9uOiB7IC4uLm5vZGUucG9zaXRpb24gfSB9IDoge30pLFxyXG4gICAgICAgIC4uLihub2RlLmNvbnRlbnRTaXplID8geyBjb250ZW50U2l6ZTogeyAuLi5ub2RlLmNvbnRlbnRTaXplIH0gfSA6IHt9KSxcclxuICAgICAgICAuLi4obm9kZS5zcHJpdGVGcmFtZVV1aWQgIT09IHVuZGVmaW5lZCA/IHsgc3ByaXRlRnJhbWVVdWlkOiBub2RlLnNwcml0ZUZyYW1lVXVpZCB9IDoge30pLFxyXG4gICAgfSkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwYWlyQ29jb3NNYXRjaGVzKGJhc2VsaW5lOiBDYW5vbmljYWxCYXNlbGluZSwgdGFyZ2V0OiBSZXNvbHZlZENvY29zUHJlZmFiKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBwbGFuID0gY3JlYXRlRGlmZjNQbGFuKHtcclxuICAgICAgICBiYXNlbGluZTogYmFzZWxpbmUubm9kZXMsXHJcbiAgICAgICAgZmlnbWE6IGJhc2VsaW5lU3RhdGVzKGJhc2VsaW5lLm5vZGVzKSxcclxuICAgICAgICBjb2NvczogdGFyZ2V0Lm5vZGVzLFxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gcGxhbi5hcHBseS5sZW5ndGggPT09IDAgJiYgcGxhbi5hcHBseUxlYXZlcy5sZW5ndGggPT09IDAgJiYgcGxhbi5wcmVzZXJ2ZUNvY29zLmxlbmd0aCA9PT0gMCAmJlxyXG4gICAgICAgIHBsYW4uY29uZmxpY3RzLmxlbmd0aCA9PT0gMCAmJiBwbGFuLnVuc3VwcG9ydGVkLmxlbmd0aCA9PT0gMDtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBSb3VuZHRyaXBEZXRlY3RSZXN1bHQge1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgZmlnbWFWZXJzaW9uOiBzdHJpbmc7XHJcbiAgICBtYW5hZ2VkUm9vdHM6IEFycmF5PHtcclxuICAgICAgICBub2RlSWQ6IHN0cmluZztcclxuICAgICAgICBuYW1lOiBzdHJpbmc7XHJcbiAgICAgICAgc3VyZmFjZUlkPzogc3RyaW5nO1xyXG4gICAgICAgIHByZWZhYlV1aWQ/OiBzdHJpbmc7XHJcbiAgICAgICAgcHJvZHVjZXI/OiBzdHJpbmc7XHJcbiAgICAgICAgZXJyb3I/OiBzdHJpbmc7XHJcbiAgICB9PjtcclxuICAgIHNlbGVjdGVkUm9vdElkPzogc3RyaW5nO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFJvdW5kdHJpcFByZXZpZXdSZXN1bHQge1xyXG4gICAgdHhuSWQ6IHN0cmluZztcclxuICAgIHByZXZpZXdUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJSZXF1aXJlZDogYm9vbGVhbjtcclxuICAgIHBhaXJFbGlnaWJsZTogYm9vbGVhbjtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgbWFuYWdlZFJvb3ROb2RlSWQ6IHN0cmluZztcclxuICAgIHN1cmZhY2VJZDogc3RyaW5nO1xyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgYXNzZXRVcmw6IHN0cmluZztcclxuICAgIHByZWZhYlByZWltYWdlSGFzaDogc3RyaW5nO1xyXG4gICAgbWV0YVByZWltYWdlSGFzaDogc3RyaW5nO1xyXG4gICAgYmFzZWxpbmVIYXNoOiBzdHJpbmc7XHJcbiAgICBsZWRnZXJHZW5lcmF0aW9uOiBudW1iZXI7XHJcbiAgICBwbGFuOiBEaWZmM1BsYW47XHJcbiAgICBibG9ja2Vyczogc3RyaW5nW107XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBSb3VuZHRyaXBTZXJ2aWNlIHtcclxuICAgIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgZGVwZW5kZW5jaWVzOiB7XHJcbiAgICAgICAgY2xpZW50OiBSb3VuZHRyaXBGaWdtYUNsaWVudDtcclxuICAgICAgICBwcm9qZWN0Um9vdDogc3RyaW5nO1xyXG4gICAgICAgIGNyZWF0b3JWZXJzaW9uOiBzdHJpbmc7XHJcbiAgICAgICAgYXNzZXREYj86IENvY29zQXNzZXREYjtcclxuICAgICAgICByZWltcG9ydGVyPzogUm91bmR0cmlwUmVpbXBvcnRlcjtcclxuICAgICAgICB0YXJnZXRTYWZldHk/OiBSb3VuZHRyaXBUYXJnZXRTYWZldHk7XHJcbiAgICB9KSB7fVxyXG5cclxuICAgIGFzeW5jIGRldGVjdChzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpOiBQcm9taXNlPFJvdW5kdHJpcERldGVjdFJlc3VsdD4ge1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IHBhcnNlUm91bmR0cmlwU291cmNlKHNvdXJjZVVybCk7XHJcbiAgICAgICAgY29uc3QgaW5kZXggPSBhd2FpdCBmZXRjaFJvdW5kdHJpcEZpbGUodGhpcy5kZXBlbmRlbmNpZXMuY2xpZW50LCBzb3VyY2UpO1xyXG4gICAgICAgIGNvbnN0IHJvb3RzID0gbWFuYWdlZFJvb3RJZHMoaW5kZXgpLm1hcCgobm9kZUlkKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBpbmRleC5ub2Rlcy5nZXQobm9kZUlkKSE7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBoZWFkZXIgPSBwYXJzZVJvb3RIZWFkZXIoc2hhcmVkVmFsdWUobm9kZSwgUk9PVF9IRUFERVJfS0VZKSEpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgICAgICBub2RlSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogbm9kZS5uYW1lID8/IG5vZGVJZCxcclxuICAgICAgICAgICAgICAgICAgICBzdXJmYWNlSWQ6IGhlYWRlci5zdXJmYWNlSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgcHJlZmFiVXVpZDogaGVhZGVyLnByZWZhYi51dWlkLFxyXG4gICAgICAgICAgICAgICAgICAgIHByb2R1Y2VyOiBgJHtoZWFkZXIucHJvZHVjZXIubmFtZX1AJHtoZWFkZXIucHJvZHVjZXIudmVyc2lvbn1gLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IG5vZGUubmFtZSA/PyBub2RlSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ2ludmFsaWQgbWFuYWdlZCByb290JyxcclxuICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGV4cGxpY2l0Um9vdElkXHJcbiAgICAgICAgICAgID8gc2VsZWN0TWFuYWdlZFJvb3QoaW5kZXgsIHsgZXhwbGljaXRSb290SWQgfSlcclxuICAgICAgICAgICAgOiBzb3VyY2Uubm9kZUlkXHJcbiAgICAgICAgICAgICAgICA/IHNlbGVjdE1hbmFnZWRSb290KGluZGV4LCB7IGRlc2NlbmRhbnROb2RlSWQ6IHNvdXJjZS5ub2RlSWQgfSlcclxuICAgICAgICAgICAgICAgIDogcm9vdHMubGVuZ3RoID09PSAxXHJcbiAgICAgICAgICAgICAgICAgICAgPyBzZWxlY3RNYW5hZ2VkUm9vdChpbmRleClcclxuICAgICAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgICAgICByZXR1cm4geyBmaWxlS2V5OiBzb3VyY2UuZmlsZUtleSwgZmlnbWFWZXJzaW9uOiBpbmRleC52ZXJzaW9uLCBtYW5hZ2VkUm9vdHM6IHJvb3RzLCBzZWxlY3RlZFJvb3RJZDogc2VsZWN0ZWQ/LmlkIH07XHJcbiAgICB9XHJcblxyXG4gICAgYXN5bmMgcHJldmlldyhzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpOiBQcm9taXNlPFJvdW5kdHJpcFByZXZpZXdSZXN1bHQ+IHtcclxuICAgICAgICBjb25zdCBzb3VyY2UgPSBwYXJzZVJvdW5kdHJpcFNvdXJjZShzb3VyY2VVcmwpO1xyXG4gICAgICAgIGNvbnN0IGluZGV4ID0gYXdhaXQgZmV0Y2hSb3VuZHRyaXBGaWxlKHRoaXMuZGVwZW5kZW5jaWVzLmNsaWVudCwgc291cmNlKTtcclxuICAgICAgICBjb25zdCByb290ID0gc2VsZWN0TWFuYWdlZFJvb3QoaW5kZXgsIGV4cGxpY2l0Um9vdElkXHJcbiAgICAgICAgICAgID8geyBleHBsaWNpdFJvb3RJZCB9XHJcbiAgICAgICAgICAgIDogeyBkZXNjZW5kYW50Tm9kZUlkOiBzb3VyY2Uubm9kZUlkIH0pO1xyXG4gICAgICAgIGNvbnN0IG1hbmFnZWQgPSBwYXJzZU1hbmFnZWREb2N1bWVudChpbmRleCwgcm9vdCk7XHJcbiAgICAgICAgY29uc3QgaWRlbnRpdHk6IExlZGdlcklkZW50aXR5ID0ge1xyXG4gICAgICAgICAgICBmaWxlS2V5OiBzb3VyY2UuZmlsZUtleSxcclxuICAgICAgICAgICAgc3VyZmFjZUlkOiBtYW5hZ2VkLmhlYWRlci5zdXJmYWNlSWQsXHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IG1hbmFnZWQuaGVhZGVyLnByZWZhYi51dWlkLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgY29uc3QgbGVkZ2VyID0gYXdhaXQgcmVhZExlZGdlckVudHJ5KHRoaXMuZGVwZW5kZW5jaWVzLnByb2plY3RSb290LCBpZGVudGl0eSk7XHJcbiAgICAgICAgaWYgKGxlZGdlciAmJiBsZWRnZXIuZW50cnkubWFuYWdlZFJvb3ROb2RlSWQgIT09IHJvb3QuaWQpIHRocm93IG5ldyBFcnJvcign5b2T5YmNIG1hbmFnZWQgcm9vdCDkuI7lt7IgUGFpciDnmoQgcm9vdCDkuI3kuIDoh7TjgIInKTtcclxuICAgICAgICBjb25zdCBiYXNlbGluZSA9IGxlZGdlcj8uYmFzZWxpbmUgPz8gbWFuYWdlZC5iYXNlbGluZTtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBhd2FpdCByZWFkQ29jb3NQcmVmYWJCeVV1aWQoe1xyXG4gICAgICAgICAgICBhc3NldERiOiB0aGlzLmRlcGVuZGVuY2llcy5hc3NldERiID8/IGVkaXRvckFzc2V0RGIsXHJcbiAgICAgICAgICAgIHByb2plY3RSb290OiB0aGlzLmRlcGVuZGVuY2llcy5wcm9qZWN0Um9vdCxcclxuICAgICAgICAgICAgcHJlZmFiVXVpZDogaWRlbnRpdHkucHJlZmFiVXVpZCxcclxuICAgICAgICAgICAgYmFzZWxpbmU6IGJhc2VsaW5lLm5vZGVzLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGNvbnN0IHBsYW4gPSBjcmVhdGVEaWZmM1BsYW4oe1xyXG4gICAgICAgICAgICBiYXNlbGluZTogYmFzZWxpbmUubm9kZXMsXHJcbiAgICAgICAgICAgIGZpZ21hOiBtYW5hZ2VkLmZpZ21hUHJvamVjdGlvbixcclxuICAgICAgICAgICAgY29jb3M6IHRhcmdldC5ub2RlcyxcclxuICAgICAgICAgICAgcmVzb3VyY2VCaW5kaW5nczogbWFuYWdlZC5yZXNvdXJjZXMsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29uc3QgcGFpclJlcXVpcmVkID0gbGVkZ2VyID09PSBudWxsO1xyXG4gICAgICAgIGNvbnN0IHBhaXJFbGlnaWJsZSA9IHBhaXJSZXF1aXJlZCAmJiBtYW5hZ2VkLmhlYWRlci5wcmVmYWIuc291cmNlSGFzaCA9PT0gdGFyZ2V0LnNvdXJjZUhhc2ggJiZcclxuICAgICAgICAgICAgbWFuYWdlZC5oZWFkZXIucHJlZmFiLm1ldGFTb3VyY2VIYXNoID09PSB0YXJnZXQubWV0YVNvdXJjZUhhc2ggJiYgcGFpckNvY29zTWF0Y2hlcyhtYW5hZ2VkLmJhc2VsaW5lLCB0YXJnZXQpO1xyXG4gICAgICAgIGNvbnN0IHRhcmdldFNhZmV0eSA9IGF3YWl0ICh0aGlzLmRlcGVuZGVuY2llcy50YXJnZXRTYWZldHkgPz8gZWRpdG9yUm91bmR0cmlwVGFyZ2V0U2FmZXR5KS5jaGVjayhpZGVudGl0eS5wcmVmYWJVdWlkKTtcclxuICAgICAgICBjb25zdCBibG9ja2Vyczogc3RyaW5nW10gPSBbXTtcclxuICAgICAgICBpZiAocGFpclJlcXVpcmVkKSBibG9ja2Vycy5wdXNoKHBhaXJFbGlnaWJsZSA/ICdQQUlSX1JFUVVJUkVEJyA6ICdQQUlSX0VWSURFTkNFX01JU01BVENIJyk7XHJcbiAgICAgICAgaWYgKHBsYW4uY29uZmxpY3RzLmxlbmd0aCA+IDApIGJsb2NrZXJzLnB1c2goJ0RJRkYzX0NPTkZMSUNUJyk7XHJcbiAgICAgICAgaWYgKHBsYW4udW5zdXBwb3J0ZWQubGVuZ3RoID4gMCkgYmxvY2tlcnMucHVzaCgnVU5TVVBQT1JURURfQ0hBTkdFJyk7XHJcbiAgICAgICAgaWYgKHRoaXMuZGVwZW5kZW5jaWVzLmNyZWF0b3JWZXJzaW9uICE9PSAnMy44LjcnKSBibG9ja2Vycy5wdXNoKCdDUkVBVE9SX1ZFUlNJT05fVU5WRVJJRklFRCcpO1xyXG4gICAgICAgIGlmICghdGFyZ2V0U2FmZXR5LnNhZmUpIGJsb2NrZXJzLnB1c2godGFyZ2V0U2FmZXR5LmJsb2NrZXIgPz8gJ1RBUkdFVF9FRElUT1JfU1RBVEVfVU5BVkFJTEFCTEUnKTtcclxuICAgICAgICBjb25zdCB0eG5JZCA9IHJhbmRvbUJ5dGVzKDE2KS50b1N0cmluZygnaGV4Jyk7XHJcbiAgICAgICAgY29uc3QgY29udGV4dDogUHJldmlld0NvbnRleHQgPSB7XHJcbiAgICAgICAgICAgIHR4bklkLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmwsXHJcbiAgICAgICAgICAgIHJvb3ROb2RlSWQ6IHJvb3QuaWQsXHJcbiAgICAgICAgICAgIGZpZ21hVmVyc2lvbjogaW5kZXgudmVyc2lvbixcclxuICAgICAgICAgICAgaWRlbnRpdHksXHJcbiAgICAgICAgICAgIGJhc2VsaW5lLFxyXG4gICAgICAgICAgICB0YXJnZXQsXHJcbiAgICAgICAgICAgIHBsYW4sXHJcbiAgICAgICAgICAgIGxlZGdlckdlbmVyYXRpb246IGxlZGdlcj8uZW50cnkuZ2VuZXJhdGlvbiA/PyAwLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgY29uc3QgcHJldmlld1Rva2VuID0gYmxvY2tlcnMubGVuZ3RoID09PSAwICYmIHBsYW4uYXBwbHkubGVuZ3RoID4gMFxyXG4gICAgICAgICAgICA/IGlzc3VlVG9rZW4ocHJldmlld1Rva2VucywgY29udGV4dClcclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgY29uc3QgcGFpclRva2VuID0gcGFpckVsaWdpYmxlICYmIHRoaXMuZGVwZW5kZW5jaWVzLmNyZWF0b3JWZXJzaW9uID09PSAnMy44LjcnICYmIHRhcmdldFNhZmV0eS5zYWZlXHJcbiAgICAgICAgICAgID8gaXNzdWVUb2tlbihwYWlyVG9rZW5zLCB7XHJcbiAgICAgICAgICAgICAgICBzb3VyY2VVcmwsXHJcbiAgICAgICAgICAgICAgICByb290Tm9kZUlkOiByb290LmlkLFxyXG4gICAgICAgICAgICAgICAgZmlnbWFWZXJzaW9uOiBpbmRleC52ZXJzaW9uLFxyXG4gICAgICAgICAgICAgICAgaWRlbnRpdHksXHJcbiAgICAgICAgICAgICAgICBiYXNlbGluZTogbWFuYWdlZC5iYXNlbGluZSxcclxuICAgICAgICAgICAgICAgIHRhcmdldCxcclxuICAgICAgICAgICAgfSlcclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgdHhuSWQsXHJcbiAgICAgICAgICAgIHByZXZpZXdUb2tlbixcclxuICAgICAgICAgICAgcGFpclRva2VuLFxyXG4gICAgICAgICAgICBwYWlyUmVxdWlyZWQsXHJcbiAgICAgICAgICAgIHBhaXJFbGlnaWJsZSxcclxuICAgICAgICAgICAgZmlnbWFWZXJzaW9uOiBpbmRleC52ZXJzaW9uLFxyXG4gICAgICAgICAgICBmaWxlS2V5OiBzb3VyY2UuZmlsZUtleSxcclxuICAgICAgICAgICAgbWFuYWdlZFJvb3ROb2RlSWQ6IHJvb3QuaWQsXHJcbiAgICAgICAgICAgIHN1cmZhY2VJZDogaWRlbnRpdHkuc3VyZmFjZUlkLFxyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiBpZGVudGl0eS5wcmVmYWJVdWlkLFxyXG4gICAgICAgICAgICBhc3NldFVybDogdGFyZ2V0LmFzc2V0VXJsLFxyXG4gICAgICAgICAgICBwcmVmYWJQcmVpbWFnZUhhc2g6IHRhcmdldC5zb3VyY2VIYXNoLFxyXG4gICAgICAgICAgICBtZXRhUHJlaW1hZ2VIYXNoOiB0YXJnZXQubWV0YVNvdXJjZUhhc2gsXHJcbiAgICAgICAgICAgIGJhc2VsaW5lSGFzaDogbWFuYWdlZC5oZWFkZXIuYmFzZWxpbmUuc2hhMjU2LFxyXG4gICAgICAgICAgICBsZWRnZXJHZW5lcmF0aW9uOiBsZWRnZXI/LmVudHJ5LmdlbmVyYXRpb24gPz8gMCxcclxuICAgICAgICAgICAgcGxhbixcclxuICAgICAgICAgICAgYmxvY2tlcnMsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuXHJcbiAgICBhc3luYyBwYWlyKHRva2VuOiBzdHJpbmcpOiBQcm9taXNlPHsgZ2VuZXJhdGlvbjogbnVtYmVyOyBiYXNlbGluZUhhc2g6IHN0cmluZyB9PiB7XHJcbiAgICAgICAgY29uc3QgY29udGV4dCA9IGNvbnN1bWVUb2tlbihwYWlyVG9rZW5zLCB0b2tlbiwgJ1BhaXIgdG9rZW4nKTtcclxuICAgICAgICBpZiAodGhpcy5kZXBlbmRlbmNpZXMuY3JlYXRvclZlcnNpb24gIT09ICczLjguNycpIHRocm93IG5ldyBFcnJvcignUm91bmQtdHJpcCBQYWlyIOS7heWFgeiuuCBDb2NvcyBDcmVhdG9yIDMuOC4344CCJyk7XHJcbiAgICAgICAgY29uc3QgbG9ja1BhdGggPSByb3VuZHRyaXBTdGF0ZVBhdGgoXHJcbiAgICAgICAgICAgIHRoaXMuZGVwZW5kZW5jaWVzLnByb2plY3RSb290LFxyXG4gICAgICAgICAgICAnbG9ja3MnLFxyXG4gICAgICAgICAgICBgJHtsZWRnZXJJZGVudGl0eUtleShjb250ZXh0LmlkZW50aXR5KX0ucGFpci5sb2NrYCxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGxvY2sgPSBhd2FpdCBhY3F1aXJlRXhjbHVzaXZlRmlsZUxvY2tXaXRoaW4oXHJcbiAgICAgICAgICAgIHRoaXMuZGVwZW5kZW5jaWVzLnByb2plY3RSb290LFxyXG4gICAgICAgICAgICBsb2NrUGF0aCxcclxuICAgICAgICAgICAgQnVmZmVyLmZyb20oY2Fub25pY2FsU3RyaW5naWZ5KHsgcHVycG9zZTogJ3BhaXInLCBwaWQ6IHByb2Nlc3MucGlkIH0pLCAndXRmOCcpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgaWYgKGF3YWl0IHJlYWRMZWRnZXJFbnRyeSh0aGlzLmRlcGVuZGVuY2llcy5wcm9qZWN0Um9vdCwgY29udGV4dC5pZGVudGl0eSkpIHRocm93IG5ldyBFcnJvcignUGFpciDlt7LnlLHlhbbku5bmk43kvZzlrozmiJDjgIInKTtcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlID0gcGFyc2VSb3VuZHRyaXBTb3VyY2UoY29udGV4dC5zb3VyY2VVcmwpO1xyXG4gICAgICAgICAgICBjb25zdCBpbmRleCA9IGF3YWl0IGZldGNoUm91bmR0cmlwRmlsZSh0aGlzLmRlcGVuZGVuY2llcy5jbGllbnQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIGlmIChpbmRleC52ZXJzaW9uICE9PSBjb250ZXh0LmZpZ21hVmVyc2lvbikgdGhyb3cgbmV3IEVycm9yKCdGaWdtYSB2ZXJzaW9uIOW3suWPmOWMlu+8jOivt+mHjeaWsOajgOa1i+OAgicpO1xyXG4gICAgICAgICAgICBjb25zdCByb290ID0gc2VsZWN0TWFuYWdlZFJvb3QoaW5kZXgsIHsgZXhwbGljaXRSb290SWQ6IGNvbnRleHQucm9vdE5vZGVJZCB9KTtcclxuICAgICAgICAgICAgY29uc3QgbWFuYWdlZCA9IHBhcnNlTWFuYWdlZERvY3VtZW50KGluZGV4LCByb290KTtcclxuICAgICAgICAgICAgY29uc3QgdGFyZ2V0ID0gYXdhaXQgcmVhZENvY29zUHJlZmFiQnlVdWlkKHtcclxuICAgICAgICAgICAgICAgIGFzc2V0RGI6IHRoaXMuZGVwZW5kZW5jaWVzLmFzc2V0RGIgPz8gZWRpdG9yQXNzZXREYixcclxuICAgICAgICAgICAgICAgIHByb2plY3RSb290OiB0aGlzLmRlcGVuZGVuY2llcy5wcm9qZWN0Um9vdCxcclxuICAgICAgICAgICAgICAgIHByZWZhYlV1aWQ6IGNvbnRleHQuaWRlbnRpdHkucHJlZmFiVXVpZCxcclxuICAgICAgICAgICAgICAgIGJhc2VsaW5lOiBjb250ZXh0LmJhc2VsaW5lLm5vZGVzLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3QgdGFyZ2V0U2FmZXR5ID0gYXdhaXQgKHRoaXMuZGVwZW5kZW5jaWVzLnRhcmdldFNhZmV0eSA/PyBlZGl0b3JSb3VuZHRyaXBUYXJnZXRTYWZldHkpLmNoZWNrKGNvbnRleHQuaWRlbnRpdHkucHJlZmFiVXVpZCk7XHJcbiAgICAgICAgICAgIGlmICghdGFyZ2V0U2FmZXR5LnNhZmUpIHRocm93IG5ldyBFcnJvcih0YXJnZXRTYWZldHkuYmxvY2tlciA/PyAnVEFSR0VUX0VESVRPUl9TVEFURV9VTkFWQUlMQUJMRScpO1xyXG4gICAgICAgICAgICBpZiAodGFyZ2V0LnNvdXJjZUhhc2ggIT09IG1hbmFnZWQuaGVhZGVyLnByZWZhYi5zb3VyY2VIYXNoIHx8XHJcbiAgICAgICAgICAgICAgICB0YXJnZXQubWV0YVNvdXJjZUhhc2ggIT09IG1hbmFnZWQuaGVhZGVyLnByZWZhYi5tZXRhU291cmNlSGFzaCB8fFxyXG4gICAgICAgICAgICAgICAgIXBhaXJDb2Nvc01hdGNoZXMoY29udGV4dC5iYXNlbGluZSwgdGFyZ2V0KSkgdGhyb3cgbmV3IEVycm9yKCdQYWlyIOivgeaNruW3suWPmOWMluOAgicpO1xyXG4gICAgICAgICAgICBjb25zdCBlbnRyeSA9IGF3YWl0IGNyZWF0ZUdlbmVzaXNMZWRnZXIoe1xyXG4gICAgICAgICAgICAgICAgcHJvamVjdFJvb3Q6IHRoaXMuZGVwZW5kZW5jaWVzLnByb2plY3RSb290LFxyXG4gICAgICAgICAgICAgICAgaWRlbnRpdHk6IGNvbnRleHQuaWRlbnRpdHksXHJcbiAgICAgICAgICAgICAgICBtYW5hZ2VkUm9vdE5vZGVJZDogY29udGV4dC5yb290Tm9kZUlkLFxyXG4gICAgICAgICAgICAgICAgYmFzZWxpbmU6IGNvbnRleHQuYmFzZWxpbmUsXHJcbiAgICAgICAgICAgICAgICBmaWdtYVZlcnNpb246IGNvbnRleHQuZmlnbWFWZXJzaW9uLFxyXG4gICAgICAgICAgICAgICAgY29jb3NQb3N0aW1hZ2VIYXNoOiB0YXJnZXQuc291cmNlSGFzaCxcclxuICAgICAgICAgICAgICAgIHR4bklkOiBgcGFpci0ke3JhbmRvbUJ5dGVzKDEyKS50b1N0cmluZygnaGV4Jyl9YCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiB7IGdlbmVyYXRpb246IGVudHJ5LmdlbmVyYXRpb24sIGJhc2VsaW5lSGFzaDogZW50cnkuYmFzZWxpbmVIYXNoIH07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgYXdhaXQgbG9jay5yZWxlYXNlKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGFzeW5jIGFwcGx5KHRva2VuOiBzdHJpbmcpOiBQcm9taXNlPFRyYW5zYWN0aW9uUmVjZWlwdD4ge1xyXG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IGNsYWltUHJldmlld1Rva2VuKHRva2VuKTtcclxuICAgICAgICBpZiAoc3RvcmVkLnN0YXRlID09PSAnY29uc3VtZWQnKSByZXR1cm4gc3RvcmVkLnJlc3VsdCBhcyBUcmFuc2FjdGlvblJlY2VpcHQ7XHJcbiAgICAgICAgc3RvcmVkLnN0YXRlID0gJ2FwcGx5aW5nJztcclxuICAgICAgICBjb25zdCBjb250ZXh0ID0gc3RvcmVkLnZhbHVlO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gcGFyc2VSb3VuZHRyaXBTb3VyY2UoY29udGV4dC5zb3VyY2VVcmwpO1xyXG4gICAgICAgIGNvbnN0IGluZGV4ID0gYXdhaXQgZmV0Y2hSb3VuZHRyaXBGaWxlKHRoaXMuZGVwZW5kZW5jaWVzLmNsaWVudCwgc291cmNlKTtcclxuICAgICAgICBpZiAoaW5kZXgudmVyc2lvbiAhPT0gY29udGV4dC5maWdtYVZlcnNpb24pIHRocm93IG5ldyBFcnJvcignRmlnbWEgdmVyc2lvbiDlt7Llj5jljJbvvIzor7fph43mlrDpooTop4jjgIInKTtcclxuICAgICAgICBjb25zdCByb290ID0gc2VsZWN0TWFuYWdlZFJvb3QoaW5kZXgsIHsgZXhwbGljaXRSb290SWQ6IGNvbnRleHQucm9vdE5vZGVJZCB9KTtcclxuICAgICAgICBjb25zdCBtYW5hZ2VkID0gcGFyc2VNYW5hZ2VkRG9jdW1lbnQoaW5kZXgsIHJvb3QpO1xyXG4gICAgICAgIGNvbnN0IGxlZGdlciA9IGF3YWl0IHJlYWRMZWRnZXJFbnRyeSh0aGlzLmRlcGVuZGVuY2llcy5wcm9qZWN0Um9vdCwgY29udGV4dC5pZGVudGl0eSk7XHJcbiAgICAgICAgaWYgKCFsZWRnZXIgfHwgbGVkZ2VyLmVudHJ5LmdlbmVyYXRpb24gIT09IGNvbnRleHQubGVkZ2VyR2VuZXJhdGlvbiB8fFxyXG4gICAgICAgICAgICBsZWRnZXIuZW50cnkubWFuYWdlZFJvb3ROb2RlSWQgIT09IGNvbnRleHQucm9vdE5vZGVJZCkgdGhyb3cgbmV3IEVycm9yKCdMZWRnZXIg5bey5Y+Y5YyW77yM6K+36YeN5paw6aKE6KeI44CCJyk7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gYXdhaXQgcmVhZENvY29zUHJlZmFiQnlVdWlkKHtcclxuICAgICAgICAgICAgYXNzZXREYjogdGhpcy5kZXBlbmRlbmNpZXMuYXNzZXREYiA/PyBlZGl0b3JBc3NldERiLFxyXG4gICAgICAgICAgICBwcm9qZWN0Um9vdDogdGhpcy5kZXBlbmRlbmNpZXMucHJvamVjdFJvb3QsXHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IGNvbnRleHQuaWRlbnRpdHkucHJlZmFiVXVpZCxcclxuICAgICAgICAgICAgYmFzZWxpbmU6IGxlZGdlci5iYXNlbGluZS5ub2RlcyxcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25zdCB0YXJnZXRTYWZldHkgPSBhd2FpdCAodGhpcy5kZXBlbmRlbmNpZXMudGFyZ2V0U2FmZXR5ID8/IGVkaXRvclJvdW5kdHJpcFRhcmdldFNhZmV0eSkuY2hlY2soY29udGV4dC5pZGVudGl0eS5wcmVmYWJVdWlkKTtcclxuICAgICAgICBpZiAoIXRhcmdldFNhZmV0eS5zYWZlKSB0aHJvdyBuZXcgRXJyb3IodGFyZ2V0U2FmZXR5LmJsb2NrZXIgPz8gJ1RBUkdFVF9FRElUT1JfU1RBVEVfVU5BVkFJTEFCTEUnKTtcclxuICAgICAgICBjb25zdCBmcmVzaFBsYW4gPSBjcmVhdGVEaWZmM1BsYW4oe1xyXG4gICAgICAgICAgICBiYXNlbGluZTogbGVkZ2VyLmJhc2VsaW5lLm5vZGVzLFxyXG4gICAgICAgICAgICBmaWdtYTogbWFuYWdlZC5maWdtYVByb2plY3Rpb24sXHJcbiAgICAgICAgICAgIGNvY29zOiB0YXJnZXQubm9kZXMsXHJcbiAgICAgICAgICAgIHJlc291cmNlQmluZGluZ3M6IG1hbmFnZWQucmVzb3VyY2VzLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChjYW5vbmljYWxTdHJpbmdpZnkoZnJlc2hQbGFuKSAhPT0gY2Fub25pY2FsU3RyaW5naWZ5KGNvbnRleHQucGxhbikpIHRocm93IG5ldyBFcnJvcignUGF0Y2hQbGFuIOW3suWPmOWMlu+8jOivt+mHjeaWsOmihOiniOOAgicpO1xyXG4gICAgICAgIGNvbnN0IHJlY2VpcHQgPSBhd2FpdCBhcHBseVJvdW5kdHJpcFRyYW5zYWN0aW9uKHtcclxuICAgICAgICAgICAgcHJvamVjdFJvb3Q6IHRoaXMuZGVwZW5kZW5jaWVzLnByb2plY3RSb290LFxyXG4gICAgICAgICAgICBjcmVhdG9yVmVyc2lvbjogdGhpcy5kZXBlbmRlbmNpZXMuY3JlYXRvclZlcnNpb24sXHJcbiAgICAgICAgICAgIGFzc2V0RGI6IHRoaXMuZGVwZW5kZW5jaWVzLmFzc2V0RGIgPz8gZWRpdG9yQXNzZXREYixcclxuICAgICAgICAgICAgcmVpbXBvcnRlcjogdGhpcy5kZXBlbmRlbmNpZXMucmVpbXBvcnRlciA/PyBlZGl0b3JSZWltcG9ydGVyLFxyXG4gICAgICAgICAgICBpZGVudGl0eTogY29udGV4dC5pZGVudGl0eSxcclxuICAgICAgICAgICAgbWFuYWdlZFJvb3ROb2RlSWQ6IGNvbnRleHQucm9vdE5vZGVJZCxcclxuICAgICAgICAgICAgZmlnbWFWZXJzaW9uOiBjb250ZXh0LmZpZ21hVmVyc2lvbixcclxuICAgICAgICAgICAgZXhwZWN0ZWRMZWRnZXJHZW5lcmF0aW9uOiBjb250ZXh0LmxlZGdlckdlbmVyYXRpb24sXHJcbiAgICAgICAgICAgIHRhcmdldCxcclxuICAgICAgICAgICAgYmFzZWxpbmU6IGxlZGdlci5iYXNlbGluZSxcclxuICAgICAgICAgICAgcGxhbjogZnJlc2hQbGFuLFxyXG4gICAgICAgICAgICB0eG5JZDogY29udGV4dC50eG5JZCxcclxuICAgICAgICAgICAgYXNzZXJ0VGFyZ2V0U2FmZTogYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgc2FmZXR5ID0gYXdhaXQgKHRoaXMuZGVwZW5kZW5jaWVzLnRhcmdldFNhZmV0eSA/PyBlZGl0b3JSb3VuZHRyaXBUYXJnZXRTYWZldHkpLmNoZWNrKGNvbnRleHQuaWRlbnRpdHkucHJlZmFiVXVpZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXNhZmV0eS5zYWZlKSB0aHJvdyBuZXcgRXJyb3Ioc2FmZXR5LmJsb2NrZXIgPz8gJ1RBUkdFVF9FRElUT1JfU1RBVEVfVU5BVkFJTEFCTEUnKTtcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBzdG9yZWQuc3RhdGUgPSAnY29uc3VtZWQnO1xyXG4gICAgICAgIHN0b3JlZC5yZXN1bHQgPSByZWNlaXB0O1xyXG4gICAgICAgIHN0b3JlZC5leHBpcmVzQXQgPSBEYXRlLm5vdygpICsgVE9LRU5fVFRMX01TO1xyXG4gICAgICAgIHJldHVybiByZWNlaXB0O1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHN0b3JlZC5zdGF0ZSA9ICdjb25zdW1lZCc7XHJcbiAgICAgICAgICAgIHN0b3JlZC5lcnJvciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ1JvdW5kLXRyaXAg5bqU55So5aSx6LSl44CCJztcclxuICAgICAgICAgICAgc3RvcmVkLmV4cGlyZXNBdCA9IERhdGUubm93KCkgKyBUT0tFTl9UVExfTVM7XHJcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG4iXX0=