/** Minimal shared shape for source nodes and renderer tree DTOs. */
export interface VisibilityNode {
    readonly id: string;
    readonly visible?: boolean;
    readonly children: readonly VisibilityNode[];
}

/** Hidden means the Figma visibility flag, including any hidden ancestor.
 * Opacity, geometry and paint visibility do not change this import setting.
 * Return derived IDs without changing source nodes or saved user strategies.
 */
export function hiddenLayerIds<T extends VisibilityNode>(
    roots: readonly T[],
    importHiddenLayers = true,
): Set<string> {
    const hiddenIds = new Set<string>();
    if (importHiddenLayers !== false) return hiddenIds;
    const visit = (node: VisibilityNode, ancestorHidden: boolean): void => {
        const hidden = ancestorHidden || node.visible === false;
        if (hidden) hiddenIds.add(node.id);
        node.children.forEach((child) => visit(child, hidden));
    };
    roots.forEach((node) => visit(node, false));
    return hiddenIds;
}
