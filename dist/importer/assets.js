"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssetWriter = exports.RASTER_IMAGE_EXTENSIONS = void 0;
exports.hasSlicedBorders = hasSlicedBorders;
exports.sanitizeAssetName = sanitizeAssetName;
exports.detectImageExtension = detectImageExtension;
exports.resolveAssetUuid = resolveAssetUuid;
const crypto_1 = require("crypto");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const diagnostics_1 = require("../diagnostics");
const raster_format_1 = require("./raster-format");
exports.RASTER_IMAGE_EXTENSIONS = [
    'png',
    'jpg',
    'webp',
    'gif',
    'bmp',
];
const assetLocks = new Map();
const assetIndexVersions = new Map();
const hash = (input) => (0, crypto_1.createHash)('sha256').update(input).digest('hex');
const normalized = (input) => input.normalize('NFKC').toLocaleLowerCase('en-US');
async function locked(key, task) {
    var _a;
    const previous = (_a = assetLocks.get(key)) !== null && _a !== void 0 ? _a : Promise.resolve();
    const pending = previous.catch(() => undefined).then(task);
    assetLocks.set(key, pending);
    try {
        return await pending;
    }
    finally {
        if (assetLocks.get(key) === pending)
            assetLocks.delete(key);
    }
}
function configKey(borders, tiled = false) {
    return JSON.stringify(tiled ? ['tiled'] : ['sprite', ...['left', 'right', 'top', 'bottom']
            .map((side) => { var _a; return Math.max(0, Math.round((_a = borders === null || borders === void 0 ? void 0 : borders[side]) !== null && _a !== void 0 ? _a : 0)); })]);
}
function storedConfig(meta, tiled = false) {
    var _a, _b;
    const data = (_b = Object.values((_a = meta === null || meta === void 0 ? void 0 : meta.subMetas) !== null && _a !== void 0 ? _a : {}).find((item) => item.importer === 'sprite-frame')) === null || _b === void 0 ? void 0 : _b.userData;
    return configKey(data ? { left: Number(data.borderLeft) || 0, right: Number(data.borderRight) || 0,
        top: Number(data.borderTop) || 0, bottom: Number(data.borderBottom) || 0 } : undefined, tiled);
}
function validConfiguration(meta, tiled) {
    var _a, _b;
    const data = (_b = Object.values((_a = meta === null || meta === void 0 ? void 0 : meta.subMetas) !== null && _a !== void 0 ? _a : {}).find((item) => item.importer === 'sprite-frame')) === null || _b === void 0 ? void 0 : _b.userData;
    if (!data)
        return false;
    if (tiled)
        return data.trimType === 'none' && data.packable === false && !hasSlicedBorders(meta);
    return !hasSlicedBorders(meta) || data.trimType === 'none';
}
function identityFrom(meta) {
    var _a;
    const identity = (_a = meta === null || meta === void 0 ? void 0 : meta.userData) === null || _a === void 0 ? void 0 : _a.figmaImporter;
    return (identity === null || identity === void 0 ? void 0 : identity.version) === 1 && typeof identity.contentHash === 'string' && /^[0-9a-f]{64}$/.test(identity.contentHash)
        && typeof identity.config === 'string' && identity.sources && typeof identity.sources === 'object'
        && Object.entries(identity.sources).every(([key, value]) => /^[0-9a-f]{64}$/.test(key)
            && typeof value === 'number' && Number.isFinite(value) && value > 0)
        ? identity : undefined;
}
function hasSlicedBorders(meta) {
    var _a;
    const spriteMeta = Object.values((_a = meta === null || meta === void 0 ? void 0 : meta.subMetas) !== null && _a !== void 0 ? _a : {})
        .find((item) => item.importer === 'sprite-frame');
    return ['borderLeft', 'borderRight', 'borderTop', 'borderBottom']
        .some((key) => {
        var _a;
        const value = (_a = spriteMeta === null || spriteMeta === void 0 ? void 0 : spriteMeta.userData) === null || _a === void 0 ? void 0 : _a[key];
        return typeof value === 'number' && Number.isFinite(value) && value > 0;
    });
}
function normalizeFolder(input) {
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
function sanitizeAssetName(input) {
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
function detectImageExtension(contents) {
    if (contents.length >= 8
        && contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'png';
    }
    if (contents.length >= 3
        && contents[0] === 0xff
        && contents[1] === 0xd8
        && contents[2] === 0xff) {
        return 'jpg';
    }
    if (contents.length >= 12
        && contents.subarray(0, 4).toString('ascii') === 'RIFF'
        && contents.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'webp';
    }
    const header = contents.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') {
        return 'gif';
    }
    if (contents.length >= 2 && contents[0] === 0x42 && contents[1] === 0x4d) {
        return 'bmp';
    }
    throw new Error('Figma 原始平铺图片格式无法识别；当前支持 PNG、JPEG、WebP、GIF 和 BMP。');
}
function assetBaseName(name) {
    return sanitizeAssetName(name).replace(/\.(png|jpe?g|webp|gif|bmp|svg)$/i, '');
}
function findSpriteFrame(info) {
    var _a;
    const queue = [info];
    while (queue.length) {
        const item = queue.shift();
        if (item.importer === 'sprite-frame' || item.type === 'cc.SpriteFrame') {
            return item;
        }
        queue.push(...Object.values((_a = item.subAssets) !== null && _a !== void 0 ? _a : {}));
    }
    return null;
}
function assetRequest(channel, method, ...args) {
    // Log only the target, never image contents or serialized metadata.
    return (0, diagnostics_1.diagnosticTask)(`Cocos 资源 ${method}`, { target: args[0] }, () => Editor.Message.request(channel, method, ...args));
}
async function queryAsset(value) {
    return await assetRequest('asset-db', 'query-asset-info', value, ['subAssets']);
}
async function waitForAsset(url, requireSpriteFrame = true, knownUuid) {
    var _a;
    const started = Date.now();
    let lastInfo = null;
    while (Date.now() - started < 30000) {
        let info = await queryAsset(url);
        if (!info && knownUuid)
            info = await queryAsset(knownUuid);
        lastInfo = info;
        if (info === null || info === void 0 ? void 0 : info.invalid) {
            throw new Error(`Cocos 资源导入失败：${url}`);
        }
        if (info === null || info === void 0 ? void 0 : info.imported) {
            if (!requireSpriteFrame || findSpriteFrame(info))
                return info;
            const meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid);
            const frame = Object.values((_a = meta === null || meta === void 0 ? void 0 : meta.subMetas) !== null && _a !== void 0 ? _a : {}).find((item) => item.importer === 'sprite-frame');
            if (frame === null || frame === void 0 ? void 0 : frame.uuid)
                return { ...info, subAssets: { ...info.subAssets,
                        persistedFrame: { ...info, uuid: frame.uuid, importer: 'sprite-frame', type: 'cc.SpriteFrame' } } };
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if ((lastInfo === null || lastInfo === void 0 ? void 0 : lastInfo.imported) && requireSpriteFrame) {
        throw new Error(`Cocos 已导入图片但未能生成 SpriteFrame：${url}`);
    }
    throw new Error(`等待 Cocos 图片资源导入超时：${url}`);
}
async function ensureSpriteFrame(url, info) {
    var _a, _b;
    if (findSpriteFrame(info)) {
        return info;
    }
    const meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid);
    if (!meta) {
        throw new Error(`无法读取 Cocos 图片资源 Meta：${url}`);
    }
    const persistedFrame = Object.values((_a = meta.subMetas) !== null && _a !== void 0 ? _a : {}).find((item) => item.importer === 'sprite-frame');
    if (persistedFrame === null || persistedFrame === void 0 ? void 0 : persistedFrame.uuid)
        return { ...info, subAssets: { ...info.subAssets,
                persistedFrame: { ...info, uuid: persistedFrame.uuid, importer: 'sprite-frame', type: 'cc.SpriteFrame' } } };
    meta.userData = (_b = meta.userData) !== null && _b !== void 0 ? _b : {};
    if (meta.userData.type !== 'sprite-frame') {
        meta.userData.type = 'sprite-frame';
        await assetRequest('asset-db', 'save-asset-meta', info.uuid, JSON.stringify(meta, null, 2));
    }
    await assetRequest('asset-db', 'reimport-asset', info.uuid);
    return waitForAsset(url, true, info.uuid);
}
async function ensureFolder(url) {
    const existing = await queryAsset(url);
    if (existing) {
        return;
    }
    await assetRequest('asset-db', 'create-asset', url, null);
}
class AssetWriter {
    constructor(folder, beforeWrite) {
        this.beforeWrite = beforeWrite;
        this.events = [];
        this.writeTargets = new Map();
        this.indexVersion = -1;
        this.indexed = new Map();
        this.folder = normalizeFolder(folder);
    }
    get projectRoot() {
        var _a;
        return typeof Editor !== 'undefined' && ((_a = Editor.Project) === null || _a === void 0 ? void 0 : _a.path) ? (0, path_1.resolve)(Editor.Project.path) : undefined;
    }
    pathFor(url) {
        const root = this.projectRoot;
        if (!root)
            return undefined;
        if (!url.startsWith('db://assets/') || /[\u0000?#]/.test(url))
            throw new Error(`资源地址无效：${url}`);
        const path = (0, path_1.resolve)(root, url.slice('db://'.length));
        const suffix = (0, path_1.relative)((0, path_1.join)(root, 'assets'), path);
        if (!suffix || suffix.startsWith('..') || (0, path_1.isAbsolute)(suffix))
            throw new Error(`资源地址超出项目 assets：${url}`);
        return path;
    }
    async diskMeta(url) {
        const path = this.pathFor(url);
        if (!path)
            return null;
        try {
            return JSON.parse(await (0, promises_1.readFile)(`${path}.meta`, 'utf8'));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw new Error(`无法读取已有资源 Meta，不会覆盖：${url}；${String(error)}`);
        }
    }
    async contentsAt(url) {
        const path = this.pathFor(url);
        if (!path)
            return null;
        try {
            return await (0, promises_1.readFile)(path);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        }
    }
    async indexAssets() {
        var _a;
        const root = this.projectRoot;
        if (!root)
            return;
        const currentVersion = (_a = assetIndexVersions.get(root)) !== null && _a !== void 0 ? _a : 0;
        if (this.indexPromise && this.indexVersion === currentVersion)
            return this.indexPromise;
        this.indexVersion = currentVersion;
        this.indexed.clear();
        const scan = async (folder) => {
            const entries = await (0, promises_1.readdir)(folder, { withFileTypes: true });
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
                const path = (0, path_1.join)(folder, entry.name);
                // Hidden directories/assets participate exactly like visible ones.
                // Do not follow directory symlinks outside the project.
                if (entry.isDirectory())
                    await scan(path);
                else if (entry.isFile() && /\.(png|jpe?g|webp|gif|bmp|svg)\.meta$/i.test(entry.name)) {
                    const url = `db://${(0, path_1.relative)(root, path.slice(0, -5)).replace(/\\/g, '/')}`;
                    const meta = await this.diskMeta(url);
                    if (meta)
                        this.indexed.set(url, meta);
                }
            }
        };
        this.indexPromise = scan((0, path_1.join)(root, 'assets')).catch((error) => {
            this.indexPromise = undefined;
            this.indexed.clear();
            throw error;
        });
        return this.indexPromise;
    }
    async availableInfo(url) {
        let info = await queryAsset(url);
        if (!info) {
            const meta = await this.diskMeta(url);
            if (meta === null || meta === void 0 ? void 0 : meta.uuid)
                info = await queryAsset(meta.uuid);
            if (!info && (meta || await this.contentsAt(url))) {
                throw new Error(`已有资源尚未被 Cocos 资源数据库识别，请等待导入完成后重试，不会另建副本：${url}`);
            }
        }
        if (info === null || info === void 0 ? void 0 : info.invalid)
            throw new Error(`Cocos 资源无效，不会覆盖其 Meta：${url}`);
        if (info && !info.imported)
            info = await waitForAsset(info.url || url, false, info.uuid);
        return info;
    }
    async existingForSource(sourceKey, options) {
        var _a;
        return locked((_a = this.projectRoot) !== null && _a !== void 0 ? _a : this.folder, async () => {
            var _a;
            await this.indexAssets();
            const key = hash(sourceKey);
            const candidates = [...this.indexed.entries()].filter(([, meta]) => { var _a; return (_a = identityFrom(meta)) === null || _a === void 0 ? void 0 : _a.sources[key]; });
            candidates.sort((a, b) => (identityFrom(b[1]).sources[key] - identityFrom(a[1]).sources[key])
                || a[0].localeCompare(b[0]));
            for (const [url] of candidates) {
                const meta = (_a = await this.diskMeta(url)) !== null && _a !== void 0 ? _a : this.indexed.get(url);
                const identity = identityFrom(meta);
                const contents = await this.contentsAt(url);
                if (!identity || identity.pending || !contents || hash(contents) !== identity.contentHash)
                    continue;
                const tiled = identity.config === configKey(undefined, true);
                if ((options === null || options === void 0 ? void 0 : options.tiled) !== undefined && options.tiled !== tiled)
                    continue;
                if ((options === null || options === void 0 ? void 0 : options.sliced) !== undefined && options.sliced !== hasSlicedBorders(meta))
                    continue;
                if ((options === null || options === void 0 ? void 0 : options.borders) && identity.config !== configKey(options.borders, options.tiled))
                    continue;
                if (identity.config !== storedConfig(meta, tiled) || !validConfiguration(meta, tiled))
                    continue;
                const asset = await this.existing(url, tiled);
                if (asset) {
                    this.events.push({ sourceKey: key, url: asset.url, action: 'reused', reason: '源标识、内容、SpriteFrame UUID 与切片配置均已验证' });
                    return asset;
                }
            }
            return null;
        });
    }
    async resolve(url, contents, options) {
        var _a;
        return locked((_a = this.projectRoot) !== null && _a !== void 0 ? _a : this.folder, async () => {
            var _a, _b, _c;
            if (!options.sourceKey.trim())
                throw new Error('资源源标识不能为空。');
            await this.indexAssets();
            const sourceKey = hash(options.sourceKey);
            const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
            const inputHash = hash(bytes);
            let jpegHash;
            const config = configKey(options.borders, options.tiled);
            const mapped = [...this.indexed.entries()].filter(([, meta]) => { var _a; return (_a = identityFrom(meta)) === null || _a === void 0 ? void 0 : _a.sources[sourceKey]; });
            mapped.sort((a, b) => identityFrom(b[1]).sources[sourceKey] - identityFrom(a[1]).sources[sourceKey]);
            const named = [...this.indexed.keys()].filter((candidate) => normalized((0, path_1.basename)(candidate, (0, path_1.extname)(candidate)))
                === normalized((0, path_1.basename)(url, (0, path_1.extname)(url))));
            const candidates = [...new Set([...mapped.map(([candidate]) => candidate), url,
                    ...(/\.png$/i.test(url) ? [url.replace(/\.png$/i, '.jpg'), url.replace(/\.png$/i, '.jpeg')] : []), ...named])];
            let ownUpdate;
            for (const candidate of candidates) {
                const info = await this.availableInfo(candidate);
                if (!info)
                    continue;
                const meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid);
                const identity = identityFrom(meta);
                const stored = await this.contentsAt(candidate);
                const pendingOwned = ((_a = identity === null || identity === void 0 ? void 0 : identity.pending) === null || _a === void 0 ? void 0 : _a.sourceKey) === sourceKey
                    && Object.keys(identity.sources).length === 1;
                const verified = stored && (!identity || hash(stored) === identity.contentHash
                    || (pendingOwned && hash(stored) === identity.pending.contentHash));
                if (verified && /\.jpe?g$/i.test(candidate) && (0, raster_format_1.isPng)(bytes) && !(identity === null || identity === void 0 ? void 0 : identity.inputHash) && !jpegHash) {
                    const prepared = (0, raster_format_1.prepareNewRaster)(bytes);
                    if (prepared.extension === 'jpg')
                        jpegHash = hash(prepared.contents);
                }
                const sameContents = verified && (hash(stored) === inputHash || (identity === null || identity === void 0 ? void 0 : identity.inputHash) === inputHash
                    || (jpegHash && hash(stored) === jpegHash));
                const sameConfig = config === storedConfig(meta, options.tiled)
                    && (!identity || identity.config === config)
                    && validConfiguration(meta, Boolean(options.tiled))
                    && (!options.tiled || (identity === null || identity === void 0 ? void 0 : identity.config) === config);
                if (sameContents && sameConfig) {
                    const asset = await this.existing(candidate, options.tiled);
                    if (asset) {
                        await this.bindIdentity(candidate, info, meta, sourceKey, inputHash, config, hash(stored));
                        this.events.push({ sourceKey, url: candidate, action: 'reused', reason: (identity === null || identity === void 0 ? void 0 : identity.sources[sourceKey])
                                ? '源映射命中，内容与切片配置一致' : '同名资源内容与切片配置一致，已绑定源标识' });
                        return asset;
                    }
                }
                if ((identity === null || identity === void 0 ? void 0 : identity.sources[sourceKey]) && Object.keys(identity.sources).length === 1 && verified
                    && (!/\.jpe?g$/i.test(candidate) || !(0, raster_format_1.isPng)(bytes) || (0, raster_format_1.prepareNewRaster)(bytes).extension === 'jpg')) {
                    ownUpdate !== null && ownUpdate !== void 0 ? ownUpdate : (ownUpdate = candidate);
                }
            }
            // Only an exclusively owned source may update pixels/metadata in place.
            // A shared or legacy asset always keeps its valid references and bytes.
            let target = ownUpdate !== null && ownUpdate !== void 0 ? ownUpdate : url;
            let existed = Boolean(await this.availableInfo(target));
            let isolated = false;
            if (!ownUpdate && !existed && /\.png$/i.test(target) && (0, raster_format_1.prepareNewRaster)(bytes).extension === 'jpg') {
                target = target.replace(/\.png$/i, '.jpg');
                existed = Boolean(await this.availableInfo(target));
            }
            if (!ownUpdate && existed) {
                isolated = true;
                const extension = (0, path_1.extname)(target);
                target = `${target.slice(0, -extension.length)}__${hash(`${inputHash}:${config}`).slice(0, 12)}${extension}`;
                existed = Boolean(await this.availableInfo(target));
                if (existed) {
                    const stored = await this.contentsAt(target);
                    const info = await this.availableInfo(target);
                    const meta = info ? await assetRequest('asset-db', 'query-asset-meta', info.uuid) : null;
                    if (!stored || (hash(stored) !== inputHash && ((_b = identityFrom(meta)) === null || _b === void 0 ? void 0 : _b.inputHash) !== inputHash)
                        || storedConfig(meta, options.tiled) !== config || !validConfiguration(meta, Boolean(options.tiled))) {
                        throw new Error(`资源变体地址被不同内容或切片配置占用，不会覆盖：${target}`);
                    }
                    const asset = await this.existing(target, options.tiled);
                    if (asset && info) {
                        await this.bindIdentity(target, info, meta, sourceKey, inputHash, config, hash(stored));
                        this.events.push({ sourceKey, url: target, action: 'reused', reason: '重试命中已创建的稳定变体，保留原 UUID' });
                        return asset;
                    }
                }
            }
            if (ownUpdate)
                await this.beginUpdate(ownUpdate, bytes, sourceKey, inputHash, config);
            const writeBorders = ownUpdate && !options.tiled && !options.borders
                ? { left: 0, right: 0, top: 0, bottom: 0 } : options.borders;
            // resolve already selected a verified destination. A legacy write's
            // PNG→JPG alias must not redirect a different source/alpha variant.
            this.writeTargets.delete(target);
            const asset = await this.write(target, bytes, writeBorders, options.tiled);
            const info = await this.availableInfo(asset.url);
            if (!info)
                throw new Error(`无法确认资源 UUID：${asset.url}`);
            const meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid);
            const stored = await this.contentsAt(asset.url);
            // A failed inset save still produced this source's image. Bind the
            // actual stored configuration so the sliced writer can restore its
            // full PNG in place, rather than leaving an unowned compact copy.
            // A later sliced lookup must still reject the unverified borders.
            const boundConfig = asset.sliceFallback ? storedConfig(meta, Boolean(options.tiled)) : config;
            await this.bindIdentity(asset.url, info, meta, sourceKey, inputHash, boundConfig, hash(stored !== null && stored !== void 0 ? stored : bytes));
            this.events.push({ sourceKey, url: asset.url, action: asset.sliceFallback ? 'fallback' : existed ? 'updated' : 'created',
                reason: (_c = asset.sliceFallback) !== null && _c !== void 0 ? _c : (ownUpdate ? '同源资源独占，原位更新并保留 UUID 与 Meta'
                    : isolated ? '同名内容或切片配置冲突，创建稳定变体并保留已有资源' : '未找到内容及切片配置相符的已有资源') });
            return asset;
        });
    }
    async beginUpdate(url, bytes, sourceKey, inputHash, config) {
        var _a, _b;
        const info = await this.availableInfo(url);
        const meta = info ? await assetRequest('asset-db', 'query-asset-meta', info.uuid) : null;
        const identity = identityFrom(meta);
        if (!info || !meta || !(identity === null || identity === void 0 ? void 0 : identity.sources[sourceKey]) || Object.keys(identity.sources).length !== 1) {
            throw new Error(`资源源映射已发生变化，无法安全原位更新：${url}`);
        }
        const stored = await this.contentsAt(url);
        if (!stored || (hash(stored) !== identity.contentHash && hash(stored) !== ((_a = identity.pending) === null || _a === void 0 ? void 0 : _a.contentHash))) {
            throw new Error(`资源内容已在导入期间变化，无法安全原位更新：${url}`);
        }
        const prepared = /\.jpe?g$/i.test(url) && (0, raster_format_1.isPng)(bytes) ? (0, raster_format_1.prepareNewRaster)(bytes).contents : bytes;
        const next = JSON.parse(JSON.stringify(meta));
        const pending = { sourceKey, inputHash, contentHash: hash(prepared), config };
        next.userData.figmaImporter = { ...identity, pending };
        await ((_b = this.beforeWrite) === null || _b === void 0 ? void 0 : _b.call(this, url, true));
        await assetRequest('asset-db', 'save-asset-meta', info.uuid, JSON.stringify(next, null, 2));
        this.indexed.set(url, next);
    }
    async bindIdentity(url, info, meta, sourceKey, inputHash, config, contentHash) {
        var _a, _b, _c, _d;
        if (!meta)
            throw new Error(`无法持久化资源源标识：${url}`);
        if (meta.uuid && meta.uuid !== info.uuid)
            throw new Error(`资源 UUID 与 Meta 不一致，不会写入源映射：${url}`);
        const previous = identityFrom(meta);
        if ((previous === null || previous === void 0 ? void 0 : previous.sources[sourceKey]) && !previous.pending && previous.inputHash === inputHash && previous.config === config
            && previous.contentHash === contentHash) {
            this.indexed.set(url, meta);
            return;
        }
        await ((_a = this.beforeWrite) === null || _a === void 0 ? void 0 : _a.call(this, url, true));
        const next = JSON.parse(JSON.stringify(meta));
        (_b = next.userData) !== null && _b !== void 0 ? _b : (next.userData = {});
        const latestRevision = Math.max(0, ...[...this.indexed.values()]
            .map((item) => { var _a, _b; return (_b = (_a = identityFrom(item)) === null || _a === void 0 ? void 0 : _a.sources[sourceKey]) !== null && _b !== void 0 ? _b : 0; }));
        next.userData.figmaImporter = { version: 1, contentHash, inputHash, config,
            sources: { ...((_c = previous === null || previous === void 0 ? void 0 : previous.sources) !== null && _c !== void 0 ? _c : {}), [sourceKey]: Math.max(Date.now(), latestRevision + 1) } };
        await assetRequest('asset-db', 'save-asset-meta', info.uuid, JSON.stringify(next, null, 2));
        // Index only after successful persistence. A failed bind can safely retry
        // by comparing the file's content/config without a source record.
        this.indexed.set(url, next);
        if (this.projectRoot) {
            const version = ((_d = assetIndexVersions.get(this.projectRoot)) !== null && _d !== void 0 ? _d : 0) + 1;
            assetIndexVersions.set(this.projectRoot, version);
            this.indexVersion = version;
        }
    }
    async initialize() {
        let current = 'db://assets';
        for (const part of this.folder.split('/')) {
            current += `/${part}`;
            await ensureFolder(current);
        }
    }
    buildUrl(name, _id, extension, _scale) {
        const fileName = assetBaseName(name);
        return `db://assets/${this.folder}/${fileName}.${extension}`;
    }
    buildTiledUrl(name, sourceKey, extension) {
        const sourceHash = (0, crypto_1.createHash)('sha256').update(sourceKey).digest('hex').slice(0, 10);
        return `db://assets/${this.folder}/${assetBaseName(name)}__tile_${sourceHash}.${extension}`;
    }
    async existing(url, tiled = false) {
        var _a;
        let info = await this.availableInfo(url);
        if (!(info === null || info === void 0 ? void 0 : info.imported) || info.invalid) {
            return null;
        }
        let meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid);
        // AssetDB can omit subAssets while indexing. A persisted SpriteFrame
        // remains an existing asset; do not infer absence from UI visibility.
        let spriteFrame = findSpriteFrame(info);
        const frameMeta = Object.values((_a = meta === null || meta === void 0 ? void 0 : meta.subMetas) !== null && _a !== void 0 ? _a : {}).find((item) => item.importer === 'sprite-frame');
        if (spriteFrame && (frameMeta === null || frameMeta === void 0 ? void 0 : frameMeta.uuid) && frameMeta.uuid !== spriteFrame.uuid) {
            throw new Error(`SpriteFrame UUID 与 Meta 不一致，请等待 Cocos 重导入完成：${url}`);
        }
        if (!spriteFrame) {
            if (frameMeta === null || frameMeta === void 0 ? void 0 : frameMeta.uuid)
                spriteFrame = { ...info, uuid: frameMeta.uuid, importer: 'sprite-frame', type: 'cc.SpriteFrame' };
        }
        if (!spriteFrame)
            return null;
        if (tiled && meta && await this.applySpriteMeta(info, meta, undefined, true)) {
            info = await waitForAsset(url, true, info.uuid);
            spriteFrame = findSpriteFrame(info);
            meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid);
        }
        if (!spriteFrame) {
            return null;
        }
        return {
            uuid: spriteFrame.uuid,
            url,
            sliced: hasSlicedBorders(meta),
            tiled: tiled || undefined,
        };
    }
    async existingRaster(url, tiled = false, nodeName = url) {
        var _a;
        if (!/\.(png|jpe?g)$/i.test(url))
            return this.existing(url, tiled);
        const named = (_a = nodeName.match(/\.(png|jpe?g)$/i)) === null || _a === void 0 ? void 0 : _a[1].toLowerCase();
        const extensions = Array.from(new Set([...(named ? [named] : []), 'png', 'jpg', 'jpeg']));
        for (const extension of extensions) {
            const candidate = url.replace(/\.(png|jpe?g)$/i, `.${extension}`);
            const asset = tiled ? await this.existing(candidate, true) : await this.existing(candidate);
            if (asset)
                return asset;
        }
        return null;
    }
    async write(url, contents, borders, tiled = false) {
        var _a, _b, _c;
        const requestedUrl = url;
        url = (_a = this.writeTargets.get(url)) !== null && _a !== void 0 ? _a : url;
        let existing = await this.availableInfo(url);
        let data = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
        if (!existing && /\.png$/i.test(url)) {
            const prepared = (0, raster_format_1.prepareNewRaster)(data);
            if (prepared.extension === 'jpg') {
                const jpegUrl = url.replace(/\.png$/i, '.jpg');
                // Repeated imports normally reuse this file before reaching write.
                // A forced refresh must update it in place, preserving its UUID.
                existing = await this.availableInfo(jpegUrl);
                url = jpegUrl;
                data = prepared.contents;
            }
        }
        else if (/\.jpe?g$/i.test(url) && (0, raster_format_1.isPng)(data)) {
            const prepared = (0, raster_format_1.prepareNewRaster)(data);
            if (prepared.extension !== 'jpg')
                throw new Error(`不能将透明 PNG 或转换失败的图片写入 JPG：${url}`);
            data = prepared.contents;
        }
        this.writeTargets.set(requestedUrl, url);
        await ((_b = this.beforeWrite) === null || _b === void 0 ? void 0 : _b.call(this, url, Boolean(existing)));
        if (existing) {
            await assetRequest('asset-db', 'save-asset', url, data);
        }
        else {
            await assetRequest('asset-db', 'create-asset', url, data, { overwrite: false });
        }
        let info = await waitForAsset(url, false, existing === null || existing === void 0 ? void 0 : existing.uuid);
        info = await ensureSpriteFrame(url, info);
        const requestedSliced = !tiled
            && Boolean(borders && Object.values(borders).some((value) => value > 0));
        let meta = null;
        let sliceFallback;
        try {
            meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid);
            if (meta && await this.applySpriteMeta(info, meta, borders, tiled)) {
                info = await waitForAsset(url, true, info.uuid);
                meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid);
            }
        }
        catch (error) {
            if (!requestedSliced) {
                throw error;
            }
            // The PNG and its SpriteFrame already exist. A border metadata
            // failure must not discard the entire Prefab import; fail closed
            // to a normal SIMPLE Sprite and expose the reason to the panel.
            meta = null;
            sliceFallback = error instanceof Error ? error.message : String(error);
        }
        // Existing SpriteFrames can already carry valid borders even when this
        // write does not request new ones. Preserve that sliced classification.
        const stored = (meta === null || meta === void 0 ? void 0 : meta.subMetas) && ((_c = Object.values(meta.subMetas)
            .find((item) => item.importer === 'sprite-frame')) === null || _c === void 0 ? void 0 : _c.userData);
        const exactBorders = !requestedSliced || ((stored === null || stored === void 0 ? void 0 : stored.trimType) === 'none'
            && ['left', 'right', 'top', 'bottom'].every((side) => {
                const key = side;
                return stored[`border${side[0].toUpperCase()}${side.substring(1)}`]
                    === Math.max(0, Math.round(borders[key]));
            }));
        const sliced = !tiled && hasSlicedBorders(meta) && exactBorders;
        if (requestedSliced && !sliced && !sliceFallback) {
            sliceFallback = `Cocos 未能写入或回读三/九宫 SpriteFrame 边界：${url}`;
        }
        const spriteFrame = findSpriteFrame(info);
        if (!spriteFrame) {
            throw new Error(`资源没有生成 SpriteFrame：${url}`);
        }
        return {
            uuid: spriteFrame.uuid,
            url,
            sliced,
            sliceFallback,
            tiled: tiled || undefined,
        };
    }
    async applySpriteMeta(info, meta, borders, tiled) {
        if (!meta.subMetas) {
            return false;
        }
        const spriteMeta = Object.values(meta.subMetas).find((item) => item.importer === 'sprite-frame');
        if (!spriteMeta) {
            return false;
        }
        const changes = {};
        if (borders) {
            Object.assign(changes, {
                trimType: 'none',
                borderLeft: Math.max(0, Math.round(borders.left)),
                borderRight: Math.max(0, Math.round(borders.right)),
                borderTop: Math.max(0, Math.round(borders.top)),
                borderBottom: Math.max(0, Math.round(borders.bottom)),
            });
        }
        if (tiled) {
            Object.assign(changes, {
                trimType: 'none',
                packable: false,
                borderLeft: 0,
                borderRight: 0,
                borderTop: 0,
                borderBottom: 0,
            });
        }
        const changed = Object.entries(changes)
            .some(([key, value]) => spriteMeta.userData[key] !== value);
        if (!changed) {
            return false;
        }
        Object.assign(spriteMeta.userData, changes);
        await assetRequest('asset-db', 'save-asset-meta', info.uuid, JSON.stringify(meta, null, 2));
        await assetRequest('asset-db', 'reimport-asset', info.uuid);
        return true;
    }
}
exports.AssetWriter = AssetWriter;
async function resolveAssetUuid(value) {
    const input = value.trim();
    if (!input) {
        return undefined;
    }
    const info = await queryAsset(input);
    return info === null || info === void 0 ? void 0 : info.uuid;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXNzZXRzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc291cmNlL2ltcG9ydGVyL2Fzc2V0cy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUE0R0EsNENBUUM7QUFnQkQsOENBV0M7QUFFRCxvREF3QkM7QUF3akJELDRDQU9DO0FBeHVCRCxtQ0FBb0M7QUFDcEMsMENBQWdEO0FBQ2hELCtCQUE4RTtBQUM5RSxnREFBZ0Q7QUFFaEQsbURBQTBEO0FBSTdDLFFBQUEsdUJBQXVCLEdBQW9DO0lBQ3BFLEtBQUs7SUFDTCxLQUFLO0lBQ0wsTUFBTTtJQUNOLEtBQUs7SUFDTCxLQUFLO0NBQ1IsQ0FBQztBQXFERixNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsRUFBNEIsQ0FBQztBQUN2RCxNQUFNLGtCQUFrQixHQUFHLElBQUksR0FBRyxFQUFrQixDQUFDO0FBQ3JELE1BQU0sSUFBSSxHQUFHLENBQUMsS0FBc0IsRUFBRSxFQUFFLENBQUMsSUFBQSxtQkFBVSxFQUFDLFFBQVEsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDMUYsTUFBTSxVQUFVLEdBQUcsQ0FBQyxLQUFhLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUMsaUJBQWlCLENBQUMsT0FBTyxDQUFDLENBQUM7QUFFekYsS0FBSyxVQUFVLE1BQU0sQ0FBSSxHQUFXLEVBQUUsSUFBc0I7O0lBQ3hELE1BQU0sUUFBUSxHQUFHLE1BQUEsVUFBVSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsbUNBQUksT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO0lBQzFELE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzNELFVBQVUsQ0FBQyxHQUFHLENBQUMsR0FBRyxF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RSxJQUFJLENBQUM7QUFDdEIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tICdjcnlwdG8nO1xyXG5pbXBvcnQgeyByZWFkZGlyLCByZWFkRmlsZSB9IGZyb20gJ2ZzL3Byb21pc2VzJztcclxuaW1wb3J0IHsgYmFzZW5hbWUsIGV4dG5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7IGRpYWdub3N0aWNUYXNrIH0gZnJvbSAnLi4vZGlhZ25vc3RpY3MnO1xyXG5pbXBvcnQgdHlwZSB7IFNwcml0ZUFzc2V0U3BlYyB9IGZyb20gJy4uL3R5cGVzJztcbmltcG9ydCB7IGlzUG5nLCBwcmVwYXJlTmV3UmFzdGVyIH0gZnJvbSAnLi9yYXN0ZXItZm9ybWF0JztcblxyXG5leHBvcnQgdHlwZSBSYXN0ZXJJbWFnZUV4dGVuc2lvbiA9ICdwbmcnIHwgJ2pwZycgfCAnd2VicCcgfCAnZ2lmJyB8ICdibXAnO1xyXG5cclxuZXhwb3J0IGNvbnN0IFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TOiByZWFkb25seSBSYXN0ZXJJbWFnZUV4dGVuc2lvbltdID0gW1xyXG4gICAgJ3BuZycsXHJcbiAgICAnanBnJyxcclxuICAgICd3ZWJwJyxcclxuICAgICdnaWYnLFxyXG4gICAgJ2JtcCcsXHJcbl07XHJcblxyXG5pbnRlcmZhY2UgQXNzZXRJbmZvIHtcclxuICAgIHV1aWQ6IHN0cmluZztcclxuICAgIHVybDogc3RyaW5nO1xyXG4gICAgaW1wb3J0ZXI6IHN0cmluZztcclxuICAgIHR5cGU6IHN0cmluZztcclxuICAgIGltcG9ydGVkOiBib29sZWFuO1xyXG4gICAgaW52YWxpZDogYm9vbGVhbjtcclxuICAgIHN1YkFzc2V0cz86IFJlY29yZDxzdHJpbmcsIEFzc2V0SW5mbz47XHJcbn1cclxuXHJcbmludGVyZmFjZSBBc3NldE1ldGEge1xyXG4gICAgdXVpZDogc3RyaW5nO1xyXG4gICAgdXNlckRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgc3ViTWV0YXM6IFJlY29yZDxzdHJpbmcsIHtcclxuICAgICAgICBpbXBvcnRlcjogc3RyaW5nO1xyXG4gICAgICAgIHV1aWQ6IHN0cmluZztcclxuICAgICAgICB1c2VyRGF0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbiAgICB9PjtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBBc3NldFJlc29sdmVPcHRpb25zIHtcclxuICAgIC8qKiBJbmNsdWRlIHRoZSBGaWdtYSBmaWxlIElELCBub2RlL3NvdXJjZSBJRCBhbmQgcmVuZGVyaW5nIHZhcmlhbnQuIE5ldmVyIGp1c3QgYSBub2RlIG5hbWUuICovXHJcbiAgICBzb3VyY2VLZXk6IHN0cmluZztcclxuICAgIGJvcmRlcnM/OiB7IGxlZnQ6IG51bWJlcjsgcmlnaHQ6IG51bWJlcjsgdG9wOiBudW1iZXI7IGJvdHRvbTogbnVtYmVyIH07XHJcbiAgICB0aWxlZD86IGJvb2xlYW47XHJcbiAgICByZWZyZXNoPzogYm9vbGVhbjtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBBc3NldExvb2t1cE9wdGlvbnMge1xyXG4gICAgdGlsZWQ/OiBib29sZWFuO1xyXG4gICAgc2xpY2VkPzogYm9vbGVhbjtcclxuICAgIGJvcmRlcnM/OiBBc3NldFJlc29sdmVPcHRpb25zWydib3JkZXJzJ107XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgQXNzZXRSZXNvbHV0aW9uRXZlbnQge1xyXG4gICAgc291cmNlS2V5Pzogc3RyaW5nO1xyXG4gICAgdXJsOiBzdHJpbmc7XHJcbiAgICBhY3Rpb246ICdyZXVzZWQnIHwgJ2NyZWF0ZWQnIHwgJ3VwZGF0ZWQnIHwgJ2ZhbGxiYWNrJztcclxuICAgIHJlYXNvbjogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU291cmNlSWRlbnRpdHkge1xyXG4gICAgdmVyc2lvbjogMTtcclxuICAgIGNvbnRlbnRIYXNoOiBzdHJpbmc7XHJcbiAgICBpbnB1dEhhc2g/OiBzdHJpbmc7XHJcbiAgICBjb25maWc6IHN0cmluZztcclxuICAgIHNvdXJjZXM6IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XHJcbiAgICAvKiogRXhjbHVzaXZlIHNvdXJjZSB1cGRhdGUgam91cm5hbDsgbmV2ZXIgYSBzdWNjZXNzZnVsIHJldXNhYmxlIG1hcHBpbmcuICovXHJcbiAgICBwZW5kaW5nPzogeyBzb3VyY2VLZXk6IHN0cmluZzsgaW5wdXRIYXNoOiBzdHJpbmc7IGNvbnRlbnRIYXNoOiBzdHJpbmc7IGNvbmZpZzogc3RyaW5nIH07XHJcbn1cclxuXHJcbmNvbnN0IGFzc2V0TG9ja3MgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTx1bmtub3duPj4oKTtcclxuY29uc3QgYXNzZXRJbmRleFZlcnNpb25zID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuY29uc3QgaGFzaCA9IChpbnB1dDogQnVmZmVyIHwgc3RyaW5nKSA9PiBjcmVhdGVIYXNoKCdzaGEyNTYnKS51cGRhdGUoaW5wdXQpLmRpZ2VzdCgnaGV4Jyk7XHJcbmNvbnN0IG5vcm1hbGl6ZWQgPSAoaW5wdXQ6IHN0cmluZykgPT4gaW5wdXQubm9ybWFsaXplKCdORktDJykudG9Mb2NhbGVMb3dlckNhc2UoJ2VuLVVTJyk7XHJcblxyXG5hc3luYyBmdW5jdGlvbiBsb2NrZWQ8VD4oa2V5OiBzdHJpbmcsIHRhc2s6ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcclxuICAgIGNvbnN0IHByZXZpb3VzID0gYXNzZXRMb2Nrcy5nZXQoa2V5KSA/PyBQcm9taXNlLnJlc29sdmUoKTtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSBwcmV2aW91cy5jYXRjaCgoKSA9PiB1bmRlZmluZWQpLnRoZW4odGFzayk7XHJcbiAgICBhc3NldExvY2tzLnNldChrZXksIHBlbmRpbmcpO1xyXG4gICAgdHJ5IHsgcmV0dXJuIGF3YWl0IHBlbmRpbmc7IH1cclxuICAgIGZpbmFsbHkgeyBpZiAoYXNzZXRMb2Nrcy5nZXQoa2V5KSA9PT0gcGVuZGluZykgYXNzZXRMb2Nrcy5kZWxldGUoa2V5KTsgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWdLZXkoYm9yZGVycz86IEFzc2V0UmVzb2x2ZU9wdGlvbnNbJ2JvcmRlcnMnXSwgdGlsZWQgPSBmYWxzZSk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodGlsZWQgPyBbJ3RpbGVkJ10gOiBbJ3Nwcml0ZScsIC4uLihbJ2xlZnQnLCAncmlnaHQnLCAndG9wJywgJ2JvdHRvbSddIGFzIGNvbnN0KVxyXG4gICAgICAgIC5tYXAoKHNpZGUpID0+IE1hdGgubWF4KDAsIE1hdGgucm91bmQoYm9yZGVycz8uW3NpZGVdID8/IDApKSldKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc3RvcmVkQ29uZmlnKG1ldGE6IEFzc2V0TWV0YSB8IG51bGwsIHRpbGVkID0gZmFsc2UpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZGF0YSA9IE9iamVjdC52YWx1ZXMobWV0YT8uc3ViTWV0YXMgPz8ge30pLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaW1wb3J0ZXIgPT09ICdzcHJpdGUtZnJhbWUnKT8udXNlckRhdGE7XHJcbiAgICByZXR1cm4gY29uZmlnS2V5KGRhdGEgPyB7IGxlZnQ6IE51bWJlcihkYXRhLmJvcmRlckxlZnQpIHx8IDAsIHJpZ2h0OiBOdW1iZXIoZGF0YS5ib3JkZXJSaWdodCkgfHwgMCxcclxuICAgICAgICB0b3A6IE51bWJlcihkYXRhLmJvcmRlclRvcCkgfHwgMCwgYm90dG9tOiBOdW1iZXIoZGF0YS5ib3JkZXJCb3R0b20pIHx8IDAgfSA6IHVuZGVmaW5lZCwgdGlsZWQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2YWxpZENvbmZpZ3VyYXRpb24obWV0YTogQXNzZXRNZXRhIHwgbnVsbCwgdGlsZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGRhdGEgPSBPYmplY3QudmFsdWVzKG1ldGE/LnN1Yk1ldGFzID8/IHt9KS5maW5kKChpdGVtKSA9PiBpdGVtLmltcG9ydGVyID09PSAnc3ByaXRlLWZyYW1lJyk/LnVzZXJEYXRhO1xyXG4gICAgaWYgKCFkYXRhKSByZXR1cm4gZmFsc2U7XHJcbiAgICBpZiAodGlsZWQpIHJldHVybiBkYXRhLnRyaW1UeXBlID09PSAnbm9uZScgJiYgZGF0YS5wYWNrYWJsZSA9PT0gZmFsc2UgJiYgIWhhc1NsaWNlZEJvcmRlcnMobWV0YSk7XHJcbiAgICByZXR1cm4gIWhhc1NsaWNlZEJvcmRlcnMobWV0YSkgfHwgZGF0YS50cmltVHlwZSA9PT0gJ25vbmUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpZGVudGl0eUZyb20obWV0YTogQXNzZXRNZXRhIHwgbnVsbCk6IFNvdXJjZUlkZW50aXR5IHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IGlkZW50aXR5ID0gbWV0YT8udXNlckRhdGE/LmZpZ21hSW1wb3J0ZXIgYXMgU291cmNlSWRlbnRpdHkgfCB1bmRlZmluZWQ7XHJcbiAgICByZXR1cm4gaWRlbnRpdHk/LnZlcnNpb24gPT09IDEgJiYgdHlwZW9mIGlkZW50aXR5LmNvbnRlbnRIYXNoID09PSAnc3RyaW5nJyAmJiAvXlswLTlhLWZdezY0fSQvLnRlc3QoaWRlbnRpdHkuY29udGVudEhhc2gpXHJcbiAgICAgICAgJiYgdHlwZW9mIGlkZW50aXR5LmNvbmZpZyA9PT0gJ3N0cmluZycgJiYgaWRlbnRpdHkuc291cmNlcyAmJiB0eXBlb2YgaWRlbnRpdHkuc291cmNlcyA9PT0gJ29iamVjdCdcclxuICAgICAgICAmJiBPYmplY3QuZW50cmllcyhpZGVudGl0eS5zb3VyY2VzKS5ldmVyeSgoW2tleSwgdmFsdWVdKSA9PiAvXlswLTlhLWZdezY0fSQvLnRlc3Qoa2V5KVxyXG4gICAgICAgICAgICAmJiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgJiYgdmFsdWUgPiAwKVxyXG4gICAgICAgID8gaWRlbnRpdHkgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBoYXNTbGljZWRCb3JkZXJzKG1ldGE6IEFzc2V0TWV0YSB8IG51bGwgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IHNwcml0ZU1ldGEgPSBPYmplY3QudmFsdWVzKG1ldGE/LnN1Yk1ldGFzID8/IHt9KVxyXG4gICAgICAgIC5maW5kKChpdGVtKSA9PiBpdGVtLmltcG9ydGVyID09PSAnc3ByaXRlLWZyYW1lJyk7XHJcbiAgICByZXR1cm4gWydib3JkZXJMZWZ0JywgJ2JvcmRlclJpZ2h0JywgJ2JvcmRlclRvcCcsICdib3JkZXJCb3R0b20nXVxyXG4gICAgICAgIC5zb21lKChrZXkpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBzcHJpdGVNZXRhPy51c2VyRGF0YT8uW2tleV07XHJcbiAgICAgICAgICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgJiYgdmFsdWUgPiAwO1xyXG4gICAgICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub3JtYWxpemVGb2xkZXIoaW5wdXQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IGlucHV0LnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXlxcLyt8XFwvKyQvZywgJycpO1xyXG4gICAgaWYgKCF2YWx1ZSB8fCB2YWx1ZSA9PT0gJy4nIHx8IHZhbHVlLnNwbGl0KCcvJykuc29tZSgocGFydCkgPT4gIXBhcnQgfHwgcGFydCA9PT0gJy4uJykpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+i1hOa6kOebruW9leaXoOaViOOAgicpO1xyXG4gICAgfVxyXG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoJ2Fzc2V0cy8nKSkge1xyXG4gICAgICAgIHJldHVybiB2YWx1ZS5zbGljZSgnYXNzZXRzLycubGVuZ3RoKTtcclxuICAgIH1cclxuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKCdkYjovLycpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfotYTmupDnm67lvZXor7floavlhpkgYXNzZXRzIOS4i+eahOebuOWvuei3r+W+hOOAgicpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc2FuaXRpemVBc3NldE5hbWUoaW5wdXQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBsZXQgdmFsdWUgPSBpbnB1dFxyXG4gICAgICAgIC5ub3JtYWxpemUoJ05GS0MnKVxyXG4gICAgICAgIC5yZXBsYWNlKC9bPD46XCIvXFxcXHw/KiMlXFx1MDAwMC1cXHUwMDFmXS9nLCAnXycpXHJcbiAgICAgICAgLnJlcGxhY2UoL1xccysvZywgJyAnKVxyXG4gICAgICAgIC5yZXBsYWNlKC9eWy4gXSt8Wy4gXSskL2csICcnKVxyXG4gICAgICAgIC5zbGljZSgwLCA3Mik7XHJcbiAgICBpZiAoL14oY29ufHBybnxhdXh8bnVsfGNvbVsxLTldfGxwdFsxLTldKSg/OlxcLnwkKS9pLnRlc3QodmFsdWUpKSB7XHJcbiAgICAgICAgdmFsdWUgPSBgXyR7dmFsdWV9YDtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZSB8fCAnZmlnbWFfbm9kZSc7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50czogQnVmZmVyKTogUmFzdGVySW1hZ2VFeHRlbnNpb24ge1xyXG4gICAgaWYgKGNvbnRlbnRzLmxlbmd0aCA+PSA4XHJcbiAgICAgICAgJiYgY29udGVudHMuc3ViYXJyYXkoMCwgOCkuZXF1YWxzKEJ1ZmZlci5mcm9tKFsweDg5LCAweDUwLCAweDRlLCAweDQ3LCAweDBkLCAweDBhLCAweDFhLCAweDBhXSkpKSB7XHJcbiAgICAgICAgcmV0dXJuICdwbmcnO1xyXG4gICAgfVxyXG4gICAgaWYgKGNvbnRlbnRzLmxlbmd0aCA+PSAzXHJcbiAgICAgICAgJiYgY29udGVudHNbMF0gPT09IDB4ZmZcclxuICAgICAgICAmJiBjb250ZW50c1sxXSA9PT0gMHhkOFxyXG4gICAgICAgICYmIGNvbnRlbnRzWzJdID09PSAweGZmKSB7XHJcbiAgICAgICAgcmV0dXJuICdqcGcnO1xyXG4gICAgfVxyXG4gICAgaWYgKGNvbnRlbnRzLmxlbmd0aCA+PSAxMlxyXG4gICAgICAgICYmIGNvbnRlbnRzLnN1YmFycmF5KDAsIDQpLnRvU3RyaW5nKCdhc2NpaScpID09PSAnUklGRidcclxuICAgICAgICAmJiBjb250ZW50cy5zdWJhcnJheSg4LCAxMikudG9TdHJpbmcoJ2FzY2lpJykgPT09ICdXRUJQJykge1xyXG4gICAgICAgIHJldHVybiAnd2VicCc7XHJcbiAgICB9XHJcbiAgICBjb25zdCBoZWFkZXIgPSBjb250ZW50cy5zdWJhcnJheSgwLCA2KS50b1N0cmluZygnYXNjaWknKTtcclxuICAgIGlmIChoZWFkZXIgPT09ICdHSUY4N2EnIHx8IGhlYWRlciA9PT0gJ0dJRjg5YScpIHtcclxuICAgICAgICByZXR1cm4gJ2dpZic7XHJcbiAgICB9XHJcbiAgICBpZiAoY29udGVudHMubGVuZ3RoID49IDIgJiYgY29udGVudHNbMF0gPT09IDB4NDIgJiYgY29udGVudHNbMV0gPT09IDB4NGQpIHtcclxuICAgICAgICByZXR1cm4gJ2JtcCc7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0ZpZ21hIOWOn+Wni+W5s+mTuuWbvueJh+agvOW8j+aXoOazleivhuWIq++8m+W9k+WJjeaUr+aMgSBQTkfjgIFKUEVH44CBV2ViUOOAgUdJRiDlkowgQk1Q44CCJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2V0QmFzZU5hbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzYW5pdGl6ZUFzc2V0TmFtZShuYW1lKS5yZXBsYWNlKC9cXC4ocG5nfGpwZT9nfHdlYnB8Z2lmfGJtcHxzdmcpJC9pLCAnJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmRTcHJpdGVGcmFtZShpbmZvOiBBc3NldEluZm8pOiBBc3NldEluZm8gfCBudWxsIHtcclxuICAgIGNvbnN0IHF1ZXVlOiBBc3NldEluZm9bXSA9IFtpbmZvXTtcclxuICAgIHdoaWxlIChxdWV1ZS5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBpdGVtID0gcXVldWUuc2hpZnQoKSE7XHJcbiAgICAgICAgaWYgKGl0ZW0uaW1wb3J0ZXIgPT09ICdzcHJpdGUtZnJhbWUnIHx8IGl0ZW0udHlwZSA9PT0gJ2NjLlNwcml0ZUZyYW1lJykge1xyXG4gICAgICAgICAgICByZXR1cm4gaXRlbTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcXVldWUucHVzaCguLi5PYmplY3QudmFsdWVzKGl0ZW0uc3ViQXNzZXRzID8/IHt9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXRSZXF1ZXN0KGNoYW5uZWw6IHN0cmluZywgbWV0aG9kOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTxhbnk+IHtcclxuICAgIC8vIExvZyBvbmx5IHRoZSB0YXJnZXQsIG5ldmVyIGltYWdlIGNvbnRlbnRzIG9yIHNlcmlhbGl6ZWQgbWV0YWRhdGEuXHJcbiAgICByZXR1cm4gZGlhZ25vc3RpY1Rhc2soYENvY29zIOi1hOa6kCAke21ldGhvZH1gLCB7IHRhcmdldDogYXJnc1swXSB9LFxyXG4gICAgICAgICgpID0+IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoY2hhbm5lbCwgbWV0aG9kLCAuLi5hcmdzKSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHF1ZXJ5QXNzZXQodmFsdWU6IHN0cmluZyk6IFByb21pc2U8QXNzZXRJbmZvIHwgbnVsbD4ge1xyXG4gICAgcmV0dXJuIGF3YWl0IGFzc2V0UmVxdWVzdChcclxuICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICdxdWVyeS1hc3NldC1pbmZvJyxcclxuICAgICAgICB2YWx1ZSxcclxuICAgICAgICBbJ3N1YkFzc2V0cyddLFxyXG4gICAgKSBhcyBBc3NldEluZm8gfCBudWxsO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yQXNzZXQodXJsOiBzdHJpbmcsIHJlcXVpcmVTcHJpdGVGcmFtZSA9IHRydWUsIGtub3duVXVpZD86IHN0cmluZyk6IFByb21pc2U8QXNzZXRJbmZvPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGxldCBsYXN0SW5mbzogQXNzZXRJbmZvIHwgbnVsbCA9IG51bGw7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAzMF8wMDApIHtcclxuICAgICAgICBsZXQgaW5mbyA9IGF3YWl0IHF1ZXJ5QXNzZXQodXJsKTtcclxuICAgICAgICBpZiAoIWluZm8gJiYga25vd25VdWlkKSBpbmZvID0gYXdhaXQgcXVlcnlBc3NldChrbm93blV1aWQpO1xyXG4gICAgICAgIGxhc3RJbmZvID0gaW5mbztcclxuICAgICAgICBpZiAoaW5mbz8uaW52YWxpZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvY29zIOi1hOa6kOWvvOWFpeWksei0pe+8miR7dXJsfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaW5mbz8uaW1wb3J0ZWQpIHtcclxuICAgICAgICAgICAgaWYgKCFyZXF1aXJlU3ByaXRlRnJhbWUgfHwgZmluZFNwcml0ZUZyYW1lKGluZm8pKSByZXR1cm4gaW5mbztcclxuICAgICAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IGFzc2V0UmVxdWVzdCgnYXNzZXQtZGInLCAncXVlcnktYXNzZXQtbWV0YScsIGluZm8udXVpZCkgYXMgQXNzZXRNZXRhIHwgbnVsbDtcclxuICAgICAgICAgICAgY29uc3QgZnJhbWUgPSBPYmplY3QudmFsdWVzKG1ldGE/LnN1Yk1ldGFzID8/IHt9KS5maW5kKChpdGVtKSA9PiBpdGVtLmltcG9ydGVyID09PSAnc3ByaXRlLWZyYW1lJyk7XHJcbiAgICAgICAgICAgIGlmIChmcmFtZT8udXVpZCkgcmV0dXJuIHsgLi4uaW5mbywgc3ViQXNzZXRzOiB7IC4uLmluZm8uc3ViQXNzZXRzLFxyXG4gICAgICAgICAgICAgICAgcGVyc2lzdGVkRnJhbWU6IHsgLi4uaW5mbywgdXVpZDogZnJhbWUudXVpZCwgaW1wb3J0ZXI6ICdzcHJpdGUtZnJhbWUnLCB0eXBlOiAnY2MuU3ByaXRlRnJhbWUnIH0gfSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAxMjApKTtcclxuICAgIH1cclxuICAgIGlmIChsYXN0SW5mbz8uaW1wb3J0ZWQgJiYgcmVxdWlyZVNwcml0ZUZyYW1lKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb2NvcyDlt7Llr7zlhaXlm77niYfkvYbmnKrog73nlJ/miJAgU3ByaXRlRnJhbWXvvJoke3VybH1gKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg562J5b6FIENvY29zIOWbvueJh+i1hOa6kOWvvOWFpei2heaXtu+8miR7dXJsfWApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVTcHJpdGVGcmFtZSh1cmw6IHN0cmluZywgaW5mbzogQXNzZXRJbmZvKTogUHJvbWlzZTxBc3NldEluZm8+IHtcclxuICAgIGlmIChmaW5kU3ByaXRlRnJhbWUoaW5mbykpIHtcclxuICAgICAgICByZXR1cm4gaW5mbztcclxuICAgIH1cclxuICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBhc3NldFJlcXVlc3QoXHJcbiAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAncXVlcnktYXNzZXQtbWV0YScsXHJcbiAgICAgICAgaW5mby51dWlkLFxyXG4gICAgKSBhcyBBc3NldE1ldGEgfCBudWxsO1xyXG4gICAgaWYgKCFtZXRhKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xor7vlj5YgQ29jb3Mg5Zu+54mH6LWE5rqQIE1ldGHvvJoke3VybH1gKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHBlcnNpc3RlZEZyYW1lID0gT2JqZWN0LnZhbHVlcyhtZXRhLnN1Yk1ldGFzID8/IHt9KS5maW5kKChpdGVtKSA9PiBpdGVtLmltcG9ydGVyID09PSAnc3ByaXRlLWZyYW1lJyk7XHJcbiAgICBpZiAocGVyc2lzdGVkRnJhbWU/LnV1aWQpIHJldHVybiB7IC4uLmluZm8sIHN1YkFzc2V0czogeyAuLi5pbmZvLnN1YkFzc2V0cyxcclxuICAgICAgICBwZXJzaXN0ZWRGcmFtZTogeyAuLi5pbmZvLCB1dWlkOiBwZXJzaXN0ZWRGcmFtZS51dWlkLCBpbXBvcnRlcjogJ3Nwcml0ZS1mcmFtZScsIHR5cGU6ICdjYy5TcHJpdGVGcmFtZScgfSB9IH07XHJcbiAgICBtZXRhLnVzZXJEYXRhID0gbWV0YS51c2VyRGF0YSA/PyB7fTtcclxuICAgIGlmIChtZXRhLnVzZXJEYXRhLnR5cGUgIT09ICdzcHJpdGUtZnJhbWUnKSB7XHJcbiAgICAgICAgbWV0YS51c2VyRGF0YS50eXBlID0gJ3Nwcml0ZS1mcmFtZSc7XHJcbiAgICAgICAgYXdhaXQgYXNzZXRSZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXRhLCBudWxsLCAyKSxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgYXNzZXRSZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICByZXR1cm4gd2FpdEZvckFzc2V0KHVybCwgdHJ1ZSwgaW5mby51dWlkKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZW5zdXJlRm9sZGVyKHVybDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHF1ZXJ5QXNzZXQodXJsKTtcclxuICAgIGlmIChleGlzdGluZykge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGF3YWl0IGFzc2V0UmVxdWVzdCgnYXNzZXQtZGInLCAnY3JlYXRlLWFzc2V0JywgdXJsLCBudWxsKTtcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIEFzc2V0V3JpdGVyIHtcbiAgICByZWFkb25seSBmb2xkZXI6IHN0cmluZztcbiAgICByZWFkb25seSBldmVudHM6IEFzc2V0UmVzb2x1dGlvbkV2ZW50W10gPSBbXTtcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgd3JpdGVUYXJnZXRzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBwcml2YXRlIGluZGV4UHJvbWlzZT86IFByb21pc2U8dm9pZD47XHJcbiAgICBwcml2YXRlIGluZGV4VmVyc2lvbiA9IC0xO1xyXG4gICAgcHJpdmF0ZSByZWFkb25seSBpbmRleGVkID0gbmV3IE1hcDxzdHJpbmcsIEFzc2V0TWV0YT4oKTtcclxuXHJcbiAgICBjb25zdHJ1Y3Rvcihmb2xkZXI6IHN0cmluZywgcHJpdmF0ZSByZWFkb25seSBiZWZvcmVXcml0ZT86ICh1cmw6IHN0cmluZywgZXhpc3RlZDogYm9vbGVhbikgPT4gUHJvbWlzZTx2b2lkPikge1xyXG4gICAgICAgIHRoaXMuZm9sZGVyID0gbm9ybWFsaXplRm9sZGVyKGZvbGRlcik7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBnZXQgcHJvamVjdFJvb3QoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgICAgICByZXR1cm4gdHlwZW9mIEVkaXRvciAhPT0gJ3VuZGVmaW5lZCcgJiYgRWRpdG9yLlByb2plY3Q/LnBhdGggPyByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgpIDogdW5kZWZpbmVkO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgcGF0aEZvcih1cmw6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICAgICAgY29uc3Qgcm9vdCA9IHRoaXMucHJvamVjdFJvb3Q7XHJcbiAgICAgICAgaWYgKCFyb290KSByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgICAgIGlmICghdXJsLnN0YXJ0c1dpdGgoJ2RiOi8vYXNzZXRzLycpIHx8IC9bXFx1MDAwMD8jXS8udGVzdCh1cmwpKSB0aHJvdyBuZXcgRXJyb3IoYOi1hOa6kOWcsOWdgOaXoOaViO+8miR7dXJsfWApO1xyXG4gICAgICAgIGNvbnN0IHBhdGggPSByZXNvbHZlKHJvb3QsIHVybC5zbGljZSgnZGI6Ly8nLmxlbmd0aCkpO1xyXG4gICAgICAgIGNvbnN0IHN1ZmZpeCA9IHJlbGF0aXZlKGpvaW4ocm9vdCwgJ2Fzc2V0cycpLCBwYXRoKTtcclxuICAgICAgICBpZiAoIXN1ZmZpeCB8fCBzdWZmaXguc3RhcnRzV2l0aCgnLi4nKSB8fCBpc0Fic29sdXRlKHN1ZmZpeCkpIHRocm93IG5ldyBFcnJvcihg6LWE5rqQ5Zyw5Z2A6LaF5Ye66aG555uuIGFzc2V0c++8miR7dXJsfWApO1xyXG4gICAgICAgIHJldHVybiBwYXRoO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgZGlza01ldGEodXJsOiBzdHJpbmcpOiBQcm9taXNlPEFzc2V0TWV0YSB8IG51bGw+IHtcclxuICAgICAgICBjb25zdCBwYXRoID0gdGhpcy5wYXRoRm9yKHVybCk7XHJcbiAgICAgICAgaWYgKCFwYXRoKSByZXR1cm4gbnVsbDtcclxuICAgICAgICB0cnkgeyByZXR1cm4gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZShgJHtwYXRofS5tZXRhYCwgJ3V0ZjgnKSkgYXMgQXNzZXRNZXRhOyB9XHJcbiAgICAgICAgY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGlmICgoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlID09PSAnRU5PRU5UJykgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV6K+75Y+W5bey5pyJ6LWE5rqQIE1ldGHvvIzkuI3kvJropobnm5bvvJoke3VybH3vvJske1N0cmluZyhlcnJvcil9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgY29udGVudHNBdCh1cmw6IHN0cmluZyk6IFByb21pc2U8QnVmZmVyIHwgbnVsbD4ge1xyXG4gICAgICAgIGNvbnN0IHBhdGggPSB0aGlzLnBhdGhGb3IodXJsKTtcclxuICAgICAgICBpZiAoIXBhdGgpIHJldHVybiBudWxsO1xyXG4gICAgICAgIHRyeSB7IHJldHVybiBhd2FpdCByZWFkRmlsZShwYXRoKTsgfVxyXG4gICAgICAgIGNhdGNoIChlcnJvcikgeyBpZiAoKGVycm9yIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZSA9PT0gJ0VOT0VOVCcpIHJldHVybiBudWxsOyB0aHJvdyBlcnJvcjsgfVxyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgaW5kZXhBc3NldHMoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgY29uc3Qgcm9vdCA9IHRoaXMucHJvamVjdFJvb3Q7XHJcbiAgICAgICAgaWYgKCFyb290KSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgY3VycmVudFZlcnNpb24gPSBhc3NldEluZGV4VmVyc2lvbnMuZ2V0KHJvb3QpID8/IDA7XHJcbiAgICAgICAgaWYgKHRoaXMuaW5kZXhQcm9taXNlICYmIHRoaXMuaW5kZXhWZXJzaW9uID09PSBjdXJyZW50VmVyc2lvbikgcmV0dXJuIHRoaXMuaW5kZXhQcm9taXNlO1xyXG4gICAgICAgIHRoaXMuaW5kZXhWZXJzaW9uID0gY3VycmVudFZlcnNpb247XHJcbiAgICAgICAgdGhpcy5pbmRleGVkLmNsZWFyKCk7XHJcbiAgICAgICAgY29uc3Qgc2NhbiA9IGFzeW5jIChmb2xkZXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBlbnRyaWVzID0gYXdhaXQgcmVhZGRpcihmb2xkZXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcclxuICAgICAgICAgICAgZW50cmllcy5zb3J0KChhLCBiKSA9PiBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBwYXRoID0gam9pbihmb2xkZXIsIGVudHJ5Lm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgLy8gSGlkZGVuIGRpcmVjdG9yaWVzL2Fzc2V0cyBwYXJ0aWNpcGF0ZSBleGFjdGx5IGxpa2UgdmlzaWJsZSBvbmVzLlxyXG4gICAgICAgICAgICAgICAgLy8gRG8gbm90IGZvbGxvdyBkaXJlY3Rvcnkgc3ltbGlua3Mgb3V0c2lkZSB0aGUgcHJvamVjdC5cclxuICAgICAgICAgICAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpKSBhd2FpdCBzY2FuKHBhdGgpO1xyXG4gICAgICAgICAgICAgICAgZWxzZSBpZiAoZW50cnkuaXNGaWxlKCkgJiYgL1xcLihwbmd8anBlP2d8d2VicHxnaWZ8Ym1wfHN2ZylcXC5tZXRhJC9pLnRlc3QoZW50cnkubmFtZSkpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCB1cmwgPSBgZGI6Ly8ke3JlbGF0aXZlKHJvb3QsIHBhdGguc2xpY2UoMCwgLTUpKS5yZXBsYWNlKC9cXFxcL2csICcvJyl9YDtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgdGhpcy5kaXNrTWV0YSh1cmwpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChtZXRhKSB0aGlzLmluZGV4ZWQuc2V0KHVybCwgbWV0YSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIHRoaXMuaW5kZXhQcm9taXNlID0gc2Nhbihqb2luKHJvb3QsICdhc3NldHMnKSkuY2F0Y2goKGVycm9yKSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMuaW5kZXhQcm9taXNlID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICB0aGlzLmluZGV4ZWQuY2xlYXIoKTtcclxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMuaW5kZXhQcm9taXNlO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgYXZhaWxhYmxlSW5mbyh1cmw6IHN0cmluZyk6IFByb21pc2U8QXNzZXRJbmZvIHwgbnVsbD4ge1xyXG4gICAgICAgIGxldCBpbmZvID0gYXdhaXQgcXVlcnlBc3NldCh1cmwpO1xyXG4gICAgICAgIGlmICghaW5mbykge1xyXG4gICAgICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgdGhpcy5kaXNrTWV0YSh1cmwpO1xyXG4gICAgICAgICAgICBpZiAobWV0YT8udXVpZCkgaW5mbyA9IGF3YWl0IHF1ZXJ5QXNzZXQobWV0YS51dWlkKTtcclxuICAgICAgICAgICAgaWYgKCFpbmZvICYmIChtZXRhIHx8IGF3YWl0IHRoaXMuY29udGVudHNBdCh1cmwpKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlt7LmnInotYTmupDlsJrmnKrooqsgQ29jb3Mg6LWE5rqQ5pWw5o2u5bqT6K+G5Yir77yM6K+3562J5b6F5a+85YWl5a6M5oiQ5ZCO6YeN6K+V77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHt1cmx9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGluZm8/LmludmFsaWQpIHRocm93IG5ldyBFcnJvcihgQ29jb3Mg6LWE5rqQ5peg5pWI77yM5LiN5Lya6KaG55uW5YW2IE1ldGHvvJoke3VybH1gKTtcclxuICAgICAgICBpZiAoaW5mbyAmJiAhaW5mby5pbXBvcnRlZCkgaW5mbyA9IGF3YWl0IHdhaXRGb3JBc3NldChpbmZvLnVybCB8fCB1cmwsIGZhbHNlLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgIHJldHVybiBpbmZvO1xyXG4gICAgfVxyXG5cclxuICAgIGFzeW5jIGV4aXN0aW5nRm9yU291cmNlKHNvdXJjZUtleTogc3RyaW5nLCBvcHRpb25zPzogQXNzZXRMb29rdXBPcHRpb25zKTogUHJvbWlzZTxTcHJpdGVBc3NldFNwZWMgfCBudWxsPiB7XHJcbiAgICAgICAgcmV0dXJuIGxvY2tlZCh0aGlzLnByb2plY3RSb290ID8/IHRoaXMuZm9sZGVyLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuaW5kZXhBc3NldHMoKTtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gaGFzaChzb3VyY2VLZXkpO1xyXG4gICAgICAgICAgICBjb25zdCBjYW5kaWRhdGVzID0gWy4uLnRoaXMuaW5kZXhlZC5lbnRyaWVzKCldLmZpbHRlcigoWywgbWV0YV0pID0+IGlkZW50aXR5RnJvbShtZXRhKT8uc291cmNlc1trZXldKTtcclxuICAgICAgICAgICAgY2FuZGlkYXRlcy5zb3J0KChhLCBiKSA9PiAoaWRlbnRpdHlGcm9tKGJbMV0pIS5zb3VyY2VzW2tleV0gLSBpZGVudGl0eUZyb20oYVsxXSkhLnNvdXJjZXNba2V5XSlcclxuICAgICAgICAgICAgICAgIHx8IGFbMF0ubG9jYWxlQ29tcGFyZShiWzBdKSk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW3VybF0gb2YgY2FuZGlkYXRlcykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IHRoaXMuZGlza01ldGEodXJsKSA/PyB0aGlzLmluZGV4ZWQuZ2V0KHVybCkhO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgaWRlbnRpdHkgPSBpZGVudGl0eUZyb20obWV0YSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50cyA9IGF3YWl0IHRoaXMuY29udGVudHNBdCh1cmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFpZGVudGl0eSB8fCBpZGVudGl0eS5wZW5kaW5nIHx8ICFjb250ZW50cyB8fCBoYXNoKGNvbnRlbnRzKSAhPT0gaWRlbnRpdHkuY29udGVudEhhc2gpIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdGlsZWQgPSBpZGVudGl0eS5jb25maWcgPT09IGNvbmZpZ0tleSh1bmRlZmluZWQsIHRydWUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnM/LnRpbGVkICE9PSB1bmRlZmluZWQgJiYgb3B0aW9ucy50aWxlZCAhPT0gdGlsZWQpIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnM/LnNsaWNlZCAhPT0gdW5kZWZpbmVkICYmIG9wdGlvbnMuc2xpY2VkICE9PSBoYXNTbGljZWRCb3JkZXJzKG1ldGEpKSBjb250aW51ZTtcclxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zPy5ib3JkZXJzICYmIGlkZW50aXR5LmNvbmZpZyAhPT0gY29uZmlnS2V5KG9wdGlvbnMuYm9yZGVycywgb3B0aW9ucy50aWxlZCkpIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgaWYgKGlkZW50aXR5LmNvbmZpZyAhPT0gc3RvcmVkQ29uZmlnKG1ldGEsIHRpbGVkKSB8fCAhdmFsaWRDb25maWd1cmF0aW9uKG1ldGEsIHRpbGVkKSkgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NldCA9IGF3YWl0IHRoaXMuZXhpc3RpbmcodXJsLCB0aWxlZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYXNzZXQpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLmV2ZW50cy5wdXNoKHsgc291cmNlS2V5OiBrZXksIHVybDogYXNzZXQudXJsLCBhY3Rpb246ICdyZXVzZWQnLCByZWFzb246ICfmupDmoIfor4bjgIHlhoXlrrnjgIFTcHJpdGVGcmFtZSBVVUlEIOS4juWIh+eJh+mFjee9ruWdh+W3sumqjOivgScgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGFzc2V0O1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIGFzeW5jIHJlc29sdmUodXJsOiBzdHJpbmcsIGNvbnRlbnRzOiBCdWZmZXIgfCBzdHJpbmcsIG9wdGlvbnM6IEFzc2V0UmVzb2x2ZU9wdGlvbnMpOiBQcm9taXNlPFNwcml0ZUFzc2V0U3BlYz4ge1xyXG4gICAgICAgIHJldHVybiBsb2NrZWQodGhpcy5wcm9qZWN0Um9vdCA/PyB0aGlzLmZvbGRlciwgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoIW9wdGlvbnMuc291cmNlS2V5LnRyaW0oKSkgdGhyb3cgbmV3IEVycm9yKCfotYTmupDmupDmoIfor4bkuI3og73kuLrnqbrjgIInKTtcclxuICAgICAgICAgICAgYXdhaXQgdGhpcy5pbmRleEFzc2V0cygpO1xyXG4gICAgICAgICAgICBjb25zdCBzb3VyY2VLZXkgPSBoYXNoKG9wdGlvbnMuc291cmNlS2V5KTtcclxuICAgICAgICAgICAgY29uc3QgYnl0ZXMgPSB0eXBlb2YgY29udGVudHMgPT09ICdzdHJpbmcnID8gQnVmZmVyLmZyb20oY29udGVudHMsICd1dGY4JykgOiBjb250ZW50cztcclxuICAgICAgICAgICAgY29uc3QgaW5wdXRIYXNoID0gaGFzaChieXRlcyk7XHJcbiAgICAgICAgICAgIGxldCBqcGVnSGFzaDogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBjb25zdCBjb25maWcgPSBjb25maWdLZXkob3B0aW9ucy5ib3JkZXJzLCBvcHRpb25zLnRpbGVkKTtcclxuICAgICAgICAgICAgY29uc3QgbWFwcGVkID0gWy4uLnRoaXMuaW5kZXhlZC5lbnRyaWVzKCldLmZpbHRlcigoWywgbWV0YV0pID0+IGlkZW50aXR5RnJvbShtZXRhKT8uc291cmNlc1tzb3VyY2VLZXldKTtcclxuICAgICAgICAgICAgbWFwcGVkLnNvcnQoKGEsIGIpID0+IGlkZW50aXR5RnJvbShiWzFdKSEuc291cmNlc1tzb3VyY2VLZXldIC0gaWRlbnRpdHlGcm9tKGFbMV0pIS5zb3VyY2VzW3NvdXJjZUtleV0pO1xyXG4gICAgICAgICAgICBjb25zdCBuYW1lZCA9IFsuLi50aGlzLmluZGV4ZWQua2V5cygpXS5maWx0ZXIoKGNhbmRpZGF0ZSkgPT4gbm9ybWFsaXplZChiYXNlbmFtZShjYW5kaWRhdGUsIGV4dG5hbWUoY2FuZGlkYXRlKSkpXHJcbiAgICAgICAgICAgICAgICA9PT0gbm9ybWFsaXplZChiYXNlbmFtZSh1cmwsIGV4dG5hbWUodXJsKSkpKTtcclxuICAgICAgICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IFsuLi5uZXcgU2V0KFsuLi5tYXBwZWQubWFwKChbY2FuZGlkYXRlXSkgPT4gY2FuZGlkYXRlKSwgdXJsLFxyXG4gICAgICAgICAgICAgICAgLi4uKC9cXC5wbmckL2kudGVzdCh1cmwpID8gW3VybC5yZXBsYWNlKC9cXC5wbmckL2ksICcuanBnJyksIHVybC5yZXBsYWNlKC9cXC5wbmckL2ksICcuanBlZycpXSA6IFtdKSwgLi4ubmFtZWRdKV07XHJcbiAgICAgICAgICAgIGxldCBvd25VcGRhdGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IHRoaXMuYXZhaWxhYmxlSW5mbyhjYW5kaWRhdGUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFpbmZvKSBjb250aW51ZTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBhc3NldFJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LW1ldGEnLCBpbmZvLnV1aWQpIGFzIEFzc2V0TWV0YSB8IG51bGw7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpZGVudGl0eSA9IGlkZW50aXR5RnJvbShtZXRhKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IHRoaXMuY29udGVudHNBdChjYW5kaWRhdGUpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcGVuZGluZ093bmVkID0gaWRlbnRpdHk/LnBlbmRpbmc/LnNvdXJjZUtleSA9PT0gc291cmNlS2V5XHJcbiAgICAgICAgICAgICAgICAgICAgJiYgT2JqZWN0LmtleXMoaWRlbnRpdHkuc291cmNlcykubGVuZ3RoID09PSAxO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBzdG9yZWQgJiYgKCFpZGVudGl0eSB8fCBoYXNoKHN0b3JlZCkgPT09IGlkZW50aXR5LmNvbnRlbnRIYXNoXHJcbiAgICAgICAgICAgICAgICAgICAgfHwgKHBlbmRpbmdPd25lZCAmJiBoYXNoKHN0b3JlZCkgPT09IGlkZW50aXR5LnBlbmRpbmchLmNvbnRlbnRIYXNoKSk7XHJcbiAgICAgICAgICAgICAgICBpZiAodmVyaWZpZWQgJiYgL1xcLmpwZT9nJC9pLnRlc3QoY2FuZGlkYXRlKSAmJiBpc1BuZyhieXRlcykgJiYgIWlkZW50aXR5Py5pbnB1dEhhc2ggJiYgIWpwZWdIYXNoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcHJlcGFyZWQgPSBwcmVwYXJlTmV3UmFzdGVyKGJ5dGVzKTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAocHJlcGFyZWQuZXh0ZW5zaW9uID09PSAnanBnJykganBlZ0hhc2ggPSBoYXNoKHByZXBhcmVkLmNvbnRlbnRzKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IHNhbWVDb250ZW50cyA9IHZlcmlmaWVkICYmIChoYXNoKHN0b3JlZCEpID09PSBpbnB1dEhhc2ggfHwgaWRlbnRpdHk/LmlucHV0SGFzaCA9PT0gaW5wdXRIYXNoXHJcbiAgICAgICAgICAgICAgICAgICAgfHwgKGpwZWdIYXNoICYmIGhhc2goc3RvcmVkISkgPT09IGpwZWdIYXNoKSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzYW1lQ29uZmlnID0gY29uZmlnID09PSBzdG9yZWRDb25maWcobWV0YSwgb3B0aW9ucy50aWxlZClcclxuICAgICAgICAgICAgICAgICAgICAmJiAoIWlkZW50aXR5IHx8IGlkZW50aXR5LmNvbmZpZyA9PT0gY29uZmlnKVxyXG4gICAgICAgICAgICAgICAgICAgICYmIHZhbGlkQ29uZmlndXJhdGlvbihtZXRhLCBCb29sZWFuKG9wdGlvbnMudGlsZWQpKVxyXG4gICAgICAgICAgICAgICAgICAgICYmICghb3B0aW9ucy50aWxlZCB8fCBpZGVudGl0eT8uY29uZmlnID09PSBjb25maWcpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHNhbWVDb250ZW50cyAmJiBzYW1lQ29uZmlnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBhd2FpdCB0aGlzLmV4aXN0aW5nKGNhbmRpZGF0ZSwgb3B0aW9ucy50aWxlZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc2V0KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYmluZElkZW50aXR5KGNhbmRpZGF0ZSwgaW5mbywgbWV0YSwgc291cmNlS2V5LCBpbnB1dEhhc2gsIGNvbmZpZywgaGFzaChzdG9yZWQhKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuZXZlbnRzLnB1c2goeyBzb3VyY2VLZXksIHVybDogY2FuZGlkYXRlLCBhY3Rpb246ICdyZXVzZWQnLCByZWFzb246IGlkZW50aXR5Py5zb3VyY2VzW3NvdXJjZUtleV1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gJ+a6kOaYoOWwhOWRveS4re+8jOWGheWuueS4juWIh+eJh+mFjee9ruS4gOiHtCcgOiAn5ZCM5ZCN6LWE5rqQ5YaF5a655LiO5YiH54mH6YWN572u5LiA6Ie077yM5bey57uR5a6a5rqQ5qCH6K+GJyB9KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGFzc2V0O1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmIChpZGVudGl0eT8uc291cmNlc1tzb3VyY2VLZXldICYmIE9iamVjdC5rZXlzKGlkZW50aXR5LnNvdXJjZXMpLmxlbmd0aCA9PT0gMSAmJiB2ZXJpZmllZFxyXG4gICAgICAgICAgICAgICAgICAgICYmICghL1xcLmpwZT9nJC9pLnRlc3QoY2FuZGlkYXRlKSB8fCAhaXNQbmcoYnl0ZXMpIHx8IHByZXBhcmVOZXdSYXN0ZXIoYnl0ZXMpLmV4dGVuc2lvbiA9PT0gJ2pwZycpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgb3duVXBkYXRlID8/PSBjYW5kaWRhdGU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgLy8gT25seSBhbiBleGNsdXNpdmVseSBvd25lZCBzb3VyY2UgbWF5IHVwZGF0ZSBwaXhlbHMvbWV0YWRhdGEgaW4gcGxhY2UuXHJcbiAgICAgICAgICAgIC8vIEEgc2hhcmVkIG9yIGxlZ2FjeSBhc3NldCBhbHdheXMga2VlcHMgaXRzIHZhbGlkIHJlZmVyZW5jZXMgYW5kIGJ5dGVzLlxyXG4gICAgICAgICAgICBsZXQgdGFyZ2V0ID0gb3duVXBkYXRlID8/IHVybDtcclxuICAgICAgICAgICAgbGV0IGV4aXN0ZWQgPSBCb29sZWFuKGF3YWl0IHRoaXMuYXZhaWxhYmxlSW5mbyh0YXJnZXQpKTtcclxuICAgICAgICAgICAgbGV0IGlzb2xhdGVkID0gZmFsc2U7XHJcbiAgICAgICAgICAgIGlmICghb3duVXBkYXRlICYmICFleGlzdGVkICYmIC9cXC5wbmckL2kudGVzdCh0YXJnZXQpICYmIHByZXBhcmVOZXdSYXN0ZXIoYnl0ZXMpLmV4dGVuc2lvbiA9PT0gJ2pwZycpIHtcclxuICAgICAgICAgICAgICAgIHRhcmdldCA9IHRhcmdldC5yZXBsYWNlKC9cXC5wbmckL2ksICcuanBnJyk7XHJcbiAgICAgICAgICAgICAgICBleGlzdGVkID0gQm9vbGVhbihhd2FpdCB0aGlzLmF2YWlsYWJsZUluZm8odGFyZ2V0KSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFvd25VcGRhdGUgJiYgZXhpc3RlZCkge1xyXG4gICAgICAgICAgICAgICAgaXNvbGF0ZWQgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZXh0ZW5zaW9uID0gZXh0bmFtZSh0YXJnZXQpO1xyXG4gICAgICAgICAgICAgICAgdGFyZ2V0ID0gYCR7dGFyZ2V0LnNsaWNlKDAsIC1leHRlbnNpb24ubGVuZ3RoKX1fXyR7aGFzaChgJHtpbnB1dEhhc2h9OiR7Y29uZmlnfWApLnNsaWNlKDAsIDEyKX0ke2V4dGVuc2lvbn1gO1xyXG4gICAgICAgICAgICAgICAgZXhpc3RlZCA9IEJvb2xlYW4oYXdhaXQgdGhpcy5hdmFpbGFibGVJbmZvKHRhcmdldCkpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0ZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCB0aGlzLmNvbnRlbnRzQXQodGFyZ2V0KTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgdGhpcy5hdmFpbGFibGVJbmZvKHRhcmdldCk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWV0YSA9IGluZm8gPyBhd2FpdCBhc3NldFJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LW1ldGEnLCBpbmZvLnV1aWQpIGFzIEFzc2V0TWV0YSB8IG51bGwgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3RvcmVkIHx8IChoYXNoKHN0b3JlZCkgIT09IGlucHV0SGFzaCAmJiBpZGVudGl0eUZyb20obWV0YSk/LmlucHV0SGFzaCAhPT0gaW5wdXRIYXNoKVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB8fCBzdG9yZWRDb25maWcobWV0YSwgb3B0aW9ucy50aWxlZCkgIT09IGNvbmZpZyB8fCAhdmFsaWRDb25maWd1cmF0aW9uKG1ldGEsIEJvb2xlYW4ob3B0aW9ucy50aWxlZCkpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg6LWE5rqQ5Y+Y5L2T5Zyw5Z2A6KKr5LiN5ZCM5YaF5a655oiW5YiH54mH6YWN572u5Y2g55So77yM5LiN5Lya6KaG55uW77yaJHt0YXJnZXR9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gYXdhaXQgdGhpcy5leGlzdGluZyh0YXJnZXQsIG9wdGlvbnMudGlsZWQpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NldCAmJiBpbmZvKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYmluZElkZW50aXR5KHRhcmdldCwgaW5mbywgbWV0YSwgc291cmNlS2V5LCBpbnB1dEhhc2gsIGNvbmZpZywgaGFzaChzdG9yZWQpKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5ldmVudHMucHVzaCh7IHNvdXJjZUtleSwgdXJsOiB0YXJnZXQsIGFjdGlvbjogJ3JldXNlZCcsIHJlYXNvbjogJ+mHjeivleWRveS4reW3suWIm+W7uueahOeos+WumuWPmOS9k++8jOS/neeVmeWOnyBVVUlEJyB9KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGFzc2V0O1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAob3duVXBkYXRlKSBhd2FpdCB0aGlzLmJlZ2luVXBkYXRlKG93blVwZGF0ZSwgYnl0ZXMsIHNvdXJjZUtleSwgaW5wdXRIYXNoLCBjb25maWcpO1xyXG4gICAgICAgICAgICBjb25zdCB3cml0ZUJvcmRlcnMgPSBvd25VcGRhdGUgJiYgIW9wdGlvbnMudGlsZWQgJiYgIW9wdGlvbnMuYm9yZGVyc1xyXG4gICAgICAgICAgICAgICAgPyB7IGxlZnQ6IDAsIHJpZ2h0OiAwLCB0b3A6IDAsIGJvdHRvbTogMCB9IDogb3B0aW9ucy5ib3JkZXJzO1xyXG4gICAgICAgICAgICAvLyByZXNvbHZlIGFscmVhZHkgc2VsZWN0ZWQgYSB2ZXJpZmllZCBkZXN0aW5hdGlvbi4gQSBsZWdhY3kgd3JpdGUnc1xyXG4gICAgICAgICAgICAvLyBQTkfihpJKUEcgYWxpYXMgbXVzdCBub3QgcmVkaXJlY3QgYSBkaWZmZXJlbnQgc291cmNlL2FscGhhIHZhcmlhbnQuXHJcbiAgICAgICAgICAgIHRoaXMud3JpdGVUYXJnZXRzLmRlbGV0ZSh0YXJnZXQpO1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldCA9IGF3YWl0IHRoaXMud3JpdGUodGFyZ2V0LCBieXRlcywgd3JpdGVCb3JkZXJzLCBvcHRpb25zLnRpbGVkKTtcclxuICAgICAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IHRoaXMuYXZhaWxhYmxlSW5mbyhhc3NldC51cmwpO1xyXG4gICAgICAgICAgICBpZiAoIWluZm8pIHRocm93IG5ldyBFcnJvcihg5peg5rOV56Gu6K6k6LWE5rqQIFVVSUTvvJoke2Fzc2V0LnVybH1gKTtcclxuICAgICAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IGFzc2V0UmVxdWVzdCgnYXNzZXQtZGInLCAncXVlcnktYXNzZXQtbWV0YScsIGluZm8udXVpZCkgYXMgQXNzZXRNZXRhIHwgbnVsbDtcclxuICAgICAgICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgdGhpcy5jb250ZW50c0F0KGFzc2V0LnVybCk7XHJcbiAgICAgICAgICAgIC8vIEEgZmFpbGVkIGluc2V0IHNhdmUgc3RpbGwgcHJvZHVjZWQgdGhpcyBzb3VyY2UncyBpbWFnZS4gQmluZCB0aGVcclxuICAgICAgICAgICAgLy8gYWN0dWFsIHN0b3JlZCBjb25maWd1cmF0aW9uIHNvIHRoZSBzbGljZWQgd3JpdGVyIGNhbiByZXN0b3JlIGl0c1xyXG4gICAgICAgICAgICAvLyBmdWxsIFBORyBpbiBwbGFjZSwgcmF0aGVyIHRoYW4gbGVhdmluZyBhbiB1bm93bmVkIGNvbXBhY3QgY29weS5cclxuICAgICAgICAgICAgLy8gQSBsYXRlciBzbGljZWQgbG9va3VwIG11c3Qgc3RpbGwgcmVqZWN0IHRoZSB1bnZlcmlmaWVkIGJvcmRlcnMuXHJcbiAgICAgICAgICAgIGNvbnN0IGJvdW5kQ29uZmlnID0gYXNzZXQuc2xpY2VGYWxsYmFjayA/IHN0b3JlZENvbmZpZyhtZXRhLCBCb29sZWFuKG9wdGlvbnMudGlsZWQpKSA6IGNvbmZpZztcclxuICAgICAgICAgICAgYXdhaXQgdGhpcy5iaW5kSWRlbnRpdHkoYXNzZXQudXJsLCBpbmZvLCBtZXRhLCBzb3VyY2VLZXksIGlucHV0SGFzaCwgYm91bmRDb25maWcsIGhhc2goc3RvcmVkID8/IGJ5dGVzKSk7XHJcbiAgICAgICAgICAgIHRoaXMuZXZlbnRzLnB1c2goeyBzb3VyY2VLZXksIHVybDogYXNzZXQudXJsLCBhY3Rpb246IGFzc2V0LnNsaWNlRmFsbGJhY2sgPyAnZmFsbGJhY2snIDogZXhpc3RlZCA/ICd1cGRhdGVkJyA6ICdjcmVhdGVkJyxcclxuICAgICAgICAgICAgICAgIHJlYXNvbjogYXNzZXQuc2xpY2VGYWxsYmFjayA/PyAob3duVXBkYXRlID8gJ+WQjOa6kOi1hOa6kOeLrOWNoO+8jOWOn+S9jeabtOaWsOW5tuS/neeVmSBVVUlEIOS4jiBNZXRhJ1xyXG4gICAgICAgICAgICAgICAgICAgIDogaXNvbGF0ZWQgPyAn5ZCM5ZCN5YaF5a655oiW5YiH54mH6YWN572u5Yay56qB77yM5Yib5bu656iz5a6a5Y+Y5L2T5bm25L+d55WZ5bey5pyJ6LWE5rqQJyA6ICfmnKrmib7liLDlhoXlrrnlj4rliIfniYfphY3nva7nm7jnrKbnmoTlt7LmnInotYTmupAnKSB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIGFzc2V0O1xyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgYmVnaW5VcGRhdGUodXJsOiBzdHJpbmcsIGJ5dGVzOiBCdWZmZXIsIHNvdXJjZUtleTogc3RyaW5nLCBpbnB1dEhhc2g6IHN0cmluZywgY29uZmlnOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgdGhpcy5hdmFpbGFibGVJbmZvKHVybCk7XHJcbiAgICAgICAgY29uc3QgbWV0YSA9IGluZm8gPyBhd2FpdCBhc3NldFJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LW1ldGEnLCBpbmZvLnV1aWQpIGFzIEFzc2V0TWV0YSB8IG51bGwgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IGlkZW50aXR5ID0gaWRlbnRpdHlGcm9tKG1ldGEpO1xyXG4gICAgICAgIGlmICghaW5mbyB8fCAhbWV0YSB8fCAhaWRlbnRpdHk/LnNvdXJjZXNbc291cmNlS2V5XSB8fCBPYmplY3Qua2V5cyhpZGVudGl0eS5zb3VyY2VzKS5sZW5ndGggIT09IDEpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDotYTmupDmupDmmKDlsITlt7Llj5HnlJ/lj5jljJbvvIzml6Dms5Xlronlhajljp/kvY3mm7TmlrDvvJoke3VybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgdGhpcy5jb250ZW50c0F0KHVybCk7XHJcbiAgICAgICAgaWYgKCFzdG9yZWQgfHwgKGhhc2goc3RvcmVkKSAhPT0gaWRlbnRpdHkuY29udGVudEhhc2ggJiYgaGFzaChzdG9yZWQpICE9PSBpZGVudGl0eS5wZW5kaW5nPy5jb250ZW50SGFzaCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDotYTmupDlhoXlrrnlt7LlnKjlr7zlhaXmnJ/pl7Tlj5jljJbvvIzml6Dms5Xlronlhajljp/kvY3mm7TmlrDvvJoke3VybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcHJlcGFyZWQgPSAvXFwuanBlP2ckL2kudGVzdCh1cmwpICYmIGlzUG5nKGJ5dGVzKSA/IHByZXBhcmVOZXdSYXN0ZXIoYnl0ZXMpLmNvbnRlbnRzIDogYnl0ZXM7XHJcbiAgICAgICAgY29uc3QgbmV4dCA9IEpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkobWV0YSkpIGFzIEFzc2V0TWV0YTtcclxuICAgICAgICBjb25zdCBwZW5kaW5nID0geyBzb3VyY2VLZXksIGlucHV0SGFzaCwgY29udGVudEhhc2g6IGhhc2gocHJlcGFyZWQpLCBjb25maWcgfTtcclxuICAgICAgICBuZXh0LnVzZXJEYXRhLmZpZ21hSW1wb3J0ZXIgPSB7IC4uLmlkZW50aXR5LCBwZW5kaW5nIH0gc2F0aXNmaWVzIFNvdXJjZUlkZW50aXR5O1xyXG4gICAgICAgIGF3YWl0IHRoaXMuYmVmb3JlV3JpdGU/Lih1cmwsIHRydWUpO1xyXG4gICAgICAgIGF3YWl0IGFzc2V0UmVxdWVzdCgnYXNzZXQtZGInLCAnc2F2ZS1hc3NldC1tZXRhJywgaW5mby51dWlkLCBKU09OLnN0cmluZ2lmeShuZXh0LCBudWxsLCAyKSk7XHJcbiAgICAgICAgdGhpcy5pbmRleGVkLnNldCh1cmwsIG5leHQpO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgYmluZElkZW50aXR5KHVybDogc3RyaW5nLCBpbmZvOiBBc3NldEluZm8sIG1ldGE6IEFzc2V0TWV0YSB8IG51bGwsIHNvdXJjZUtleTogc3RyaW5nLFxyXG4gICAgICAgIGlucHV0SGFzaDogc3RyaW5nLCBjb25maWc6IHN0cmluZywgY29udGVudEhhc2g6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgICAgIGlmICghbWV0YSkgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XmjIHkuYXljJbotYTmupDmupDmoIfor4bvvJoke3VybH1gKTtcclxuICAgICAgICBpZiAobWV0YS51dWlkICYmIG1ldGEudXVpZCAhPT0gaW5mby51dWlkKSB0aHJvdyBuZXcgRXJyb3IoYOi1hOa6kCBVVUlEIOS4jiBNZXRhIOS4jeS4gOiHtO+8jOS4jeS8muWGmeWFpea6kOaYoOWwhO+8miR7dXJsfWApO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzID0gaWRlbnRpdHlGcm9tKG1ldGEpO1xyXG4gICAgICAgIGlmIChwcmV2aW91cz8uc291cmNlc1tzb3VyY2VLZXldICYmICFwcmV2aW91cy5wZW5kaW5nICYmIHByZXZpb3VzLmlucHV0SGFzaCA9PT0gaW5wdXRIYXNoICYmIHByZXZpb3VzLmNvbmZpZyA9PT0gY29uZmlnXHJcbiAgICAgICAgICAgICYmIHByZXZpb3VzLmNvbnRlbnRIYXNoID09PSBjb250ZW50SGFzaCkgeyB0aGlzLmluZGV4ZWQuc2V0KHVybCwgbWV0YSk7IHJldHVybjsgfVxyXG4gICAgICAgIGF3YWl0IHRoaXMuYmVmb3JlV3JpdGU/Lih1cmwsIHRydWUpO1xyXG4gICAgICAgIGNvbnN0IG5leHQgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KG1ldGEpKSBhcyBBc3NldE1ldGE7XHJcbiAgICAgICAgbmV4dC51c2VyRGF0YSA/Pz0ge307XHJcbiAgICAgICAgY29uc3QgbGF0ZXN0UmV2aXNpb24gPSBNYXRoLm1heCgwLCAuLi5bLi4udGhpcy5pbmRleGVkLnZhbHVlcygpXVxyXG4gICAgICAgICAgICAubWFwKChpdGVtKSA9PiBpZGVudGl0eUZyb20oaXRlbSk/LnNvdXJjZXNbc291cmNlS2V5XSA/PyAwKSk7XHJcbiAgICAgICAgbmV4dC51c2VyRGF0YS5maWdtYUltcG9ydGVyID0geyB2ZXJzaW9uOiAxLCBjb250ZW50SGFzaCwgaW5wdXRIYXNoLCBjb25maWcsXHJcbiAgICAgICAgICAgIHNvdXJjZXM6IHsgLi4uKHByZXZpb3VzPy5zb3VyY2VzID8/IHt9KSwgW3NvdXJjZUtleV06IE1hdGgubWF4KERhdGUubm93KCksIGxhdGVzdFJldmlzaW9uICsgMSkgfSB9IHNhdGlzZmllcyBTb3VyY2VJZGVudGl0eTtcclxuICAgICAgICBhd2FpdCBhc3NldFJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3NhdmUtYXNzZXQtbWV0YScsIGluZm8udXVpZCwgSlNPTi5zdHJpbmdpZnkobmV4dCwgbnVsbCwgMikpO1xyXG4gICAgICAgIC8vIEluZGV4IG9ubHkgYWZ0ZXIgc3VjY2Vzc2Z1bCBwZXJzaXN0ZW5jZS4gQSBmYWlsZWQgYmluZCBjYW4gc2FmZWx5IHJldHJ5XHJcbiAgICAgICAgLy8gYnkgY29tcGFyaW5nIHRoZSBmaWxlJ3MgY29udGVudC9jb25maWcgd2l0aG91dCBhIHNvdXJjZSByZWNvcmQuXHJcbiAgICAgICAgdGhpcy5pbmRleGVkLnNldCh1cmwsIG5leHQpO1xyXG4gICAgICAgIGlmICh0aGlzLnByb2plY3RSb290KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHZlcnNpb24gPSAoYXNzZXRJbmRleFZlcnNpb25zLmdldCh0aGlzLnByb2plY3RSb290KSA/PyAwKSArIDE7XHJcbiAgICAgICAgICAgIGFzc2V0SW5kZXhWZXJzaW9ucy5zZXQodGhpcy5wcm9qZWN0Um9vdCwgdmVyc2lvbik7XHJcbiAgICAgICAgICAgIHRoaXMuaW5kZXhWZXJzaW9uID0gdmVyc2lvbjtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgYXN5bmMgaW5pdGlhbGl6ZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgICAgICBsZXQgY3VycmVudCA9ICdkYjovL2Fzc2V0cyc7XHJcbiAgICAgICAgZm9yIChjb25zdCBwYXJ0IG9mIHRoaXMuZm9sZGVyLnNwbGl0KCcvJykpIHtcclxuICAgICAgICAgICAgY3VycmVudCArPSBgLyR7cGFydH1gO1xyXG4gICAgICAgICAgICBhd2FpdCBlbnN1cmVGb2xkZXIoY3VycmVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGJ1aWxkVXJsKG5hbWU6IHN0cmluZywgX2lkOiBzdHJpbmcsIGV4dGVuc2lvbjogUmFzdGVySW1hZ2VFeHRlbnNpb24sIF9zY2FsZTogbnVtYmVyKTogc3RyaW5nIHtcclxuICAgICAgICBjb25zdCBmaWxlTmFtZSA9IGFzc2V0QmFzZU5hbWUobmFtZSk7XHJcbiAgICAgICAgcmV0dXJuIGBkYjovL2Fzc2V0cy8ke3RoaXMuZm9sZGVyfS8ke2ZpbGVOYW1lfS4ke2V4dGVuc2lvbn1gO1xyXG4gICAgfVxyXG5cclxuICAgIGJ1aWxkVGlsZWRVcmwobmFtZTogc3RyaW5nLCBzb3VyY2VLZXk6IHN0cmluZywgZXh0ZW5zaW9uOiBSYXN0ZXJJbWFnZUV4dGVuc2lvbik6IHN0cmluZyB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlSGFzaCA9IGNyZWF0ZUhhc2goJ3NoYTI1NicpLnVwZGF0ZShzb3VyY2VLZXkpLmRpZ2VzdCgnaGV4Jykuc2xpY2UoMCwgMTApO1xyXG4gICAgICAgIHJldHVybiBgZGI6Ly9hc3NldHMvJHt0aGlzLmZvbGRlcn0vJHthc3NldEJhc2VOYW1lKG5hbWUpfV9fdGlsZV8ke3NvdXJjZUhhc2h9LiR7ZXh0ZW5zaW9ufWA7XHJcbiAgICB9XHJcblxyXG4gICAgYXN5bmMgZXhpc3RpbmcodXJsOiBzdHJpbmcsIHRpbGVkID0gZmFsc2UpOiBQcm9taXNlPFNwcml0ZUFzc2V0U3BlYyB8IG51bGw+IHtcbiAgICAgICAgbGV0IGluZm8gPSBhd2FpdCB0aGlzLmF2YWlsYWJsZUluZm8odXJsKTtcclxuICAgICAgICBpZiAoIWluZm8/LmltcG9ydGVkIHx8IGluZm8uaW52YWxpZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGV0IG1ldGEgPSBhd2FpdCBhc3NldFJlcXVlc3QoXHJcbiAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICdxdWVyeS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICkgYXMgQXNzZXRNZXRhIHwgbnVsbDtcclxuICAgICAgICAvLyBBc3NldERCIGNhbiBvbWl0IHN1YkFzc2V0cyB3aGlsZSBpbmRleGluZy4gQSBwZXJzaXN0ZWQgU3ByaXRlRnJhbWVcclxuICAgICAgICAvLyByZW1haW5zIGFuIGV4aXN0aW5nIGFzc2V0OyBkbyBub3QgaW5mZXIgYWJzZW5jZSBmcm9tIFVJIHZpc2liaWxpdHkuXHJcbiAgICAgICAgbGV0IHNwcml0ZUZyYW1lID0gZmluZFNwcml0ZUZyYW1lKGluZm8pO1xyXG4gICAgICAgIGNvbnN0IGZyYW1lTWV0YSA9IE9iamVjdC52YWx1ZXMobWV0YT8uc3ViTWV0YXMgPz8ge30pLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaW1wb3J0ZXIgPT09ICdzcHJpdGUtZnJhbWUnKTtcclxuICAgICAgICBpZiAoc3ByaXRlRnJhbWUgJiYgZnJhbWVNZXRhPy51dWlkICYmIGZyYW1lTWV0YS51dWlkICE9PSBzcHJpdGVGcmFtZS51dWlkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgU3ByaXRlRnJhbWUgVVVJRCDkuI4gTWV0YSDkuI3kuIDoh7TvvIzor7fnrYnlvoUgQ29jb3Mg6YeN5a+85YWl5a6M5oiQ77yaJHt1cmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghc3ByaXRlRnJhbWUpIHtcclxuICAgICAgICAgICAgaWYgKGZyYW1lTWV0YT8udXVpZCkgc3ByaXRlRnJhbWUgPSB7IC4uLmluZm8sIHV1aWQ6IGZyYW1lTWV0YS51dWlkLCBpbXBvcnRlcjogJ3Nwcml0ZS1mcmFtZScsIHR5cGU6ICdjYy5TcHJpdGVGcmFtZScgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCFzcHJpdGVGcmFtZSkgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgaWYgKHRpbGVkICYmIG1ldGEgJiYgYXdhaXQgdGhpcy5hcHBseVNwcml0ZU1ldGEoaW5mbywgbWV0YSwgdW5kZWZpbmVkLCB0cnVlKSkge1xyXG4gICAgICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvckFzc2V0KHVybCwgdHJ1ZSwgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgc3ByaXRlRnJhbWUgPSBmaW5kU3ByaXRlRnJhbWUoaW5mbyk7XHJcbiAgICAgICAgICAgIG1ldGEgPSBhd2FpdCBhc3NldFJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3F1ZXJ5LWFzc2V0LW1ldGEnLFxyXG4gICAgICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICApIGFzIEFzc2V0TWV0YSB8IG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghc3ByaXRlRnJhbWUpIHtcclxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHV1aWQ6IHNwcml0ZUZyYW1lLnV1aWQsXHJcbiAgICAgICAgICAgIHVybCxcclxuICAgICAgICAgICAgc2xpY2VkOiBoYXNTbGljZWRCb3JkZXJzKG1ldGEpLFxyXG4gICAgICAgICAgICB0aWxlZDogdGlsZWQgfHwgdW5kZWZpbmVkLFxyXG4gICAgICAgIH07XHJcbiAgICB9XG5cbiAgICBhc3luYyBleGlzdGluZ1Jhc3Rlcih1cmw6IHN0cmluZywgdGlsZWQgPSBmYWxzZSwgbm9kZU5hbWUgPSB1cmwpOiBQcm9taXNlPFNwcml0ZUFzc2V0U3BlYyB8IG51bGw+IHtcbiAgICAgICAgaWYgKCEvXFwuKHBuZ3xqcGU/ZykkL2kudGVzdCh1cmwpKSByZXR1cm4gdGhpcy5leGlzdGluZyh1cmwsIHRpbGVkKTtcbiAgICAgICAgY29uc3QgbmFtZWQgPSBub2RlTmFtZS5tYXRjaCgvXFwuKHBuZ3xqcGU/ZykkL2kpPy5bMV0udG9Mb3dlckNhc2UoKTtcbiAgICAgICAgY29uc3QgZXh0ZW5zaW9ucyA9IEFycmF5LmZyb20obmV3IFNldChbLi4uKG5hbWVkID8gW25hbWVkXSA6IFtdKSwgJ3BuZycsICdqcGcnLCAnanBlZyddKSk7XG4gICAgICAgIGZvciAoY29uc3QgZXh0ZW5zaW9uIG9mIGV4dGVuc2lvbnMpIHtcbiAgICAgICAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHVybC5yZXBsYWNlKC9cXC4ocG5nfGpwZT9nKSQvaSwgYC4ke2V4dGVuc2lvbn1gKTtcbiAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gdGlsZWQgPyBhd2FpdCB0aGlzLmV4aXN0aW5nKGNhbmRpZGF0ZSwgdHJ1ZSkgOiBhd2FpdCB0aGlzLmV4aXN0aW5nKGNhbmRpZGF0ZSk7XG4gICAgICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cclxuICAgIGFzeW5jIHdyaXRlKFxyXG4gICAgICAgIHVybDogc3RyaW5nLFxyXG4gICAgICAgIGNvbnRlbnRzOiBCdWZmZXIgfCBzdHJpbmcsXHJcbiAgICAgICAgYm9yZGVycz86IHsgbGVmdDogbnVtYmVyOyByaWdodDogbnVtYmVyOyB0b3A6IG51bWJlcjsgYm90dG9tOiBudW1iZXIgfSxcclxuICAgICAgICB0aWxlZCA9IGZhbHNlLFxyXG4gICAgKTogUHJvbWlzZTxTcHJpdGVBc3NldFNwZWM+IHtcclxuICAgICAgICBjb25zdCByZXF1ZXN0ZWRVcmwgPSB1cmw7XG4gICAgICAgIHVybCA9IHRoaXMud3JpdGVUYXJnZXRzLmdldCh1cmwpID8/IHVybDtcbiAgICAgICAgbGV0IGV4aXN0aW5nID0gYXdhaXQgdGhpcy5hdmFpbGFibGVJbmZvKHVybCk7XHJcbiAgICAgICAgbGV0IGRhdGEgPSB0eXBlb2YgY29udGVudHMgPT09ICdzdHJpbmcnID8gQnVmZmVyLmZyb20oY29udGVudHMsICd1dGY4JykgOiBjb250ZW50cztcbiAgICAgICAgaWYgKCFleGlzdGluZyAmJiAvXFwucG5nJC9pLnRlc3QodXJsKSkge1xuICAgICAgICAgICAgY29uc3QgcHJlcGFyZWQgPSBwcmVwYXJlTmV3UmFzdGVyKGRhdGEpO1xuICAgICAgICAgICAgaWYgKHByZXBhcmVkLmV4dGVuc2lvbiA9PT0gJ2pwZycpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBqcGVnVXJsID0gdXJsLnJlcGxhY2UoL1xcLnBuZyQvaSwgJy5qcGcnKTtcbiAgICAgICAgICAgICAgICAvLyBSZXBlYXRlZCBpbXBvcnRzIG5vcm1hbGx5IHJldXNlIHRoaXMgZmlsZSBiZWZvcmUgcmVhY2hpbmcgd3JpdGUuXG4gICAgICAgICAgICAgICAgLy8gQSBmb3JjZWQgcmVmcmVzaCBtdXN0IHVwZGF0ZSBpdCBpbiBwbGFjZSwgcHJlc2VydmluZyBpdHMgVVVJRC5cbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuYXZhaWxhYmxlSW5mbyhqcGVnVXJsKTtcclxuICAgICAgICAgICAgICAgIHVybCA9IGpwZWdVcmw7XG4gICAgICAgICAgICAgICAgZGF0YSA9IHByZXBhcmVkLmNvbnRlbnRzO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKC9cXC5qcGU/ZyQvaS50ZXN0KHVybCkgJiYgaXNQbmcoZGF0YSkpIHtcbiAgICAgICAgICAgIGNvbnN0IHByZXBhcmVkID0gcHJlcGFyZU5ld1Jhc3RlcihkYXRhKTtcbiAgICAgICAgICAgIGlmIChwcmVwYXJlZC5leHRlbnNpb24gIT09ICdqcGcnKSB0aHJvdyBuZXcgRXJyb3IoYOS4jeiDveWwhumAj+aYjiBQTkcg5oiW6L2s5o2i5aSx6LSl55qE5Zu+54mH5YaZ5YWlIEpQR++8miR7dXJsfWApO1xuICAgICAgICAgICAgZGF0YSA9IHByZXBhcmVkLmNvbnRlbnRzO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMud3JpdGVUYXJnZXRzLnNldChyZXF1ZXN0ZWRVcmwsIHVybCk7XG4gICAgICAgIGF3YWl0IHRoaXMuYmVmb3JlV3JpdGU/Lih1cmwsIEJvb2xlYW4oZXhpc3RpbmcpKTtcclxuICAgICAgICBpZiAoZXhpc3RpbmcpIHtcclxuICAgICAgICAgICAgYXdhaXQgYXNzZXRSZXF1ZXN0KCdhc3NldC1kYicsICdzYXZlLWFzc2V0JywgdXJsLCBkYXRhKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBhd2FpdCBhc3NldFJlcXVlc3QoJ2Fzc2V0LWRiJywgJ2NyZWF0ZS1hc3NldCcsIHVybCwgZGF0YSwgeyBvdmVyd3JpdGU6IGZhbHNlIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZXQgaW5mbyA9IGF3YWl0IHdhaXRGb3JBc3NldCh1cmwsIGZhbHNlLCBleGlzdGluZz8udXVpZCk7XHJcbiAgICAgICAgaW5mbyA9IGF3YWl0IGVuc3VyZVNwcml0ZUZyYW1lKHVybCwgaW5mbyk7XHJcbiAgICAgICAgY29uc3QgcmVxdWVzdGVkU2xpY2VkID0gIXRpbGVkXHJcbiAgICAgICAgICAgICYmIEJvb2xlYW4oYm9yZGVycyAmJiBPYmplY3QudmFsdWVzKGJvcmRlcnMpLnNvbWUoKHZhbHVlKSA9PiB2YWx1ZSA+IDApKTtcclxuICAgICAgICBsZXQgbWV0YTogQXNzZXRNZXRhIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgbGV0IHNsaWNlRmFsbGJhY2s6IHN0cmluZyB8IHVuZGVmaW5lZDtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBtZXRhID0gYXdhaXQgYXNzZXRSZXF1ZXN0KFxyXG4gICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgICAgICdxdWVyeS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgKSBhcyBBc3NldE1ldGEgfCBudWxsO1xyXG4gICAgICAgICAgICBpZiAobWV0YSAmJiBhd2FpdCB0aGlzLmFwcGx5U3ByaXRlTWV0YShcclxuICAgICAgICAgICAgICAgIGluZm8sXHJcbiAgICAgICAgICAgICAgICBtZXRhLFxyXG4gICAgICAgICAgICAgICAgYm9yZGVycyxcclxuICAgICAgICAgICAgICAgIHRpbGVkLFxyXG4gICAgICAgICAgICApKSB7XHJcbiAgICAgICAgICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvckFzc2V0KHVybCwgdHJ1ZSwgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgICAgIG1ldGEgPSBhd2FpdCBhc3NldFJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgICAgICAgICAncXVlcnktYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICAgICAgKSBhcyBBc3NldE1ldGEgfCBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgaWYgKCFyZXF1ZXN0ZWRTbGljZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIC8vIFRoZSBQTkcgYW5kIGl0cyBTcHJpdGVGcmFtZSBhbHJlYWR5IGV4aXN0LiBBIGJvcmRlciBtZXRhZGF0YVxyXG4gICAgICAgICAgICAvLyBmYWlsdXJlIG11c3Qgbm90IGRpc2NhcmQgdGhlIGVudGlyZSBQcmVmYWIgaW1wb3J0OyBmYWlsIGNsb3NlZFxyXG4gICAgICAgICAgICAvLyB0byBhIG5vcm1hbCBTSU1QTEUgU3ByaXRlIGFuZCBleHBvc2UgdGhlIHJlYXNvbiB0byB0aGUgcGFuZWwuXHJcbiAgICAgICAgICAgIG1ldGEgPSBudWxsO1xyXG4gICAgICAgICAgICBzbGljZUZhbGxiYWNrID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyBFeGlzdGluZyBTcHJpdGVGcmFtZXMgY2FuIGFscmVhZHkgY2FycnkgdmFsaWQgYm9yZGVycyBldmVuIHdoZW4gdGhpc1xyXG4gICAgICAgIC8vIHdyaXRlIGRvZXMgbm90IHJlcXVlc3QgbmV3IG9uZXMuIFByZXNlcnZlIHRoYXQgc2xpY2VkIGNsYXNzaWZpY2F0aW9uLlxyXG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IG1ldGE/LnN1Yk1ldGFzICYmIE9iamVjdC52YWx1ZXMobWV0YS5zdWJNZXRhcylcclxuICAgICAgICAgICAgLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaW1wb3J0ZXIgPT09ICdzcHJpdGUtZnJhbWUnKT8udXNlckRhdGE7XHJcbiAgICAgICAgY29uc3QgZXhhY3RCb3JkZXJzID0gIXJlcXVlc3RlZFNsaWNlZCB8fCAoc3RvcmVkPy50cmltVHlwZSA9PT0gJ25vbmUnXHJcbiAgICAgICAgICAgICYmIFsnbGVmdCcsICdyaWdodCcsICd0b3AnLCAnYm90dG9tJ10uZXZlcnkoKHNpZGUpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGtleSA9IHNpZGUgYXMga2V5b2YgTm9uTnVsbGFibGU8dHlwZW9mIGJvcmRlcnM+O1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHN0b3JlZFtgYm9yZGVyJHtzaWRlWzBdLnRvVXBwZXJDYXNlKCl9JHtzaWRlLnN1YnN0cmluZygxKX1gXVxyXG4gICAgICAgICAgICAgICAgICAgID09PSBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKGJvcmRlcnMhW2tleV0pKTtcclxuICAgICAgICAgICAgfSkpO1xyXG4gICAgICAgIGNvbnN0IHNsaWNlZCA9ICF0aWxlZCAmJiBoYXNTbGljZWRCb3JkZXJzKG1ldGEpICYmIGV4YWN0Qm9yZGVycztcclxuICAgICAgICBpZiAocmVxdWVzdGVkU2xpY2VkICYmICFzbGljZWQgJiYgIXNsaWNlRmFsbGJhY2spIHtcclxuICAgICAgICAgICAgc2xpY2VGYWxsYmFjayA9IGBDb2NvcyDmnKrog73lhpnlhaXmiJblm57or7vkuIkv5Lmd5a6rIFNwcml0ZUZyYW1lIOi+ueeVjO+8miR7dXJsfWA7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHNwcml0ZUZyYW1lID0gZmluZFNwcml0ZUZyYW1lKGluZm8pO1xyXG4gICAgICAgIGlmICghc3ByaXRlRnJhbWUpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDotYTmupDmsqHmnInnlJ/miJAgU3ByaXRlRnJhbWXvvJoke3VybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgdXVpZDogc3ByaXRlRnJhbWUudXVpZCxcclxuICAgICAgICAgICAgdXJsLFxyXG4gICAgICAgICAgICBzbGljZWQsXHJcbiAgICAgICAgICAgIHNsaWNlRmFsbGJhY2ssXHJcbiAgICAgICAgICAgIHRpbGVkOiB0aWxlZCB8fCB1bmRlZmluZWQsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGFzeW5jIGFwcGx5U3ByaXRlTWV0YShcclxuICAgICAgICBpbmZvOiBBc3NldEluZm8sXHJcbiAgICAgICAgbWV0YTogQXNzZXRNZXRhLFxyXG4gICAgICAgIGJvcmRlcnM6IHsgbGVmdDogbnVtYmVyOyByaWdodDogbnVtYmVyOyB0b3A6IG51bWJlcjsgYm90dG9tOiBudW1iZXIgfSB8IHVuZGVmaW5lZCxcclxuICAgICAgICB0aWxlZDogYm9vbGVhbixcclxuICAgICk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gICAgICAgIGlmICghbWV0YS5zdWJNZXRhcykge1xyXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHNwcml0ZU1ldGEgPSBPYmplY3QudmFsdWVzKG1ldGEuc3ViTWV0YXMpLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaW1wb3J0ZXIgPT09ICdzcHJpdGUtZnJhbWUnKTtcclxuICAgICAgICBpZiAoIXNwcml0ZU1ldGEpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGFuZ2VzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xyXG4gICAgICAgIGlmIChib3JkZXJzKSB7XHJcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24oY2hhbmdlcywge1xyXG4gICAgICAgICAgICAgICAgdHJpbVR5cGU6ICdub25lJyxcclxuICAgICAgICAgICAgICAgIGJvcmRlckxlZnQ6IE1hdGgubWF4KDAsIE1hdGgucm91bmQoYm9yZGVycy5sZWZ0KSksXHJcbiAgICAgICAgICAgICAgICBib3JkZXJSaWdodDogTWF0aC5tYXgoMCwgTWF0aC5yb3VuZChib3JkZXJzLnJpZ2h0KSksXHJcbiAgICAgICAgICAgICAgICBib3JkZXJUb3A6IE1hdGgubWF4KDAsIE1hdGgucm91bmQoYm9yZGVycy50b3ApKSxcclxuICAgICAgICAgICAgICAgIGJvcmRlckJvdHRvbTogTWF0aC5tYXgoMCwgTWF0aC5yb3VuZChib3JkZXJzLmJvdHRvbSkpLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRpbGVkKSB7XHJcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24oY2hhbmdlcywge1xyXG4gICAgICAgICAgICAgICAgdHJpbVR5cGU6ICdub25lJyxcclxuICAgICAgICAgICAgICAgIHBhY2thYmxlOiBmYWxzZSxcclxuICAgICAgICAgICAgICAgIGJvcmRlckxlZnQ6IDAsXHJcbiAgICAgICAgICAgICAgICBib3JkZXJSaWdodDogMCxcclxuICAgICAgICAgICAgICAgIGJvcmRlclRvcDogMCxcclxuICAgICAgICAgICAgICAgIGJvcmRlckJvdHRvbTogMCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNoYW5nZWQgPSBPYmplY3QuZW50cmllcyhjaGFuZ2VzKVxyXG4gICAgICAgICAgICAuc29tZSgoW2tleSwgdmFsdWVdKSA9PiBzcHJpdGVNZXRhLnVzZXJEYXRhW2tleV0gIT09IHZhbHVlKTtcclxuICAgICAgICBpZiAoIWNoYW5nZWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBPYmplY3QuYXNzaWduKHNwcml0ZU1ldGEudXNlckRhdGEsIGNoYW5nZXMpO1xyXG4gICAgICAgIGF3YWl0IGFzc2V0UmVxdWVzdCgnYXNzZXQtZGInLCAnc2F2ZS1hc3NldC1tZXRhJywgaW5mby51dWlkLCBKU09OLnN0cmluZ2lmeShtZXRhLCBudWxsLCAyKSk7XHJcbiAgICAgICAgYXdhaXQgYXNzZXRSZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXNvbHZlQXNzZXRVdWlkKHZhbHVlOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xyXG4gICAgY29uc3QgaW5wdXQgPSB2YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIWlucHV0KSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGluZm8gPSBhd2FpdCBxdWVyeUFzc2V0KGlucHV0KTtcclxuICAgIHJldHVybiBpbmZvPy51dWlkO1xyXG59XHJcbiJdfQ==