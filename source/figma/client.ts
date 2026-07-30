import { request as httpsRequest } from 'https';
import { URL } from 'url';

const API_BASE = 'https://api.figma.com';
const MAX_RESPONSE_BYTES = 200 * 1024 * 1024;

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
            const location = response.headers.location;
            if (status >= 300 && status < 400 && location) {
                response.resume();
                if (redirects >= 5) {
                    reject(new Error('下载重定向次数过多。'));
                    return;
                }
                resolve(requestOnce(new URL(location, target).toString(), options, redirects + 1));
                return;
            }
            const chunks: Buffer[] = [];
            let length = 0;
            response.on('data', (chunk: Buffer) => {
                length += chunk.length;
                if (length > MAX_RESPONSE_BYTES) {
                    req.destroy(new Error('响应超过 200 MB 安全上限。'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                resolve({
                    status,
                    headers: response.headers,
                    body: Buffer.concat(chunks),
                });
            });
        });

        const abort = () => req.destroy(new CancelledError());
        options.signal?.addEventListener('abort', abort, { once: true });
        req.setTimeout(options.timeoutMs ?? 30_000, () => req.destroy(new Error('请求超时。')));
        req.on('error', (error) => {
            options.signal?.removeEventListener('abort', abort);
            reject(error);
        });
        req.on('close', () => options.signal?.removeEventListener('abort', abort));
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
    while (true) {
        if (options.signal?.aborted) {
            throw new CancelledError();
        }
        try {
            const response = await requestOnce(url, options);
            if (response.status >= 200 && response.status < 300) {
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
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, delay);
                options.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new CancelledError());
                }, { once: true });
            });
            attempt += 1;
        } catch (error) {
            if (error instanceof CancelledError || options.signal?.aborted) {
                throw new CancelledError();
            }
            if (attempt >= retries) {
                throw error;
            }
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

    async getNode(fileKey: string, nodeId: string): Promise<Record<string, unknown>> {
        const ids = encodeURIComponent(nodeId);
        return this.json(`/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${ids}&geometry=paths`);
    }

    async getImageUrls(
        fileKey: string,
        nodeIds: string[],
        format: 'png' | 'svg',
        scale: number,
    ): Promise<Record<string, string | null>> {
        const result: Record<string, string | null> = {};
        for (let index = 0; index < nodeIds.length; index += 100) {
            const batch = nodeIds.slice(index, index + 100);
            const query = new URLSearchParams({
                ids: batch.join(','),
                format,
                use_absolute_bounds: 'true',
            });
            if (format === 'png') {
                query.set('scale', String(Math.max(0.25, Math.min(4, scale))));
            }
            const payload = await this.json<{ images?: Record<string, string | null>; err?: string }>(
                `/v1/images/${encodeURIComponent(fileKey)}?${query.toString()}`,
            );
            Object.assign(result, payload.images ?? {});
        }
        return result;
    }

    async download(url: string): Promise<Buffer> {
        const response = await requestWithRetry(url, {
            signal: this.signal,
            headers: { Accept: 'image/*,*/*' },
            retries: 2,
            timeoutMs: 45_000,
        });
        return response.body;
    }
}
