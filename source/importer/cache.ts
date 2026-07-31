import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'path';

export interface CacheEntryKey {
    fileKey: string;
    nodeId: string;
    format: 'png' | 'svg';
    scale: number;
}

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function normalizeRoot(input: string): string {
    const value = input.trim();
    if (!value || !isAbsolute(value)) {
        throw new Error('本地缓存目录必须是绝对路径。');
    }
    const root = resolve(value);
    if (root === parse(root).root) {
        throw new Error('本地缓存目录不能直接使用磁盘根目录。');
    }
    return root;
}

export class LocalAssetCache {
    readonly root: string;

    constructor(root: string) {
        this.root = normalizeRoot(root);
    }

    async initialize(): Promise<void> {
        await mkdir(this.root, { recursive: true });
    }

    pathFor(key: CacheEntryKey): string {
        const fileFolder = digest(key.fileKey).slice(0, 16);
        const scale = Number.isFinite(key.scale) ? key.scale : 1;
        const fileName = `${digest(`${key.nodeId}:${key.format}:${scale}`).slice(0, 24)}.${key.format}`;
        return join(this.root, fileFolder, fileName);
    }

    async read(key: CacheEntryKey): Promise<Buffer | null> {
        try {
            return await readFile(this.pathFor(key));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            throw new Error(`读取本地缓存失败：${(error as Error).message}`);
        }
    }

    async write(key: CacheEntryKey, contents: Buffer): Promise<void> {
        const target = this.pathFor(key);
        try {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, contents);
        } catch (error) {
            throw new Error(`写入本地缓存失败：${(error as Error).message}`);
        }
    }
}
