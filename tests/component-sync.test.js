'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNode } = require('../dist/figma/parser');
const { inferAction, inferKind } = require('../dist/figma/analyzer');
const { makeSpec } = require('../dist/main');
const { SYNC_MARKER_SCRIPT_SOURCE, SYNC_MARKER_SCRIPT_URL } = require('../dist/importer/sync-marker');
const { planSyncMarkerScript } = require('../dist/importer/sync-marker-asset');

const FILE_KEY = 'VxeomJZczEotAMsETIlXWl';

function figmaNode(overrides = {}) {
    const parsed = parseNode({
        id: '164:4754',
        name: 'btn_primary',
        type: 'COMPONENT',
        visible: true,
        absoluteBoundingBox: { x: 10, y: 20, width: 200, height: 80 },
        children: [],
        ...overrides,
    });
    assert.ok(parsed);
    return parsed;
}

function decisionsFor(roots, explicit = {}) {
    const result = new Map();
    const visit = (item) => {
        result.set(item.id, {
            action: inferAction(item),
            kind: inferKind(item),
            nineSlice: false,
            explicit: false,
            ...(explicit[item.id] ?? {}),
        });
        item.children.forEach(visit);
    };
    roots.forEach(visit);
    return result;
}

function indexNodes(roots) {
    const map = new Map();
    const visit = (item) => {
        map.set(item.id, item);
        item.children.forEach(visit);
    };
    roots.forEach(visit);
    return map;
}

test('marker script plan creates a missing script', () => {
    const plan = planSyncMarkerScript(null);
    assert.equal(plan.action, 'create');
    assert.equal(plan.content, SYNC_MARKER_SCRIPT_SOURCE);
});

test('marker script plan keeps an identical script', () => {
    assert.deepEqual(planSyncMarkerScript(SYNC_MARKER_SCRIPT_SOURCE), { action: 'keep' });
    // 行尾差异不应触发重写，避免 Windows 检出反复改动项目文件。
    const crlf = SYNC_MARKER_SCRIPT_SOURCE.replace(/\n/g, '\r\n');
    assert.deepEqual(planSyncMarkerScript(crlf), { action: 'keep' });
});

test('marker script plan rewrites an older or edited copy of the plugin script', () => {
    const older = SYNC_MARKER_SCRIPT_SOURCE.replace('标记协议版本', '标记协议版本（旧）');
    const plan = planSyncMarkerScript(older);
    assert.equal(plan.action, 'rewrite');
    assert.equal(plan.content, SYNC_MARKER_SCRIPT_SOURCE);
    assert.match(plan.reason, /重建/);
});

test('a script that lost the marker fields is treated as foreign, not silently reused', () => {
    const broken = SYNC_MARKER_SCRIPT_SOURCE.replace('public figmaSubtreeHash', 'public figmaOldHash');
    assert.equal(planSyncMarkerScript(broken).action, 'reject');
});

test('marker script plan refuses to overwrite a foreign script', () => {
    const plan = planSyncMarkerScript("import { Component } from 'cc';\nexport class SomethingElse extends Component {}\n");
    assert.equal(plan.action, 'reject');
    assert.match(plan.reason, /已被其他脚本占用/);
    assert.equal(plan.reason.includes(SYNC_MARKER_SCRIPT_URL), true);
});

test('component imports carry a sync marker, frame imports do not', () => {
    const root = figmaNode();
    const decisions = decisionsFor([root]);
    const plans = new Map([[root.id, { nodeId: root.id, role: 'root', reason: 'root-structure' }]]);
    const context = {
        root,
        decisions,
        plans,
        nodeById: indexNodes([root]),
        assets: new Map(),
        fonts: new Map(),
    };
    const withoutSync = makeSpec(root, undefined, context.decisions, context.plans,
        context.nodeById, context.assets, context.fonts, true);
    assert.equal(withoutSync.syncMarker, undefined);

    const withSync = makeSpec(root, undefined, context.decisions, context.plans,
        context.nodeById, context.assets, context.fonts, true, 0, { fileKey: FILE_KEY });
    assert.equal(withSync.syncMarker.figmaNodeId, '164:4754');
    assert.match(withSync.syncMarker.figmaFileHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(withSync.syncMarker.visualHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(withSync.syncMarker.aliasNodeIds, []);
    assert.equal(JSON.stringify(withSync).includes(FILE_KEY), false);
});

test('markers reach every generated child node', () => {
    const child = {
        id: '164:4755',
        name: 'txt_label',
        type: 'TEXT',
        visible: true,
        absoluteBoundingBox: { x: 30, y: 40, width: 100, height: 24 },
        children: [],
    };
    const root = figmaNode({ children: [child] });
    const nodeById = indexNodes([root]);
    const specs = makeSpec(root, undefined, decisionsFor([root]),
        new Map([[root.id, { nodeId: root.id, role: 'root', reason: 'root-structure' }]]),
        nodeById, new Map(), new Map(), true, 0, { fileKey: FILE_KEY });
    assert.equal(specs.children.length, 1);
    assert.equal(specs.children[0].syncMarker.figmaNodeId, '164:4755');
});

test('a folded sub-layer becomes an alias of its parent marker', () => {
    const leaf = {
        id: '164:4760',
        name: 'Rectangle 12',
        type: 'RECTANGLE',
        visible: true,
        absoluteBoundingBox: { x: 10, y: 20, width: 200, height: 80 },
        children: [],
    };
    const root = figmaNode({ children: [leaf] });
    const decisions = decisionsFor([root]);
    const plans = new Map([[root.id, {
        nodeId: root.id,
        role: 'image',
        reason: 'single-image-fold',
        kind: 'sprite',
        fold: {
            kind: 'single-image',
            sourceNodeId: leaf.id,
            absorbedNodeIds: [leaf.id],
        },
    }]]);
    const spec = makeSpec(root, undefined, decisions, plans, indexNodes([root]),
        new Map(), new Map(), true, 0, { fileKey: FILE_KEY });
    assert.equal(spec.children.length, 0);
    assert.deepEqual(spec.syncMarker.aliasNodeIds, ['164:4760']);
});
