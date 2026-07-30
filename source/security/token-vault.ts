const STORAGE_KEY = 'secrets.figmaToken';
const STORAGE_PREFIX = 'safe-storage:v1:';

interface SafeStorageApi {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
    getSelectedStorageBackend?(): string;
}

function safeStorageApi(): SafeStorageApi | null {
    try {
        const electron = require('electron') as { safeStorage?: SafeStorageApi };
        return electron.safeStorage ?? null;
    } catch {
        return null;
    }
}

export interface VaultStatus {
    hasToken: boolean;
    persistent: boolean;
    backend: string;
    warning?: string;
}

export class TokenVault {
    private token: string | null = null;
    private initialized = false;
    private persistent = false;
    private backend = 'session';
    private warning: string | undefined;

    constructor(private readonly packageName: string) {}

    private inspectBackend(): SafeStorageApi | null {
        const storage = safeStorageApi();
        if (!storage || !storage.isEncryptionAvailable()) {
            this.persistent = false;
            this.backend = 'session';
            this.warning = '系统加密服务不可用，Token 仅在本次编辑器会话中保留。';
            return null;
        }
        const backend = storage.getSelectedStorageBackend?.() ?? process.platform;
        if (process.platform === 'linux' && backend === 'basic_text') {
            this.persistent = false;
            this.backend = 'session';
            this.warning = '当前 Linux 凭据后端不安全，Token 仅在本次编辑器会话中保留。';
            return null;
        }
        this.persistent = true;
        this.backend = backend;
        this.warning = undefined;
        return storage;
    }

    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        const storage = this.inspectBackend();
        if (!storage) {
            return;
        }
        const encrypted = await Editor.Profile.getConfig(this.packageName, STORAGE_KEY, 'local');
        if (typeof encrypted !== 'string' || !encrypted.startsWith(STORAGE_PREFIX)) {
            return;
        }
        try {
            const bytes = Buffer.from(encrypted.slice(STORAGE_PREFIX.length), 'base64');
            this.token = storage.decryptString(bytes);
        } catch {
            this.token = null;
            await Editor.Profile.removeConfig(this.packageName, STORAGE_KEY, 'local');
            this.warning = '已清除无法解密的旧凭据，请重新设置 Figma Token。';
        }
    }

    async set(value: string): Promise<VaultStatus> {
        await this.initialize();
        const token = value.trim();
        if (!token) {
            throw new Error('Token 不能为空。');
        }
        if (token.length > 512) {
            throw new Error('Token 长度异常。');
        }
        this.token = token;
        const storage = this.inspectBackend();
        if (storage) {
            const encrypted = storage.encryptString(token).toString('base64');
            await Editor.Profile.setConfig(
                this.packageName,
                STORAGE_KEY,
                `${STORAGE_PREFIX}${encrypted}`,
                'local',
            );
        } else {
            await Editor.Profile.removeConfig(this.packageName, STORAGE_KEY, 'local');
        }
        return this.status();
    }

    async clear(): Promise<VaultStatus> {
        await this.initialize();
        this.token = null;
        await Editor.Profile.removeConfig(this.packageName, STORAGE_KEY, 'local');
        return this.status();
    }

    async get(): Promise<string> {
        await this.initialize();
        if (!this.token) {
            throw new Error('请先设置 Figma Personal Access Token。');
        }
        return this.token;
    }

    status(): VaultStatus {
        return {
            hasToken: Boolean(this.token),
            persistent: this.persistent,
            backend: this.backend,
            warning: this.warning,
        };
    }
}
