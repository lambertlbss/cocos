"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PREFAB_SYNC_KIND = exports.PREFAB_SYNC_SCHEMA = void 0;
exports.figmaFrameSourceHash = figmaFrameSourceHash;
exports.figmaNodeIdentityKey = figmaNodeIdentityKey;
exports.collectSceneSpecFigmaIds = collectSceneSpecFigmaIds;
exports.resolveExistingNodeFileIds = resolveExistingNodeFileIds;
exports.createPrefabSyncRecord = createPrefabSyncRecord;
exports.recordPrefabSyncCapture = recordPrefabSyncCapture;
exports.readPrefabSyncRecord = readPrefabSyncRecord;
exports.mergePrefabSyncRecord = mergePrefabSyncRecord;
exports.planPrefabRecoveryTarget = planPrefabRecoveryTarget;
exports.prefabJsonContainsSyncRecord = prefabJsonContainsSyncRecord;
exports.createMinimalPrefabJson = createMinimalPrefabJson;
const crypto_1 = require("crypto");
const uuid_1 = require("../roundtrip/uuid");
exports.PREFAB_SYNC_SCHEMA = 1;
exports.PREFAB_SYNC_KIND = 'frame-prefab';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9+/_=-]{8,128}$/;
function sha256(value) {
    return `sha256:${(0, crypto_1.createHash)('sha256').update(value, 'utf8').digest('hex')}`;
}
function cleanNodeId(value) {
    return value.trim().replace(/-/g, ':');
}
function cleanFileId(value, label) {
    if (typeof value !== 'string' || !FILE_ID_PATTERN.test(value)) {
        throw new Error(`${label} 不是有效的 Cocos fileId。`);
    }
    return value;
}
function sortedUniqueFileIds(value, label) {
    if (!Array.isArray(value)) {
        throw new Error(`${label} 必须是 fileId 数组。`);
    }
    return [...new Set(value.map((item, index) => cleanFileId(item, `${label}[${index}]`)))].sort();
}
function sortedNodeMap(entries) {
    return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}
function cleanPrefabInstances(value, managedNodes) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Prefab 实例所有权记录无效。');
    const entries = [];
    const instanceIds = new Set();
    for (const [carrier, raw] of Object.entries(value)) {
        cleanFileId(carrier, 'Prefab carrier fileId');
        if (!managedNodes.includes(carrier) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('Prefab 实例不属于受管节点。');
        }
        const item = raw;
        if (typeof item.assetUuid !== 'string' || !/^[A-Za-z0-9+/_=@.-]{1,256}$/.test(item.assetUuid)) {
            throw new Error('Prefab 实例资源 UUID 无效。');
        }
        const instanceFileId = cleanFileId(item.instanceFileId, 'Prefab instance fileId');
        if (instanceIds.has(instanceFileId))
            throw new Error('Prefab 实例 fileId 重复。');
        instanceIds.add(instanceFileId);
        entries.push([carrier, { assetUuid: (0, uuid_1.normalizeCocosUuid)(item.assetUuid), instanceFileId }]);
    }
    return entries.length ? Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) : undefined;
}
function figmaFrameSourceHash(fileKey, sourceNodeId) {
    const normalizedFileKey = fileKey.trim();
    const normalizedNodeId = cleanNodeId(sourceNodeId);
    if (!normalizedFileKey || !normalizedNodeId) {
        throw new Error('Figma Frame 来源缺少 fileKey 或 nodeId。');
    }
    return sha256(`figma-importer:frame:v1\0${normalizedFileKey}\0${normalizedNodeId}`);
}
function figmaNodeIdentityKey(sourceHash, nodeId) {
    if (!SHA256_PATTERN.test(sourceHash)) {
        throw new Error('Prefab 来源指纹格式无效。');
    }
    const normalizedNodeId = cleanNodeId(nodeId);
    if (!normalizedNodeId || normalizedNodeId === '__root__') {
        throw new Error('Figma 节点 ID 无效。');
    }
    return sha256(`figma-importer:node:v1\0${sourceHash}\0${normalizedNodeId}`);
}
function collectSceneSpecFigmaIds(specs) {
    const ids = [];
    const visit = (nodes) => {
        var _a;
        for (const node of nodes) {
            for (const id of [node.figmaId, ...((_a = node.aliasFigmaIds) !== null && _a !== void 0 ? _a : [])]) {
                if (typeof id === 'string' && id.length > 0 && id !== '__root__') {
                    ids.push(cleanNodeId(id));
                }
            }
            if (!node.prefab)
                visit(node.children);
        }
    };
    visit(specs);
    return [...new Set(ids)];
}
function resolveExistingNodeFileIds(record, figmaNodeIds) {
    const resolved = [];
    for (const rawId of figmaNodeIds) {
        const nodeId = cleanNodeId(rawId);
        const fileId = record.nodeFileIds[figmaNodeIdentityKey(record.sourceHash, nodeId)];
        if (fileId) {
            resolved.push([nodeId, fileId]);
        }
    }
    return Object.fromEntries(resolved);
}
function createPrefabSyncRecord(sourceHash, rootFigmaNodeId, rootFileId, rootTransformFileId) {
    if (!SHA256_PATTERN.test(sourceHash)) {
        throw new Error('Prefab 来源指纹格式无效。');
    }
    const safeRootFileId = cleanFileId(rootFileId, 'rootFileId');
    const safeTransformFileId = cleanFileId(rootTransformFileId, 'rootTransformFileId');
    return {
        schema: exports.PREFAB_SYNC_SCHEMA,
        kind: exports.PREFAB_SYNC_KIND,
        sourceHash,
        rootFileId: safeRootFileId,
        nodeFileIds: {
            [figmaNodeIdentityKey(sourceHash, rootFigmaNodeId)]: safeRootFileId,
        },
        managedNodeFileIds: [safeRootFileId],
        managedComponentFileIds: [safeTransformFileId],
        managedHelperFileIds: [],
    };
}
function recordPrefabSyncCapture(previous, capture) {
    const entries = [];
    for (const [nodeId, rawFileId] of Object.entries(capture.nodeFileIds)) {
        const fileId = cleanFileId(rawFileId, `nodeFileIds.${nodeId}`);
        entries.push([figmaNodeIdentityKey(previous.sourceHash, nodeId), fileId]);
    }
    const nodeFileIds = sortedNodeMap(entries);
    if (!Object.values(nodeFileIds).includes(previous.rootFileId)) {
        throw new Error('Prefab 同步结果缺少原根节点 fileId，已拒绝提交来源记录。');
    }
    const managedNodeFileIds = sortedUniqueFileIds(capture.managedNodeFileIds, 'managedNodeFileIds');
    const prefabInstances = cleanPrefabInstances(capture.prefabInstances, managedNodeFileIds);
    return {
        schema: exports.PREFAB_SYNC_SCHEMA,
        kind: exports.PREFAB_SYNC_KIND,
        sourceHash: previous.sourceHash,
        rootFileId: previous.rootFileId,
        nodeFileIds,
        managedNodeFileIds,
        managedComponentFileIds: sortedUniqueFileIds(capture.managedComponentFileIds, 'managedComponentFileIds'),
        managedHelperFileIds: sortedUniqueFileIds(capture.managedHelperFileIds, 'managedHelperFileIds'),
        ...(prefabInstances ? { prefabInstances } : {}),
    };
}
function readPrefabSyncRecord(meta) {
    if (!meta || typeof meta !== 'object') {
        return null;
    }
    const userData = meta.userData;
    if (!userData || typeof userData !== 'object') {
        return null;
    }
    const raw = userData.figmaImporter;
    if (raw === undefined) {
        return null;
    }
    if (!raw || typeof raw !== 'object') {
        throw new Error('Prefab 的 figmaImporter 来源记录已损坏。');
    }
    const value = raw;
    if (value.schema !== exports.PREFAB_SYNC_SCHEMA || value.kind !== exports.PREFAB_SYNC_KIND) {
        throw new Error('Prefab 的 figmaImporter 来源记录版本或类型不受支持。');
    }
    if (typeof value.sourceHash !== 'string' || !SHA256_PATTERN.test(value.sourceHash)) {
        throw new Error('Prefab 的 Figma 来源指纹无效。');
    }
    const rawNodeFileIds = value.nodeFileIds;
    if (!rawNodeFileIds || typeof rawNodeFileIds !== 'object' || Array.isArray(rawNodeFileIds)) {
        throw new Error('Prefab 的节点 fileId 映射无效。');
    }
    const nodeEntries = [];
    for (const [key, fileId] of Object.entries(rawNodeFileIds)) {
        if (!SHA256_PATTERN.test(key)) {
            throw new Error('Prefab 的节点来源键无效。');
        }
        nodeEntries.push([key, cleanFileId(fileId, `nodeFileIds.${key}`)]);
    }
    const rootFileId = cleanFileId(value.rootFileId, 'rootFileId');
    const managedNodeFileIds = sortedUniqueFileIds(value.managedNodeFileIds, 'managedNodeFileIds');
    if (!managedNodeFileIds.includes(rootFileId)) {
        throw new Error('Prefab 来源记录未声明根节点所有权。');
    }
    const prefabInstances = cleanPrefabInstances(value.prefabInstances, managedNodeFileIds);
    return {
        schema: exports.PREFAB_SYNC_SCHEMA,
        kind: exports.PREFAB_SYNC_KIND,
        sourceHash: value.sourceHash,
        rootFileId,
        nodeFileIds: sortedNodeMap(nodeEntries),
        managedNodeFileIds,
        managedComponentFileIds: sortedUniqueFileIds(value.managedComponentFileIds, 'managedComponentFileIds'),
        managedHelperFileIds: sortedUniqueFileIds(value.managedHelperFileIds, 'managedHelperFileIds'),
        ...(prefabInstances ? { prefabInstances } : {}),
    };
}
function mergePrefabSyncRecord(meta, record) {
    const source = meta && typeof meta === 'object'
        ? meta
        : {};
    const userData = source.userData && typeof source.userData === 'object'
        ? source.userData
        : {};
    return {
        ...source,
        userData: {
            ...userData,
            figmaImporter: record,
        },
    };
}
function planPrefabRecoveryTarget(pendingPrefabUuid, boundPrefabUuid, pendingAssetExists) {
    if (!pendingPrefabUuid) {
        return {
            targetUuid: boundPrefabUuid,
            clearPending: false,
            clearBinding: false,
        };
    }
    if (pendingAssetExists) {
        return {
            targetUuid: pendingPrefabUuid,
            clearPending: false,
            clearBinding: false,
        };
    }
    const bindingPointsAtMissingPending = boundPrefabUuid === pendingPrefabUuid;
    return {
        targetUuid: bindingPointsAtMissingPending ? undefined : boundPrefabUuid,
        clearPending: true,
        clearBinding: bindingPointsAtMissingPending,
    };
}
function prefabJsonContainsSyncRecord(contents, record) {
    var _a, _b, _c, _d, _e, _f;
    let parsed;
    try {
        parsed = JSON.parse(typeof contents === 'string' ? contents : contents.toString('utf8'));
    }
    catch {
        return false;
    }
    if (!Array.isArray(parsed)) {
        return false;
    }
    const entries = parsed;
    const resolve = (ref) => Number.isInteger(ref === null || ref === void 0 ? void 0 : ref.__id__)
        ? entries[ref.__id__] : undefined;
    const rootIndex = (_b = (_a = entries[0]) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.__id__;
    const foreignInfos = new Set();
    for (const item of entries) {
        if ((item === null || item === void 0 ? void 0 : item.__type__) === 'cc.PrefabInfo' && (typeof ((_c = item.asset) === null || _c === void 0 ? void 0 : _c.__uuid__) === 'string'
            || (Number.isInteger(rootIndex) && Number.isInteger((_d = item.root) === null || _d === void 0 ? void 0 : _d.__id__) && item.root.__id__ !== rootIndex))) {
            foreignInfos.add(item);
        }
    }
    for (const item of entries) {
        if (foreignInfos.has(resolve((_e = resolve(item === null || item === void 0 ? void 0 : item.node)) === null || _e === void 0 ? void 0 : _e._prefab))) {
            const componentInfo = resolve(item.__prefab);
            if (componentInfo)
                foreignInfos.add(componentInfo);
        }
    }
    const nodeFileIds = new Set();
    const componentFileIds = new Set();
    for (const item of parsed) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const value = item;
        if (foreignInfos.has(value))
            continue;
        const fileId = typeof value.fileId === 'string' ? value.fileId : '';
        if (!fileId) {
            continue;
        }
        const target = value.__type__ === 'cc.PrefabInfo'
            ? nodeFileIds
            : value.__type__ === 'cc.CompPrefabInfo'
                ? componentFileIds
                : null;
        if (!target) {
            continue;
        }
        if (target.has(fileId)) {
            return false;
        }
        target.add(fileId);
    }
    const expectedNodes = new Set([
        record.rootFileId,
        ...Object.values(record.nodeFileIds),
        ...record.managedNodeFileIds,
        ...record.managedHelperFileIds,
    ]);
    if (![...expectedNodes].every((fileId) => nodeFileIds.has(fileId))
        || !record.managedComponentFileIds.every((fileId) => componentFileIds.has(fileId)))
        return false;
    for (const [carrierId, attachment] of Object.entries((_f = record.prefabInstances) !== null && _f !== void 0 ? _f : {})) {
        const carriers = entries.filter((node) => {
            var _a;
            return (node === null || node === void 0 ? void 0 : node.__type__) === 'cc.Node'
                && !foreignInfos.has(resolve(node._prefab)) && ((_a = resolve(node._prefab)) === null || _a === void 0 ? void 0 : _a.fileId) === carrierId;
        });
        if (carriers.length !== 1 || !Array.isArray(carriers[0]._children))
            return false;
        const matches = carriers[0]._children.filter((ref) => {
            var _a, _b;
            const child = resolve(ref);
            const info = resolve(child === null || child === void 0 ? void 0 : child._prefab);
            const instance = resolve(info === null || info === void 0 ? void 0 : info.instance);
            return info && child && resolve(info.root) === child
                && (0, uuid_1.normalizeCocosUuid)(String((_b = (_a = info.asset) === null || _a === void 0 ? void 0 : _a.__uuid__) !== null && _b !== void 0 ? _b : '')) === (0, uuid_1.normalizeCocosUuid)(attachment.assetUuid)
                && (instance === null || instance === void 0 ? void 0 : instance.__type__) === 'cc.PrefabInstance' && instance.fileId === attachment.instanceFileId;
        });
        if (matches.length !== 1)
            return false;
    }
    return true;
}
function cleanPrefabName(value) {
    return value.replace(/[\u0000-\u001f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 96)
        || 'FigmaPrefab';
}
function createMinimalPrefabJson(name, frame, rootFileId, rootTransformFileId) {
    const safeRootFileId = cleanFileId(rootFileId, 'rootFileId');
    const safeTransformFileId = cleanFileId(rootTransformFileId, 'rootTransformFileId');
    const width = Number.isFinite(frame.width) ? Math.max(0, frame.width) : 0;
    const height = Number.isFinite(frame.height) ? Math.max(0, frame.height) : 0;
    const safeName = cleanPrefabName(name);
    return JSON.stringify([
        {
            __type__: 'cc.Prefab',
            _name: safeName,
            _objFlags: 0,
            __editorExtras__: {},
            _native: '',
            data: { __id__: 1 },
            optimizationPolicy: 0,
            persistent: false,
        },
        {
            __type__: 'cc.Node',
            _name: safeName,
            _objFlags: 0,
            __editorExtras__: {},
            _parent: null,
            _children: [],
            _active: true,
            _components: [{ __id__: 2 }],
            _prefab: { __id__: 4 },
            _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
            _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
            _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 },
            _mobility: 0,
            _layer: 1073741824,
            _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
            _id: '',
        },
        {
            __type__: 'cc.UITransform',
            _name: '',
            _objFlags: 0,
            __editorExtras__: {},
            node: { __id__: 1 },
            _enabled: true,
            __prefab: { __id__: 3 },
            _contentSize: { __type__: 'cc.Size', width, height },
            _anchorPoint: { __type__: 'cc.Vec2', x: 0.5, y: 0.5 },
            _id: '',
        },
        {
            __type__: 'cc.CompPrefabInfo',
            fileId: safeTransformFileId,
        },
        {
            __type__: 'cc.PrefabInfo',
            root: { __id__: 1 },
            asset: { __id__: 0 },
            fileId: safeRootFileId,
            instance: null,
            targetOverrides: null,
        },
    ], null, 2);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJlZmFiLXN5bmMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvaW1wb3J0ZXIvcHJlZmFiLXN5bmMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBdUZBLG9EQU9DO0FBRUQsb0RBU0M7QUFFRCw0REFjQztBQUVELGdFQWFDO0FBRUQsd0RBdUJDO0FBRUQsMERBNkJDO0FBRUQsb0RBcURDO0FBRUQsc0RBY0M7QUFFRCw0REF5QkM7QUFFRCxvRUE4RUM7QUFPRCwwREFpRUM7QUExYkQsbUNBQW9DO0FBR3BDLDRDQUF1RDtBQUUxQyxRQUFBLGtCQUFrQixHQUFHLENBQVUsQ0FBQztBQUNoQyxRQUFBLGdCQUFnQixHQUFHLGNBQXVCLENBQUM7QUE4QnhELE1BQU0sY0FBYyxHQUFHLHVCQUF1QixDQUFDO0FBQy9DLE1BQU0sZUFBZSxHQUFHLDJCQUEyQixDQUFDO0FBRXBELFNBQVMsTUFBTSxDQUFDLEtBQWE7SUFDekIsT0FBTyxVQUFVLElBQUEsbUJBQVUsRUFBQyxRQUFRLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO0FBQ2hGLENBQUM7QUFFRCxTQUFTLFdBQVcsQ0FBQyxLQUFhO0lBQzlCLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDM0MsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLEtBQWMsRUFBRSxLQUFhO0lBQzlDLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzVELE1BQU0sSUFBSSxLQUFLLENBQUMsR0FBRyxLQUFLLHNCQUFzQixDQUFDLENBQUM7SUFDcEQsQ0FBQztJQUNELE9BQU8sS0FBSyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxTQUFTLG1CQUFtQixDQUFDLEtBQWMsRUFBRSxLQUFhO0lBQ3RELElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDeEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxHQUFHLEtBQUssaUJBQWlCLENBQUMsQ0FBQztJQUMvQyxDQUFDO0lBQ0QsT0FBTyxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsR0FBRyxLQUFLLElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUNwRyxDQUFDO0FBRUQsU0FBUyxhQUFhLENBQUMsT0FBbUM7SUFDdEQsT0FBTyxNQUFNLENBQUMsV0FBVyxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ25GLENBQUM7QUFFRCxTQUFTLG9CQUFvQixDQUFDLEtBQWMsRUFBRSxZQUFzQjtJQUNoRSxJQUFJLEtBQUssS0FBSyxTQUFTO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDMUMsSUFBSSxDQUFDLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUM7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLG1CQUFtQixDQUFDLENBQUM7SUFDdEcsTUFBTSxPQUFPLEdBQThDLEVBQUUsQ0FBQztJQUM5RCxNQUFNLFdBQVcsR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBQ3RDLEtBQUssTUFBTSxDQUFDLE9BQU8sRUFBRSxHQUFHLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDakQsV0FBVyxDQUFDLE9BQU8sRUFBRSx1QkFBdUIsQ0FBQyxDQUFDO1FBQzlDLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsR0FBRyxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDM0YsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO1FBQ3pDLENBQUM7UUFDRCxNQUFNLElBQUksR0FBRyxHQUE4QixDQUFDO1FBQzVDLElBQUksT0FBTyxJQUFJLENBQUMsU0FBUyxLQUFLLFFBQVEsSUFBSSxDQUFDLDZCQUE2QixDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztZQUM1RixNQUFNLElBQUksS0FBSyxDQUFDLHNCQUFzQixDQUFDLENBQUM7UUFDNUMsQ0FBQztRQUNELE1BQU0sY0FBYyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUMsY0FBYyxFQUFFLHdCQUF3QixDQUFDLENBQUM7UUFDbEYsSUFBSSxXQUFXLENBQUMsR0FBRyxDQUFDLGNBQWMsQ0FBQztZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsc0JBQXNCLENBQUMsQ0FBQztRQUM3RSxXQUFXLENBQUMsR0FBRyxDQUFDLGNBQWMsQ0FBQyxDQUFDO1FBQ2hDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxTQUFTLEVBQUUsSUFBQSx5QkFBa0IsRUFBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsY0FBYyxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQy9GLENBQUM7SUFDRCxPQUFPLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUMzRyxDQUFDO0FBRUQsU0FBZ0Isb0JBQW9CLENBQUMsT0FBZSxFQUFFLFlBQW9CO0lBQ3RFLE1BQU0saUJBQWlCLEdBQUcsT0FBTyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQ3pDLE1BQU0sZ0JBQWdCLEdBQUcsV0FBVyxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ25ELElBQUksQ0FBQyxpQkFBaUIsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7UUFDMUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQ0FBb0MsQ0FBQyxDQUFDO0lBQzFELENBQUM7SUFDRCxPQUFPLE1BQU0sQ0FBQyw0QkFBNEIsaUJBQWlCLEtBQUssZ0JBQWdCLEVBQUUsQ0FBQyxDQUFDO0FBQ3hGLENBQUM7QUFFRCxTQUFnQixvQkFBb0IsQ0FBQyxVQUFrQixFQUFFLE1BQWM7SUFDbkUsSUFBSSxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztRQUNuQyxNQUFNLElBQUksS0FBSyxDQUFDLGtCQUFrQixDQUFDLENBQUM7SUFDeEMsQ0FBQztJQUNELE1BQU0sZ0JBQWdCLEdBQUcsV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzdDLElBQUksQ0FBQyxnQkFBZ0IsSUFBSSxnQkFBZ0IsS0FBSyxVQUFVLEVBQUUsQ0FBQztRQUN2RCxNQUFNLElBQUksS0FBSyxDQUFDLGlCQUFpQixDQUFDLENBQUM7SUFDdkMsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDLDJCQUEyQixVQUFVLEtBQUssZ0JBQWdCLEVBQUUsQ0FBQyxDQUFDO0FBQ2hGLENBQUM7QUFFRCxTQUFnQix3QkFBd0IsQ0FBQyxLQUFzQjtJQUMzRCxNQUFNLEdBQUcsR0FBYSxFQUFFLENBQUM7SUFDekIsTUFBTSxLQUFLLEdBQUcsQ0FBQyxLQUFzQixFQUFFLEVBQUU7O1FBQ3JDLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7WUFDdkIsS0FBSyxNQUFNLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsR0FBRyxDQUFDLE1BQUEsSUFBSSxDQUFDLGFBQWEsbUNBQUksRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUM3RCxJQUFJLE9BQU8sRUFBRSxLQUFLLFFBQVEsSUFBSSxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsSUFBSSxFQUFFLEtBQUssVUFBVSxFQUFFLENBQUM7b0JBQy9ELEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7Z0JBQzlCLENBQUM7WUFDTCxDQUFDO1lBQ0QsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNO2dCQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDM0MsQ0FBQztJQUNMLENBQUMsQ0FBQztJQUNGLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNiLE9BQU8sQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDN0IsQ0FBQztBQUVELFNBQWdCLDBCQUEwQixDQUN0QyxNQUF3QixFQUN4QixZQUE4QjtJQUU5QixNQUFNLFFBQVEsR0FBNEIsRUFBRSxDQUFDO0lBQzdDLEtBQUssTUFBTSxLQUFLLElBQUksWUFBWSxFQUFFLENBQUM7UUFDL0IsTUFBTSxNQUFNLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2xDLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxXQUFXLENBQUMsb0JBQW9CLENBQUMsTUFBTSxDQUFDLFVBQVUsRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDO1FBQ25GLElBQUksTUFBTSxFQUFFLENBQUM7WUFDVCxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUM7UUFDcEMsQ0FBQztJQUNMLENBQUM7SUFDRCxPQUFPLE1BQU0sQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDeEMsQ0FBQztBQUVELFNBQWdCLHNCQUFzQixDQUNsQyxVQUFrQixFQUNsQixlQUF1QixFQUN2QixVQUFrQixFQUNsQixtQkFBMkI7SUFFM0IsSUFBSSxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztRQUNuQyxNQUFNLElBQUksS0FBSyxDQUFDLGtCQUFrQixDQUFDLENBQUM7SUFDeEMsQ0FBQztJQUNELE1BQU0sY0FBYyxHQUFHLFdBQVcsQ0FBQyxVQUFVLEVBQUUsWUFBWSxDQUFDLENBQUM7SUFDN0QsTUFBTSxtQkFBbUIsR0FBRyxXQUFXLENBQUMsbUJBQW1CLEVBQUUscUJBQXFCLENBQUMsQ0FBQztJQUNwRixPQUFPO1FBQ0gsTUFBTSxFQUFFLDBCQUFrQjtRQUMxQixJQUFJLEVBQUUsd0JBQWdCO1FBQ3RCLFVBQVU7UUFDVixVQUFVLEVBQUUsY0FBYztRQUMxQixXQUFXLEVBQUU7WUFDVCxDQUFDLG9CQUFvQixDQUFDLFVBQVUsRUFBRSxlQUFlLENBQUMsQ0FBQyxFQUFFLGNBQWM7U0FDdEU7UUFDRCxrQkFBa0IsRUFBRSxDQUFDLGNBQWMsQ0FBQztRQUNwQyx1QkFBdUIsRUFBRSxDQUFDLG1CQUFtQixDQUFDO1FBQzlDLG9CQUFvQixFQUFFLEVBQUU7S0FDM0IsQ0FBQztBQUNOLENBQUM7QUFFRCxTQUFnQix1QkFBdUIsQ0FDbkMsUUFBMEIsRUFDMUIsT0FBMEI7SUFFMUIsTUFBTSxPQUFPLEdBQTRCLEVBQUUsQ0FBQztJQUM1QyxLQUFLLE1BQU0sQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQztRQUNwRSxNQUFNLE1BQU0sR0FBRyxXQUFXLENBQUMsU0FBUyxFQUFFLGVBQWUsTUFBTSxFQUFFLENBQUMsQ0FBQztRQUMvRCxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsb0JBQW9CLENBQUMsUUFBUSxDQUFDLFVBQVUsRUFBRSxNQUFNLENBQUMsRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDO0lBQzlFLENBQUM7SUFDRCxNQUFNLFdBQVcsR0FBRyxhQUFhLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDM0MsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDO1FBQzVELE1BQU0sSUFBSSxLQUFLLENBQUMscUNBQXFDLENBQUMsQ0FBQztJQUMzRCxDQUFDO0lBQ0QsTUFBTSxrQkFBa0IsR0FBRyxtQkFBbUIsQ0FBQyxPQUFPLENBQUMsa0JBQWtCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztJQUNqRyxNQUFNLGVBQWUsR0FBRyxvQkFBb0IsQ0FBQyxPQUFPLENBQUMsZUFBZSxFQUFFLGtCQUFrQixDQUFDLENBQUM7SUFDMUYsT0FBTztRQUNILE1BQU0sRUFBRSwwQkFBa0I7UUFDMUIsSUFBSSxFQUFFLHdCQUFnQjtRQUN0QixVQUFVLEVBQUUsUUFBUSxDQUFDLFVBQVU7UUFDL0IsVUFBVSxFQUFFLFFBQVEsQ0FBQyxVQUFVO1FBQy9CLFdBQVc7UUFDWCxrQkFBa0I7UUFDbEIsdUJBQXVCLEVBQUUsbUJBQW1CLENBQ3hDLE9BQU8sQ0FBQyx1QkFBdUIsRUFDL0IseUJBQXlCLENBQzVCO1FBQ0Qsb0JBQW9CLEVBQUUsbUJBQW1CLENBQUMsT0FBTyxDQUFDLG9CQUFvQixFQUFFLHNCQUFzQixDQUFDO1FBQy9GLEdBQUcsQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLEVBQUUsZUFBZSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztLQUNsRCxDQUFDO0FBQ04sQ0FBQztBQUVELFNBQWdCLG9CQUFvQixDQUFDLElBQWE7SUFDOUMsSUFBSSxDQUFDLElBQUksSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUNwQyxPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0lBQ0QsTUFBTSxRQUFRLEdBQUksSUFBK0IsQ0FBQyxRQUFRLENBQUM7SUFDM0QsSUFBSSxDQUFDLFFBQVEsSUFBSSxPQUFPLFFBQVEsS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUM1QyxPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0lBQ0QsTUFBTSxHQUFHLEdBQUksUUFBb0MsQ0FBQyxhQUFhLENBQUM7SUFDaEUsSUFBSSxHQUFHLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDcEIsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztJQUNELElBQUksQ0FBQyxHQUFHLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDbEMsTUFBTSxJQUFJLEtBQUssQ0FBQyxpQ0FBaUMsQ0FBQyxDQUFDO0lBQ3ZELENBQUM7SUFDRCxNQUFNLEtBQUssR0FBRyxHQUE4QixDQUFDO0lBQzdDLElBQUksS0FBSyxDQUFDLE1BQU0sS0FBSywwQkFBa0IsSUFBSSxLQUFLLENBQUMsSUFBSSxLQUFLLHdCQUFnQixFQUFFLENBQUM7UUFDekUsTUFBTSxJQUFJLEtBQUssQ0FBQyx1Q0FBdUMsQ0FBQyxDQUFDO0lBQzdELENBQUM7SUFDRCxJQUFJLE9BQU8sS0FBSyxDQUFDLFVBQVUsS0FBSyxRQUFRLElBQUksQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDO1FBQ2pGLE1BQU0sSUFBSSxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUM5QyxDQUFDO0lBQ0QsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLFdBQVcsQ0FBQztJQUN6QyxJQUFJLENBQUMsY0FBYyxJQUFJLE9BQU8sY0FBYyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLGNBQWMsQ0FBQyxFQUFFLENBQUM7UUFDekYsTUFBTSxJQUFJLEtBQUssQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO0lBQy9DLENBQUM7SUFDRCxNQUFNLFdBQVcsR0FBNEIsRUFBRSxDQUFDO0lBQ2hELEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxNQUFNLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLGNBQXlDLENBQUMsRUFBRSxDQUFDO1FBQ3BGLElBQUksQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDNUIsTUFBTSxJQUFJLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO1FBQ3hDLENBQUM7UUFDRCxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxFQUFFLFdBQVcsQ0FBQyxNQUFNLEVBQUUsZUFBZSxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN2RSxDQUFDO0lBQ0QsTUFBTSxVQUFVLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxVQUFVLEVBQUUsWUFBWSxDQUFDLENBQUM7SUFDL0QsTUFBTSxrQkFBa0IsR0FBRyxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsa0JBQWtCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztJQUMvRixJQUFJLENBQUMsa0JBQWtCLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUM7UUFDM0MsTUFBTSxJQUFJLEtBQUssQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDO0lBQzdDLENBQUM7SUFDRCxNQUFNLGVBQWUsR0FBRyxvQkFBb0IsQ0FBQyxLQUFLLENBQUMsZUFBZSxFQUFFLGtCQUFrQixDQUFDLENBQUM7SUFDeEYsT0FBTztRQUNILE1BQU0sRUFBRSwwQkFBa0I7UUFDMUIsSUFBSSxFQUFFLHdCQUFnQjtRQUN0QixVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7UUFDNUIsVUFBVTtRQUNWLFdBQVcsRUFBRSxhQUFhLENBQUMsV0FBVyxDQUFDO1FBQ3ZDLGtCQUFrQjtRQUNsQix1QkFBdUIsRUFBRSxtQkFBbUIsQ0FDeEMsS0FBSyxDQUFDLHVCQUF1QixFQUM3Qix5QkFBeUIsQ0FDNUI7UUFDRCxvQkFBb0IsRUFBRSxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsb0JBQW9CLEVBQUUsc0JBQXNCLENBQUM7UUFDN0YsR0FBRyxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsRUFBRSxlQUFlLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0tBQ2xELENBQUM7QUFDTixDQUFDO0FBRUQsU0FBZ0IscUJBQXFCLENBQUMsSUFBYSxFQUFFLE1BQXdCO0lBQ3pFLE1BQU0sTUFBTSxHQUFHLElBQUksSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRO1FBQzNDLENBQUMsQ0FBQyxJQUErQjtRQUNqQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ1QsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLFFBQVEsSUFBSSxPQUFPLE1BQU0sQ0FBQyxRQUFRLEtBQUssUUFBUTtRQUNuRSxDQUFDLENBQUMsTUFBTSxDQUFDLFFBQW1DO1FBQzVDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDVCxPQUFPO1FBQ0gsR0FBRyxNQUFNO1FBQ1QsUUFBUSxFQUFFO1lBQ04sR0FBRyxRQUFRO1lBQ1gsYUFBYSxFQUFFLE1BQU07U0FDeEI7S0FDSixDQUFDO0FBQ04sQ0FBQztBQUVELFNBQWdCLHdCQUF3QixDQUNwQyxpQkFBcUMsRUFDckMsZUFBbUMsRUFDbkMsa0JBQTJCO0lBRTNCLElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO1FBQ3JCLE9BQU87WUFDSCxVQUFVLEVBQUUsZUFBZTtZQUMzQixZQUFZLEVBQUUsS0FBSztZQUNuQixZQUFZLEVBQUUsS0FBSztTQUN0QixDQUFDO0lBQ04sQ0FBQztJQUNELElBQUksa0JBQWtCLEVBQUUsQ0FBQztRQUNyQixPQUFPO1lBQ0gsVUFBVSxFQUFFLGlCQUFpQjtZQUM3QixZQUFZLEVBQUUsS0FBSztZQUNuQixZQUFZLEVBQUUsS0FBSztTQUN0QixDQUFDO0lBQ04sQ0FBQztJQUNELE1BQU0sNkJBQTZCLEdBQUcsZUFBZSxLQUFLLGlCQUFpQixDQUFDO0lBQzVFLE9BQU87UUFDSCxVQUFVLEVBQUUsNkJBQTZCLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsZUFBZTtRQUN2RSxZQUFZLEVBQUUsSUFBSTtRQUNsQixZQUFZLEVBQUUsNkJBQTZCO0tBQzlDLENBQUM7QUFDTixDQUFDO0FBRUQsU0FBZ0IsNEJBQTRCLENBQ3hDLFFBQXlCLEVBQ3pCLE1BQXdCOztJQUV4QixJQUFJLE1BQWUsQ0FBQztJQUNwQixJQUFJLENBQUM7UUFDRCxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLFFBQVEsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0lBQzdGLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxPQUFPLEtBQUssQ0FBQztJQUNqQixDQUFDO0lBQ0QsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUN6QixPQUFPLEtBQUssQ0FBQztJQUNqQixDQUFDO0lBQ0QsTUFBTSxPQUFPLEdBQUcsTUFBb0MsQ0FBQztJQUNyRCxNQUFNLE9BQU8sR0FBRyxDQUFDLEdBQVEsRUFBbUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsR0FBRyxhQUFILEdBQUcsdUJBQUgsR0FBRyxDQUFFLE1BQU0sQ0FBQztRQUN4RixDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0lBQ3RDLE1BQU0sU0FBUyxHQUFHLE1BQUEsTUFBQSxPQUFPLENBQUMsQ0FBQyxDQUFDLDBDQUFFLElBQUksMENBQUUsTUFBTSxDQUFDO0lBQzNDLE1BQU0sWUFBWSxHQUFHLElBQUksR0FBRyxFQUF1QixDQUFDO0lBQ3BELEtBQUssTUFBTSxJQUFJLElBQUksT0FBTyxFQUFFLENBQUM7UUFDekIsSUFBSSxDQUFBLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxRQUFRLE1BQUssZUFBZSxJQUFJLENBQUMsT0FBTyxDQUFBLE1BQUEsSUFBSSxDQUFDLEtBQUssMENBQUUsUUFBUSxDQUFBLEtBQUssUUFBUTtlQUM1RSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsU0FBUyxDQUFDLElBQUksTUFBTSxDQUFDLFNBQVMsQ0FBQyxNQUFBLElBQUksQ0FBQyxJQUFJLDBDQUFFLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxLQUFLLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUM3RyxZQUFZLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzNCLENBQUM7SUFDTCxDQUFDO0lBQ0QsS0FBSyxNQUFNLElBQUksSUFBSSxPQUFPLEVBQUUsQ0FBQztRQUN6QixJQUFJLFlBQVksQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLE1BQUEsT0FBTyxDQUFDLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxJQUFJLENBQUMsMENBQUUsT0FBTyxDQUFFLENBQUMsRUFBRSxDQUFDO1lBQzNELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDN0MsSUFBSSxhQUFhO2dCQUFFLFlBQVksQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDdkQsQ0FBQztJQUNMLENBQUM7SUFDRCxNQUFNLFdBQVcsR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBQ3RDLE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUMzQyxLQUFLLE1BQU0sSUFBSSxJQUFJLE1BQU0sRUFBRSxDQUFDO1FBQ3hCLElBQUksQ0FBQyxJQUFJLElBQUksT0FBTyxJQUFJLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDcEMsU0FBUztRQUNiLENBQUM7UUFDRCxNQUFNLEtBQUssR0FBRyxJQUErQixDQUFDO1FBQzlDLElBQUksWUFBWSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUM7WUFBRSxTQUFTO1FBQ3RDLE1BQU0sTUFBTSxHQUFHLE9BQU8sS0FBSyxDQUFDLE1BQU0sS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNwRSxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDVixTQUFTO1FBQ2IsQ0FBQztRQUNELE1BQU0sTUFBTSxHQUFHLEtBQUssQ0FBQyxRQUFRLEtBQUssZUFBZTtZQUM3QyxDQUFDLENBQUMsV0FBVztZQUNiLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxLQUFLLG1CQUFtQjtnQkFDcEMsQ0FBQyxDQUFDLGdCQUFnQjtnQkFDbEIsQ0FBQyxDQUFDLElBQUksQ0FBQztRQUNmLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNWLFNBQVM7UUFDYixDQUFDO1FBQ0QsSUFBSSxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7WUFDckIsT0FBTyxLQUFLLENBQUM7UUFDakIsQ0FBQztRQUNELE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdkIsQ0FBQztJQUNELE1BQU0sYUFBYSxHQUFHLElBQUksR0FBRyxDQUFDO1FBQzFCLE1BQU0sQ0FBQyxVQUFVO1FBQ2pCLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDO1FBQ3BDLEdBQUcsTUFBTSxDQUFDLGtCQUFrQjtRQUM1QixHQUFHLE1BQU0sQ0FBQyxvQkFBb0I7S0FDakMsQ0FBQyxDQUFDO0lBQ0gsSUFBSSxDQUFDLENBQUMsR0FBRyxhQUFhLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUM7V0FDM0QsQ0FBQyxNQUFNLENBQUMsdUJBQXVCLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUM7UUFBRSxPQUFPLEtBQUssQ0FBQztJQUNyRyxLQUFLLE1BQU0sQ0FBQyxTQUFTLEVBQUUsVUFBVSxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxNQUFBLE1BQU0sQ0FBQyxlQUFlLG1DQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUM7UUFDakYsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFOztZQUFDLE9BQUEsQ0FBQSxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsUUFBUSxNQUFLLFNBQVM7bUJBQy9ELENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBRSxDQUFDLElBQUksQ0FBQSxNQUFBLE9BQU8sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLDBDQUFFLE1BQU0sTUFBSyxTQUFTLENBQUE7U0FBQSxDQUFDLENBQUM7UUFDakcsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztZQUFFLE9BQU8sS0FBSyxDQUFDO1FBQ2pGLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBWSxFQUFFLEVBQUU7O1lBQzFELE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUMzQixNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsS0FBSyxhQUFMLEtBQUssdUJBQUwsS0FBSyxDQUFFLE9BQU8sQ0FBQyxDQUFDO1lBQ3JDLE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsUUFBUSxDQUFDLENBQUM7WUFDekMsT0FBTyxJQUFJLElBQUksS0FBSyxJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssS0FBSzttQkFDN0MsSUFBQSx5QkFBa0IsRUFBQyxNQUFNLENBQUMsTUFBQSxNQUFBLElBQUksQ0FBQyxLQUFLLDBDQUFFLFFBQVEsbUNBQUksRUFBRSxDQUFDLENBQUMsS0FBSyxJQUFBLHlCQUFrQixFQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUM7bUJBQ25HLENBQUEsUUFBUSxhQUFSLFFBQVEsdUJBQVIsUUFBUSxDQUFFLFFBQVEsTUFBSyxtQkFBbUIsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLFVBQVUsQ0FBQyxjQUFjLENBQUM7UUFDdkcsQ0FBQyxDQUFDLENBQUM7UUFDSCxJQUFJLE9BQU8sQ0FBQyxNQUFNLEtBQUssQ0FBQztZQUFFLE9BQU8sS0FBSyxDQUFDO0lBQzNDLENBQUM7SUFDRCxPQUFPLElBQUksQ0FBQztBQUNoQixDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsS0FBYTtJQUNsQyxPQUFPLEtBQUssQ0FBQyxPQUFPLENBQUMscUJBQXFCLEVBQUUsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQztXQUNsRixhQUFhLENBQUM7QUFDekIsQ0FBQztBQUVELFNBQWdCLHVCQUF1QixDQUNuQyxJQUFZLEVBQ1osS0FBVyxFQUNYLFVBQWtCLEVBQ2xCLG1CQUEyQjtJQUUzQixNQUFNLGNBQWMsR0FBRyxXQUFXLENBQUMsVUFBVSxFQUFFLFlBQVksQ0FBQyxDQUFDO0lBQzdELE1BQU0sbUJBQW1CLEdBQUcsV0FBVyxDQUFDLG1CQUFtQixFQUFFLHFCQUFxQixDQUFDLENBQUM7SUFDcEYsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzFFLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM3RSxNQUFNLFFBQVEsR0FBRyxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDdkMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDO1FBQ2xCO1lBQ0ksUUFBUSxFQUFFLFdBQVc7WUFDckIsS0FBSyxFQUFFLFFBQVE7WUFDZixTQUFTLEVBQUUsQ0FBQztZQUNaLGdCQUFnQixFQUFFLEVBQUU7WUFDcEIsT0FBTyxFQUFFLEVBQUU7WUFDWCxJQUFJLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFFO1lBQ25CLGtCQUFrQixFQUFFLENBQUM7WUFDckIsVUFBVSxFQUFFLEtBQUs7U0FDcEI7UUFDRDtZQUNJLFFBQVEsRUFBRSxTQUFTO1lBQ25CLEtBQUssRUFBRSxRQUFRO1lBQ2YsU0FBUyxFQUFFLENBQUM7WUFDWixnQkFBZ0IsRUFBRSxFQUFFO1lBQ3BCLE9BQU8sRUFBRSxJQUFJO1lBQ2IsU0FBUyxFQUFFLEVBQUU7WUFDYixPQUFPLEVBQUUsSUFBSTtZQUNiLFdBQVcsRUFBRSxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRSxDQUFDO1lBQzVCLE9BQU8sRUFBRSxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUU7WUFDdEIsS0FBSyxFQUFFLEVBQUUsUUFBUSxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRTtZQUNoRCxLQUFLLEVBQUUsRUFBRSxRQUFRLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUU7WUFDdEQsT0FBTyxFQUFFLEVBQUUsUUFBUSxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRTtZQUNsRCxTQUFTLEVBQUUsQ0FBQztZQUNaLE1BQU0sRUFBRSxVQUFVO1lBQ2xCLE1BQU0sRUFBRSxFQUFFLFFBQVEsRUFBRSxTQUFTLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUU7WUFDakQsR0FBRyxFQUFFLEVBQUU7U0FDVjtRQUNEO1lBQ0ksUUFBUSxFQUFFLGdCQUFnQjtZQUMxQixLQUFLLEVBQUUsRUFBRTtZQUNULFNBQVMsRUFBRSxDQUFDO1lBQ1osZ0JBQWdCLEVBQUUsRUFBRTtZQUNwQixJQUFJLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFFO1lBQ25CLFFBQVEsRUFBRSxJQUFJO1lBQ2QsUUFBUSxFQUFFLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRTtZQUN2QixZQUFZLEVBQUUsRUFBRSxRQUFRLEVBQUUsU0FBUyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUU7WUFDcEQsWUFBWSxFQUFFLEVBQUUsUUFBUSxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUU7WUFDckQsR0FBRyxFQUFFLEVBQUU7U0FDVjtRQUNEO1lBQ0ksUUFBUSxFQUFFLG1CQUFtQjtZQUM3QixNQUFNLEVBQUUsbUJBQW1CO1NBQzlCO1FBQ0Q7WUFDSSxRQUFRLEVBQUUsZUFBZTtZQUN6QixJQUFJLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFFO1lBQ25CLEtBQUssRUFBRSxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUU7WUFDcEIsTUFBTSxFQUFFLGNBQWM7WUFDdEIsUUFBUSxFQUFFLElBQUk7WUFDZCxlQUFlLEVBQUUsSUFBSTtTQUN4QjtLQUNKLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ2hCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSAnY3J5cHRvJztcclxuaW1wb3J0IHR5cGUgeyBSZWN0LCBTY2VuZU5vZGVTcGVjIH0gZnJvbSAnLi4vdHlwZXMnO1xyXG5pbXBvcnQgdHlwZSB7IFByZWZhYkluc3RhbmNlQXR0YWNobWVudCB9IGZyb20gJy4uL3ByZWZhYi1pbnN0YW5jZSc7XHJcbmltcG9ydCB7IG5vcm1hbGl6ZUNvY29zVXVpZCB9IGZyb20gJy4uL3JvdW5kdHJpcC91dWlkJztcclxuXHJcbmV4cG9ydCBjb25zdCBQUkVGQUJfU1lOQ19TQ0hFTUEgPSAxIGFzIGNvbnN0O1xyXG5leHBvcnQgY29uc3QgUFJFRkFCX1NZTkNfS0lORCA9ICdmcmFtZS1wcmVmYWInIGFzIGNvbnN0O1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBQcmVmYWJTeW5jUmVjb3JkIHtcclxuICAgIHNjaGVtYTogdHlwZW9mIFBSRUZBQl9TWU5DX1NDSEVNQTtcclxuICAgIGtpbmQ6IHR5cGVvZiBQUkVGQUJfU1lOQ19LSU5EO1xyXG4gICAgc291cmNlSGFzaDogc3RyaW5nO1xyXG4gICAgcm9vdEZpbGVJZDogc3RyaW5nO1xyXG4gICAgLyoqIFNIQS0yNTYoRmlnbWEgbm9kZSBpZGVudGl0eSkgLT4gQ29jb3MgUHJlZmFiSW5mby5maWxlSWQuICovXHJcbiAgICBub2RlRmlsZUlkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIC8qKiBFeGFjdCBvd25lcnNoaXAgc2V0cyB1c2VkIHRvIGF2b2lkIHRvdWNoaW5nIHVzZXItYXV0aG9yZWQgbm9kZXMvY29tcG9uZW50cy4gKi9cclxuICAgIG1hbmFnZWROb2RlRmlsZUlkczogc3RyaW5nW107XHJcbiAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogc3RyaW5nW107XHJcbiAgICBtYW5hZ2VkSGVscGVyRmlsZUlkczogc3RyaW5nW107XHJcbiAgICBwcmVmYWJJbnN0YW5jZXM/OiBSZWNvcmQ8c3RyaW5nLCBQcmVmYWJJbnN0YW5jZUF0dGFjaG1lbnQ+O1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFByZWZhYlN5bmNDYXB0dXJlIHtcclxuICAgIG5vZGVGaWxlSWRzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgbWFuYWdlZE5vZGVGaWxlSWRzOiBzdHJpbmdbXTtcclxuICAgIG1hbmFnZWRDb21wb25lbnRGaWxlSWRzOiBzdHJpbmdbXTtcclxuICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBzdHJpbmdbXTtcclxuICAgIHByZWZhYkluc3RhbmNlcz86IFJlY29yZDxzdHJpbmcsIFByZWZhYkluc3RhbmNlQXR0YWNobWVudD47XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUHJlZmFiUmVjb3ZlcnlUYXJnZXRQbGFuIHtcclxuICAgIHRhcmdldFV1aWQ/OiBzdHJpbmc7XHJcbiAgICBjbGVhclBlbmRpbmc6IGJvb2xlYW47XHJcbiAgICBjbGVhckJpbmRpbmc6IGJvb2xlYW47XHJcbn1cclxuXHJcbmNvbnN0IFNIQTI1Nl9QQVRURVJOID0gL15zaGEyNTY6WzAtOWEtZl17NjR9JC87XHJcbmNvbnN0IEZJTEVfSURfUEFUVEVSTiA9IC9eW0EtWmEtejAtOSsvXz0tXXs4LDEyOH0kLztcclxuXHJcbmZ1bmN0aW9uIHNoYTI1Nih2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBgc2hhMjU2OiR7Y3JlYXRlSGFzaCgnc2hhMjU2JykudXBkYXRlKHZhbHVlLCAndXRmOCcpLmRpZ2VzdCgnaGV4Jyl9YDtcclxufVxyXG5cclxuZnVuY3Rpb24gY2xlYW5Ob2RlSWQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gdmFsdWUudHJpbSgpLnJlcGxhY2UoLy0vZywgJzonKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY2xlYW5GaWxlSWQodmFsdWU6IHVua25vd24sIGxhYmVsOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycgfHwgIUZJTEVfSURfUEFUVEVSTi50ZXN0KHZhbHVlKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtsYWJlbH0g5LiN5piv5pyJ5pWI55qEIENvY29zIGZpbGVJZOOAgmApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzb3J0ZWRVbmlxdWVGaWxlSWRzKHZhbHVlOiB1bmtub3duLCBsYWJlbDogc3RyaW5nKTogc3RyaW5nW10ge1xyXG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtsYWJlbH0g5b+F6aG75pivIGZpbGVJZCDmlbDnu4TjgIJgKTtcclxuICAgIH1cclxuICAgIHJldHVybiBbLi4ubmV3IFNldCh2YWx1ZS5tYXAoKGl0ZW0sIGluZGV4KSA9PiBjbGVhbkZpbGVJZChpdGVtLCBgJHtsYWJlbH1bJHtpbmRleH1dYCkpKV0uc29ydCgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzb3J0ZWROb2RlTWFwKGVudHJpZXM6IEl0ZXJhYmxlPFtzdHJpbmcsIHN0cmluZ10+KTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XHJcbiAgICByZXR1cm4gT2JqZWN0LmZyb21FbnRyaWVzKFsuLi5lbnRyaWVzXS5zb3J0KChbYV0sIFtiXSkgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNsZWFuUHJlZmFiSW5zdGFuY2VzKHZhbHVlOiB1bmtub3duLCBtYW5hZ2VkTm9kZXM6IHN0cmluZ1tdKTogUmVjb3JkPHN0cmluZywgUHJlZmFiSW5zdGFuY2VBdHRhY2htZW50PiB8IHVuZGVmaW5lZCB7XHJcbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHZhbHVlKSkgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5a6e5L6L5omA5pyJ5p2D6K6w5b2V5peg5pWI44CCJyk7XHJcbiAgICBjb25zdCBlbnRyaWVzOiBBcnJheTxbc3RyaW5nLCBQcmVmYWJJbnN0YW5jZUF0dGFjaG1lbnRdPiA9IFtdO1xyXG4gICAgY29uc3QgaW5zdGFuY2VJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGZvciAoY29uc3QgW2NhcnJpZXIsIHJhd10gb2YgT2JqZWN0LmVudHJpZXModmFsdWUpKSB7XHJcbiAgICAgICAgY2xlYW5GaWxlSWQoY2FycmllciwgJ1ByZWZhYiBjYXJyaWVyIGZpbGVJZCcpO1xyXG4gICAgICAgIGlmICghbWFuYWdlZE5vZGVzLmluY2x1ZGVzKGNhcnJpZXIpIHx8ICFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShyYXcpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWunuS+i+S4jeWxnuS6juWPl+euoeiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpdGVtID0gcmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgICAgIGlmICh0eXBlb2YgaXRlbS5hc3NldFV1aWQgIT09ICdzdHJpbmcnIHx8ICEvXltBLVphLXowLTkrL189QC4tXXsxLDI1Nn0kLy50ZXN0KGl0ZW0uYXNzZXRVdWlkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlrp7kvovotYTmupAgVVVJRCDml6DmlYjjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaW5zdGFuY2VGaWxlSWQgPSBjbGVhbkZpbGVJZChpdGVtLmluc3RhbmNlRmlsZUlkLCAnUHJlZmFiIGluc3RhbmNlIGZpbGVJZCcpO1xyXG4gICAgICAgIGlmIChpbnN0YW5jZUlkcy5oYXMoaW5zdGFuY2VGaWxlSWQpKSB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlrp7kvosgZmlsZUlkIOmHjeWkjeOAgicpO1xyXG4gICAgICAgIGluc3RhbmNlSWRzLmFkZChpbnN0YW5jZUZpbGVJZCk7XHJcbiAgICAgICAgZW50cmllcy5wdXNoKFtjYXJyaWVyLCB7IGFzc2V0VXVpZDogbm9ybWFsaXplQ29jb3NVdWlkKGl0ZW0uYXNzZXRVdWlkKSwgaW5zdGFuY2VGaWxlSWQgfV0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGVudHJpZXMubGVuZ3RoID8gT2JqZWN0LmZyb21FbnRyaWVzKGVudHJpZXMuc29ydCgoW2FdLCBbYl0pID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZmlnbWFGcmFtZVNvdXJjZUhhc2goZmlsZUtleTogc3RyaW5nLCBzb3VyY2VOb2RlSWQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBub3JtYWxpemVkRmlsZUtleSA9IGZpbGVLZXkudHJpbSgpO1xyXG4gICAgY29uc3Qgbm9ybWFsaXplZE5vZGVJZCA9IGNsZWFuTm9kZUlkKHNvdXJjZU5vZGVJZCk7XHJcbiAgICBpZiAoIW5vcm1hbGl6ZWRGaWxlS2V5IHx8ICFub3JtYWxpemVkTm9kZUlkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdGaWdtYSBGcmFtZSDmnaXmupDnvLrlsJEgZmlsZUtleSDmiJYgbm9kZUlk44CCJyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2hhMjU2KGBmaWdtYS1pbXBvcnRlcjpmcmFtZTp2MVxcMCR7bm9ybWFsaXplZEZpbGVLZXl9XFwwJHtub3JtYWxpemVkTm9kZUlkfWApO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZmlnbWFOb2RlSWRlbnRpdHlLZXkoc291cmNlSGFzaDogc3RyaW5nLCBub2RlSWQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBpZiAoIVNIQTI1Nl9QQVRURVJOLnRlc3Qoc291cmNlSGFzaCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDmjIfnurnmoLzlvI/ml6DmlYjjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IG5vcm1hbGl6ZWROb2RlSWQgPSBjbGVhbk5vZGVJZChub2RlSWQpO1xyXG4gICAgaWYgKCFub3JtYWxpemVkTm9kZUlkIHx8IG5vcm1hbGl6ZWROb2RlSWQgPT09ICdfX3Jvb3RfXycpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ZpZ21hIOiKgueCuSBJRCDml6DmlYjjgIInKTtcclxuICAgIH1cclxuICAgIHJldHVybiBzaGEyNTYoYGZpZ21hLWltcG9ydGVyOm5vZGU6djFcXDAke3NvdXJjZUhhc2h9XFwwJHtub3JtYWxpemVkTm9kZUlkfWApO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY29sbGVjdFNjZW5lU3BlY0ZpZ21hSWRzKHNwZWNzOiBTY2VuZU5vZGVTcGVjW10pOiBzdHJpbmdbXSB7XHJcbiAgICBjb25zdCBpZHM6IHN0cmluZ1tdID0gW107XHJcbiAgICBjb25zdCB2aXNpdCA9IChub2RlczogU2NlbmVOb2RlU3BlY1tdKSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgaWQgb2YgW25vZGUuZmlnbWFJZCwgLi4uKG5vZGUuYWxpYXNGaWdtYUlkcyA/PyBbXSldKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBpZC5sZW5ndGggPiAwICYmIGlkICE9PSAnX19yb290X18nKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWRzLnB1c2goY2xlYW5Ob2RlSWQoaWQpKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIW5vZGUucHJlZmFiKSB2aXNpdChub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgdmlzaXQoc3BlY3MpO1xyXG4gICAgcmV0dXJuIFsuLi5uZXcgU2V0KGlkcyldO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMoXHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQsXHJcbiAgICBmaWdtYU5vZGVJZHM6IEl0ZXJhYmxlPHN0cmluZz4sXHJcbik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xyXG4gICAgY29uc3QgcmVzb2x2ZWQ6IEFycmF5PFtzdHJpbmcsIHN0cmluZ10+ID0gW107XHJcbiAgICBmb3IgKGNvbnN0IHJhd0lkIG9mIGZpZ21hTm9kZUlkcykge1xyXG4gICAgICAgIGNvbnN0IG5vZGVJZCA9IGNsZWFuTm9kZUlkKHJhd0lkKTtcclxuICAgICAgICBjb25zdCBmaWxlSWQgPSByZWNvcmQubm9kZUZpbGVJZHNbZmlnbWFOb2RlSWRlbnRpdHlLZXkocmVjb3JkLnNvdXJjZUhhc2gsIG5vZGVJZCldO1xyXG4gICAgICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICAgICAgcmVzb2x2ZWQucHVzaChbbm9kZUlkLCBmaWxlSWRdKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gT2JqZWN0LmZyb21FbnRyaWVzKHJlc29sdmVkKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVByZWZhYlN5bmNSZWNvcmQoXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbiAgICByb290RmlnbWFOb2RlSWQ6IHN0cmluZyxcclxuICAgIHJvb3RGaWxlSWQ6IHN0cmluZyxcclxuICAgIHJvb3RUcmFuc2Zvcm1GaWxlSWQ6IHN0cmluZyxcclxuKTogUHJlZmFiU3luY1JlY29yZCB7XHJcbiAgICBpZiAoIVNIQTI1Nl9QQVRURVJOLnRlc3Qoc291cmNlSGFzaCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDmjIfnurnmoLzlvI/ml6DmlYjjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNhZmVSb290RmlsZUlkID0gY2xlYW5GaWxlSWQocm9vdEZpbGVJZCwgJ3Jvb3RGaWxlSWQnKTtcclxuICAgIGNvbnN0IHNhZmVUcmFuc2Zvcm1GaWxlSWQgPSBjbGVhbkZpbGVJZChyb290VHJhbnNmb3JtRmlsZUlkLCAncm9vdFRyYW5zZm9ybUZpbGVJZCcpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBzY2hlbWE6IFBSRUZBQl9TWU5DX1NDSEVNQSxcclxuICAgICAgICBraW5kOiBQUkVGQUJfU1lOQ19LSU5ELFxyXG4gICAgICAgIHNvdXJjZUhhc2gsXHJcbiAgICAgICAgcm9vdEZpbGVJZDogc2FmZVJvb3RGaWxlSWQsXHJcbiAgICAgICAgbm9kZUZpbGVJZHM6IHtcclxuICAgICAgICAgICAgW2ZpZ21hTm9kZUlkZW50aXR5S2V5KHNvdXJjZUhhc2gsIHJvb3RGaWdtYU5vZGVJZCldOiBzYWZlUm9vdEZpbGVJZCxcclxuICAgICAgICB9LFxyXG4gICAgICAgIG1hbmFnZWROb2RlRmlsZUlkczogW3NhZmVSb290RmlsZUlkXSxcclxuICAgICAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogW3NhZmVUcmFuc2Zvcm1GaWxlSWRdLFxyXG4gICAgICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBbXSxcclxuICAgIH07XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiByZWNvcmRQcmVmYWJTeW5jQ2FwdHVyZShcclxuICAgIHByZXZpb3VzOiBQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgY2FwdHVyZTogUHJlZmFiU3luY0NhcHR1cmUsXHJcbik6IFByZWZhYlN5bmNSZWNvcmQge1xyXG4gICAgY29uc3QgZW50cmllczogQXJyYXk8W3N0cmluZywgc3RyaW5nXT4gPSBbXTtcclxuICAgIGZvciAoY29uc3QgW25vZGVJZCwgcmF3RmlsZUlkXSBvZiBPYmplY3QuZW50cmllcyhjYXB0dXJlLm5vZGVGaWxlSWRzKSkge1xyXG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IGNsZWFuRmlsZUlkKHJhd0ZpbGVJZCwgYG5vZGVGaWxlSWRzLiR7bm9kZUlkfWApO1xyXG4gICAgICAgIGVudHJpZXMucHVzaChbZmlnbWFOb2RlSWRlbnRpdHlLZXkocHJldmlvdXMuc291cmNlSGFzaCwgbm9kZUlkKSwgZmlsZUlkXSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBub2RlRmlsZUlkcyA9IHNvcnRlZE5vZGVNYXAoZW50cmllcyk7XHJcbiAgICBpZiAoIU9iamVjdC52YWx1ZXMobm9kZUZpbGVJZHMpLmluY2x1ZGVzKHByZXZpb3VzLnJvb3RGaWxlSWQpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5ZCM5q2l57uT5p6c57y65bCR5Y6f5qC56IqC54K5IGZpbGVJZO+8jOW3suaLkue7neaPkOS6pOadpea6kOiusOW9leOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbWFuYWdlZE5vZGVGaWxlSWRzID0gc29ydGVkVW5pcXVlRmlsZUlkcyhjYXB0dXJlLm1hbmFnZWROb2RlRmlsZUlkcywgJ21hbmFnZWROb2RlRmlsZUlkcycpO1xyXG4gICAgY29uc3QgcHJlZmFiSW5zdGFuY2VzID0gY2xlYW5QcmVmYWJJbnN0YW5jZXMoY2FwdHVyZS5wcmVmYWJJbnN0YW5jZXMsIG1hbmFnZWROb2RlRmlsZUlkcyk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNjaGVtYTogUFJFRkFCX1NZTkNfU0NIRU1BLFxyXG4gICAgICAgIGtpbmQ6IFBSRUZBQl9TWU5DX0tJTkQsXHJcbiAgICAgICAgc291cmNlSGFzaDogcHJldmlvdXMuc291cmNlSGFzaCxcclxuICAgICAgICByb290RmlsZUlkOiBwcmV2aW91cy5yb290RmlsZUlkLFxyXG4gICAgICAgIG5vZGVGaWxlSWRzLFxyXG4gICAgICAgIG1hbmFnZWROb2RlRmlsZUlkcyxcclxuICAgICAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogc29ydGVkVW5pcXVlRmlsZUlkcyhcclxuICAgICAgICAgICAgY2FwdHVyZS5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyxcclxuICAgICAgICAgICAgJ21hbmFnZWRDb21wb25lbnRGaWxlSWRzJyxcclxuICAgICAgICApLFxyXG4gICAgICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBzb3J0ZWRVbmlxdWVGaWxlSWRzKGNhcHR1cmUubWFuYWdlZEhlbHBlckZpbGVJZHMsICdtYW5hZ2VkSGVscGVyRmlsZUlkcycpLFxyXG4gICAgICAgIC4uLihwcmVmYWJJbnN0YW5jZXMgPyB7IHByZWZhYkluc3RhbmNlcyB9IDoge30pLFxyXG4gICAgfTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHJlYWRQcmVmYWJTeW5jUmVjb3JkKG1ldGE6IHVua25vd24pOiBQcmVmYWJTeW5jUmVjb3JkIHwgbnVsbCB7XHJcbiAgICBpZiAoIW1ldGEgfHwgdHlwZW9mIG1ldGEgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCB1c2VyRGF0YSA9IChtZXRhIGFzIHsgdXNlckRhdGE/OiB1bmtub3duIH0pLnVzZXJEYXRhO1xyXG4gICAgaWYgKCF1c2VyRGF0YSB8fCB0eXBlb2YgdXNlckRhdGEgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCByYXcgPSAodXNlckRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmZpZ21hSW1wb3J0ZXI7XHJcbiAgICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGlmICghcmF3IHx8IHR5cGVvZiByYXcgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg55qEIGZpZ21hSW1wb3J0ZXIg5p2l5rqQ6K6w5b2V5bey5o2f5Z2P44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2YWx1ZSA9IHJhdyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgIGlmICh2YWx1ZS5zY2hlbWEgIT09IFBSRUZBQl9TWU5DX1NDSEVNQSB8fCB2YWx1ZS5raW5kICE9PSBQUkVGQUJfU1lOQ19LSU5EKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg55qEIGZpZ21hSW1wb3J0ZXIg5p2l5rqQ6K6w5b2V54mI5pys5oiW57G75Z6L5LiN5Y+X5pSv5oyB44CCJyk7XHJcbiAgICB9XHJcbiAgICBpZiAodHlwZW9mIHZhbHVlLnNvdXJjZUhhc2ggIT09ICdzdHJpbmcnIHx8ICFTSEEyNTZfUEFUVEVSTi50ZXN0KHZhbHVlLnNvdXJjZUhhc2gpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg55qEIEZpZ21hIOadpea6kOaMh+e6ueaXoOaViOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmF3Tm9kZUZpbGVJZHMgPSB2YWx1ZS5ub2RlRmlsZUlkcztcclxuICAgIGlmICghcmF3Tm9kZUZpbGVJZHMgfHwgdHlwZW9mIHJhd05vZGVGaWxlSWRzICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHJhd05vZGVGaWxlSWRzKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOeahOiKgueCuSBmaWxlSWQg5pig5bCE5peg5pWI44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBub2RlRW50cmllczogQXJyYXk8W3N0cmluZywgc3RyaW5nXT4gPSBbXTtcclxuICAgIGZvciAoY29uc3QgW2tleSwgZmlsZUlkXSBvZiBPYmplY3QuZW50cmllcyhyYXdOb2RlRmlsZUlkcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICBpZiAoIVNIQTI1Nl9QQVRURVJOLnRlc3Qoa2V5KSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDnmoToioLngrnmnaXmupDplK7ml6DmlYjjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZUVudHJpZXMucHVzaChba2V5LCBjbGVhbkZpbGVJZChmaWxlSWQsIGBub2RlRmlsZUlkcy4ke2tleX1gKV0pO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgcm9vdEZpbGVJZCA9IGNsZWFuRmlsZUlkKHZhbHVlLnJvb3RGaWxlSWQsICdyb290RmlsZUlkJyk7XHJcbiAgICBjb25zdCBtYW5hZ2VkTm9kZUZpbGVJZHMgPSBzb3J0ZWRVbmlxdWVGaWxlSWRzKHZhbHVlLm1hbmFnZWROb2RlRmlsZUlkcywgJ21hbmFnZWROb2RlRmlsZUlkcycpO1xyXG4gICAgaWYgKCFtYW5hZ2VkTm9kZUZpbGVJZHMuaW5jbHVkZXMocm9vdEZpbGVJZCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDorrDlvZXmnKrlo7DmmI7moLnoioLngrnmiYDmnInmnYPjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHByZWZhYkluc3RhbmNlcyA9IGNsZWFuUHJlZmFiSW5zdGFuY2VzKHZhbHVlLnByZWZhYkluc3RhbmNlcywgbWFuYWdlZE5vZGVGaWxlSWRzKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc2NoZW1hOiBQUkVGQUJfU1lOQ19TQ0hFTUEsXHJcbiAgICAgICAga2luZDogUFJFRkFCX1NZTkNfS0lORCxcclxuICAgICAgICBzb3VyY2VIYXNoOiB2YWx1ZS5zb3VyY2VIYXNoLFxyXG4gICAgICAgIHJvb3RGaWxlSWQsXHJcbiAgICAgICAgbm9kZUZpbGVJZHM6IHNvcnRlZE5vZGVNYXAobm9kZUVudHJpZXMpLFxyXG4gICAgICAgIG1hbmFnZWROb2RlRmlsZUlkcyxcclxuICAgICAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogc29ydGVkVW5pcXVlRmlsZUlkcyhcclxuICAgICAgICAgICAgdmFsdWUubWFuYWdlZENvbXBvbmVudEZpbGVJZHMsXHJcbiAgICAgICAgICAgICdtYW5hZ2VkQ29tcG9uZW50RmlsZUlkcycsXHJcbiAgICAgICAgKSxcclxuICAgICAgICBtYW5hZ2VkSGVscGVyRmlsZUlkczogc29ydGVkVW5pcXVlRmlsZUlkcyh2YWx1ZS5tYW5hZ2VkSGVscGVyRmlsZUlkcywgJ21hbmFnZWRIZWxwZXJGaWxlSWRzJyksXHJcbiAgICAgICAgLi4uKHByZWZhYkluc3RhbmNlcyA/IHsgcHJlZmFiSW5zdGFuY2VzIH0gOiB7fSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbWVyZ2VQcmVmYWJTeW5jUmVjb3JkKG1ldGE6IHVua25vd24sIHJlY29yZDogUHJlZmFiU3luY1JlY29yZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IG1ldGEgJiYgdHlwZW9mIG1ldGEgPT09ICdvYmplY3QnXHJcbiAgICAgICAgPyBtZXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XHJcbiAgICAgICAgOiB7fTtcclxuICAgIGNvbnN0IHVzZXJEYXRhID0gc291cmNlLnVzZXJEYXRhICYmIHR5cGVvZiBzb3VyY2UudXNlckRhdGEgPT09ICdvYmplY3QnXHJcbiAgICAgICAgPyBzb3VyY2UudXNlckRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cclxuICAgICAgICA6IHt9O1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAuLi5zb3VyY2UsXHJcbiAgICAgICAgdXNlckRhdGE6IHtcclxuICAgICAgICAgICAgLi4udXNlckRhdGEsXHJcbiAgICAgICAgICAgIGZpZ21hSW1wb3J0ZXI6IHJlY29yZCxcclxuICAgICAgICB9LFxyXG4gICAgfTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldChcclxuICAgIHBlbmRpbmdQcmVmYWJVdWlkOiBzdHJpbmcgfCB1bmRlZmluZWQsXHJcbiAgICBib3VuZFByZWZhYlV1aWQ6IHN0cmluZyB8IHVuZGVmaW5lZCxcclxuICAgIHBlbmRpbmdBc3NldEV4aXN0czogYm9vbGVhbixcclxuKTogUHJlZmFiUmVjb3ZlcnlUYXJnZXRQbGFuIHtcclxuICAgIGlmICghcGVuZGluZ1ByZWZhYlV1aWQpIHtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICB0YXJnZXRVdWlkOiBib3VuZFByZWZhYlV1aWQsXHJcbiAgICAgICAgICAgIGNsZWFyUGVuZGluZzogZmFsc2UsXHJcbiAgICAgICAgICAgIGNsZWFyQmluZGluZzogZmFsc2UsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuICAgIGlmIChwZW5kaW5nQXNzZXRFeGlzdHMpIHtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICB0YXJnZXRVdWlkOiBwZW5kaW5nUHJlZmFiVXVpZCxcclxuICAgICAgICAgICAgY2xlYXJQZW5kaW5nOiBmYWxzZSxcclxuICAgICAgICAgICAgY2xlYXJCaW5kaW5nOiBmYWxzZSxcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgYmluZGluZ1BvaW50c0F0TWlzc2luZ1BlbmRpbmcgPSBib3VuZFByZWZhYlV1aWQgPT09IHBlbmRpbmdQcmVmYWJVdWlkO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB0YXJnZXRVdWlkOiBiaW5kaW5nUG9pbnRzQXRNaXNzaW5nUGVuZGluZyA/IHVuZGVmaW5lZCA6IGJvdW5kUHJlZmFiVXVpZCxcclxuICAgICAgICBjbGVhclBlbmRpbmc6IHRydWUsXHJcbiAgICAgICAgY2xlYXJCaW5kaW5nOiBiaW5kaW5nUG9pbnRzQXRNaXNzaW5nUGVuZGluZyxcclxuICAgIH07XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBwcmVmYWJKc29uQ29udGFpbnNTeW5jUmVjb3JkKFxyXG4gICAgY29udGVudHM6IHN0cmluZyB8IEJ1ZmZlcixcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZCxcclxuKTogYm9vbGVhbiB7XHJcbiAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHR5cGVvZiBjb250ZW50cyA9PT0gJ3N0cmluZycgPyBjb250ZW50cyA6IGNvbnRlbnRzLnRvU3RyaW5nKCd1dGY4JykpO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCBlbnRyaWVzID0gcGFyc2VkIGFzIEFycmF5PFJlY29yZDxzdHJpbmcsIGFueT4+O1xyXG4gICAgY29uc3QgcmVzb2x2ZSA9IChyZWY6IGFueSk6IFJlY29yZDxzdHJpbmcsIGFueT4gfCB1bmRlZmluZWQgPT4gTnVtYmVyLmlzSW50ZWdlcihyZWY/Ll9faWRfXylcclxuICAgICAgICA/IGVudHJpZXNbcmVmLl9faWRfX10gOiB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCByb290SW5kZXggPSBlbnRyaWVzWzBdPy5kYXRhPy5fX2lkX187XHJcbiAgICBjb25zdCBmb3JlaWduSW5mb3MgPSBuZXcgU2V0PFJlY29yZDxzdHJpbmcsIGFueT4+KCk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgZW50cmllcykge1xyXG4gICAgICAgIGlmIChpdGVtPy5fX3R5cGVfXyA9PT0gJ2NjLlByZWZhYkluZm8nICYmICh0eXBlb2YgaXRlbS5hc3NldD8uX191dWlkX18gPT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgIHx8IChOdW1iZXIuaXNJbnRlZ2VyKHJvb3RJbmRleCkgJiYgTnVtYmVyLmlzSW50ZWdlcihpdGVtLnJvb3Q/Ll9faWRfXykgJiYgaXRlbS5yb290Ll9faWRfXyAhPT0gcm9vdEluZGV4KSkpIHtcclxuICAgICAgICAgICAgZm9yZWlnbkluZm9zLmFkZChpdGVtKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgZW50cmllcykge1xyXG4gICAgICAgIGlmIChmb3JlaWduSW5mb3MuaGFzKHJlc29sdmUocmVzb2x2ZShpdGVtPy5ub2RlKT8uX3ByZWZhYikhKSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRJbmZvID0gcmVzb2x2ZShpdGVtLl9fcHJlZmFiKTtcclxuICAgICAgICAgICAgaWYgKGNvbXBvbmVudEluZm8pIGZvcmVpZ25JbmZvcy5hZGQoY29tcG9uZW50SW5mbyk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3Qgbm9kZUZpbGVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBwYXJzZWQpIHtcclxuICAgICAgICBpZiAoIWl0ZW0gfHwgdHlwZW9mIGl0ZW0gIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCB2YWx1ZSA9IGl0ZW0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbiAgICAgICAgaWYgKGZvcmVpZ25JbmZvcy5oYXModmFsdWUpKSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCBmaWxlSWQgPSB0eXBlb2YgdmFsdWUuZmlsZUlkID09PSAnc3RyaW5nJyA/IHZhbHVlLmZpbGVJZCA6ICcnO1xyXG4gICAgICAgIGlmICghZmlsZUlkKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCB0YXJnZXQgPSB2YWx1ZS5fX3R5cGVfXyA9PT0gJ2NjLlByZWZhYkluZm8nXHJcbiAgICAgICAgICAgID8gbm9kZUZpbGVJZHNcclxuICAgICAgICAgICAgOiB2YWx1ZS5fX3R5cGVfXyA9PT0gJ2NjLkNvbXBQcmVmYWJJbmZvJ1xyXG4gICAgICAgICAgICAgICAgPyBjb21wb25lbnRGaWxlSWRzXHJcbiAgICAgICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgaWYgKCF0YXJnZXQpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0YXJnZXQuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0YXJnZXQuYWRkKGZpbGVJZCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBleHBlY3RlZE5vZGVzID0gbmV3IFNldChbXHJcbiAgICAgICAgcmVjb3JkLnJvb3RGaWxlSWQsXHJcbiAgICAgICAgLi4uT2JqZWN0LnZhbHVlcyhyZWNvcmQubm9kZUZpbGVJZHMpLFxyXG4gICAgICAgIC4uLnJlY29yZC5tYW5hZ2VkTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgLi4ucmVjb3JkLm1hbmFnZWRIZWxwZXJGaWxlSWRzLFxyXG4gICAgXSk7XHJcbiAgICBpZiAoIVsuLi5leHBlY3RlZE5vZGVzXS5ldmVyeSgoZmlsZUlkKSA9PiBub2RlRmlsZUlkcy5oYXMoZmlsZUlkKSlcclxuICAgICAgICB8fCAhcmVjb3JkLm1hbmFnZWRDb21wb25lbnRGaWxlSWRzLmV2ZXJ5KChmaWxlSWQpID0+IGNvbXBvbmVudEZpbGVJZHMuaGFzKGZpbGVJZCkpKSByZXR1cm4gZmFsc2U7XHJcbiAgICBmb3IgKGNvbnN0IFtjYXJyaWVySWQsIGF0dGFjaG1lbnRdIG9mIE9iamVjdC5lbnRyaWVzKHJlY29yZC5wcmVmYWJJbnN0YW5jZXMgPz8ge30pKSB7XHJcbiAgICAgICAgY29uc3QgY2FycmllcnMgPSBlbnRyaWVzLmZpbHRlcigobm9kZSkgPT4gbm9kZT8uX190eXBlX18gPT09ICdjYy5Ob2RlJ1xyXG4gICAgICAgICAgICAmJiAhZm9yZWlnbkluZm9zLmhhcyhyZXNvbHZlKG5vZGUuX3ByZWZhYikhKSAmJiByZXNvbHZlKG5vZGUuX3ByZWZhYik/LmZpbGVJZCA9PT0gY2FycmllcklkKTtcclxuICAgICAgICBpZiAoY2FycmllcnMubGVuZ3RoICE9PSAxIHx8ICFBcnJheS5pc0FycmF5KGNhcnJpZXJzWzBdLl9jaGlsZHJlbikpIHJldHVybiBmYWxzZTtcclxuICAgICAgICBjb25zdCBtYXRjaGVzID0gY2FycmllcnNbMF0uX2NoaWxkcmVuLmZpbHRlcigocmVmOiB1bmtub3duKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkID0gcmVzb2x2ZShyZWYpO1xyXG4gICAgICAgICAgICBjb25zdCBpbmZvID0gcmVzb2x2ZShjaGlsZD8uX3ByZWZhYik7XHJcbiAgICAgICAgICAgIGNvbnN0IGluc3RhbmNlID0gcmVzb2x2ZShpbmZvPy5pbnN0YW5jZSk7XHJcbiAgICAgICAgICAgIHJldHVybiBpbmZvICYmIGNoaWxkICYmIHJlc29sdmUoaW5mby5yb290KSA9PT0gY2hpbGRcclxuICAgICAgICAgICAgICAgICYmIG5vcm1hbGl6ZUNvY29zVXVpZChTdHJpbmcoaW5mby5hc3NldD8uX191dWlkX18gPz8gJycpKSA9PT0gbm9ybWFsaXplQ29jb3NVdWlkKGF0dGFjaG1lbnQuYXNzZXRVdWlkKVxyXG4gICAgICAgICAgICAgICAgJiYgaW5zdGFuY2U/Ll9fdHlwZV9fID09PSAnY2MuUHJlZmFiSW5zdGFuY2UnICYmIGluc3RhbmNlLmZpbGVJZCA9PT0gYXR0YWNobWVudC5pbnN0YW5jZUZpbGVJZDtcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAobWF0Y2hlcy5sZW5ndGggIT09IDEpIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjbGVhblByZWZhYk5hbWUodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gdmFsdWUucmVwbGFjZSgvW1xcdTAwMDAtXFx1MDAxZi9cXFxcXS9nLCAnICcpLnJlcGxhY2UoL1xccysvZywgJyAnKS50cmltKCkuc2xpY2UoMCwgOTYpXHJcbiAgICAgICAgfHwgJ0ZpZ21hUHJlZmFiJztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZU1pbmltYWxQcmVmYWJKc29uKFxyXG4gICAgbmFtZTogc3RyaW5nLFxyXG4gICAgZnJhbWU6IFJlY3QsXHJcbiAgICByb290RmlsZUlkOiBzdHJpbmcsXHJcbiAgICByb290VHJhbnNmb3JtRmlsZUlkOiBzdHJpbmcsXHJcbik6IHN0cmluZyB7XHJcbiAgICBjb25zdCBzYWZlUm9vdEZpbGVJZCA9IGNsZWFuRmlsZUlkKHJvb3RGaWxlSWQsICdyb290RmlsZUlkJyk7XHJcbiAgICBjb25zdCBzYWZlVHJhbnNmb3JtRmlsZUlkID0gY2xlYW5GaWxlSWQocm9vdFRyYW5zZm9ybUZpbGVJZCwgJ3Jvb3RUcmFuc2Zvcm1GaWxlSWQnKTtcclxuICAgIGNvbnN0IHdpZHRoID0gTnVtYmVyLmlzRmluaXRlKGZyYW1lLndpZHRoKSA/IE1hdGgubWF4KDAsIGZyYW1lLndpZHRoKSA6IDA7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBOdW1iZXIuaXNGaW5pdGUoZnJhbWUuaGVpZ2h0KSA/IE1hdGgubWF4KDAsIGZyYW1lLmhlaWdodCkgOiAwO1xyXG4gICAgY29uc3Qgc2FmZU5hbWUgPSBjbGVhblByZWZhYk5hbWUobmFtZSk7XHJcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoW1xyXG4gICAgICAgIHtcclxuICAgICAgICAgICAgX190eXBlX186ICdjYy5QcmVmYWInLFxyXG4gICAgICAgICAgICBfbmFtZTogc2FmZU5hbWUsXHJcbiAgICAgICAgICAgIF9vYmpGbGFnczogMCxcclxuICAgICAgICAgICAgX19lZGl0b3JFeHRyYXNfXzoge30sXHJcbiAgICAgICAgICAgIF9uYXRpdmU6ICcnLFxyXG4gICAgICAgICAgICBkYXRhOiB7IF9faWRfXzogMSB9LFxyXG4gICAgICAgICAgICBvcHRpbWl6YXRpb25Qb2xpY3k6IDAsXHJcbiAgICAgICAgICAgIHBlcnNpc3RlbnQ6IGZhbHNlLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgICBfX3R5cGVfXzogJ2NjLk5vZGUnLFxyXG4gICAgICAgICAgICBfbmFtZTogc2FmZU5hbWUsXHJcbiAgICAgICAgICAgIF9vYmpGbGFnczogMCxcclxuICAgICAgICAgICAgX19lZGl0b3JFeHRyYXNfXzoge30sXHJcbiAgICAgICAgICAgIF9wYXJlbnQ6IG51bGwsXHJcbiAgICAgICAgICAgIF9jaGlsZHJlbjogW10sXHJcbiAgICAgICAgICAgIF9hY3RpdmU6IHRydWUsXHJcbiAgICAgICAgICAgIF9jb21wb25lbnRzOiBbeyBfX2lkX186IDIgfV0sXHJcbiAgICAgICAgICAgIF9wcmVmYWI6IHsgX19pZF9fOiA0IH0sXHJcbiAgICAgICAgICAgIF9scG9zOiB7IF9fdHlwZV9fOiAnY2MuVmVjMycsIHg6IDAsIHk6IDAsIHo6IDAgfSxcclxuICAgICAgICAgICAgX2xyb3Q6IHsgX190eXBlX186ICdjYy5RdWF0JywgeDogMCwgeTogMCwgejogMCwgdzogMSB9LFxyXG4gICAgICAgICAgICBfbHNjYWxlOiB7IF9fdHlwZV9fOiAnY2MuVmVjMycsIHg6IDEsIHk6IDEsIHo6IDEgfSxcclxuICAgICAgICAgICAgX21vYmlsaXR5OiAwLFxyXG4gICAgICAgICAgICBfbGF5ZXI6IDEwNzM3NDE4MjQsXHJcbiAgICAgICAgICAgIF9ldWxlcjogeyBfX3R5cGVfXzogJ2NjLlZlYzMnLCB4OiAwLCB5OiAwLCB6OiAwIH0sXHJcbiAgICAgICAgICAgIF9pZDogJycsXHJcbiAgICAgICAgfSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIF9fdHlwZV9fOiAnY2MuVUlUcmFuc2Zvcm0nLFxyXG4gICAgICAgICAgICBfbmFtZTogJycsXHJcbiAgICAgICAgICAgIF9vYmpGbGFnczogMCxcclxuICAgICAgICAgICAgX19lZGl0b3JFeHRyYXNfXzoge30sXHJcbiAgICAgICAgICAgIG5vZGU6IHsgX19pZF9fOiAxIH0sXHJcbiAgICAgICAgICAgIF9lbmFibGVkOiB0cnVlLFxyXG4gICAgICAgICAgICBfX3ByZWZhYjogeyBfX2lkX186IDMgfSxcclxuICAgICAgICAgICAgX2NvbnRlbnRTaXplOiB7IF9fdHlwZV9fOiAnY2MuU2l6ZScsIHdpZHRoLCBoZWlnaHQgfSxcclxuICAgICAgICAgICAgX2FuY2hvclBvaW50OiB7IF9fdHlwZV9fOiAnY2MuVmVjMicsIHg6IDAuNSwgeTogMC41IH0sXHJcbiAgICAgICAgICAgIF9pZDogJycsXHJcbiAgICAgICAgfSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIF9fdHlwZV9fOiAnY2MuQ29tcFByZWZhYkluZm8nLFxyXG4gICAgICAgICAgICBmaWxlSWQ6IHNhZmVUcmFuc2Zvcm1GaWxlSWQsXHJcbiAgICAgICAgfSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIF9fdHlwZV9fOiAnY2MuUHJlZmFiSW5mbycsXHJcbiAgICAgICAgICAgIHJvb3Q6IHsgX19pZF9fOiAxIH0sXHJcbiAgICAgICAgICAgIGFzc2V0OiB7IF9faWRfXzogMCB9LFxyXG4gICAgICAgICAgICBmaWxlSWQ6IHNhZmVSb290RmlsZUlkLFxyXG4gICAgICAgICAgICBpbnN0YW5jZTogbnVsbCxcclxuICAgICAgICAgICAgdGFyZ2V0T3ZlcnJpZGVzOiBudWxsLFxyXG4gICAgICAgIH0sXHJcbiAgICBdLCBudWxsLCAyKTtcclxufVxyXG4iXX0=