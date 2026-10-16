import type { ImportAction, LegacyImportAction, NodeKind } from './types';

const CURRENT_ACTIONS = new Set<ImportAction>([
    'ignore',
    'generate',
    'render',
    'transform',
]);

/** Explicit visual-resource naming convention; other image-role aliases stay editable. */
export function isMergedResourceName(name: string): boolean {
    return /^(?:icon|img)_.+/i.test(name.trim().normalize('NFKC'));
}

export function normalizeImportAction(value: unknown): ImportAction {
    if (value === 'merge' || value === 'svg') {
        return 'render';
    }
    if (typeof value === 'string' && CURRENT_ACTIONS.has(value as ImportAction)) {
        return value as ImportAction;
    }
    return 'generate';
}

export function isTerminalAction(value: ImportAction | LegacyImportAction): boolean {
    const action = normalizeImportAction(value);
    return action === 'render' || action === 'transform';
}

export function blocksDescendants(value: ImportAction | LegacyImportAction): boolean {
    return normalizeImportAction(value) === 'ignore' || isTerminalAction(value);
}

export function kindForImportAction(
    kind: NodeKind,
    value: ImportAction | LegacyImportAction,
    nineSlice = false,
): NodeKind {
    if (nineSlice || normalizeImportAction(value) === 'render') {
        return kind === 'button' ? 'button' : 'sprite';
    }
    return kind;
}
