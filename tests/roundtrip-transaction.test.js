'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { projectCocosPrefab, readCocosPrefabByUuid } = require('../dist/roundtrip/cocos-reader');
const { createDiff3Plan } = require('../dist/roundtrip/diff3');
const { createGenesisLedger, readLedgerEntry } = require('../dist/roundtrip/ledger');
const { createSyncId } = require('../dist/roundtrip/protocol');
const { applyRoundtripTransaction } = require('../dist/roundtrip/transaction');
const { canonicalStringify, sha256 } = require('../dist/roundtrip/canonical-json');
const { recoverInterruptedTransactions } = require('../dist/roundtrip/recovery');
const { acquireExclusiveFileLockWithin, writeNewFileWithin } = require('../dist/roundtrip/storage-primitives');

const PREFAB_UUID = '01234567-89ab-cdef-0123-456789abcdef';
const identity = {
    fileKey: 'redacted-file-key',
    surfaceId: '00000000-0000-4000-8000-000000000002',
    prefabUuid: PREFAB_UUID,
};

function fixture() {
    return [
        { __type__: 'cc.Prefab', _uuid: PREFAB_UUID, data: { __id__: 1 } },
        {
            __type__: 'cc.Node',
            _name: 'Root',
            _parent: null,
            _children: [],
            _components: [{ __id__: 3 }, { __id__: 5 }],
            _prefab: { __id__: 2 },
            _lpos: { x: 10, y: 20, z: 7 },
        },
        { __type__: 'cc.PrefabInfo', fileId: 'root-file-id' },
        {
            __type__: 'cc.UITransform',
            _contentSize: { width: 100, height: 50 },
            _anchorPoint: { x: 0.5, y: 0.5 },
            __prefab: { __id__: 4 },
        },
        { __type__: 'cc.CompPrefabInfo', fileId: 'root-transform' },
        { __type__: 'ExampleScript', score: 7 },
    ];
}

function baseline() {
    const locator = {
        ownerPrefabUuid: PREFAB_UUID,
        sourcePrefabUuid: PREFAB_UUID,
        instanceChain: [],
        nodeFileId: 'root-file-id',
    };
    const syncId = createSyncId(locator);
    return {
        schemaVersion: 1,
        prefabUuid: PREFAB_UUID,
        nodes: [{
            syncId,
            locator,
            componentLocators: {
                uiTransform: { strategy: 'comp-prefab-file-id', componentType: 'cc.UITransform', fileId: 'root-transform' },
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

function bytes(value) {
    return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

async function setupProject() {
    const projectRoot = await mkdtemp(join(tmpdir(), 'figma-roundtrip-transaction-'));
    const folder = join(projectRoot, 'assets', 'ui');
    await mkdir(folder, { recursive: true });
    const prefabPath = join(folder, 'fixture.prefab');
    const metaPath = `${prefabPath}.meta`;
    const prefabBytes = bytes(fixture());
    const metaBytes = bytes({ uuid: PREFAB_UUID, importer: 'prefab' });
    await writeFile(prefabPath, prefabBytes);
    await writeFile(metaPath, metaBytes);
    const assetDb = {
        queryAssetInfo: async () => ({
            uuid: PREFAB_UUID,
            url: 'db://assets/ui/fixture.prefab',
            importer: 'prefab',
            type: 'cc.Prefab',
            imported: true,
            invalid: false,
        }),
    };
    const target = await readCocosPrefabByUuid({ projectRoot, prefabUuid: PREFAB_UUID, baseline: baseline().nodes, assetDb });
    await createGenesisLedger({
        projectRoot,
        identity,
        managedRootNodeId: '1:1',
        baseline: baseline(),
        figmaVersion: 'v1',
        cocosPostimageHash: target.sourceHash,
        txnId: 'pair-fixture',
    });
    const state = target.nodes[0];
    const plan = createDiff3Plan({
        baseline: baseline().nodes,
        figma: [{ ...state, position: { x: 30, y: 20 }, contentSize: { width: 120, height: 50 } }],
        cocos: target.nodes,
    });
    return { projectRoot, prefabPath, metaBytes, assetDb, target, plan };
}

test('transaction writes only whitelisted leaves, audits and advances ledger', async () => {
    const setup = await setupProject();
    try {
        const receipt = await applyRoundtripTransaction({
            projectRoot: setup.projectRoot,
            creatorVersion: '3.8.7',
            assetDb: setup.assetDb,
            reimporter: { reimportAsset: async () => undefined },
            identity,
            managedRootNodeId: '1:1',
            figmaVersion: 'v2',
            expectedLedgerGeneration: 1,
            txnId: 'apply-success',
            target: setup.target,
            baseline: baseline(),
            plan: setup.plan,
        });
        assert.equal(receipt.status, 'committed');
        const post = projectCocosPrefab(await readFile(setup.prefabPath), setup.metaBytes, baseline().nodes, PREFAB_UUID);
        assert.deepEqual(post.nodes[0].position, { x: 30, y: 20 });
        assert.deepEqual(post.nodes[0].contentSize, { width: 120, height: 50 });
        assert.equal(post.serialized[5].score, 7);
        const ledger = await readLedgerEntry(setup.projectRoot, identity);
        assert.equal(ledger.entry.generation, 2);
        assert.deepEqual(ledger.baseline.nodes[0].position, { x: 30, y: 20 });
    } finally {
        await rm(setup.projectRoot, { recursive: true, force: true });
    }
});

test('transaction restores exact bytes and leaves ledger unchanged after reimport failure', async () => {
    const setup = await setupProject();
    try {
        const original = await readFile(setup.prefabPath);
        let calls = 0;
        await assert.rejects(applyRoundtripTransaction({
            projectRoot: setup.projectRoot,
            creatorVersion: '3.8.7',
            assetDb: setup.assetDb,
            reimporter: {
                reimportAsset: async () => {
                    calls += 1;
                    if (calls === 1) throw new Error('injected reimport failure');
                },
            },
            identity,
            managedRootNodeId: '1:1',
            figmaVersion: 'v2',
            expectedLedgerGeneration: 1,
            txnId: 'apply-rollback',
            target: setup.target,
            baseline: baseline(),
            plan: setup.plan,
        }), /injected reimport failure/);
        assert.deepEqual(await readFile(setup.prefabPath), original);
        assert.equal((await readLedgerEntry(setup.projectRoot, identity)).entry.generation, 1);
        const receipt = JSON.parse(await readFile(
            join(setup.projectRoot, '.cocos-figma-sync', 'receipts', 'apply-rollback.json'),
            'utf8',
        ));
        assert.equal(receipt.status, 'rolled-back');
    } finally {
        await rm(setup.projectRoot, { recursive: true, force: true });
    }
});

test('transaction blocks unsupported Creator versions before writing', async () => {
    const setup = await setupProject();
    try {
        const original = await readFile(setup.prefabPath);
        await assert.rejects(applyRoundtripTransaction({
            projectRoot: setup.projectRoot,
            creatorVersion: '3.8.8',
            assetDb: setup.assetDb,
            reimporter: { reimportAsset: async () => undefined },
            identity,
            managedRootNodeId: '1:1',
            figmaVersion: 'v2',
            expectedLedgerGeneration: 1,
            txnId: 'wrong-version',
            target: setup.target,
            baseline: baseline(),
            plan: setup.plan,
        }), /3\.8\.7/);
        assert.deepEqual(await readFile(setup.prefabPath), original);
    } finally {
        await rm(setup.projectRoot, { recursive: true, force: true });
    }
});

test('transaction rechecks editor target safety after acquiring its lock', async () => {
    const setup = await setupProject();
    try {
        const original = await readFile(setup.prefabPath);
        await assert.rejects(applyRoundtripTransaction({
            projectRoot: setup.projectRoot,
            creatorVersion: '3.8.7',
            assetDb: setup.assetDb,
            reimporter: { reimportAsset: async () => undefined },
            identity,
            managedRootNodeId: '1:1',
            figmaVersion: 'v2',
            expectedLedgerGeneration: 1,
            txnId: 'unsafe-target',
            target: setup.target,
            baseline: baseline(),
            plan: setup.plan,
            assertTargetSafe: async () => { throw new Error('TARGET_PREFAB_LOADED_IN_EDITOR'); },
        }), /TARGET_PREFAB_LOADED_IN_EDITOR/);
        assert.deepEqual(await readFile(setup.prefabPath), original);
        assert.equal((await readLedgerEntry(setup.projectRoot, identity)).entry.generation, 1);
    } finally {
        await rm(setup.projectRoot, { recursive: true, force: true });
    }
});

test('startup recovery breaks only the exact dead-owner lock and restores prepared bytes', async () => {
    const setup = await setupProject();
    try {
        const original = await readFile(setup.prefabPath);
        const changed = Buffer.from('changed-before-crash');
        await writeFile(setup.prefabPath, changed);
        const stateRoot = join(setup.projectRoot, '.cocos-figma-sync');
        const txnId = 'crash-recovery';
        const backupRoot = join(stateRoot, 'backups', txnId);
        const prefabBackupPath = join(backupRoot, 'target.prefab');
        const metaBackupPath = join(backupRoot, 'target.prefab.meta');
        await writeNewFileWithin(setup.projectRoot, prefabBackupPath, original);
        await writeNewFileWithin(setup.projectRoot, metaBackupPath, setup.metaBytes);
        const lockPath = join(stateRoot, 'locks', 'crash.lock');
        const lockOwner = canonicalStringify({ txnId, pid: 2147483647 });
        await acquireExclusiveFileLockWithin(setup.projectRoot, lockPath, Buffer.from(lockOwner));
        const journal = {
            schemaVersion: 1,
            txnId,
            state: 'prepared',
            prefabPath: setup.prefabPath,
            metaPath: `${setup.prefabPath}.meta`,
            prefabBackupPath,
            metaBackupPath,
            prefabPreimageHash: sha256(original),
            metaPreimageHash: sha256(setup.metaBytes),
            expectedLedgerGeneration: 1,
            assetUrl: 'db://assets/ui/fixture.prefab',
            identity,
            applied: setup.plan.apply,
            lockPath,
            lockOwner,
        };
        await writeNewFileWithin(
            setup.projectRoot,
            join(stateRoot, 'journals', `${txnId}.json`),
            Buffer.from(canonicalStringify(journal)),
        );
        const recovered = await recoverInterruptedTransactions(
            setup.projectRoot,
            { reimportAsset: async () => undefined },
        );
        assert.deepEqual(recovered, [{ txnId, status: 'recovered' }]);
        assert.deepEqual(await readFile(setup.prefabPath), original);
        const receipt = JSON.parse(await readFile(join(stateRoot, 'receipts', `${txnId}.json`), 'utf8'));
        assert.equal(receipt.status, 'rolled-back');
    } finally {
        await rm(setup.projectRoot, { recursive: true, force: true });
    }
});

test('startup recovery finalizes a ledger-committed transaction instead of rolling Prefab back', async () => {
    const setup = await setupProject();
    try {
        const original = await readFile(setup.prefabPath);
        const txnId = 'commit-recovery';
        await applyRoundtripTransaction({
            projectRoot: setup.projectRoot,
            creatorVersion: '3.8.7',
            assetDb: setup.assetDb,
            reimporter: { reimportAsset: async () => undefined },
            identity,
            managedRootNodeId: '1:1',
            figmaVersion: 'v2',
            expectedLedgerGeneration: 1,
            txnId,
            target: setup.target,
            baseline: baseline(),
            plan: setup.plan,
        });
        const stateRoot = join(setup.projectRoot, '.cocos-figma-sync');
        const journalPath = join(stateRoot, 'journals', `${txnId}.json`);
        const receiptPath = join(stateRoot, 'receipts', `${txnId}.json`);
        const journal = JSON.parse(await readFile(journalPath, 'utf8'));
        journal.state = 'prepared';
        const lockOwner = canonicalStringify({ txnId, pid: 2147483647 });
        journal.lockOwner = lockOwner;
        await writeFile(journalPath, canonicalStringify(journal));
        await rm(receiptPath);
        await acquireExclusiveFileLockWithin(setup.projectRoot, journal.lockPath, Buffer.from(lockOwner));

        const committedPrefab = await readFile(setup.prefabPath);
        assert.notDeepEqual(committedPrefab, original);
        const recovered = await recoverInterruptedTransactions(
            setup.projectRoot,
            { reimportAsset: async () => { throw new Error('committed recovery must not reimport/rollback'); } },
        );
        assert.deepEqual(recovered, [{ txnId, status: 'finalized-commit' }]);
        assert.deepEqual(await readFile(setup.prefabPath), committedPrefab);
        assert.equal((await readLedgerEntry(setup.projectRoot, identity)).entry.generation, 2);
        assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).status, 'committed');
        assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).state, 'committed');
    } finally {
        await rm(setup.projectRoot, { recursive: true, force: true });
    }
});
