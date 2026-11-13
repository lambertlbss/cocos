export interface PrefabSourceGeometry {
    /** Historical compatibility fields; engine dimensions never participate in multipliers. */
    width?: number;
    height?: number;
    scale: { x: number; y: number; z: number };
}

export interface PrefabScalePlan {
    scale?: { x: number; y: number; z: number };
    reason?: string;
}

/** Applies Figma's instance/master multipliers to the immutable authored root scale. */
export function planPrefabScale(source: PrefabSourceGeometry,
    ratio: { x: number; y: number }, importScale = 1): PrefabScalePlan {
    const authored = { x: source?.scale?.x, y: source?.scale?.y, z: source?.scale?.z };
    if (![authored.x, authored.y, authored.z].every(Number.isFinite) || authored.x === 0 || authored.y === 0) {
        return { reason: '源 Prefab 根缩放无效，无法应用 Figma 实例倍率。' };
    }
    const factorX = ratio?.x;
    const factorY = ratio?.y;
    if (![factorX, factorY].every((value) => Number.isFinite(value) && value > 0)) {
        return { reason: 'Figma 实例相对母组件的倍率无效。' };
    }
    if (!Number.isFinite(importScale) || importScale <= 0) {
        return { reason: '导入倍率无效，无法应用 Figma 实例倍率。' };
    }
    // Engine UI dimensions are deliberately irrelevant. Each Figma axis may have
    // its own multiplier; positive multipliers retain authored mirroring.
    const scale = { x: authored.x * factorX * importScale,
        y: authored.y * factorY * importScale, z: authored.z };
    if (![scale.x, scale.y, scale.z].every(Number.isFinite) || scale.x === 0 || scale.y === 0) {
        return { reason: 'Prefab 目标缩放超出可计算范围。' };
    }
    return { scale };
}
