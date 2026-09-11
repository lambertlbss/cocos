import type { SceneNodeSpec } from './types';

export type MaskTarget = 'node' | 'scroll-view' | 'tiled-helper';
export interface MaskDecision {
    shouldMask: boolean;
    reason: string;
    maskType: 'rectangle' | 'ellipse' | null;
}

/** A helper viewport is distinct from the imported source node (including roots). */
export function shouldGenerateMask(spec: SceneNodeSpec, target: MaskTarget = 'node'): MaskDecision {
    const skip = (reason: string): MaskDecision => ({ shouldMask: false, reason, maskType: null });
    if (target === 'scroll-view') {
        return spec.action === 'generate' && spec.kind === 'scrollView'
            ? { shouldMask: true, reason: 'scroll-view-viewport', maskType: 'rectangle' }
            : skip('not-generated-scroll-view');
    }
    if (target === 'tiled-helper') {
        return (spec.action === 'generate' || spec.action === 'render')
            && Boolean(spec.sprite?.tiled) && spec.figmaType === 'ELLIPSE'
            ? { shouldMask: true, reason: 'tiled-ellipse-shape', maskType: 'ellipse' }
            : skip('no-tiled-ellipse');
    }
    if (spec.isRoot) return skip('import-root');
    if (spec.prefab) return skip('prefab-reference');
    if (spec.action !== 'generate') return skip('not-generated-container');
    if (spec.sprite) return skip('rasterized-node');
    if (spec.kind === 'scrollView') return skip('delegated-to-scroll-view');
    if (spec.kind === 'label' || spec.kind === 'richText'
        || ['TEXT', 'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'REGULAR_POLYGON'].includes(spec.figmaType)) {
        return skip('not-container');
    }
    if (!spec.clipsContent) return skip('clip-content-disabled');
    if (!spec.children.length) return skip('no-children');
    return {
        shouldMask: true,
        reason: 'explicit-clip-content',
        maskType: spec.figmaType === 'ELLIPSE' ? 'ellipse' : 'rectangle',
    };
}

/** Cocos 3.8.x invokes Mask.onLoad only after activation in the scene hierarchy. */
export function setMaskShapeSafely(mask: any, type: number): void {
    if (mask.type === type && mask.inverted === false) return;
    if (mask.subComp === null) {
        // 3.8.7 serialized fields: public setters can dereference a null subComp.
        // Store configuration for the normal onLoad; never activate hidden nodes
        // or manually invoke lifecycle methods just to initialize a renderer.
        if (!Object.prototype.hasOwnProperty.call(mask, '_type')
            || !Object.prototype.hasOwnProperty.call(mask, '_inverted')) {
            throw new Error('Mask 尚未初始化且引擎字段不兼容，已停止配置；请检查 Cocos Creator 版本。');
        }
        mask._type = type;
        mask._inverted = false;
        return;
    }
    if (mask.type !== type) mask.type = type;
    if (mask.inverted !== false) mask.inverted = false;
}
