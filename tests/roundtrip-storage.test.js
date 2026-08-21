'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    symlink,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const {
    STORAGE_TEMP_FILE_SUFFIX,
    ExclusiveFileLockError,
    acquireExclusiveFileLockWithin,
    atomicReplaceWithin,
    createExactBackupWithin,
    restoreExactBackupWithin,
} = require('../dist/roundtrip/storage-primitives');

async function withTemporaryRoot(run) {
    const root = await mkdtemp(join(tmpdir(), 'figma-roundtrip-storage-'));
    try {
        await run(resolve(root));
    } finally {
        const safeRoot = resolve(root);
        assert.equal(safeRoot.startsWith(resolve(tmpdir())), true);
        await rm(safeRoot, { recursive: true, force: true });
    }
}

test('atomically creates and replaces exact bytes without leaving sibling temporaries', async () => {
    await withTemporaryRoot(async (root) => {
        const target = join(root, 'state', 'value.bin');
        await atomicReplaceWithin(root, target, Buffer.from('first'));
        await atomicReplaceWithin(root, target, Buffer.from([0, 255, 10, 13]));

        assert.deepEqual(await readFile(target), Buffer.from([0, 255, 10, 13]));
        const siblings = await readdir(dirname(target));
        assert.equal(siblings.some((name) => name.endsWith(STORAGE_TEMP_FILE_SUFFIX)), false);
    });
});

test('creates an immutable byte backup and restores it exactly after replacement', async () => {
    await withTemporaryRoot(async (root) => {
        const target = join(root, 'assets', 'fixture.prefab');
        const backup = join(root, 'state', 'backups', 'fixture.prefab');
        const original = Buffer.from('\ufeff[\r\n  {"bytes":"原始"}\r\n]\r\n', 'utf8');

        await atomicReplaceWithin(root, target, original);
        await createExactBackupWithin(root, target, backup);
        await assert.rejects(
            createExactBackupWithin(root, target, backup),
            (error) => error && error.code === 'EEXIST',
        );
        await atomicReplaceWithin(root, target, Buffer.from('changed'));
        await restoreExactBackupWithin(root, backup, target);

        assert.deepEqual(await readFile(target), original);
        assert.deepEqual(await readFile(backup), original);
    });
});

test('enforces one exclusive lock owner and supports idempotent release', async () => {
    await withTemporaryRoot(async (root) => {
        const lockPath = join(root, 'state', 'locks', 'fixture.lock');
        const first = await acquireExclusiveFileLockWithin(root, lockPath, Buffer.from('owner-a'));

        await assert.rejects(
            acquireExclusiveFileLockWithin(root, lockPath, Buffer.from('owner-b')),
            (error) => error instanceof ExclusiveFileLockError
                && error.code === 'LOCK_ALREADY_HELD',
        );

        await first.release();
        await first.release();
        const second = await acquireExclusiveFileLockWithin(root, lockPath, Buffer.from('owner-b'));
        await second.release();
    });
});

test('refuses to release a lock whose owner bytes were replaced', async () => {
    await withTemporaryRoot(async (root) => {
        const lockPath = join(root, 'state', 'locks', 'fixture.lock');
        const lock = await acquireExclusiveFileLockWithin(root, lockPath, Buffer.from('owner-a'));
        await atomicReplaceWithin(root, lockPath, Buffer.from('owner-b'));

        await assert.rejects(lock.release(), /所有者信息已变化/);
        assert.deepEqual(await readFile(lockPath), Buffer.from('owner-b'));
    });
});

test('rejects lexical path escape before creating or modifying files', async () => {
    await withTemporaryRoot(async (root) => {
        const outside = resolve(root, '..', `${Date.now()}-roundtrip-escape.bin`);
        await assert.rejects(
            atomicReplaceWithin(root, outside, Buffer.from('forbidden')),
            /必须位于允许写入的根目录内/,
        );
        await assert.rejects(readFile(outside), (error) => error && error.code === 'ENOENT');
    });
});

test('rejects a contained-looking path whose parent resolves outside through a link', async (context) => {
    await withTemporaryRoot(async (root) => {
        const outside = await mkdtemp(join(tmpdir(), 'figma-roundtrip-outside-'));
        try {
            const linkedParent = join(root, 'linked-parent');
            try {
                await mkdir(outside, { recursive: true });
                await symlink(outside, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                    context.skip(`当前系统不允许创建测试链接：${error.code}`);
                    return;
                }
                throw error;
            }

            await assert.rejects(
                atomicReplaceWithin(
                    root,
                    join(linkedParent, 'must-not-be-created', 'escape.bin'),
                    Buffer.from('forbidden'),
                ),
                /符号链接目录/,
            );
            await assert.rejects(
                readFile(join(outside, 'must-not-be-created', 'escape.bin')),
                (error) => error && error.code === 'ENOENT',
            );
            await assert.rejects(
                readdir(join(outside, 'must-not-be-created')),
                (error) => error && error.code === 'ENOENT',
            );
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});
