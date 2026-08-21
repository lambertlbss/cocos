import type { PrefabNode } from './types.js';
import type { EditableField, RoundtripDiagnosticCode } from './roundtrip-protocol.js';

export interface RoundtripSafetyResult {
  editable: EditableField[];
  readonlyReasons: RoundtripDiagnosticCode[];
}

const EPSILON = 1e-6;

function unsafeTransform(node: PrefabNode): boolean {
  return (
    !Number.isFinite(node.scale.x) ||
    !Number.isFinite(node.scale.y) ||
    node.scale.x <= 0 ||
    node.scale.y <= 0 ||
    Math.abs(node.scale.x - 1) > EPSILON ||
    Math.abs(node.scale.y - 1) > EPSILON ||
    Math.abs(node.rotation.x) > EPSILON ||
    Math.abs(node.rotation.y) > EPSILON ||
    Math.abs(node.rotation.z) > EPSILON
  );
}

/** Conservative P0 ownership analysis over the node and managed ancestors. */
export function analyzeRoundtripSafety(
  node: PrefabNode,
  byId: ReadonlyMap<string, PrefabNode>,
  stableIdentity: boolean,
  isRoot: boolean,
): RoundtripSafetyResult {
  const reasons = new Set<RoundtripDiagnosticCode>();
  if (!stableIdentity) {
    for (const reason of node.roundtrip?.readonlyReasons ?? ['NODE_FILE_ID_MISSING']) reasons.add(reason);
  }
  if (node.roundtrip?.nested) reasons.add('NESTED_PREFAB_V1');

  let current: PrefabNode | undefined = node;
  let first = true;
  while (current) {
    if (unsafeTransform(current)) reasons.add('UNSAFE_TRANSFORM');
    if (first && current.roundtrip?.hasWidget) {
      reasons.add('WIDGET_OWNS_POSITION');
      reasons.add('WIDGET_OWNS_SIZE');
    }
    if (!first && current.roundtrip?.hasLayout) {
      reasons.add('LAYOUT_OWNS_POSITION');
      reasons.add('LAYOUT_OWNS_SIZE');
    }
    first = false;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  const identityWritable = stableIdentity && !node.roundtrip?.nested;
  const editable: EditableField[] = [];
  if (
    identityWritable &&
    !isRoot &&
    !reasons.has('UNSAFE_TRANSFORM') &&
    !reasons.has('LAYOUT_OWNS_POSITION') &&
    !reasons.has('WIDGET_OWNS_POSITION')
  ) editable.push('position.xy');
  if (
    identityWritable &&
    node.hasUiTransform &&
    !reasons.has('UNSAFE_TRANSFORM') &&
    !reasons.has('LAYOUT_OWNS_SIZE') &&
    !reasons.has('WIDGET_OWNS_SIZE')
  ) editable.push('contentSize.wh');
  if (
    identityWritable &&
    node.sprite?.assetUuid &&
    node.sprite.spriteType === 'SIMPLE' &&
    node.sprite.sizeMode === 'CUSTOM'
  ) editable.push('spriteFrame.uuid');
  else if (node.sprite) reasons.add('SPRITE_REBIND_UNSUPPORTED');
  return { editable, readonlyReasons: [...reasons].sort() };
}

export function applyRoundtripSafety(nodes: PrefabNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root = nodes.find((node) => node.parentId === null);
  for (const node of nodes) {
    if (!node.roundtrip) continue;
    const result = analyzeRoundtripSafety(node, byId, Boolean(node.roundtrip.locator), node === root);
    node.roundtrip.editable = result.editable;
    node.roundtrip.readonlyReasons = result.readonlyReasons;
  }
}
