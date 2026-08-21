import {
  canonicalStringify,
  chunkUtf8,
  parseCanonicalJson,
  quantizeDecimal,
  sha256,
  utf8ByteLength,
} from './canonical-json.js';
import { normalizeCocosUuid } from './names.js';

export const ROUNDTRIP_SCHEMA = 1 as const;
export const SHARED_NAMESPACE = 'cocosfigmabridge';
export const ROOT_HEADER_KEY = 'rt.header';
export const ROOT_BASELINE_PREFIX = 'rt.baseline.';
export const NODE_META_KEY = 'rt.node';
export const RESOURCE_BINDING_KEY = 'rt.resource';
export const MAX_SHARED_VALUE_BYTES = 64 * 1024;
export const RAW_CHUNK_BYTES = 48 * 1024;
export const MAX_BASELINE_BYTES = 8 * 1024 * 1024;
export const MAX_BASELINE_CHUNKS = 192;
export const MAX_MANAGED_NODES = 20_000;

export const EDITABLE_FIELD_ORDER = [
  'position.xy',
  'contentSize.wh',
  'spriteFrame.uuid',
] as const;
export type EditableField = (typeof EDITABLE_FIELD_ORDER)[number];
export type Sha256 = `sha256:${string}`;
export type SyncId = `cfn1:${string}`;
export type VisualId = `cfv1:${string}`;

export const ROUNDTRIP_DIAGNOSTIC_CODES = [
  'PREFAB_META_MISSING',
  'PREFAB_META_INVALID',
  'PREFAB_UUID_MISMATCH',
  'NODE_FILE_ID_MISSING',
  'NODE_FILE_ID_DUPLICATE',
  'COMPONENT_FILE_ID_DUPLICATE',
  'COMPONENT_IDENTITY_AMBIGUOUS',
  'NESTED_PREFAB_V1',
  'NESTED_PROVENANCE_INCOMPLETE',
  'LAYOUT_OWNS_POSITION',
  'LAYOUT_OWNS_SIZE',
  'WIDGET_OWNS_POSITION',
  'WIDGET_OWNS_SIZE',
  'UNSAFE_TRANSFORM',
  'GEOMETRY_DEPENDENCY_DIVERGED',
  'SPRITE_REBIND_UNSUPPORTED',
  'UNBOUND_IMAGE_FILL',
  'DUPLICATE_SYNC_ID',
  'DUPLICATE_VISUAL_ID',
  'STRUCTURE_CHANGED',
  'SHARED_DATA_LIMIT_EXCEEDED',
  'LEGACY_SURFACE_READONLY',
] as const;
export type RoundtripDiagnosticCode = (typeof ROUNDTRIP_DIAGNOSTIC_CODES)[number];

export interface NodeLocator {
  ownerPrefabUuid: string;
  sourcePrefabUuid: string;
  instanceChain: Array<{ instanceNodeFileId: string; sourcePrefabUuid: string }>;
  nodeFileId: string;
}

export type ComponentLocator =
  | { strategy: 'comp-prefab-file-id'; componentType: string; fileId: string }
  | {
      strategy: 'unique-component-type';
      componentType: string;
      baselineFingerprint: Sha256;
    };

export type SharedNodeMeta =
  | {
      schemaVersion: 1;
      role: 'direct';
      visualId: VisualId;
      syncId: SyncId;
      editable: EditableField[];
    }
  | {
      schemaVersion: 1;
      role: 'nested-readonly';
      visualId: VisualId;
      syncId: SyncId;
      readonlyReason: 'nested-prefab-v1';
    }
  | {
      schemaVersion: 1;
      role: 'weak-readonly';
      visualId: VisualId;
      readonlyReason: RoundtripDiagnosticCode;
    }
  | {
      schemaVersion: 1;
      role: 'helper';
      visualId: VisualId;
      ownerVisualId: VisualId;
      ownerSyncId?: SyncId;
      helperKind: 'sprite-image' | 'nine-slice-piece' | 'label-text' | 'visual-container';
    };

export interface RoundtripGeometry {
  mappingVersion: 1;
  sourceAnchor: { x: number; y: number };
  sourceScale: { x: number; y: number };
  figmaBaselineLocalRect: { x: number; y: number; width: number; height: number };
  parentSyncId: SyncId | null;
  figmaBaselineRelativeTransform: [[number, number, number], [number, number, number]];
  dependencySyncIds: SyncId[];
  dependencyHash: Sha256;
}

export interface CanonicalNode {
  syncId: SyncId;
  locator: NodeLocator;
  componentLocators: {
    uiTransform?: ComponentLocator;
    sprite?: ComponentLocator;
  };
  cocosStructure: { parentNodeFileId: string | null; siblingIndex: number };
  position?: { x: number; y: number };
  contentSize?: { width: number; height: number };
  spriteFrameUuid?: string | null;
  editable: EditableField[];
  geometry: RoundtripGeometry;
}

export interface VisualManifestEntry {
  visualId: VisualId;
  role: SharedNodeMeta['role'];
  syncId?: SyncId;
  ownerVisualId?: VisualId;
  ownerSyncId?: SyncId;
  parentVisualId: VisualId | null;
  siblingOrder: number;
  figmaNodeType: string;
  readonlyVisualFingerprint: Sha256;
}

export interface CanonicalBaseline {
  schemaVersion: 1;
  prefabUuid: string;
  nodes: CanonicalNode[];
  visualManifest: VisualManifestEntry[];
  resources: Array<{ uuid: string; type: 'cc.SpriteFrame'; name: string }>;
}

export interface RootHeader {
  schemaVersion: 1;
  surfaceId: string;
  producer: { name: string; version: string };
  prefab: {
    uuid: string;
    assetUrlHint?: string;
    sourceHash: Sha256;
    metaSourceHash: Sha256;
  };
  baseline: {
    encoding: 'canonical-json';
    chunkKeys: string[];
    byteLength: number;
    sha256: Sha256;
  };
  capabilities: {
    editable: EditableField[];
    nestedWrite: false;
    structureWrite: false;
  };
  exportedAt: string;
}

export interface ResourceBinding {
  schemaVersion: 1;
  syncId: SyncId;
  componentLocatorRef: 'sprite';
  boundUuid: string;
  intent: 'baseline' | 'explicit-rebind';
  paintVisualId: VisualId;
  paintFingerprint: Sha256;
}

function orderedEditable(fields: readonly EditableField[]): EditableField[] {
  const unique = new Set(fields);
  return EDITABLE_FIELD_ORDER.filter((field) => unique.has(field));
}

function normalizeLocator(locator: NodeLocator): NodeLocator {
  return {
    ...locator,
    ownerPrefabUuid: normalizeCocosUuid(locator.ownerPrefabUuid),
    sourcePrefabUuid: normalizeCocosUuid(locator.sourcePrefabUuid),
    instanceChain: locator.instanceChain.map((step) => ({
      ...step,
      sourcePrefabUuid: normalizeCocosUuid(step.sourcePrefabUuid),
    })),
  };
}

export function canonicalizeBaseline(baseline: CanonicalBaseline): CanonicalBaseline {
  return {
    ...baseline,
    prefabUuid: normalizeCocosUuid(baseline.prefabUuid),
    nodes: baseline.nodes
      .map((node) => ({
        ...node,
        locator: normalizeLocator(node.locator),
        editable: orderedEditable(node.editable),
        ...(node.position
          ? { position: { x: quantizeDecimal(node.position.x), y: quantizeDecimal(node.position.y) } }
          : {}),
        ...(node.contentSize
          ? {
              contentSize: {
                width: quantizeDecimal(node.contentSize.width),
                height: quantizeDecimal(node.contentSize.height),
              },
            }
          : {}),
        ...(node.spriteFrameUuid !== undefined
          ? {
              spriteFrameUuid:
                typeof node.spriteFrameUuid === 'string'
                  ? normalizeCocosUuid(node.spriteFrameUuid)
                  : node.spriteFrameUuid,
            }
          : {}),
        geometry: {
          ...node.geometry,
          dependencySyncIds: [...node.geometry.dependencySyncIds].sort(),
        },
      }))
      .sort((left, right) => left.syncId.localeCompare(right.syncId)),
    visualManifest: baseline.visualManifest
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.visualId.localeCompare(right.visualId)),
    resources: baseline.resources
      .map((resource) => ({ ...resource, uuid: normalizeCocosUuid(resource.uuid) }))
      .sort((left, right) => left.uuid.localeCompare(right.uuid)),
  };
}

export function canonicalBaselineJson(baseline: CanonicalBaseline): string {
  return canonicalStringify(canonicalizeBaseline(baseline));
}

export function createSyncId(locator: NodeLocator): SyncId {
  return `cfn1:${sha256(canonicalStringify(normalizeLocator(locator))).slice('sha256:'.length)}`;
}

export function createVisualId(uuid: string): VisualId {
  return `cfv1:${uuid.toLocaleLowerCase()}`;
}

export function baselineChunks(baseline: CanonicalBaseline): {
  canonical: string;
  chunks: string[];
  chunkKeys: string[];
  byteLength: number;
  sha256: Sha256;
} {
  const canonical = canonicalBaselineJson(baseline);
  const byteLength = utf8ByteLength(canonical);
  if (byteLength > MAX_BASELINE_BYTES) {
    throw new Error(`Baseline exceeds ${MAX_BASELINE_BYTES} bytes`);
  }
  const chunks = chunkUtf8(canonical, RAW_CHUNK_BYTES);
  if (chunks.length > MAX_BASELINE_CHUNKS) {
    throw new Error(`Baseline exceeds ${MAX_BASELINE_CHUNKS} chunks`);
  }
  const chunkKeys = chunks.map(
    (_, index) => `${ROOT_BASELINE_PREFIX}${index.toString().padStart(4, '0')}`,
  );
  return { canonical, chunks, chunkKeys, byteLength, sha256: sha256(canonical) };
}

export function decodeBaseline(
  header: RootHeader,
  values: ReadonlyMap<string, string>,
): CanonicalBaseline {
  validateRootHeader(header);
  const joined = header.baseline.chunkKeys.map((key) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing baseline chunk ${key}`);
    if (utf8ByteLength(value) > MAX_SHARED_VALUE_BYTES) throw new Error(`Chunk ${key} is too large`);
    return value;
  }).join('');
  if (utf8ByteLength(joined) !== header.baseline.byteLength) {
    throw new Error('Baseline byteLength mismatch');
  }
  if (sha256(joined) !== header.baseline.sha256) throw new Error('Baseline checksum mismatch');
  const parsed = parseCanonicalJson(joined) as unknown as CanonicalBaseline;
  validateBaseline(parsed);
  if (canonicalBaselineJson(parsed) !== joined) throw new Error('Baseline domain normalization mismatch');
  return parsed;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) throw new Error(`${label}.${key} is unknown`);
  for (const key of required) if (!(key in value)) throw new Error(`${label}.${key} is required`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function validateVec2(value: unknown, label: string, size = false): void {
  assertObject(value, label);
  const keys = size ? ['width', 'height'] : ['x', 'y'];
  exactKeys(value, keys, keys, label);
  for (const key of keys) assertFiniteNumber(value[key], `${label}.${key}`);
}

function validateComponentLocator(value: unknown, label: string): void {
  assertObject(value, label);
  assertString(value.componentType, `${label}.componentType`);
  if (value.strategy === 'comp-prefab-file-id') {
    exactKeys(value, ['strategy', 'componentType', 'fileId'], ['strategy', 'componentType', 'fileId'], label);
    assertString(value.fileId, `${label}.fileId`);
  } else if (value.strategy === 'unique-component-type') {
    exactKeys(value, ['strategy', 'componentType', 'baselineFingerprint'], ['strategy', 'componentType', 'baselineFingerprint'], label);
    assertSha(value.baselineFingerprint, `${label}.baselineFingerprint`);
  } else throw new Error(`${label}.strategy is invalid`);
}

function assertSha(value: unknown, label: string): asserts value is Sha256 {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be sha256:<hex>`);
}

function assertSyncId(value: unknown, label: string): asserts value is SyncId {
  if (typeof value !== 'string' || !/^cfn1:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be cfn1:<hex>`);
}

function assertVisualId(value: unknown, label: string): asserts value is VisualId {
  if (typeof value !== 'string' || !/^cfv1:[0-9a-f-]{36}$/.test(value)) throw new Error(`${label} must be cfv1:<uuid>`);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  const [base, suffix] = value.split('@', 2);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base!)) {
    throw new Error(`${label} must be a Cocos UUID`);
  }
  if (value.includes('@') && !suffix) throw new Error(`${label} has an empty sub-asset suffix`);
}

function assertEditable(value: unknown, label: string): asserts value is EditableField[] {
  if (!Array.isArray(value) || value.some((field) => !EDITABLE_FIELD_ORDER.includes(field as EditableField))) {
    throw new Error(`${label} contains unsupported fields`);
  }
  if (new Set(value).size !== value.length || orderedEditable(value as EditableField[]).join() !== value.join()) {
    throw new Error(`${label} must be unique and in protocol order`);
  }
}

export function validateRootHeader(value: unknown): asserts value is RootHeader {
  assertObject(value, 'header');
  exactKeys(value, ['schemaVersion', 'surfaceId', 'producer', 'prefab', 'baseline', 'capabilities', 'exportedAt'], ['schemaVersion', 'surfaceId', 'producer', 'prefab', 'baseline', 'capabilities', 'exportedAt'], 'header');
  if (value.schemaVersion !== 1) throw new Error('Unsupported round-trip schema');
  assertUuid(value.surfaceId, 'header.surfaceId');
  if (value.surfaceId.includes('@')) throw new Error('header.surfaceId cannot be a sub-asset UUID');
  assertString(value.exportedAt, 'header.exportedAt');
  assertObject(value.producer, 'header.producer');
  exactKeys(value.producer, ['name', 'version'], ['name', 'version'], 'header.producer');
  assertString(value.producer.name, 'header.producer.name');
  assertString(value.producer.version, 'header.producer.version');
  assertObject(value.prefab, 'header.prefab');
  exactKeys(value.prefab, ['uuid', 'assetUrlHint', 'sourceHash', 'metaSourceHash'], ['uuid', 'sourceHash', 'metaSourceHash'], 'header.prefab');
  assertUuid(value.prefab.uuid, 'header.prefab.uuid');
  if (value.prefab.assetUrlHint !== undefined && (typeof value.prefab.assetUrlHint !== 'string' || !value.prefab.assetUrlHint.startsWith('db://assets/'))) {
    throw new Error('header.prefab.assetUrlHint must be a db://assets/ URL');
  }
  assertSha(value.prefab.sourceHash, 'header.prefab.sourceHash');
  assertSha(value.prefab.metaSourceHash, 'header.prefab.metaSourceHash');
  assertObject(value.baseline, 'header.baseline');
  exactKeys(value.baseline, ['encoding', 'chunkKeys', 'byteLength', 'sha256'], ['encoding', 'chunkKeys', 'byteLength', 'sha256'], 'header.baseline');
  if (value.baseline.encoding !== 'canonical-json') throw new Error('Unsupported baseline encoding');
  if (!Array.isArray(value.baseline.chunkKeys) || value.baseline.chunkKeys.length === 0 || value.baseline.chunkKeys.length > MAX_BASELINE_CHUNKS) throw new Error('Invalid baseline chunkKeys');
  const expectedKeys = value.baseline.chunkKeys.map((_, index) => `${ROOT_BASELINE_PREFIX}${index.toString().padStart(4, '0')}`);
  if (value.baseline.chunkKeys.join() !== expectedKeys.join()) throw new Error('baseline.chunkKeys must be contiguous');
  if (
    typeof value.baseline.byteLength !== 'number' ||
    !Number.isInteger(value.baseline.byteLength) ||
    value.baseline.byteLength < 0 ||
    value.baseline.byteLength > MAX_BASELINE_BYTES
  ) throw new Error('Invalid baseline byteLength');
  assertSha(value.baseline.sha256, 'header.baseline.sha256');
  assertObject(value.capabilities, 'header.capabilities');
  exactKeys(value.capabilities, ['editable', 'nestedWrite', 'structureWrite'], ['editable', 'nestedWrite', 'structureWrite'], 'header.capabilities');
  assertEditable(value.capabilities.editable, 'header.capabilities.editable');
  if (value.capabilities.nestedWrite !== false || value.capabilities.structureWrite !== false) throw new Error('Schema v1 cannot write nested content or structure');
}

export function validateSharedNodeMeta(value: unknown): asserts value is SharedNodeMeta {
  assertObject(value, 'nodeMeta');
  if (value.schemaVersion !== 1) throw new Error('Unsupported node metadata schema');
  assertVisualId(value.visualId, 'nodeMeta.visualId');
  switch (value.role) {
    case 'direct':
      exactKeys(value, ['schemaVersion', 'role', 'visualId', 'syncId', 'editable'], ['schemaVersion', 'role', 'visualId', 'syncId', 'editable'], 'nodeMeta');
      assertSyncId(value.syncId, 'nodeMeta.syncId');
      assertEditable(value.editable, 'nodeMeta.editable');
      return;
    case 'nested-readonly':
      exactKeys(value, ['schemaVersion', 'role', 'visualId', 'syncId', 'readonlyReason'], ['schemaVersion', 'role', 'visualId', 'syncId', 'readonlyReason'], 'nodeMeta');
      assertSyncId(value.syncId, 'nodeMeta.syncId');
      if (value.readonlyReason !== 'nested-prefab-v1') throw new Error('Invalid nested readonly reason');
      return;
    case 'weak-readonly':
      exactKeys(value, ['schemaVersion', 'role', 'visualId', 'readonlyReason'], ['schemaVersion', 'role', 'visualId', 'readonlyReason'], 'nodeMeta');
      if (!ROUNDTRIP_DIAGNOSTIC_CODES.includes(value.readonlyReason as RoundtripDiagnosticCode)) throw new Error('Invalid weak readonly reason');
      return;
    case 'helper':
      exactKeys(value, ['schemaVersion', 'role', 'visualId', 'ownerVisualId', 'ownerSyncId', 'helperKind'], ['schemaVersion', 'role', 'visualId', 'ownerVisualId', 'helperKind'], 'nodeMeta');
      assertVisualId(value.ownerVisualId, 'nodeMeta.ownerVisualId');
      if (value.ownerSyncId !== undefined) assertSyncId(value.ownerSyncId, 'nodeMeta.ownerSyncId');
      if (!['sprite-image', 'nine-slice-piece', 'label-text', 'visual-container'].includes(String(value.helperKind))) throw new Error('Invalid helper kind');
      return;
    default:
      throw new Error('Invalid node metadata role');
  }
}

export function validateResourceBinding(value: unknown): asserts value is ResourceBinding {
  assertObject(value, 'resourceBinding');
  exactKeys(value, ['schemaVersion', 'syncId', 'componentLocatorRef', 'boundUuid', 'intent', 'paintVisualId', 'paintFingerprint'], ['schemaVersion', 'syncId', 'componentLocatorRef', 'boundUuid', 'intent', 'paintVisualId', 'paintFingerprint'], 'resourceBinding');
  if (value.schemaVersion !== 1 || value.componentLocatorRef !== 'sprite') throw new Error('Unsupported resource binding');
  assertSyncId(value.syncId, 'resourceBinding.syncId');
  assertUuid(value.boundUuid, 'resourceBinding.boundUuid');
  if (value.intent !== 'baseline' && value.intent !== 'explicit-rebind') throw new Error('Invalid resource intent');
  assertVisualId(value.paintVisualId, 'resourceBinding.paintVisualId');
  assertSha(value.paintFingerprint, 'resourceBinding.paintFingerprint');
}

export function validateBaseline(value: unknown): asserts value is CanonicalBaseline {
  assertObject(value, 'baseline');
  exactKeys(value, ['schemaVersion', 'prefabUuid', 'nodes', 'visualManifest', 'resources'], ['schemaVersion', 'prefabUuid', 'nodes', 'visualManifest', 'resources'], 'baseline');
  if (value.schemaVersion !== 1) throw new Error('Unsupported baseline schema');
  assertUuid(value.prefabUuid, 'baseline.prefabUuid');
  if (!Array.isArray(value.nodes) || value.nodes.length > MAX_MANAGED_NODES) throw new Error('Invalid baseline nodes');
  if (!Array.isArray(value.visualManifest) || value.visualManifest.length > MAX_MANAGED_NODES) throw new Error('Invalid visual manifest');
  if (!Array.isArray(value.resources)) throw new Error('Invalid baseline resources');
  const syncIds = new Set<string>();
  for (const [index, rawNode] of value.nodes.entries()) {
    assertObject(rawNode, `baseline.nodes[${index}]`);
    const label = `baseline.nodes[${index}]`;
    exactKeys(
      rawNode,
      ['syncId', 'locator', 'componentLocators', 'cocosStructure', 'position', 'contentSize', 'spriteFrameUuid', 'editable', 'geometry'],
      ['syncId', 'locator', 'componentLocators', 'cocosStructure', 'editable', 'geometry'],
      label,
    );
    assertSyncId(rawNode.syncId, `baseline.nodes[${index}].syncId`);
    if (syncIds.has(rawNode.syncId)) throw new Error('Duplicate syncId');
    syncIds.add(rawNode.syncId);
    assertObject(rawNode.locator, `${label}.locator`);
    exactKeys(rawNode.locator, ['ownerPrefabUuid', 'sourcePrefabUuid', 'instanceChain', 'nodeFileId'], ['ownerPrefabUuid', 'sourcePrefabUuid', 'instanceChain', 'nodeFileId'], `${label}.locator`);
    assertUuid(rawNode.locator.ownerPrefabUuid, `${label}.locator.ownerPrefabUuid`);
    assertUuid(rawNode.locator.sourcePrefabUuid, `${label}.locator.sourcePrefabUuid`);
    assertString(rawNode.locator.nodeFileId, `${label}.locator.nodeFileId`);
    if (!Array.isArray(rawNode.locator.instanceChain)) throw new Error(`${label}.locator.instanceChain must be an array`);
    rawNode.locator.instanceChain.forEach((step, stepIndex) => {
      assertObject(step, `${label}.locator.instanceChain[${stepIndex}]`);
      exactKeys(step, ['instanceNodeFileId', 'sourcePrefabUuid'], ['instanceNodeFileId', 'sourcePrefabUuid'], `${label}.locator.instanceChain[${stepIndex}]`);
      assertString(step.instanceNodeFileId, `${label}.locator.instanceChain[${stepIndex}].instanceNodeFileId`);
      assertUuid(step.sourcePrefabUuid, `${label}.locator.instanceChain[${stepIndex}].sourcePrefabUuid`);
    });
    if (createSyncId(rawNode.locator as unknown as NodeLocator) !== rawNode.syncId) {
      throw new Error(`${label}.syncId does not match locator`);
    }
    assertObject(rawNode.componentLocators, `${label}.componentLocators`);
    exactKeys(rawNode.componentLocators, ['uiTransform', 'sprite'], [], `${label}.componentLocators`);
    if (rawNode.componentLocators.uiTransform !== undefined) validateComponentLocator(rawNode.componentLocators.uiTransform, `${label}.componentLocators.uiTransform`);
    if (rawNode.componentLocators.sprite !== undefined) validateComponentLocator(rawNode.componentLocators.sprite, `${label}.componentLocators.sprite`);
    assertObject(rawNode.cocosStructure, `${label}.cocosStructure`);
    exactKeys(rawNode.cocosStructure, ['parentNodeFileId', 'siblingIndex'], ['parentNodeFileId', 'siblingIndex'], `${label}.cocosStructure`);
    if (rawNode.cocosStructure.parentNodeFileId !== null) assertString(rawNode.cocosStructure.parentNodeFileId, `${label}.cocosStructure.parentNodeFileId`);
    if (typeof rawNode.cocosStructure.siblingIndex !== 'number' || !Number.isInteger(rawNode.cocosStructure.siblingIndex) || rawNode.cocosStructure.siblingIndex < 0) throw new Error(`${label}.cocosStructure.siblingIndex is invalid`);
    if (rawNode.position !== undefined) validateVec2(rawNode.position, `${label}.position`);
    if (rawNode.contentSize !== undefined) validateVec2(rawNode.contentSize, `${label}.contentSize`, true);
    if (rawNode.spriteFrameUuid !== undefined && rawNode.spriteFrameUuid !== null) assertUuid(rawNode.spriteFrameUuid, `${label}.spriteFrameUuid`);
    assertEditable(rawNode.editable, `baseline.nodes[${index}].editable`);
    assertObject(rawNode.geometry, `${label}.geometry`);
    exactKeys(rawNode.geometry, ['mappingVersion', 'sourceAnchor', 'sourceScale', 'figmaBaselineLocalRect', 'parentSyncId', 'figmaBaselineRelativeTransform', 'dependencySyncIds', 'dependencyHash'], ['mappingVersion', 'sourceAnchor', 'sourceScale', 'figmaBaselineLocalRect', 'parentSyncId', 'figmaBaselineRelativeTransform', 'dependencySyncIds', 'dependencyHash'], `${label}.geometry`);
    if (rawNode.geometry.mappingVersion !== 1) throw new Error(`${label}.geometry.mappingVersion is invalid`);
    validateVec2(rawNode.geometry.sourceAnchor, `${label}.geometry.sourceAnchor`);
    validateVec2(rawNode.geometry.sourceScale, `${label}.geometry.sourceScale`);
    assertObject(rawNode.geometry.figmaBaselineLocalRect, `${label}.geometry.figmaBaselineLocalRect`);
    exactKeys(rawNode.geometry.figmaBaselineLocalRect, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height'], `${label}.geometry.figmaBaselineLocalRect`);
    for (const key of ['x', 'y', 'width', 'height']) assertFiniteNumber(rawNode.geometry.figmaBaselineLocalRect[key], `${label}.geometry.figmaBaselineLocalRect.${key}`);
    if (rawNode.geometry.parentSyncId !== null) assertSyncId(rawNode.geometry.parentSyncId, `${label}.geometry.parentSyncId`);
    if (!Array.isArray(rawNode.geometry.figmaBaselineRelativeTransform) || rawNode.geometry.figmaBaselineRelativeTransform.length !== 2 || rawNode.geometry.figmaBaselineRelativeTransform.some((row) => !Array.isArray(row) || row.length !== 3 || row.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry)))) throw new Error(`${label}.geometry.figmaBaselineRelativeTransform is invalid`);
    if (!Array.isArray(rawNode.geometry.dependencySyncIds)) throw new Error(`${label}.geometry.dependencySyncIds must be an array`);
    rawNode.geometry.dependencySyncIds.forEach((id, dependencyIndex) => assertSyncId(id, `${label}.geometry.dependencySyncIds[${dependencyIndex}]`));
    if (new Set(rawNode.geometry.dependencySyncIds).size !== rawNode.geometry.dependencySyncIds.length) throw new Error(`${label}.geometry.dependencySyncIds contains duplicates`);
    assertSha(rawNode.geometry.dependencyHash, `${label}.geometry.dependencyHash`);
  }
  const visualIds = new Set<string>();
  for (const [index, rawVisual] of value.visualManifest.entries()) {
    assertObject(rawVisual, `baseline.visualManifest[${index}]`);
    const label = `baseline.visualManifest[${index}]`;
    exactKeys(rawVisual, ['visualId', 'role', 'syncId', 'ownerVisualId', 'ownerSyncId', 'parentVisualId', 'siblingOrder', 'figmaNodeType', 'readonlyVisualFingerprint'], ['visualId', 'role', 'parentVisualId', 'siblingOrder', 'figmaNodeType', 'readonlyVisualFingerprint'], label);
    assertVisualId(rawVisual.visualId, `baseline.visualManifest[${index}].visualId`);
    if (visualIds.has(rawVisual.visualId)) throw new Error('Duplicate visualId');
    visualIds.add(rawVisual.visualId);
    if (!['direct', 'nested-readonly', 'weak-readonly', 'helper'].includes(String(rawVisual.role))) throw new Error(`${label}.role is invalid`);
    if (rawVisual.syncId !== undefined) assertSyncId(rawVisual.syncId, `${label}.syncId`);
    if (rawVisual.ownerVisualId !== undefined) assertVisualId(rawVisual.ownerVisualId, `${label}.ownerVisualId`);
    if (rawVisual.ownerSyncId !== undefined) assertSyncId(rawVisual.ownerSyncId, `${label}.ownerSyncId`);
    if (rawVisual.parentVisualId !== null) assertVisualId(rawVisual.parentVisualId, `${label}.parentVisualId`);
    if (typeof rawVisual.siblingOrder !== 'number' || !Number.isInteger(rawVisual.siblingOrder) || rawVisual.siblingOrder < 0) throw new Error(`${label}.siblingOrder is invalid`);
    assertString(rawVisual.figmaNodeType, `${label}.figmaNodeType`);
    assertSha(rawVisual.readonlyVisualFingerprint, `${label}.readonlyVisualFingerprint`);
    if ((rawVisual.role === 'direct' || rawVisual.role === 'nested-readonly') && rawVisual.syncId === undefined) throw new Error(`${label}.syncId is required`);
    if (rawVisual.role === 'weak-readonly' && (rawVisual.syncId !== undefined || rawVisual.ownerVisualId !== undefined || rawVisual.ownerSyncId !== undefined)) throw new Error(`${label} has invalid weak identity fields`);
    if (rawVisual.role === 'helper' && rawVisual.ownerVisualId === undefined) throw new Error(`${label}.ownerVisualId is required`);
  }
  for (const [index, rawResource] of value.resources.entries()) {
    assertObject(rawResource, `baseline.resources[${index}]`);
    exactKeys(rawResource, ['uuid', 'type', 'name'], ['uuid', 'type', 'name'], `baseline.resources[${index}]`);
    assertUuid(rawResource.uuid, `baseline.resources[${index}].uuid`);
    if (rawResource.type !== 'cc.SpriteFrame') throw new Error(`baseline.resources[${index}].type is invalid`);
    assertString(rawResource.name, `baseline.resources[${index}].name`);
  }
  for (const visual of value.visualManifest) {
    if (visual.parentVisualId !== null && !visualIds.has(visual.parentVisualId)) throw new Error(`Missing parentVisualId ${visual.parentVisualId}`);
    if (visual.ownerVisualId !== undefined && !visualIds.has(visual.ownerVisualId)) throw new Error(`Missing ownerVisualId ${visual.ownerVisualId}`);
    if (visual.syncId !== undefined && !syncIds.has(visual.syncId)) throw new Error(`Missing canonical node ${visual.syncId}`);
  }
}

export function canonicalHeaderJson(header: RootHeader): string {
  validateRootHeader(header);
  return canonicalStringify({
    ...header,
    capabilities: { ...header.capabilities, editable: orderedEditable(header.capabilities.editable) },
    baseline: { ...header.baseline, chunkKeys: [...header.baseline.chunkKeys].sort() },
  });
}

export function parseRootHeader(input: string): RootHeader {
  const parsed = parseCanonicalJson(input) as unknown;
  validateRootHeader(parsed);
  if (canonicalHeaderJson(parsed) !== input) throw new Error('Header domain normalization mismatch');
  return parsed;
}

export function parseSharedNodeMeta(input: string): SharedNodeMeta {
  const parsed = parseCanonicalJson(input) as unknown;
  validateSharedNodeMeta(parsed);
  return parsed;
}

export function parseResourceBinding(input: string): ResourceBinding {
  const parsed = parseCanonicalJson(input) as unknown;
  validateResourceBinding(parsed);
  return parsed;
}
