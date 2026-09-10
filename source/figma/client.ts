import { request as httpsRequest } from 'https';
import { URL } from 'url';
import { diagnosticStart, diagnosticTask } from '../diagnostics';

const API_BASE = 'https://api.figma.com';
const MAX_RESPONSE_BYTES = 200 * 1024 * 1024;

export function roundtripFilePath(fileKey: string): string {
    const query = new URLSearchParams({ geometry: 'paths', plugin_data: 'shared' });
    return `/v1/files/${encodeURIComponent(fileKey)}?${query.toString()}`;
}

export function imageFillPath(fileKey: string): string {
    return `/v1/files/${encodeURIComponent(fileKey)}/images`;
}

export function clampImageScale(scale: number): number {
    return Math.max(0.25, Math.min(4, scale));
}

export function renderedImagePath(
    fileKey: string,
    nodeIds: string[],
    format: 'png' | 'svg',
    scale: number,
    useAbsoluteBounds = true,
): string {
    const query = new URLSearchParams({
        ids: nodeIds.join(','),
        format,
        use_absolute_bounds: String(useAbsoluteBounds),
    });
    if (format === 'png') {
        query.set('scale', String(clampImageScale(scale)));
    }
    return `/v1/images/${encodeURIComponent(fileKey)}?${query.toString()}`;
}

interface ImageFillResponse {
    images?: Record<string, string | null>;
    meta?: { images?: Record<string, string | null> };
}

export function imageFillUrlsFromResponse(payload: ImageFillResponse): Record<string, string | null> {
    return payload.meta?.images ?? payload.images ?? {};
}

export class CancelledError extends Error {
    constructor() {
        super('操作已取消。');
        this.name = 'CancelledError';
    }
}

export interface RequestOptions {
    signal?: AbortSignal;
    retries?: number;
    timeoutMs?: number;
    headers?: Record<string, string>;
    diagnosticLabel?: string;
}

interface RawResponse {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
}

function requestOnce(url: string, options: RequestOptions, redirects = 0): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(new CancelledError());
            return;
        }

        const target = new URL(url);
        const trace = diagnosticStart('HTTP', {
            operation: options.diagnosticLabel ?? 'Figma 请求',
            host: target.hostname,
            timeoutMs: options.timeoutMs ?? 30_000,
            redirects,
        });
        let length = 0;
        let totalBytes: number | null = null;
        let lastDataAt = Date.now();
        let progressTimer: ReturnType<typeof setInterval> | undefined;
        const transferStats = () => ({
            receivedBytes: length,
            totalBytes,
            percent: totalBytes && totalBytes > 0
                ? Math.round(length / totalBytes * 1000) / 10
                : null,
            noDataForMs: Date.now() - lastDataAt,
        });
        const stopProgress = () => {
            if (progressTimer !== undefined) clearInterval(progressTimer);
            progressTimer = undefined;
        };
        const req = httpsRequest({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || undefined,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers: {
                'User-Agent': 'figma-importer-cocos/1.0',
                Accept: 'application/json, image/*, */*',
                ...options.headers,
            },
        }, (response) => {
            const status = response.statusCode ?? 0;
            const contentLength = response.headers['content-length'];
            const parsedLength = typeof contentLength === 'string' && /^\d+$/.test(contentLength)
                ? Number(contentLength) : NaN;
            totalBytes = Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? parsedLength : null;
            lastDataAt = Date.now();
            trace.event('收到响应头', {
                status,
                retryAfter: response.headers['retry-after'],
                contentType: response.headers['content-type'],
                contentEncoding: response.headers['content-encoding'],
                totalBytes,
            });
            response.on('aborted', () => {
                stopProgress();
                trace.event('响应中断', transferStats());
            });
            response.on('close', () => {
                stopProgress();
                if (!response.complete) trace.event('响应提前关闭', transferStats());
            });
            const location = response.headers.location;
            if (status >= 300 && status < 400 && location) {
                response.resume();
                if (redirects >= 5) {
                    trace.event('失败：重定向次数过多');
                    reject(new Error('下载重定向次数过多。'));
                    return;
                }
                trace.done({ status, redirected: true });
                resolve(requestOnce(new URL(location, target).toString(), options, redirects + 1));
                return;
            }
            const chunks: Buffer[] = [];
            // Heartbeats also report a stalled body with no data events. They
            // never abort/retry requests and are removed on every close path.
            progressTimer = setInterval(() => trace.event('接收进度', transferStats()), 5_000);
            progressTimer.unref();
            response.on('data', (chunk: Buffer) => {
                const firstChunk = length === 0;
                length += chunk.length;
                lastDataAt = Date.now();
                if (firstChunk) trace.event('收到首段内容', transferStats());
                if (totalBytes !== null && length >= totalBytes) {
                    trace.event('已收到声明大小，等待响应结束', transferStats());
                }
                if (length > MAX_RESPONSE_BYTES) {
                    req.destroy(new Error('响应超过 200 MB 安全上限。'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                stopProgress();
                trace.done({ status, bytes: length, ...transferStats() });
                resolve({
                    status,
                    headers: response.headers,
                    body: Buffer.concat(chunks),
                });
            });
        });

        const abort = () => req.destroy(new CancelledError());
        options.signal?.addEventListener('abort', abort, { once: true });
        req.setTimeout(options.timeoutMs ?? 30_000, () => {
            trace.event('连接无数据超时', transferStats());
            req.destroy(new Error('请求超时。'));
        });
        req.on('error', (error) => {
            stopProgress();
            trace.event('请求错误时接收状态', transferStats());
            trace.fail(error);
            options.signal?.removeEventListener('abort', abort);
            reject(error);
        });
        req.on('close', () => {
            stopProgress();
            options.signal?.removeEventListener('abort', abort);
        });
        req.end();
    });
}

function errorMessage(body: Buffer, status: number): string {
    try {
        const value = JSON.parse(body.toString('utf8')) as { err?: string; message?: string; status?: number };
        return value.err || value.message || `Figma API 请求失败 (${value.status ?? status})`;
    } catch {
        return `Figma API 请求失败 (${status})`;
    }
}

async function requestWithRetry(url: string, options: RequestOptions = {}): Promise<RawResponse> {
    const retries = options.retries ?? 3;
    let attempt = 0;
    const trace = diagnosticStart(options.diagnosticLabel ?? 'Figma 请求', { maxAttempts: retries + 1 });
    while (true) {
        if (options.signal?.aborted) {
            trace.fail(new CancelledError());
            throw new CancelledError();
        }
        try {
            trace.event('尝试', { attempt: attempt + 1 });
            const response = await requestOnce(url, options);
            if (response.status >= 200 && response.status < 300) {
                trace.done({ status: response.status, bytes: response.body.length });
                return response;
            }
            const retryable = response.status === 429 || response.status >= 500;
            if (!retryable || attempt >= retries) {
                throw new Error(errorMessage(response.body, response.status));
            }
            const retryAfter = Number(response.headers['retry-after']);
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 15_000)
                : Math.min(750 * (2 ** attempt), 8_000);
            trace.event('等待重试', { status: response.status, nextAttempt: attempt + 2, delayMs: delay });
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, delay);
                options.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new CancelledError());
                }, { once: true });
            });
            attempt += 1;
        } catch (error) {
            trace.event('尝试失败', { attempt: attempt + 1 });
            if (error instanceof CancelledError || options.signal?.aborted) {
                trace.fail(error);
                throw new CancelledError();
            }
            if (attempt >= retries) {
                trace.fail(error);
                throw error;
            }
            trace.event('等待重试', { nextAttempt: attempt + 2, delayMs: Math.min(750 * (2 ** attempt), 8_000) });
            await new Promise((resolve) => setTimeout(resolve, Math.min(750 * (2 ** attempt), 8_000)));
            attempt += 1;
        }
    }
}

export class FigmaClient {
    constructor(
        private readonly token: string,
        private readonly signal?: AbortSignal,
    ) {}

    private async json<T>(path: string): Promise<T> {
        const response = await requestWithRetry(`${API_BASE}${path}`, {
            signal: this.signal,
            headers: { 'X-Figma-Token': this.token },
            diagnosticLabel: `Figma API ${path.split('?')[0]}`,
        });
        try {
            return JSON.parse(response.body.toString('utf8')) as T;
        } catch {
            throw new Error('Figma API 返回了无效 JSON。');
        }
    }

    async verify(): Promise<{ id: string; email?: string; handle?: string }> {
        return this.json('/v1/me');
    }

    async getFile(fileKey: string): Promise<Record<string, unknown>> {
        return this.json(`/v1/files/${encodeURIComponent(fileKey)}?geometry=paths`);
    }

    /** Round-trip always reads the complete current file and explicitly requests shared plugin data. */
    async getRoundtripFile(fileKey: string): Promise<Record<string, unknown>> {
        return this.json(roundtripFilePath(fileKey));
    }

    async getNode(fileKey: string, nodeId: string): Promise<Record<string, unknown>> {
        const ids = encodeURIComponent(nodeId);
        return this.json(`/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${ids}&geometry=paths`);
    }

    async getImageUrls(
        fileKey: string,
        nodeIds: string[],
        format: 'png' | 'svg',
        scale: number,
        useAbsoluteBounds = true,
        nodeNames: Record<string, string> = {},
    ): Promise<Record<string, string | null>> {
        const result: Record<string, string | null> = {};
        for (let index = 0; index < nodeIds.length; index += 100) {
            const batch = nodeIds.slice(index, index + 100);
            const payload = await diagnosticTask('Figma 图片导出批次', {
                batch: index / 100 + 1,
                batches: Math.ceil(nodeIds.length / 100),
                count: batch.length,
                scale, useAbsoluteBounds,
                nodes: batch.map((id) => ({ id, name: nodeNames[id] })),
            }, () => this.json<{ images?: Record<string, string | null>; err?: string }>(
                renderedImagePath(fileKey, batch, format, scale, useAbsoluteBounds),
            ));
            Object.assign(result, payload.images ?? {});
        }
        return result;
    }

    /** Resolve IMAGE paint imageRef values to their original temporary download URLs. */
    async getImageFillUrls(fileKey: string): Promise<Record<string, string | null>> {
        const payload = await this.json<ImageFillResponse>(
            imageFillPath(fileKey),
        );
        return imageFillUrlsFromResponse(payload);
    }

    async download(url: string, nodeLabel = '未指定节点'): Promise<Buffer> {
        const response = await requestWithRetry(url, {
            signal: this.signal,
            headers: { Accept: 'image/*,*/*' },
            retries: 2,
            timeoutMs: 45_000,
            diagnosticLabel: `图片下载 ${nodeLabel}`,
        });
        return response.body;
    }
}
