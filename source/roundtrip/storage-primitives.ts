import { randomBytes } from 'crypto';
import { constants } from 'fs';
import {
    access,
    lstat,
    mkdir,
    open,
    readFile,
    realpath,
    rename,
    rm,
    unlink,
} from 'fs/promises';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'path';

const TEMP_SUFFIX = '.roundtrip-tmp';

function errno(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

function normalizeAbsolutePath(input: string, label: string): string {
    const value = input.trim();
    if (!value || !isAbsolute(value)) {
        throw new Error(`${label}必须是绝对路径。`);
    }
    const normalized = resolve(value);
    if (normalized === parse(normalized).root) {
        throw new Error(`${label}不能是磁盘根目录。`);
    }
    return normalized;
}

function isInside(root: string, target: string): boolean {
    const path = relative(root, target);
    return Boolean(path) && path !== '..' && !path.startsWith(`..${sep}`)
        && !isAbsolute(path);
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch (error) {
        if (errno(error) === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function syncDirectory(path: string): Promise<void> {
    let handle;
    try {
        handle = await open(path, 'r');
        await handle.sync();
    } catch (error) {
        if (!['EACCES', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(errno(error) ?? '')) {
            throw error;
        }
    } finally {
        await handle?.close();
    }
}

interface PreparedPath {
    target: string;
    parent: string;
}

async function prepareContainedPath(rootInput: string, targetInput: string): Promise<PreparedPath> {
    const root = normalizeAbsolutePath(rootInput, '允许写入的根目录');
    const target = normalizeAbsolutePath(targetInput, '目标路径');
    if (!isInside(root, target)) {
        throw new Error('目标路径必须位于允许写入的根目录内。');
    }

    const rootRealPath = await realpath(root);
    const segments = relative(root, target).split(sep);
    const fileName = segments.pop();
    if (!fileName || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error('目标路径包含无效的目录段。');
    }

    let parentRealPath = rootRealPath;
    for (const segment of segments) {
        const next = resolve(parentRealPath, segment);
        let info;
        try {
            info = await lstat(next);
        } catch (error) {
            if (errno(error) !== 'ENOENT') {
                throw error;
            }
            try {
                await mkdir(next);
            } catch (mkdirError) {
                if (errno(mkdirError) !== 'EEXIST') {
                    throw mkdirError;
                }
            }
            info = await lstat(next);
        }
        if (info.isSymbolicLink()) {
            throw new Error('目标路径包含符号链接目录。');
        }
        if (!info.isDirectory()) {
            throw new Error('目标路径的父级必须是目录。');
        }
        parentRealPath = await realpath(next);
        if (!isInside(rootRealPath, parentRealPath) && parentRealPath !== rootRealPath) {
            throw new Error('目标路径经过符号链接后越出了允许写入的根目录。');
        }
    }

    const canonicalTarget = resolve(parentRealPath, fileName);
    if (await exists(canonicalTarget)) {
        const info = await lstat(canonicalTarget);
        if (info.isSymbolicLink()) {
            throw new Error('目标文件不能是符号链接。');
        }
        if (!info.isFile()) {
            throw new Error('目标路径必须是普通文件。');
        }
    }

    return {
        target: canonicalTarget,
        parent: parentRealPath,
    };
}

function tempPath(target: string): string {
    const nonce = randomBytes(12).toString('hex');
    return resolve(dirname(target), `.${basename(target)}.${process.pid}.${nonce}${TEMP_SUFFIX}`);
}

async function writeExclusiveFile(path: string, contents: Buffer): Promise<void> {
    const handle = await open(path, 'wx', 0o600);
    let complete = false;
    try {
        await handle.writeFile(contents);
        await handle.sync();
        complete = true;
    } finally {
        try {
            await handle.close();
        } finally {
            if (!complete) {
                await rm(path, { force: true });
            }
        }
    }
}

/**
 * Replaces one regular file using a fully-written sibling temporary file.
 * The caller supplies the containment root so every future writer can share
 * the same path-escape and symlink checks without importing protocol state.
 */
export async function atomicReplaceWithin(
    root: string,
    target: string,
    contents: Buffer,
): Promise<void> {
    const prepared = await prepareContainedPath(root, target);
    const temporary = tempPath(prepared.target);
    try {
        await writeExclusiveFile(temporary, contents);
        await rename(temporary, prepared.target);
        await syncDirectory(prepared.parent);
    } finally {
        await rm(temporary, { force: true });
    }
}

/** Writes a durable file exactly once. Existing destinations are never replaced. */
export async function writeNewFileWithin(
    root: string,
    target: string,
    contents: Buffer,
): Promise<void> {
    const prepared = await prepareContainedPath(root, target);
    await writeExclusiveFile(prepared.target, contents);
    await syncDirectory(prepared.parent);
}

/** Copies exact source bytes to a destination that must not already exist. */
export async function createExactBackupWithin(
    root: string,
    source: string,
    backup: string,
): Promise<void> {
    const preparedSource = await prepareContainedPath(root, source);
    if (!await exists(preparedSource.target)) {
        throw new Error('备份源文件不存在。');
    }
    await writeNewFileWithin(root, backup, await readFile(preparedSource.target));
}

/** Restores exact backup bytes via atomic replacement and verifies the result. */
export async function restoreExactBackupWithin(
    root: string,
    backup: string,
    target: string,
): Promise<void> {
    const preparedBackup = await prepareContainedPath(root, backup);
    if (!await exists(preparedBackup.target)) {
        throw new Error('恢复所需的备份文件不存在。');
    }
    const expected = await readFile(preparedBackup.target);
    await atomicReplaceWithin(root, target, expected);
    const restored = await readFile((await prepareContainedPath(root, target)).target);
    if (!restored.equals(expected)) {
        throw new Error('恢复后的文件内容与备份不一致。');
    }
}

export class ExclusiveFileLockError extends Error {
    readonly code = 'LOCK_ALREADY_HELD';

    constructor(path: string) {
        super(`排他锁已被占用：${path}`);
        this.name = 'ExclusiveFileLockError';
    }
}

export interface ExclusiveFileLock {
    readonly path: string;
    release(): Promise<void>;
}

/**
 * Acquires an exclusive create-file lock containing caller-defined opaque
 * bytes. Release refuses to delete a lock whose bytes no longer match.
 */
export async function acquireExclusiveFileLockWithin(
    root: string,
    lockPath: string,
    ownerBytes: Buffer,
): Promise<ExclusiveFileLock> {
    try {
        await writeNewFileWithin(root, lockPath, ownerBytes);
    } catch (error) {
        if (errno(error) === 'EEXIST') {
            throw new ExclusiveFileLockError(lockPath);
        }
        throw error;
    }

    const prepared = await prepareContainedPath(root, lockPath);
    let released = false;
    return {
        path: prepared.target,
        async release(): Promise<void> {
            if (released) {
                return;
            }
            const current = await readFile(prepared.target);
            if (!current.equals(ownerBytes)) {
                throw new Error('锁文件所有者信息已变化，拒绝释放。');
            }
            await unlink(prepared.target);
            await syncDirectory(prepared.parent);
            released = true;
        },
    };
}

/** Removes only the exact stale lock bytes supplied by crash recovery. */
export async function removeOwnedFileLockWithin(
    root: string,
    lockPath: string,
    expectedOwnerBytes: Buffer,
): Promise<void> {
    const prepared = await prepareContainedPath(root, lockPath);
    const current = await readFile(prepared.target);
    if (!current.equals(expectedOwnerBytes)) throw new Error('锁文件所有者信息不匹配，拒绝清理。');
    await unlink(prepared.target);
    await syncDirectory(prepared.parent);
}

export const STORAGE_TEMP_FILE_SUFFIX = TEMP_SUFFIX;
