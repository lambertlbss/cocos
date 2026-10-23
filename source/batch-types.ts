import type { FontAssetOption } from './importer/fonts';
import type { ImportReview } from './import-review-model';
import type { ImportOverride, ImportSettings, TreeNodeDto } from './types';

/** Renderer DTOs contain source identifiers only in the current plugin session. */
export interface BatchDocumentDto {
    fileKey: string;
    fileName: string;
    sourceUrl: string;
    tree: TreeNodeDto[];
    fonts: string[];
    fontAssets: FontAssetOption[];
    nodeOverrides: ImportOverride[];
}

export interface BatchFrameItem {
    id: string;
    fileKey: string;
    rootId: string;
    sourceUrl: string;
    name: string;
    sectionName?: string;
    enabled: boolean;
    document: BatchDocumentDto;
}

export interface BatchSourceResult {
    sourceType: 'section' | 'frame' | 'file' | 'node';
    sourceUrl: string;
    items: BatchFrameItem[];
    added: number;
    duplicates: number;
    document?: BatchDocumentDto;
}

export interface BatchImportRequest {
    items: Array<{ id: string; overrides: ImportOverride[] }>;
    settings: ImportSettings;
    failurePolicy?: 'continue' | 'stop';
    /** Retry/resume retains already completed results in this plugin session. */
    preserveResults?: boolean;
}

export interface BatchImportItemResult {
    id: string;
    name: string;
    sourceUrl: string;
    status: 'pending' | 'running' | 'success' | 'failed';
    prefabUrl?: string;
    created?: number;
    updated?: number;
    warnings?: string[];
    review?: ImportReview;
    reviewId?: string;
    error?: string;
    /** The editor/save state needs inspection before the next task can start. */
    requiresAttention?: boolean;
}

export interface BatchProgress {
    batchId: string;
    itemId: string;
    name: string;
    index: number;
    total: number;
    completed: number;
    stopRequested: boolean;
    items: BatchImportItemResult[];
    result?: BatchImportResult;
}

export interface BatchImportResult {
    id: string;
    items: BatchImportItemResult[];
    stopped: boolean;
    completed: number;
    total: number;
}

export interface BatchState {
    items: BatchFrameItem[];
    lastResult?: BatchImportResult;
    running?: BatchProgress;
}
