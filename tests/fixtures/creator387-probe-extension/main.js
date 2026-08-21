'use strict';

const { writeFile } = require('fs/promises');
const { join } = require('path');

const PREFAB_UUID = '2d63d5c0-9a46-42ae-bda6-b17f784889cc';
const RESULT_PATH = () => join(Editor.Project.path, 'roundtrip-probe-result.json');

function importerModule(relativePath) {
    return require(join(Editor.Project.path, 'extensions', 'figma-importer-cocos', 'dist', 'roundtrip', relativePath));
}

function baseline(createSyncId) {
    const locator = {
        ownerPrefabUuid: PREFAB_UUID,
        sourcePrefabUuid: PREFAB_UUID,
        instanceChain: [],
        nodeFileId: 'fixture-root-file-id',
    };
    const syncId = createSyncId(locator);
    return {
        schemaVersion: 1,
        prefabUuid: PREFAB_UUID,
        nodes: [{
            syncId,
            locator,
            componentLocators: {
                uiTransform: {
                    strategy: 'comp-prefab-file-id',
                    componentType: 'cc.UITransform',
                    fileId: 'fixture-ui-transform',
                },
            },
            cocosStructure: { parentNodeFileId: null, siblingIndex: 0 },
            position: { x: 10, y: 20 },
            contentSize: { width: 100, height: 50 },
            editable: ['position.xy', 'contentSize.wh'],
            geometry: {
                mappingVersion: 1,
                sourceAnchor: { x: 0.5, y: 0.5 },
                sourceScale: { x: 1, y: 1 },
                figmaBaselineLocalRect: { x: -40, y: -45, width: 100, height: 50 },
                parentSyncId: null,
                figmaBaselineRelativeTransform: [[1, 0, -40], [0, 1, -45]],
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

async function queryImportedAsset(editorAssetDb) {
    let last;
    for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
            last = await editorAssetDb.queryAssetInfo(PREFAB_UUID);
            if (last?.imported && !last.invalid) return last;
        } catch (error) {
            last = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`AssetDB UUID query did not become ready: ${String(last)}`);
}

async function queryTargetSafety(editorRoundtripTargetSafety) {
    let result;
    for (let attempt = 0; attempt < 80; attempt += 1) {
        result = await editorRoundtripTargetSafety.check(PREFAB_UUID);
        if (result.safe || result.blocker !== 'TARGET_EDITOR_STATE_UNAVAILABLE') return result;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return result;
}

async function runProbe() {
    const { editorAssetDb, projectCocosPrefab, readCocosPrefabByUuid } = importerModule('cocos-reader.js');
    const { createDiff3Plan } = importerModule('diff3.js');
    const { createGenesisLedger, readLedgerEntry } = importerModule('ledger.js');
    const { createSyncId } = importerModule('protocol.js');
    const { editorRoundtripTargetSafety } = importerModule('service.js');
    const { applyRoundtripTransaction, editorReimporter } = importerModule('transaction.js');
    const assetInfo = await queryImportedAsset(editorAssetDb);
    const targetSafety = await queryTargetSafety(editorRoundtripTargetSafety);
    if (!targetSafety?.safe) throw new Error(`Target safety rejected isolated fixture: ${JSON.stringify(targetSafety)}`);
    const canonical = baseline(createSyncId);
    const identity = {
        fileKey: 'creator387-isolated-probe',
        surfaceId: '00000000-0000-4000-8000-000000000002',
        prefabUuid: PREFAB_UUID,
    };
    const target = await readCocosPrefabByUuid({
        projectRoot: Editor.Project.path,
        prefabUuid: PREFAB_UUID,
        baseline: canonical.nodes,
        assetDb: editorAssetDb,
    });
    await createGenesisLedger({
        projectRoot: Editor.Project.path,
        identity,
        managedRootNodeId: '1:1',
        baseline: canonical,
        figmaVersion: 'creator387-probe-v1',
        cocosPostimageHash: target.sourceHash,
        txnId: 'creator387-probe-pair',
    });
    const figma = target.nodes.map((node) => ({
        ...node,
        position: { x: 35, y: 20 },
        contentSize: { width: 125, height: 50 },
    }));
    const plan = createDiff3Plan({ baseline: canonical.nodes, figma, cocos: target.nodes });
    const receipt = await applyRoundtripTransaction({
        projectRoot: Editor.Project.path,
        creatorVersion: Editor.App.version,
        assetDb: editorAssetDb,
        reimporter: editorReimporter,
        identity,
        managedRootNodeId: '1:1',
        figmaVersion: 'creator387-probe-v2',
        expectedLedgerGeneration: 1,
        txnId: 'creator387-probe-apply',
        target,
        baseline: canonical,
        plan,
        assertTargetSafe: async () => {
            const safety = await editorRoundtripTargetSafety.check(PREFAB_UUID);
            if (!safety.safe) throw new Error(safety.blocker ?? 'TARGET_EDITOR_STATE_UNAVAILABLE');
        },
    });
    const refreshed = await readCocosPrefabByUuid({
        projectRoot: Editor.Project.path,
        prefabUuid: PREFAB_UUID,
        baseline: canonical.nodes,
        assetDb: editorAssetDb,
    });
    const post = projectCocosPrefab(refreshed.prefabBytes, refreshed.metaBytes, canonical.nodes, PREFAB_UUID);
    const ledger = await readLedgerEntry(Editor.Project.path, identity);
    return {
        ok: true,
        creatorVersion: Editor.App.version,
        asset: {
            uuid: assetInfo.uuid,
            url: assetInfo.url,
            importer: assetInfo.importer,
            type: assetInfo.type,
            imported: assetInfo.imported,
            invalid: assetInfo.invalid,
        },
        targetSafety,
        preimageHash: receipt.prefabPreimageHash,
        postimageHash: receipt.prefabPostimageHash,
        preserveProjectionHash: post.preserveProjectionHash,
        appliedKinds: receipt.applied.map((operation) => operation.kind),
        finalNode: post.nodes[0],
        ledgerGeneration: ledger?.entry.generation,
        ledgerTxnId: ledger?.entry.lastTxnId,
        receiptStatus: receipt.status,
    };
}

exports.methods = {
    async runProbe() {
        try {
            const result = await runProbe();
            await writeFile(RESULT_PATH(), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
            console.log(`ROUNDTRIP_S0_PROBE_SUCCESS ${JSON.stringify(result)}`);
        } catch (error) {
            const result = { ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) };
            await writeFile(RESULT_PATH(), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
            console.error(`ROUNDTRIP_S0_PROBE_FAILURE ${JSON.stringify(result)}`);
        }
    },
};

exports.load = function load() {};

exports.unload = function unload() {};
