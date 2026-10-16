import { readdir, readFile } from 'fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { sanitizeAssetName } from './assets';

export interface LocalResourceMatch {
    path: string;
    contents: Buffer;
}

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.svg']);
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

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

function candidateNames(nodeName: string, format: string): string[] {
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
    private initializing?: Promise<void>;

    constructor(root: string) {
        const selected = root.trim();
        if (!selected || !isAbsolute(selected)) {
            throw new Error('本地同名资源目录必须是绝对路径。');
        }
        this.root = resolve(selected);
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        if (this.initializing) return this.initializing;
        const index = new Map<string, string[]>();
        this.initializing = this.indexDirectory(this.root, index).then(() => {
            for (const [name, paths] of index) this.filesByName.set(name, paths);
            this.initialized = true;
        }).finally(() => { this.initializing = undefined; });
        return this.initializing;
    }

    /** Every same-name candidate, including hidden directories, in preference order. */
    async findAll(nodeName: string, format: 'png' | 'svg'): Promise<LocalResourceMatch[]> {
        await this.initialize();
        const namedExtension = extname(nodeName.trim()).slice(1).toLowerCase();
        const formats = format === 'svg' ? ['svg'] : Array.from(new Set([
            ...(['png', 'jpg', 'jpeg'].includes(namedExtension) ? [namedExtension] : []), 'png', 'jpg', 'jpeg',
        ]));
        const result: LocalResourceMatch[] = [];
        for (const candidateFormat of formats) {
            for (const path of this.matchingPaths(nodeName, candidateFormat)) {
                try { result.push({ path, contents: await readFile(path) }); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
        }
        return result;
    }

    async find(nodeName: string, format: 'png' | 'svg'): Promise<LocalResourceMatch | null> {
        return (await this.findAll(nodeName, format))[0] ?? null;
    }

    private matchingPaths(nodeName: string, format: string): string[] {
        const matches = new Set<string>();
        for (const candidate of candidateNames(nodeName, format)) {
            for (const path of this.filesByName.get(candidate) ?? []) {
                matches.add(path);
            }
        }
        if (!matches.size) {
            return [];
        }
        const paths = Array.from(matches).sort((left, right) => left.localeCompare(right));
        const rootMatches = paths.filter((path) => !relative(this.root, path).includes('\\')
            && !relative(this.root, path).includes('/'));
        return [...rootMatches, ...paths.filter((path) => !rootMatches.includes(path))];
    }

    private async indexDirectory(folder: string, index: Map<string, string[]>): Promise<void> {
        const entries = await readdir(folder, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRECTORIES.has(entry.name)) {
                    await this.indexDirectory(path, index);
                }
                continue;
            }
            if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase('en-US'))) {
                continue;
            }
            const key = normalizedFileName(entry.name);
            const paths = index.get(key) ?? [];
            paths.push(path);
            index.set(key, paths);
        }
    }
}
