import { readdir, readFile } from 'fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { sanitizeAssetName } from './assets';

export interface LocalResourceMatch {
    path: string;
    contents: Buffer;
}

const SUPPORTED_EXTENSIONS = new Set(['.png', '.svg']);
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'library', 'temp']);

function normalizedFileName(value: string): string {
    return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function resourceBaseName(nodeName: string): string {
    const fileName = basename(nodeName.trim().replace(/\\/g, '/'));
    const extension = extname(fileName).toLocaleLowerCase('en-US');
    return SUPPORTED_EXTENSIONS.has(extension)
        ? fileName.slice(0, -extension.length)
        : fileName;
}

function candidateNames(nodeName: string, format: 'png' | 'svg'): string[] {
    const baseName = resourceBaseName(nodeName);
    return Array.from(new Set([
        normalizedFileName(`${baseName}.${format}`),
        normalizedFileName(`${sanitizeAssetName(baseName)}.${format}`),
        normalizedFileName(`${baseName.replace(/\s+/g, '_')}.${format}`),
    ]));
}

export class LocalResourceLibrary {
    readonly root: string;
    private readonly filesByName = new Map<string, string[]>();
    private initialized = false;

    constructor(root: string) {
        const selected = root.trim();
        if (!selected || !isAbsolute(selected)) {
            throw new Error('本地同名资源目录必须是绝对路径。');
        }
        this.root = resolve(selected);
    }

    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }
        await this.indexDirectory(this.root);
        this.initialized = true;
    }

    async find(nodeName: string, format: 'png' | 'svg'): Promise<LocalResourceMatch | null> {
        await this.initialize();
        const matches = new Set<string>();
        for (const candidate of candidateNames(nodeName, format)) {
            for (const path of this.filesByName.get(candidate) ?? []) {
                matches.add(path);
            }
        }
        if (!matches.size) {
            return null;
        }
        const paths = Array.from(matches).sort((left, right) => left.localeCompare(right));
        const rootMatches = paths.filter((path) => !relative(this.root, path).includes('\\')
            && !relative(this.root, path).includes('/'));
        const resolved = rootMatches[0] ?? paths[0];
        return {
            path: resolved,
            contents: await readFile(resolved),
        };
    }

    private async indexDirectory(folder: string): Promise<void> {
        const entries = await readdir(folder, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRECTORIES.has(entry.name)) {
                    await this.indexDirectory(path);
                }
                continue;
            }
            if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase('en-US'))) {
                continue;
            }
            const key = normalizedFileName(entry.name);
            const paths = this.filesByName.get(key) ?? [];
            paths.push(path);
            this.filesByName.set(key, paths);
        }
    }
}
