import { canonicalStringify, quantizeDecimal, sha256 } from './canonical-json';
import type { Sha256, SyncId } from './protocol';

export interface CanonicalGeometryNode {
  position: { x: number; y: number };
  contentSize: { width: number; height: number };
  anchor: { x: number; y: number };
  scale: { x: number; y: number };
}

export interface CanonicalGeometryParent {
  contentSize: { width: number; height: number };
  anchor: { x: number; y: number };
}

export interface FigmaGeometryProjection {
  localRect: { x: number; y: number; width: number; height: number };
  relativeTransform: [[number, number, number], [number, number, number]];
}

export interface GeometryBaseline extends FigmaGeometryProjection {
  mappingVersion: 1;
  sourceAnchor: { x: number; y: number };
  sourceScale: { x: number; y: number };
  parent: CanonicalGeometryParent | null;
  parentSyncId: SyncId | null;
  dependencySyncIds: SyncId[];
  dependencyHash: Sha256;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function positiveScale(value: number, label: string): number {
  finite(value, label);
  if (value <= 0) throw new Error(`${label} must be positive for geometry v1`);
  return value;
}

function parentAnchor(parent: CanonicalGeometryParent | null): { x: number; y: number } {
  return parent
    ? {
        x: parent.anchor.x * parent.contentSize.width,
        y: (1 - parent.anchor.y) * parent.contentSize.height,
      }
    : { x: 0, y: 0 };
}

/**
 * Geometry v1 is parent-local and rotation/skew free. Positive Cocos scale is
 * baked into the Figma node's visible size, while identity axes preserve a
 * deterministic inverse for move and resize.
 */
export function forwardGeometry(
  node: CanonicalGeometryNode,
  parent: CanonicalGeometryParent | null,
): FigmaGeometryProjection {
  const scaleX = positiveScale(node.scale.x, 'scale.x');
  const scaleY = positiveScale(node.scale.y, 'scale.y');
  const width = finite(node.contentSize.width, 'contentSize.width') * scaleX;
  const height = finite(node.contentSize.height, 'contentSize.height') * scaleY;
  const origin = parentAnchor(parent);
  const x = origin.x + node.position.x - node.anchor.x * width;
  const y = origin.y - node.position.y - (1 - node.anchor.y) * height;
  const localRect = { x, y, width, height };
  return {
    localRect,
    relativeTransform: [[1, 0, x], [0, 1, y]],
  };
}

export function inverseGeometry(
  figma: FigmaGeometryProjection,
  baseline: GeometryBaseline,
): Pick<CanonicalGeometryNode, 'position' | 'contentSize'> {
  if (baseline.mappingVersion !== 1) throw new Error('Unsupported geometry mapping');
  const scaleX = positiveScale(baseline.sourceScale.x, 'sourceScale.x');
  const scaleY = positiveScale(baseline.sourceScale.y, 'sourceScale.y');
  const origin = parentAnchor(baseline.parent);
  const contentSize = {
    width: quantizeDecimal(finite(figma.localRect.width, 'localRect.width') / scaleX),
    height: quantizeDecimal(finite(figma.localRect.height, 'localRect.height') / scaleY),
  };
  const position = {
    x: quantizeDecimal(
      finite(figma.localRect.x, 'localRect.x') - origin.x + baseline.sourceAnchor.x * figma.localRect.width,
    ),
    y: quantizeDecimal(
      origin.y - finite(figma.localRect.y, 'localRect.y') -
        (1 - baseline.sourceAnchor.y) * figma.localRect.height,
    ),
  };
  return { position, contentSize };
}

export function geometryDependencyHash(input: {
  parent: CanonicalGeometryParent | null;
  ancestors: Array<{
    syncId: SyncId;
    contentSize: { width: number; height: number };
    anchor: { x: number; y: number };
    scale: { x: number; y: number };
  }>;
}): Sha256 {
  return sha256(canonicalStringify(input));
}
