import type { SpriteAssetSpec } from '../types';

interface AssetInfo {
    uuid: string;
    url: string;
    importer: string;
    type: string;
    imported: boolean;
    invalid: boolean;
    subAssets?: Record<string, AssetInfo>;
}

interface AssetMeta {
    uuid: string;
    subMetas: Record<string, {
        importer: string;
        uuid: string;
        userData: Record<string, unknown>;
    }>;
}

export function hasSlicedBorders(meta: AssetMeta | null | undefined): boolean {
    const spriteMeta = Object.values(meta?.subMetas ?? {})
        .find((item) => item.importer === 'sprite-frame');
    return ['borderLeft', 'borderRight', 'borderTop', 'borderBottom']
        .some((key) => {
            const value = spriteMeta?.userData?.[key];
            return typeof value === 'number' && Number.isFinite(value) && value > 0;
        });
}

function normalizeFolder(input: string): string {
    const value = input.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!value || value === '.' || value.split('/').some((part) => !part || part === '..')) {
        throw new Error('资源目录无效。');
    }
    if (value.startsWith('assets/')) {
        return value.slice('assets/'.length);
    }
    if (value.startsWith('db://')) {
        throw new Error('资源目录请填写 assets 下的相对路径。');
    }
    return value;
}

export function sanitizeAssetName(input: string): string {
    let value = input
        .normalize('NFKC')
        .replace(/[<>:"/\\|?*#%\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[. ]+|[. ]+$/g, '')
        .slice(0, 72);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
        value = `_${value}`;
    }
    return value || 'figma_node';
}

function findSpriteFrame(info: AssetInfo): AssetInfo | null {
    const queue: AssetInfo[] = [info];
    while (queue.length) {
        const item = queue.shift()!;
        if (item.importer === 'sprite-frame' || item.type === 'cc.SpriteFrame') {
            return item;
        }
        queue.push(...Object.values(item.subAssets ?? {}));
    }
    return null;
}

async function queryAsset(value: string): Promise<AssetInfo | null> {
    return await Editor.Message.request(
        'asset-db',
        'query-asset-info',
        value,
        ['subAssets'],
    ) as AssetInfo | null;
}

async function waitForAsset(url: string): Promise<AssetInfo> {
    const started = Date.now();
    while (Date.now() - started < 30_000) {
        const info = await queryAsset(url);
        if (info?.invalid) {
            throw new Error(`Cocos 资源导入失败：${url}`);
        }
        if (info?.imported && findSpriteFrame(info)) {
            return info;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error(`等待 Cocos 资源导入超时：${url}`);
}

async function ensureFolder(url: string): Promise<void> {
    const existing = await queryAsset(url);
    if (existing) {
        return;
    }
    await Editor.Message.request('asset-db', 'create-asset', url, null);
}

export class AssetWriter {
    readonly folder: string;

    constructor(folder: string) {
        this.folder = normalizeFolder(folder);
    }

    async initialize(): Promise<void> {
        let current = 'db://assets';
        for (const part of this.folder.split('/')) {
            current += `/${part}`;
            await ensureFolder(current);
        }
    }

    buildUrl(name: string, _id: string, extension: 'png', _scale: number): string {
        const fileName = sanitizeAssetName(name).replace(/\.(png|svg)$/i, '');
        return `db://assets/${this.folder}/${fileName}.${extension}`;
    }

    async existing(url: string): Promise<SpriteAssetSpec | null> {
        const info = await queryAsset(url);
        const spriteFrame = info ? findSpriteFrame(info) : null;
        if (!info?.imported || info.invalid || !spriteFrame) {
            return null;
        }
        const meta = await Editor.Message.request(
            'asset-db',
            'query-asset-meta',
            info.uuid,
        ) as AssetMeta | null;
        return { uuid: spriteFrame.uuid, url, sliced: hasSlicedBorders(meta) };
    }

    async write(
        url: string,
        contents: Buffer | string,
        borders?: { left: number; right: number; top: number; bottom: number },
    ): Promise<SpriteAssetSpec> {
        const existing = await queryAsset(url);
        const data = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
        if (existing) {
            await Editor.Message.request('asset-db', 'save-asset', url, data);
        } else {
            await Editor.Message.request('asset-db', 'create-asset', url, data, { overwrite: true });
        }
        let info = await waitForAsset(url);
        const sliced = Boolean(borders && Object.values(borders).some((value) => value > 0));
        const meta = await Editor.Message.request('asset-db', 'query-asset-meta', info.uuid) as AssetMeta | null;
        if (borders || hasSlicedBorders(meta)) {
            await this.applyBorders(info, borders ?? { left: 0, right: 0, top: 0, bottom: 0 });
            info = await waitForAsset(url);
        }
        const spriteFrame = findSpriteFrame(info);
        if (!spriteFrame) {
            throw new Error(`资源没有生成 SpriteFrame：${url}`);
        }
        return { uuid: spriteFrame.uuid, url, sliced };
    }

    private async applyBorders(
        info: AssetInfo,
        borders: { left: number; right: number; top: number; bottom: number },
    ): Promise<void> {
        const meta = await Editor.Message.request('asset-db', 'query-asset-meta', info.uuid) as AssetMeta | null;
        if (!meta?.subMetas) {
            return;
        }
        const spriteMeta = Object.values(meta.subMetas).find((item) => item.importer === 'sprite-frame');
        if (!spriteMeta) {
            return;
        }
        Object.assign(spriteMeta.userData, {
            trimType: 'none',
            borderLeft: Math.max(0, Math.round(borders.left)),
            borderRight: Math.max(0, Math.round(borders.right)),
            borderTop: Math.max(0, Math.round(borders.top)),
            borderBottom: Math.max(0, Math.round(borders.bottom)),
        });
        await Editor.Message.request('asset-db', 'save-asset-meta', info.uuid, JSON.stringify(meta, null, 2));
        await Editor.Message.request('asset-db', 'reimport-asset', info.uuid);
    }
}

export async function resolveAssetUuid(value: string): Promise<string | undefined> {
    const input = value.trim();
    if (!input) {
        return undefined;
    }
    const info = await queryAsset(input);
    return info?.uuid;
}
