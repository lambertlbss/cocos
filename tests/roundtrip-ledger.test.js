'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createSyncId } = require('../dist/roundtrip/protocol');
const {
    advanceLedger,
    createGenesisLedger,
    ledgerIdentityKey,
    readLedgerEntry,
} = require('../dist/roundtrip/ledger');

const identity = {
    fileKey: 'redacted-file-key',
    surfaceId: '00000000-0000-4000-8000-000000000002',
    prefabUuid: '01234567-89ab-cdef-0123-456789abcdef',
};

function baseline(width = 100) {
    const locator = {
        ownerPrefabUuid: identity.prefabUuid,
        sourcePrefabUuid: identity.prefabUuid,
        instanceChain: [],
        nodeFileId: 'root-file-id',
    };
    const syncId = createSyncId(locator);
    return {
        schemaVersion: 1,
        prefabUuid: identity.prefabUuid,
        nodes: [{
            syncId,
            locator,
            componentLocators: {},
            cocosStructure: { parentNodeFileId: null, siblingIndex: 0 },
            contentSize: { width, height: 50 },
            editable: [],
            geometry: {
                mappingVersion: 1,
                sourceAnchor: { x: 0.5, y: 0.5 },
                sourceScale: { x: 1, y: 1 },
                figmaBaselineLocalRect: { x: 0, y: 0, width, height: 50 },
                parentSyncId: null,
                figmaBaselineRelativeTransform: [[1, 0, 0], [0, 1, 0]],
                dependencySyncIds: [],
                dependencyHash: `sha256:${'0'.repeat(64)}`,
            },
        }],
        visualManifest: [{
            visualId: 'cfv1:00000000-0000-4000-8000-000000000001',
            role: 'direct',
            syncId,
            parentVisualId: null,
            siblingOrder: 0,
            figmaNodeType: 'FRAME',
            readonlyVisualFingerprint: `sha256:${'0'.repeat(64)}`,
        }],
        resources: [],
    };
}

async function temporaryProject(run) {
    const root = await mkdtemp(join(tmpdir(), 'figma-roundtrip-ledger-'));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('ledger creates immutable genesis and reads its content-addressed baseline', async () => {
    await temporaryProject(async (projectRoot) => {
        const entry = await createGenesisLedger({
            projectRoot,
            identity,
            managedRootNodeId: '1:1',
            baseline: baseline(),
            figmaVersion: 'v1',
            cocosPostimageHash: `sha256:${'1'.repeat(64)}`,
            txnId: 'pair-1',
        });
        assert.equal(entry.generation, 1);
        assert.equal(entry.baselineFile, `baselines/${entry.baselineHash.slice(7)}.json`);
        const loaded = await readLedgerEntry(projectRoot, identity);
        assert.equal(loaded.entry.baselineHash, entry.baselineHash);
        assert.equal(loaded.baseline.nodes[0].contentSize.width, 100);
        await assert.rejects(createGenesisLedger({
            projectRoot,
            identity,
            managedRootNodeId: '1:1',
            baseline: baseline(),
            figmaVersion: 'v1',
            cocosPostimageHash: `sha256:${'1'.repeat(64)}`,
            txnId: 'pair-2',
        }), /重复建立 genesis/);
    });
});

test('ledger advances monotonically and rejects a stale generation', async () => {
    await temporaryProject(async (projectRoot) => {
        await createGenesisLedger({
            projectRoot,
            identity,
            managedRootNodeId: '1:1',
            baseline: baseline(),
            figmaVersion: 'v1',
            cocosPostimageHash: `sha256:${'1'.repeat(64)}`,
            txnId: 'pair-1',
        });
        const next = await advanceLedger({
            projectRoot,
            identity,
            expectedGeneration: 1,
            managedRootNodeId: '1:1',
            baseline: baseline(120),
            figmaVersion: 'v2',
            cocosPostimageHash: `sha256:${'2'.repeat(64)}`,
            txnId: 'apply-1',
        });
        assert.equal(next.generation, 2);
        await assert.rejects(advanceLedger({
            projectRoot,
            identity,
            expectedGeneration: 1,
            managedRootNodeId: '1:1',
            baseline: baseline(130),
            figmaVersion: 'v3',
            cocosPostimageHash: `sha256:${'3'.repeat(64)}`,
            txnId: 'apply-stale',
        }), /generation/);
    });
});

test('ledger fails closed on non-canonical or damaged state', async () => {
    await temporaryProject(async (projectRoot) => {
        await createGenesisLedger({
            projectRoot,
            identity,
            managedRootNodeId: '1:1',
            baseline: baseline(),
            figmaVersion: 'v1',
            cocosPostimageHash: `sha256:${'1'.repeat(64)}`,
            txnId: 'pair-1',
        });
        const path = join(projectRoot, '.cocos-figma-sync', 'ledger.json');
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        parsed.entries[ledgerIdentityKey(identity)].generation = 0;
        await writeFile(path, JSON.stringify(parsed));
        await assert.rejects(readLedgerEntry(projectRoot, identity), /canonical|generation/);
    });
});
