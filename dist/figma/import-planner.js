"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.semanticRoleForNode = semanticRoleForNode;
exports.normalizeFigmaSliceDecision = normalizeFigmaSliceDecision;
exports.normalizePrefabDecision = normalizePrefabDecision;
exports.resolveAutomaticMergeDecisions = resolveAutomaticMergeDecisions;
exports.compileImportPlan = compileImportPlan;
exports.annotateTreeWithImportPlan = annotateTreeWithImportPlan;
exports.importPlanReasonText = importPlanReasonText;
const analyzer_1 = require("./analyzer");
const import_actions_1 = require("../import-actions");
const CONTAINER_TYPES = new Set([
    'DOCUMENT',
    'CANVAS',
    'FRAME',
    'GROUP',
    'SECTION',
    'COMPONENT',
    'COMPONENT_SET',
    'INSTANCE',
]);
const SCROLL_DIRECTIONS = new Set([
    'HORIZONTAL_SCROLLING',
    'VERTICAL_SCROLLING',
    'HORIZONTAL_AND_VERTICAL_SCROLLING',
    'HORIZONTAL',
    'VERTICAL',
    'BOTH',
]);
const ROLE_PREFIX = /^(panel|list|layout|btn|button|img|image|icon|bg|sprite|txt|text|label)(?:_|$)/i;
function normalizedName(node) {
    return node.name.trim().normalize('NFKC');
}
function semanticRoleForNode(node, isRoot = false) {
    if (isRoot) {
        return 'root';
    }
    const name = normalizedName(node);
    const lower = name.toLocaleLowerCase('en-US');
    if (lower === 'view')
        return 'view';
    if (lower === 'content')
        return 'content';
    const match = ROLE_PREFIX.exec(lower);
    switch (match === null || match === void 0 ? void 0 : match[1]) {
        case 'panel': return 'panel';
        case 'list': return 'list';
        case 'layout': return 'layout';
        case 'btn':
        case 'button': return 'button';
        case 'img':
        case 'image':
        case 'icon':
        case 'bg':
        case 'sprite': return 'image';
        case 'txt':
        case 'text':
        case 'label': return 'text';
        default: return 'unknown';
    }
}
function defaultDecision(node) {
    return {
        action: (0, analyzer_1.inferAction)(node),
        kind: (0, analyzer_1.inferKind)(node),
        nineSlice: (0, analyzer_1.isPatchCandidate)(node),
        explicit: false,
    };
}
/** Valid Figma slice geometry owns its strategy; ignoring the node still wins.
 * The renderer supplies its analyzed patchCandidate instead of re-reading geometry.
 */
function normalizeFigmaSliceDecision(decision, hasFigmaSlice) {
    if (!hasFigmaSlice || decision.action === 'ignore')
        return decision;
    return { ...decision, action: 'render', kind: (0, import_actions_1.kindForImportAction)(decision.kind, 'render', true), nineSlice: true };
}
/** An explicit Prefab parameter owns the boundary; ignoring still wins. */
function normalizePrefabDecision(decision, prefabName) {
    if (!(prefabName === null || prefabName === void 0 ? void 0 : prefabName.trim()) || decision.action === 'ignore')
        return decision;
    return { ...decision, action: 'generate', kind: 'node', nineSlice: false };
}
function resolvedDecision(node, decisions) {
    var _a, _b;
    const decision = (_a = decisions.get(node.id)) !== null && _a !== void 0 ? _a : defaultDecision(node);
    return ((_b = node.prefabName) === null || _b === void 0 ? void 0 : _b.trim())
        ? normalizePrefabDecision(decision, node.prefabName)
        : normalizeFigmaSliceDecision(decision, (0, analyzer_1.isPatchCandidate)(node));
}
function subtreeHasPrefabBoundary(node, decisions) {
    var _a, _b;
    const decision = (_a = decisions.get(node.id)) !== null && _a !== void 0 ? _a : defaultDecision(node);
    if (decision.action === 'ignore')
        return false;
    if ((_b = node.prefabName) === null || _b === void 0 ? void 0 : _b.trim())
        return true;
    // A deliberate ancestor terminal strategy owns its entire subtree.
    if (decision.explicit && (decision.action === 'render' || decision.action === 'transform'))
        return false;
    return node.children.some((child) => subtreeHasPrefabBoundary(child, decisions));
}
function visiblePaints(node) {
    const hasFill = node.fills.some((paint) => { var _a; return paint.visible !== false && ((_a = paint.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
    const hasStroke = node.strokeWeight > 0
        && node.strokes.some((paint) => { var _a; return paint.visible !== false && ((_a = paint.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
    const hasEffect = node.effects.some((effect) => effect.visible !== false);
    return hasFill || hasStroke || hasEffect;
}
function hasRuntimeContainerBehavior(node) {
    var _a, _b;
    const overflow = (_b = (_a = node.overflowDirection) === null || _a === void 0 ? void 0 : _a.trim().toUpperCase()) !== null && _b !== void 0 ? _b : '';
    return node.clipsContent
        || SCROLL_DIRECTIONS.has(overflow)
        || Boolean(node.layoutMode && node.layoutMode !== 'NONE');
}
function isSafeVisualHost(node) {
    return CONTAINER_TYPES.has(node.type)
        && !visiblePaints(node)
        && !hasRuntimeContainerBehavior(node)
        && (!node.blendMode || node.blendMode === 'NORMAL' || node.blendMode === 'PASS_THROUGH');
}
const GEOMETRY_EPSILON = 0.0001;
function framesEquivalent(parent, child) {
    if (!parent || !child)
        return false;
    return Math.abs(parent.x - child.x) <= GEOMETRY_EPSILON
        && Math.abs(parent.y - child.y) <= GEOMETRY_EPSILON
        && Math.abs(parent.width - child.width) <= GEOMETRY_EPSILON
        && Math.abs(parent.height - child.height) <= GEOMETRY_EPSILON;
}
function hasTranslationOnlyTransform(node) {
    var _a, _b;
    const transform = node.relativeTransform;
    if (!transform)
        return true;
    if (transform.length < 2 || ((_a = transform[0]) === null || _a === void 0 ? void 0 : _a.length) < 2 || ((_b = transform[1]) === null || _b === void 0 ? void 0 : _b.length) < 2) {
        return false;
    }
    return Math.abs(transform[0][0] - 1) <= GEOMETRY_EPSILON
        && Math.abs(transform[0][1]) <= GEOMETRY_EPSILON
        && Math.abs(transform[1][0]) <= GEOMETRY_EPSILON
        && Math.abs(transform[1][1] - 1) <= GEOMETRY_EPSILON;
}
function transformsFoldable(parent, child) {
    var _a, _b;
    return Math.abs((_a = parent.rotation) !== null && _a !== void 0 ? _a : 0) <= GEOMETRY_EPSILON
        && Math.abs((_b = child.rotation) !== null && _b !== void 0 ? _b : 0) <= GEOMETRY_EPSILON
        && hasTranslationOnlyTransform(parent)
        && hasTranslationOnlyTransform(child);
}
function opacityIsNeutral(node) {
    return Math.abs(node.opacity - 1) <= GEOMETRY_EPSILON;
}
function effectiveChildren(node, decisions) {
    return node.children.filter((child) => resolvedDecision(child, decisions).action !== 'ignore');
}
function canFoldSourceVisibility(host, source) {
    // A hidden source under a visible host needs its own Inactive node. Folding
    // it onto the host would make the visual appear immediately in Cocos.
    return (host.visible === false || source.visible !== false)
        && !(0, analyzer_1.hasHiddenDescendant)(source);
}
function collectSubtreeIds(node) {
    return [node.id, ...node.children.flatMap(collectSubtreeIds)];
}
function foldPlan(kind, source) {
    return {
        kind,
        sourceNodeId: source.id,
        absorbedNodeIds: collectSubtreeIds(source),
    };
}
function canUseChildAsSprite(child, decisions) {
    const decision = resolvedDecision(child, decisions);
    return decision.action === 'render' || decision.nineSlice;
}
function subtreeHasExplicitConflict(node, decisions) {
    const decision = resolvedDecision(node, decisions);
    return decision.explicit === true
        || Boolean(decision.name)
        || node.children.some((child) => subtreeHasExplicitConflict(child, decisions));
}
function subtreeHasSliceBoundary(node, decisions) {
    return Boolean(resolvedDecision(node, decisions).nineSlice)
        || (0, analyzer_1.isNamedSliceGroup)(node)
        || (0, analyzer_1.isPatchCandidate)(node)
        || node.children.some((child) => subtreeHasSliceBoundary(child, decisions));
}
function prefixMergeConflict(node, decisions) {
    if (node.children.some((child) => subtreeHasExplicitConflict(child, decisions))) {
        return 'prefix-merge-override-conflict';
    }
    return node.children.some((child) => subtreeHasSliceBoundary(child, decisions))
        ? 'prefix-merge-slice-conflict'
        : undefined;
}
/**
 * Resolve automatic resource boundaries before collecting assets and building
 * scene specs. Descendant overrides and independent slices must never be lost
 * to the naming default. The input map and Figma nodes remain untouched.
 */
function resolveAutomaticMergeDecisions(roots, decisions) {
    const result = new Map(decisions);
    const visit = (node, isRoot) => {
        var _a;
        const decision = resolvedDecision(node, result);
        if ((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim()) {
            result.set(node.id, normalizePrefabDecision(decision, node.prefabName));
        }
        else if (!decision.explicit && decision.action !== 'ignore' && decision.action !== 'transform'
            && node.children.some((child) => subtreeHasPrefabBoundary(child, result))) {
            result.set(node.id, { ...decision, action: 'generate', nineSlice: false });
        }
        else if (node.type !== 'TEXT'
            && (0, import_actions_1.isMergedResourceName)(node.name)
            && !decision.explicit
            && decision.action !== 'ignore'
            && decision.action !== 'transform'
            // Real mask groups have already been resolved by the mask planner
            // to either a safe base+tint or a whole composite fallback.
            && !node.children.some((child) => child.isMask)
            && !decision.nineSlice
            && !(0, analyzer_1.hasManualExport)(node)
            && !(0, analyzer_1.isNamedSliceGroup)(node)
            && !(0, analyzer_1.isPatchCandidate)(node)) {
            result.set(node.id, {
                ...decision,
                action: isRoot || prefixMergeConflict(node, result) ? 'generate' : 'render',
            });
        }
        else {
            result.set(node.id, decision);
        }
        node.children.forEach((child) => visit(child, false));
    };
    roots.forEach((root) => visit(root, true));
    return result;
}
function baseReason(node, role, decision, isRoot) {
    var _a;
    if (decision.action !== 'ignore' && ((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim()))
        return 'prefab-reference';
    if (decision.action !== 'ignore' && (0, analyzer_1.isPatchCandidate)(node))
        return 'slice-resource';
    if (decision.explicit)
        return 'user-override';
    if (decision.action === 'ignore')
        return 'ignored';
    if (isRoot)
        return 'root-structure';
    if (node.type === 'TEXT')
        return 'editable-text';
    if (decision.nineSlice || (0, analyzer_1.isNamedSliceGroup)(node) || (0, analyzer_1.isPatchCandidate)(node))
        return 'slice-resource';
    if ((0, analyzer_1.hasManualExport)(node))
        return 'manual-export';
    if ((0, import_actions_1.isMergedResourceName)(node.name)) {
        return decision.action === 'render' ? 'prefix-merge' : 'default-generate';
    }
    if (['panel', 'list', 'layout', 'button', 'view', 'content'].includes(role)) {
        return 'semantic-container';
    }
    if (decision.action === 'render')
        return 'visual-fallback';
    return 'default-generate';
}
function plannedKindForEmptyTextHost(node, role, decision, children) {
    if (role !== 'text'
        || children.length
        || decision.action !== 'generate'
        || decision.explicit
        || !isSafeVisualHost(node)) {
        return undefined;
    }
    return 'label';
}
function visualFoldForNode(node, role, decision, decisions) {
    var _a;
    if (((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim())
        || node.children.some((child) => subtreeHasPrefabBoundary(child, decisions)))
        return undefined;
    const explicitKindRequestsFold = decision.explicit === true && ((role === 'text' && (decision.kind === 'label' || decision.kind === 'richText'))
        || (role === 'image' && (decision.kind === 'sprite' || decision.kind === 'button'))
        || (role === 'button' && decision.kind === 'button'));
    if (decision.action !== 'generate'
        || decision.nineSlice
        || (0, analyzer_1.isNamedSliceGroup)(node)
        || (0, analyzer_1.isPatchCandidate)(node)
        || (decision.explicit && !explicitKindRequestsFold)
        || !isSafeVisualHost(node)) {
        return undefined;
    }
    const children = effectiveChildren(node, decisions);
    if (role === 'text' && children.length === 1) {
        const child = children[0];
        if (child.type === 'TEXT'
            && canFoldSourceVisibility(node, child)
            && !subtreeHasExplicitConflict(child, decisions)
            && framesEquivalent(node.absoluteBoundingBox, child.absoluteBoundingBox)
            && transformsFoldable(node, child)) {
            return {
                fold: foldPlan('single-text', child),
                kind: decision.kind === 'richText' ? 'richText' : 'label',
                reason: 'single-text-fold',
            };
        }
    }
    if (role === 'image' && children.length === 1) {
        const child = children[0];
        if (canUseChildAsSprite(child, decisions)
            && canFoldSourceVisibility(node, child)
            && !subtreeHasExplicitConflict(child, decisions)
            && framesEquivalent(node.absoluteBoundingBox, child.absoluteBoundingBox)
            && transformsFoldable(node, child)) {
            return {
                fold: foldPlan('single-image', child),
                kind: decision.kind === 'button' ? 'button' : 'sprite',
                reason: 'single-image-fold',
            };
        }
    }
    if (role === 'button' && (decision.kind === 'button' || decision.kind === 'auto')) {
        const candidates = children.filter((child) => canUseChildAsSprite(child, decisions)
            && canFoldSourceVisibility(node, child)
            && framesEquivalent(node.absoluteBoundingBox, child.absoluteBoundingBox)
            && transformsFoldable(node, child)
            && opacityIsNeutral(child));
        if (candidates.length === 1
            && children[0] === candidates[0]
            && !subtreeHasExplicitConflict(candidates[0], decisions)) {
            return {
                fold: foldPlan('background', candidates[0]),
                kind: 'button',
                reason: 'background-promotion',
            };
        }
    }
    return undefined;
}
/**
 * 编译一次导入使用的唯一规划表。资源收集完成后可再次编译，以接收本地同名
 * 资源对 decision 的提升；SceneNodeSpec 与面板说明都消费同一套纯规则。
 */
function compileImportPlan(roots, decisions) {
    decisions = resolveAutomaticMergeDecisions(roots, decisions);
    const plans = new Map();
    const visit = (node, isRoot) => {
        var _a, _b, _c, _d;
        const decision = resolvedDecision(node, decisions);
        const role = semanticRoleForNode(node, isRoot);
        const prefabReference = decision.action !== 'ignore' && Boolean((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim());
        const prefabDescendant = node.children.some((child) => subtreeHasPrefabBoundary(child, decisions));
        const children = effectiveChildren(node, decisions);
        const fold = visualFoldForNode(node, role, decision, decisions);
        const emptyTextKind = plannedKindForEmptyTextHost(node, role, decision, children);
        const prefixConflict = !isRoot
            && !prefabReference
            && !prefabDescendant
            && node.type !== 'TEXT'
            && (0, import_actions_1.isMergedResourceName)(node.name)
            && !decision.explicit
            && decision.action === 'generate'
            && !decision.nineSlice
            && !(0, analyzer_1.hasManualExport)(node)
            && !(0, analyzer_1.isNamedSliceGroup)(node)
            && !(0, analyzer_1.isPatchCandidate)(node)
            ? prefixMergeConflict(node, decisions)
            : undefined;
        const reason = prefabDescendant && !decision.explicit && decision.action === 'generate' && !prefabReference
            ? 'default-generate'
            : (_c = (_b = fold === null || fold === void 0 ? void 0 : fold.reason) !== null && _b !== void 0 ? _b : prefixConflict) !== null && _c !== void 0 ? _c : (emptyTextKind ? 'editable-text' : baseReason(node, role, decision, isRoot));
        plans.set(node.id, {
            nodeId: node.id,
            role,
            reason,
            kind: prefabReference ? 'node' : (_d = fold === null || fold === void 0 ? void 0 : fold.kind) !== null && _d !== void 0 ? _d : emptyTextKind,
            fold: fold === null || fold === void 0 ? void 0 : fold.fold,
            warning: prefabReference
                ? `引用项目 Prefab“${node.prefabName}”，${node.prefabName.replace(/\.prefab$/i, '').normalize('NFKC').toLocaleLowerCase('en-US') === 'popup' ? '按 Figma 调整宽高' : '实例保持原尺寸'}；不导入此节点的原始内容及子树`
                : prefabDescendant && !decision.explicit && decision.action === 'generate'
                    ? '内部存在 Prefab 引用，智能模式保留节点结构，不自动合并为图片'
                    : !fold && prefixConflict
                        ? importPlanReasonText(prefixConflict)
                        : reason === 'prefix-merge'
                            ? 'icon_/img_ 前缀按 PNG 整层合并，采用当前显隐合成；隐藏子层不生成独立节点'
                            : undefined,
        });
        node.children.forEach((child) => visit(child, false));
    };
    roots.forEach((root) => visit(root, true));
    return plans;
}
function annotateTreeWithImportPlan(tree, plans) {
    return tree.map((node) => {
        var _a, _b;
        const plan = plans.get(node.id);
        return {
            ...node,
            reason: plan === null || plan === void 0 ? void 0 : plan.reason,
            warning: node.warning && (plan === null || plan === void 0 ? void 0 : plan.warning) && node.warning.includes(plan.warning)
                ? node.warning
                : [...new Set([node.warning, plan === null || plan === void 0 ? void 0 : plan.warning].filter(Boolean))].join('；') || undefined,
            fold: (_a = plan === null || plan === void 0 ? void 0 : plan.fold) === null || _a === void 0 ? void 0 : _a.kind,
            absorbedNodeIds: (_b = plan === null || plan === void 0 ? void 0 : plan.fold) === null || _b === void 0 ? void 0 : _b.absorbedNodeIds,
            children: annotateTreeWithImportPlan(node.children, plans),
        };
    });
}
function importPlanReasonText(reason) {
    switch (reason) {
        case 'ignored': return '节点策略设为忽略，不导入';
        case 'prefab-reference': return '引用项目已有 Prefab';
        case 'root-structure': return '保留为 Prefab 根结构';
        case 'manual-export': return '检测到 Figma Export，按整层资源导入';
        case 'slice-resource': return '识别为三/九宫资源';
        case 'prefix-merge': return 'icon_/img_ 前缀默认合并为单个资源';
        case 'prefix-merge-slice-conflict': return '前缀合并已回退：内部存在独立三/九宫资源，保留其结构与切片能力';
        case 'prefix-merge-override-conflict': return '前缀合并已回退：子层存在手动策略或命名，保留独立子节点';
        case 'semantic-container': return '保留 Cocos 运行时语义容器';
        case 'editable-text': return '保留为可编辑文字';
        case 'single-image-fold': return '单一图片子层提升到父节点';
        case 'single-text-fold': return '单一文字子层提升到父节点';
        case 'background-promotion': return '背景资源提升到父节点，保留内容子层';
        case 'visual-fallback': return '纯视觉内容按 PNG 导入';
        case 'user-override': return '采用手动节点策略';
        case 'default-generate': return '按可编辑节点结构生成';
        default: return '';
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1wb3J0LXBsYW5uZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvZmlnbWEvaW1wb3J0LXBsYW5uZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUErQ0Esa0RBNEJDO0FBY0Qsa0VBR0M7QUFHRCwwREFHQztBQW1KRCx3RUFtQ0M7QUFtSEQsOENBbURDO0FBRUQsZ0VBaUJDO0FBRUQsb0RBb0JDO0FBNWRELHlDQU9vQjtBQUNwQixzREFBOEU7QUFFOUUsTUFBTSxlQUFlLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDNUIsVUFBVTtJQUNWLFFBQVE7SUFDUixPQUFPO0lBQ1AsT0FBTztJQUNQLFNBQVM7SUFDVCxXQUFXO0lBQ1gsZUFBZTtJQUNmLFVBQVU7Q0FDYixDQUFDLENBQUM7QUFFSCxNQUFNLGlCQUFpQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQzlCLHNCQUFzQjtJQUN0QixvQkFBb0I7SUFDcEIsbUNBQW1DO0lBQ25DLFlBQVk7SUFDWixVQUFVO0lBQ1YsTUFBTTtDQUNULENBQUMsQ0FBQztBQUVILE1BQU0sV0FBVyxHQUFHLGlGQUFpRixDQUFDO0FBRXRHLFNBQVMsY0FBYyxDQUFDLElBQTZCO0lBQ2pELE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDOUMsQ0FBQztBQUVELFNBQWdCLG1CQUFtQixDQUMvQixJQUE2QixFQUM3QixNQUFNLEdBQUcsS0FBSztJQUVkLElBQUksTUFBTSxFQUFFLENBQUM7UUFDVCxPQUFPLE1BQU0sQ0FBQztJQUNsQixDQUFDO0lBQ0QsTUFBTSxJQUFJLEdBQUcsY0FBYyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2xDLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM5QyxJQUFJLEtBQUssS0FBSyxNQUFNO1FBQUUsT0FBTyxNQUFNLENBQUM7SUFDcEMs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dCB0eXBlIHtcclxuICAgIEZpZ21hTm9kZSxcclxuICAgIEltcG9ydERlY2lzaW9uLFxyXG4gICAgSW1wb3J0UGxhblJlYXNvbixcclxuICAgIE5vZGVJbXBvcnRQbGFuLFxyXG4gICAgTm9kZUtpbmQsXHJcbiAgICBOb2RlU2VtYW50aWNSb2xlLFxyXG4gICAgUmVjdCxcclxuICAgIFRyZWVOb2RlRHRvLFxyXG4gICAgVmlzdWFsRm9sZFBsYW4sXHJcbn0gZnJvbSAnLi4vdHlwZXMnO1xyXG5pbXBvcnQge1xyXG4gICAgaGFzSGlkZGVuRGVzY2VuZGFudCxcclxuICAgIGhhc01hbnVhbEV4cG9ydCxcclxuICAgIGluZmVyQWN0aW9uLFxyXG4gICAgaW5mZXJLaW5kLFxyXG4gICAgaXNOYW1lZFNsaWNlR3JvdXAsXHJcbiAgICBpc1BhdGNoQ2FuZGlkYXRlLFxyXG59IGZyb20gJy4vYW5hbHl6ZXInO1xyXG5pbXBvcnQgeyBpc01lcmdlZFJlc291cmNlTmFtZSwga2luZEZvckltcG9ydEFjdGlvbiB9IGZyb20gJy4uL2ltcG9ydC1hY3Rpb25zJztcclxuXHJcbmNvbnN0IENPTlRBSU5FUl9UWVBFUyA9IG5ldyBTZXQoW1xyXG4gICAgJ0RPQ1VNRU5UJyxcclxuICAgICdDQU5WQVMnLFxyXG4gICAgJ0ZSQU1FJyxcclxuICAgICdHUk9VUCcsXHJcbiAgICAnU0VDVElPTicsXHJcbiAgICAnQ09NUE9ORU5UJyxcclxuICAgICdDT01QT05FTlRfU0VUJyxcclxuICAgICdJTlNUQU5DRScsXHJcbl0pO1xyXG5cclxuY29uc3QgU0NST0xMX0RJUkVDVElPTlMgPSBuZXcgU2V0KFtcclxuICAgICdIT1JJWk9OVEFMX1NDUk9MTElORycsXHJcbiAgICAnVkVSVElDQUxfU0NST0xMSU5HJyxcclxuICAgICdIT1JJWk9OVEFMX0FORF9WRVJUSUNBTF9TQ1JPTExJTkcnLFxyXG4gICAgJ0hPUklaT05UQUwnLFxyXG4gICAgJ1ZFUlRJQ0FMJyxcclxuICAgICdCT1RIJyxcclxuXSk7XHJcblxyXG5jb25zdCBST0xFX1BSRUZJWCA9IC9eKHBhbmVsfGxpc3R8bGF5b3V0fGJ0bnxidXR0b258aW1nfGltYWdlfGljb258Ymd8c3ByaXRlfHR4dHx0ZXh0fGxhYmVsKSg/Ol98JCkvaTtcclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZWROYW1lKG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnbmFtZSc+KTogc3RyaW5nIHtcclxuICAgIHJldHVybiBub2RlLm5hbWUudHJpbSgpLm5vcm1hbGl6ZSgnTkZLQycpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc2VtYW50aWNSb2xlRm9yTm9kZShcclxuICAgIG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnbmFtZSc+LFxyXG4gICAgaXNSb290ID0gZmFsc2UsXHJcbik6IE5vZGVTZW1hbnRpY1JvbGUge1xyXG4gICAgaWYgKGlzUm9vdCkge1xyXG4gICAgICAgIHJldHVybiAncm9vdCc7XHJcbiAgICB9XHJcbiAgICBjb25zdCBuYW1lID0gbm9ybWFsaXplZE5hbWUobm9kZSk7XHJcbiAgICBjb25zdCBsb3dlciA9IG5hbWUudG9Mb2NhbGVMb3dlckNhc2UoJ2VuLVVTJyk7XHJcbiAgICBpZiAobG93ZXIgPT09ICd2aWV3JykgcmV0dXJuICd2aWV3JztcclxuICAgIGlmIChsb3dlciA9PT0gJ2NvbnRlbnQnKSByZXR1cm4gJ2NvbnRlbnQnO1xyXG4gICAgY29uc3QgbWF0Y2ggPSBST0xFX1BSRUZJWC5leGVjKGxvd2VyKTtcclxuICAgIHN3aXRjaCAobWF0Y2g/LlsxXSkge1xyXG4gICAgICAgIGNhc2UgJ3BhbmVsJzogcmV0dXJuICdwYW5lbCc7XHJcbiAgICAgICAgY2FzZSAnbGlzdCc6IHJldHVybiAnbGlzdCc7XHJcbiAgICAgICAgY2FzZSAnbGF5b3V0JzogcmV0dXJuICdsYXlvdXQnO1xyXG4gICAgICAgIGNhc2UgJ2J0bic6XHJcbiAgICAgICAgY2FzZSAnYnV0dG9uJzogcmV0dXJuICdidXR0b24nO1xyXG4gICAgICAgIGNhc2UgJ2ltZyc6XHJcbiAgICAgICAgY2FzZSAnaW1hZ2UnOlxyXG4gICAgICAgIGNhc2UgJ2ljb24nOlxyXG4gICAgICAgIGNhc2UgJ2JnJzpcclxuICAgICAgICBjYXNlICdzcHJpdGUnOiByZXR1cm4gJ2ltYWdlJztcclxuICAgICAgICBjYXNlICd0eHQnOlxyXG4gICAgICAgIGNhc2UgJ3RleHQnOlxyXG4gICAgICAgIGNhc2UgJ2xhYmVsJzogcmV0dXJuICd0ZXh0JztcclxuICAgICAgICBkZWZhdWx0OiByZXR1cm4gJ3Vua25vd24nO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0RGVjaXNpb24obm9kZTogRmlnbWFOb2RlKTogSW1wb3J0RGVjaXNpb24ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBhY3Rpb246IGluZmVyQWN0aW9uKG5vZGUpLFxyXG4gICAgICAgIGtpbmQ6IGluZmVyS2luZChub2RlKSxcclxuICAgICAgICBuaW5lU2xpY2U6IGlzUGF0Y2hDYW5kaWRhdGUobm9kZSksXHJcbiAgICAgICAgZXhwbGljaXQ6IGZhbHNlLFxyXG4gICAgfTtcclxufVxyXG5cclxuLyoqIFZhbGlkIEZpZ21hIHNsaWNlIGdlb21ldHJ5IG93bnMgaXRzIHN0cmF0ZWd5OyBpZ25vcmluZyB0aGUgbm9kZSBzdGlsbCB3aW5zLlxyXG4gKiBUaGUgcmVuZGVyZXIgc3VwcGxpZXMgaXRzIGFuYWx5emVkIHBhdGNoQ2FuZGlkYXRlIGluc3RlYWQgb2YgcmUtcmVhZGluZyBnZW9tZXRyeS5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb248VCBleHRlbmRzIEltcG9ydERlY2lzaW9uPihkZWNpc2lvbjogVCwgaGFzRmlnbWFTbGljZTogYm9vbGVhbik6IFQge1xyXG4gICAgaWYgKCFoYXNGaWdtYVNsaWNlIHx8IGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHJldHVybiBkZWNpc2lvbjtcclxuICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBraW5kOiBraW5kRm9ySW1wb3J0QWN0aW9uKGRlY2lzaW9uLmtpbmQsICdyZW5kZXInLCB0cnVlKSwgbmluZVNsaWNlOiB0cnVlIH07XHJcbn1cclxuXHJcbi8qKiBBbiBleHBsaWNpdCBQcmVmYWIgcGFyYW1ldGVyIG93bnMgdGhlIGJvdW5kYXJ5OyBpZ25vcmluZyBzdGlsbCB3aW5zLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplUHJlZmFiRGVjaXNpb248VCBleHRlbmRzIEltcG9ydERlY2lzaW9uPihkZWNpc2lvbjogVCwgcHJlZmFiTmFtZT86IHN0cmluZyk6IFQge1xyXG4gICAgaWYgKCFwcmVmYWJOYW1lPy50cmltKCkgfHwgZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuIGRlY2lzaW9uO1xyXG4gICAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ2dlbmVyYXRlJywga2luZDogJ25vZGUnLCBuaW5lU2xpY2U6IGZhbHNlIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc29sdmVkRGVjaXNpb24oXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4pOiBJbXBvcnREZWNpc2lvbiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCkgPz8gZGVmYXVsdERlY2lzaW9uKG5vZGUpO1xyXG4gICAgcmV0dXJuIG5vZGUucHJlZmFiTmFtZT8udHJpbSgpXHJcbiAgICAgICAgPyBub3JtYWxpemVQcmVmYWJEZWNpc2lvbihkZWNpc2lvbiwgbm9kZS5wcmVmYWJOYW1lKVxyXG4gICAgICAgIDogbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uKGRlY2lzaW9uLCBpc1BhdGNoQ2FuZGlkYXRlKG5vZGUpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc3VidHJlZUhhc1ByZWZhYkJvdW5kYXJ5KG5vZGU6IEZpZ21hTm9kZSwgZGVjaXNpb25zOiBSZWFkb25seU1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPik6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKTtcclxuICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSByZXR1cm4gZmFsc2U7XHJcbiAgICBpZiAobm9kZS5wcmVmYWJOYW1lPy50cmltKCkpIHJldHVybiB0cnVlO1xyXG4gICAgLy8gQSBkZWxpYmVyYXRlIGFuY2VzdG9yIHRlcm1pbmFsIHN0cmF0ZWd5IG93bnMgaXRzIGVudGlyZSBzdWJ0cmVlLlxyXG4gICAgaWYgKGRlY2lzaW9uLmV4cGxpY2l0ICYmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInIHx8IGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3RyYW5zZm9ybScpKSByZXR1cm4gZmFsc2U7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gc3VidHJlZUhhc1ByZWZhYkJvdW5kYXJ5KGNoaWxkLCBkZWNpc2lvbnMpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdmlzaWJsZVBhaW50cyhub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGhhc0ZpbGwgPSBub2RlLmZpbGxzLnNvbWUoKHBhaW50KSA9PiBwYWludC52aXNpYmxlICE9PSBmYWxzZSAmJiAocGFpbnQub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzU3Ryb2tlID0gbm9kZS5zdHJva2VXZWlnaHQgPiAwXHJcbiAgICAgICAgJiYgbm9kZS5zdHJva2VzLnNvbWUoKHBhaW50KSA9PiBwYWludC52aXNpYmxlICE9PSBmYWxzZSAmJiAocGFpbnQub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzRWZmZWN0ID0gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIHJldHVybiBoYXNGaWxsIHx8IGhhc1N0cm9rZSB8fCBoYXNFZmZlY3Q7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc1J1bnRpbWVDb250YWluZXJCZWhhdmlvcihub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IG92ZXJmbG93ID0gbm9kZS5vdmVyZmxvd0RpcmVjdGlvbj8udHJpbSgpLnRvVXBwZXJDYXNlKCkgPz8gJyc7XHJcbiAgICByZXR1cm4gbm9kZS5jbGlwc0NvbnRlbnRcclxuICAgICAgICB8fCBTQ1JPTExfRElSRUNUSU9OUy5oYXMob3ZlcmZsb3cpXHJcbiAgICAgICAgfHwgQm9vbGVhbihub2RlLmxheW91dE1vZGUgJiYgbm9kZS5sYXlvdXRNb2RlICE9PSAnTk9ORScpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc1NhZmVWaXN1YWxIb3N0KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKVxyXG4gICAgICAgICYmICF2aXNpYmxlUGFpbnRzKG5vZGUpXHJcbiAgICAgICAgJiYgIWhhc1J1bnRpbWVDb250YWluZXJCZWhhdmlvcihub2RlKVxyXG4gICAgICAgICYmICghbm9kZS5ibGVuZE1vZGUgfHwgbm9kZS5ibGVuZE1vZGUgPT09ICdOT1JNQUwnIHx8IG5vZGUuYmxlbmRNb2RlID09PSAnUEFTU19USFJPVUdIJyk7XHJcbn1cclxuXHJcbmNvbnN0IEdFT01FVFJZX0VQU0lMT04gPSAwLjAwMDE7XHJcblxyXG5mdW5jdGlvbiBmcmFtZXNFcXVpdmFsZW50KHBhcmVudDogUmVjdCB8IHVuZGVmaW5lZCwgY2hpbGQ6IFJlY3QgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcclxuICAgIGlmICghcGFyZW50IHx8ICFjaGlsZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgcmV0dXJuIE1hdGguYWJzKHBhcmVudC54IC0gY2hpbGQueCkgPD0gR0VPTUVUUllfRVBTSUxPTlxyXG4gICAgICAgICYmIE1hdGguYWJzKHBhcmVudC55IC0gY2hpbGQueSkgPD0gR0VPTUVUUllfRVBTSUxPTlxyXG4gICAgICAgICYmIE1hdGguYWJzKHBhcmVudC53aWR0aCAtIGNoaWxkLndpZHRoKSA8PSBHRU9NRVRSWV9FUFNJTE9OXHJcbiAgICAgICAgJiYgTWF0aC5hYnMocGFyZW50LmhlaWdodCAtIGNoaWxkLmhlaWdodCkgPD0gR0VPTUVUUllfRVBTSUxPTjtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzVHJhbnNsYXRpb25Pbmx5VHJhbnNmb3JtKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5yZWxhdGl2ZVRyYW5zZm9ybTtcclxuICAgIGlmICghdHJhbnNmb3JtKSByZXR1cm4gdHJ1ZTtcclxuICAgIGlmICh0cmFuc2Zvcm0ubGVuZ3RoIDwgMiB8fCB0cmFuc2Zvcm1bMF0/Lmxlbmd0aCA8IDIgfHwgdHJhbnNmb3JtWzFdPy5sZW5ndGggPCAyKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIE1hdGguYWJzKHRyYW5zZm9ybVswXVswXSAtIDEpIDw9IEdFT01FVFJZX0VQU0lMT05cclxuICAgICAgICAmJiBNYXRoLmFicyh0cmFuc2Zvcm1bMF1bMV0pIDw9IEdFT01FVFJZX0VQU0lMT05cclxuICAgICAgICAmJiBNYXRoLmFicyh0cmFuc2Zvcm1bMV1bMF0pIDw9IEdFT01FVFJZX0VQU0lMT05cclxuICAgICAgICAmJiBNYXRoLmFicyh0cmFuc2Zvcm1bMV1bMV0gLSAxKSA8PSBHRU9NRVRSWV9FUFNJTE9OO1xyXG59XHJcblxyXG5mdW5jdGlvbiB0cmFuc2Zvcm1zRm9sZGFibGUocGFyZW50OiBGaWdtYU5vZGUsIGNoaWxkOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBNYXRoLmFicyhwYXJlbnQucm90YXRpb24gPz8gMCkgPD0gR0VPTUVUUllfRVBTSUxPTlxyXG4gICAgICAgICYmIE1hdGguYWJzKGNoaWxkLnJvdGF0aW9uID8/IDApIDw9IEdFT01FVFJZX0VQU0lMT05cclxuICAgICAgICAmJiBoYXNUcmFuc2xhdGlvbk9ubHlUcmFuc2Zvcm0ocGFyZW50KVxyXG4gICAgICAgICYmIGhhc1RyYW5zbGF0aW9uT25seVRyYW5zZm9ybShjaGlsZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG9wYWNpdHlJc05ldXRyYWwobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gTWF0aC5hYnMobm9kZS5vcGFjaXR5IC0gMSkgPD0gR0VPTUVUUllfRVBTSUxPTjtcclxufVxyXG5cclxuZnVuY3Rpb24gZWZmZWN0aXZlQ2hpbGRyZW4oXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4pOiBGaWdtYU5vZGVbXSB7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkKSA9PiByZXNvbHZlZERlY2lzaW9uKGNoaWxkLCBkZWNpc2lvbnMpLmFjdGlvbiAhPT0gJ2lnbm9yZScpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjYW5Gb2xkU291cmNlVmlzaWJpbGl0eShob3N0OiBGaWdtYU5vZGUsIHNvdXJjZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICAvLyBBIGhpZGRlbiBzb3VyY2UgdW5kZXIgYSB2aXNpYmxlIGhvc3QgbmVlZHMgaXRzIG93biBJbmFjdGl2ZSBub2RlLiBGb2xkaW5nXHJcbiAgICAvLyBpdCBvbnRvIHRoZSBob3N0IHdvdWxkIG1ha2UgdGhlIHZpc3VhbCBhcHBlYXIgaW1tZWRpYXRlbHkgaW4gQ29jb3MuXHJcbiAgICByZXR1cm4gKGhvc3QudmlzaWJsZSA9PT0gZmFsc2UgfHwgc291cmNlLnZpc2libGUgIT09IGZhbHNlKVxyXG4gICAgICAgICYmICFoYXNIaWRkZW5EZXNjZW5kYW50KHNvdXJjZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbGxlY3RTdWJ0cmVlSWRzKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZ1tdIHtcclxuICAgIHJldHVybiBbbm9kZS5pZCwgLi4ubm9kZS5jaGlsZHJlbi5mbGF0TWFwKGNvbGxlY3RTdWJ0cmVlSWRzKV07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZvbGRQbGFuKGtpbmQ6IFZpc3VhbEZvbGRQbGFuWydraW5kJ10sIHNvdXJjZTogRmlnbWFOb2RlKTogVmlzdWFsRm9sZFBsYW4ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBraW5kLFxyXG4gICAgICAgIHNvdXJjZU5vZGVJZDogc291cmNlLmlkLFxyXG4gICAgICAgIGFic29yYmVkTm9kZUlkczogY29sbGVjdFN1YnRyZWVJZHMoc291cmNlKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNhblVzZUNoaWxkQXNTcHJpdGUoXHJcbiAgICBjaGlsZDogRmlnbWFOb2RlLFxyXG4gICAgZGVjaXNpb25zOiBSZWFkb25seU1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPixcclxuKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IHJlc29sdmVkRGVjaXNpb24oY2hpbGQsIGRlY2lzaW9ucyk7XHJcbiAgICByZXR1cm4gZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJyB8fCBkZWNpc2lvbi5uaW5lU2xpY2U7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN1YnRyZWVIYXNFeHBsaWNpdENvbmZsaWN0KFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgZGVjaXNpb25zOiBSZWFkb25seU1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPixcclxuKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IHJlc29sdmVkRGVjaXNpb24obm9kZSwgZGVjaXNpb25zKTtcclxuICAgIHJldHVybiBkZWNpc2lvbi5leHBsaWNpdCA9PT0gdHJ1ZVxyXG4gICAgICAgIHx8IEJvb2xlYW4oZGVjaXNpb24ubmFtZSlcclxuICAgICAgICB8fCBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBzdWJ0cmVlSGFzRXhwbGljaXRDb25mbGljdChjaGlsZCwgZGVjaXNpb25zKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN1YnRyZWVIYXNTbGljZUJvdW5kYXJ5KFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgZGVjaXNpb25zOiBSZWFkb25seU1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPixcclxuKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbihyZXNvbHZlZERlY2lzaW9uKG5vZGUsIGRlY2lzaW9ucykubmluZVNsaWNlKVxyXG4gICAgICAgIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpXHJcbiAgICAgICAgfHwgaXNQYXRjaENhbmRpZGF0ZShub2RlKVxyXG4gICAgICAgIHx8IG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHN1YnRyZWVIYXNTbGljZUJvdW5kYXJ5KGNoaWxkLCBkZWNpc2lvbnMpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZml4TWVyZ2VDb25mbGljdChcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIGRlY2lzaW9uczogUmVhZG9ubHlNYXA8c3RyaW5nLCBJbXBvcnREZWNpc2lvbj4sXHJcbik6ICdwcmVmaXgtbWVyZ2Utc2xpY2UtY29uZmxpY3QnIHwgJ3ByZWZpeC1tZXJnZS1vdmVycmlkZS1jb25mbGljdCcgfCB1bmRlZmluZWQge1xyXG4gICAgaWYgKG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHN1YnRyZWVIYXNFeHBsaWNpdENvbmZsaWN0KGNoaWxkLCBkZWNpc2lvbnMpKSkge1xyXG4gICAgICAgIHJldHVybiAncHJlZml4LW1lcmdlLW92ZXJyaWRlLWNvbmZsaWN0JztcclxuICAgIH1cclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBzdWJ0cmVlSGFzU2xpY2VCb3VuZGFyeShjaGlsZCwgZGVjaXNpb25zKSlcclxuICAgICAgICA/ICdwcmVmaXgtbWVyZ2Utc2xpY2UtY29uZmxpY3QnXHJcbiAgICAgICAgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXNvbHZlIGF1dG9tYXRpYyByZXNvdXJjZSBib3VuZGFyaWVzIGJlZm9yZSBjb2xsZWN0aW5nIGFzc2V0cyBhbmQgYnVpbGRpbmdcclxuICogc2NlbmUgc3BlY3MuIERlc2NlbmRhbnQgb3ZlcnJpZGVzIGFuZCBpbmRlcGVuZGVudCBzbGljZXMgbXVzdCBuZXZlciBiZSBsb3N0XHJcbiAqIHRvIHRoZSBuYW1pbmcgZGVmYXVsdC4gVGhlIGlucHV0IG1hcCBhbmQgRmlnbWEgbm9kZXMgcmVtYWluIHVudG91Y2hlZC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQXV0b21hdGljTWVyZ2VEZWNpc2lvbnMoXHJcbiAgICByb290czogRmlnbWFOb2RlW10sXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4pOiBNYXA8c3RyaW5nLCBJbXBvcnREZWNpc2lvbj4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbmV3IE1hcChkZWNpc2lvbnMpO1xyXG4gICAgY29uc3QgdmlzaXQgPSAobm9kZTogRmlnbWFOb2RlLCBpc1Jvb3Q6IGJvb2xlYW4pOiB2b2lkID0+IHtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbiA9IHJlc29sdmVkRGVjaXNpb24obm9kZSwgcmVzdWx0KTtcclxuICAgICAgICBpZiAobm9kZS5wcmVmYWJOYW1lPy50cmltKCkpIHtcclxuICAgICAgICAgICAgcmVzdWx0LnNldChub2RlLmlkLCBub3JtYWxpemVQcmVmYWJEZWNpc2lvbihkZWNpc2lvbiwgbm9kZS5wcmVmYWJOYW1lKSk7XHJcbiAgICAgICAgfSBlbHNlIGlmICghZGVjaXNpb24uZXhwbGljaXQgJiYgZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJyAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICd0cmFuc2Zvcm0nXHJcbiAgICAgICAgICAgICYmIG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHN1YnRyZWVIYXNQcmVmYWJCb3VuZGFyeShjaGlsZCwgcmVzdWx0KSkpIHtcclxuICAgICAgICAgICAgcmVzdWx0LnNldChub2RlLmlkLCB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdnZW5lcmF0ZScsIG5pbmVTbGljZTogZmFsc2UgfSk7XHJcbiAgICAgICAgfSBlbHNlIGlmIChub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICAgICAmJiBpc01lcmdlZFJlc291cmNlTmFtZShub2RlLm5hbWUpXHJcbiAgICAgICAgICAgICYmICFkZWNpc2lvbi5leHBsaWNpdFxyXG4gICAgICAgICAgICAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnXHJcbiAgICAgICAgICAgICYmIGRlY2lzaW9uLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybSdcclxuICAgICAgICAgICAgLy8gUmVhbCBtYXNrIGdyb3VwcyBoYXZlIGFscmVhZHkgYmVlbiByZXNvbHZlZCBieSB0aGUgbWFzayBwbGFubmVyXHJcbiAgICAgICAgICAgIC8vIHRvIGVpdGhlciBhIHNhZmUgYmFzZSt0aW50IG9yIGEgd2hvbGUgY29tcG9zaXRlIGZhbGxiYWNrLlxyXG4gICAgICAgICAgICAmJiAhbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gY2hpbGQuaXNNYXNrKVxyXG4gICAgICAgICAgICAmJiAhZGVjaXNpb24ubmluZVNsaWNlXHJcbiAgICAgICAgICAgICYmICFoYXNNYW51YWxFeHBvcnQobm9kZSlcclxuICAgICAgICAgICAgJiYgIWlzTmFtZWRTbGljZUdyb3VwKG5vZGUpXHJcbiAgICAgICAgICAgICYmICFpc1BhdGNoQ2FuZGlkYXRlKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIHJlc3VsdC5zZXQobm9kZS5pZCwge1xyXG4gICAgICAgICAgICAgICAgLi4uZGVjaXNpb24sXHJcbiAgICAgICAgICAgICAgICBhY3Rpb246IGlzUm9vdCB8fCBwcmVmaXhNZXJnZUNvbmZsaWN0KG5vZGUsIHJlc3VsdCkgPyAnZ2VuZXJhdGUnIDogJ3JlbmRlcicsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHJlc3VsdC5zZXQobm9kZS5pZCwgZGVjaXNpb24pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiB2aXNpdChjaGlsZCwgZmFsc2UpKTtcclxuICAgIH07XHJcbiAgICByb290cy5mb3JFYWNoKChyb290KSA9PiB2aXNpdChyb290LCB0cnVlKSk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBiYXNlUmVhc29uKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgcm9sZTogTm9kZVNlbWFudGljUm9sZSxcclxuICAgIGRlY2lzaW9uOiBJbXBvcnREZWNpc2lvbixcclxuICAgIGlzUm9vdDogYm9vbGVhbixcclxuKTogSW1wb3J0UGxhblJlYXNvbiB7XHJcbiAgICBpZiAoZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJyAmJiBub2RlLnByZWZhYk5hbWU/LnRyaW0oKSkgcmV0dXJuICdwcmVmYWItcmVmZXJlbmNlJztcclxuICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnICYmIGlzUGF0Y2hDYW5kaWRhdGUobm9kZSkpIHJldHVybiAnc2xpY2UtcmVzb3VyY2UnO1xyXG4gICAgaWYgKGRlY2lzaW9uLmV4cGxpY2l0KSByZXR1cm4gJ3VzZXItb3ZlcnJpZGUnO1xyXG4gICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHJldHVybiAnaWdub3JlZCc7XHJcbiAgICBpZiAoaXNSb290KSByZXR1cm4gJ3Jvb3Qtc3RydWN0dXJlJztcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykgcmV0dXJuICdlZGl0YWJsZS10ZXh0JztcclxuICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkgfHwgaXNQYXRjaENhbmRpZGF0ZShub2RlKSkgcmV0dXJuICdzbGljZS1yZXNvdXJjZSc7XHJcbiAgICBpZiAoaGFzTWFudWFsRXhwb3J0KG5vZGUpKSByZXR1cm4gJ21hbnVhbC1leHBvcnQnO1xyXG4gICAgaWYgKGlzTWVyZ2VkUmVzb3VyY2VOYW1lKG5vZGUubmFtZSkpIHtcclxuICAgICAgICByZXR1cm4gZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJyA/ICdwcmVmaXgtbWVyZ2UnIDogJ2RlZmF1bHQtZ2VuZXJhdGUnO1xyXG4gICAgfVxyXG4gICAgaWYgKFsncGFuZWwnLCAnbGlzdCcsICdsYXlvdXQnLCAnYnV0dG9uJywgJ3ZpZXcnLCAnY29udGVudCddLmluY2x1ZGVzKHJvbGUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdzZW1hbnRpYy1jb250YWluZXInO1xyXG4gICAgfVxyXG4gICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcicpIHJldHVybiAndmlzdWFsLWZhbGxiYWNrJztcclxuICAgIHJldHVybiAnZGVmYXVsdC1nZW5lcmF0ZSc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBsYW5uZWRLaW5kRm9yRW1wdHlUZXh0SG9zdChcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIHJvbGU6IE5vZGVTZW1hbnRpY1JvbGUsXHJcbiAgICBkZWNpc2lvbjogSW1wb3J0RGVjaXNpb24sXHJcbiAgICBjaGlsZHJlbjogRmlnbWFOb2RlW10sXHJcbik6IE5vZGVLaW5kIHwgdW5kZWZpbmVkIHtcclxuICAgIGlmIChyb2xlICE9PSAndGV4dCdcclxuICAgICAgICB8fCBjaGlsZHJlbi5sZW5ndGhcclxuICAgICAgICB8fCBkZWNpc2lvbi5hY3Rpb24gIT09ICdnZW5lcmF0ZSdcclxuICAgICAgICB8fCBkZWNpc2lvbi5leHBsaWNpdFxyXG4gICAgICAgIHx8ICFpc1NhZmVWaXN1YWxIb3N0KG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIHJldHVybiAnbGFiZWwnO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXN1YWxGb2xkRm9yTm9kZShcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIHJvbGU6IE5vZGVTZW1hbnRpY1JvbGUsXHJcbiAgICBkZWNpc2lvbjogSW1wb3J0RGVjaXNpb24sXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4pOiB7IGZvbGQ6IFZpc3VhbEZvbGRQbGFuOyBraW5kOiBOb2RlS2luZDsgcmVhc29uOiBJbXBvcnRQbGFuUmVhc29uIH0gfCB1bmRlZmluZWQge1xyXG4gICAgaWYgKG5vZGUucHJlZmFiTmFtZT8udHJpbSgpXHJcbiAgICAgICAgfHwgbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gc3VidHJlZUhhc1ByZWZhYkJvdW5kYXJ5KGNoaWxkLCBkZWNpc2lvbnMpKSkgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IGV4cGxpY2l0S2luZFJlcXVlc3RzRm9sZCA9IGRlY2lzaW9uLmV4cGxpY2l0ID09PSB0cnVlICYmIChcclxuICAgICAgICAocm9sZSA9PT0gJ3RleHQnICYmIChkZWNpc2lvbi5raW5kID09PSAnbGFiZWwnIHx8IGRlY2lzaW9uLmtpbmQgPT09ICdyaWNoVGV4dCcpKVxyXG4gICAgICAgIHx8IChyb2xlID09PSAnaW1hZ2UnICYmIChkZWNpc2lvbi5raW5kID09PSAnc3ByaXRlJyB8fCBkZWNpc2lvbi5raW5kID09PSAnYnV0dG9uJykpXHJcbiAgICAgICAgfHwgKHJvbGUgPT09ICdidXR0b24nICYmIGRlY2lzaW9uLmtpbmQgPT09ICdidXR0b24nKVxyXG4gICAgKTtcclxuICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gIT09ICdnZW5lcmF0ZSdcclxuICAgICAgICB8fCBkZWNpc2lvbi5uaW5lU2xpY2VcclxuICAgICAgICB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKVxyXG4gICAgICAgIHx8IGlzUGF0Y2hDYW5kaWRhdGUobm9kZSlcclxuICAgICAgICB8fCAoZGVjaXNpb24uZXhwbGljaXQgJiYgIWV4cGxpY2l0S2luZFJlcXVlc3RzRm9sZClcclxuICAgICAgICB8fCAhaXNTYWZlVmlzdWFsSG9zdChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjaGlsZHJlbiA9IGVmZmVjdGl2ZUNoaWxkcmVuKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICBpZiAocm9sZSA9PT0gJ3RleHQnICYmIGNoaWxkcmVuLmxlbmd0aCA9PT0gMSkge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkID0gY2hpbGRyZW5bMF07XHJcbiAgICAgICAgaWYgKGNoaWxkLnR5cGUgPT09ICdURVhUJ1xyXG4gICAgICAgICAgICAmJiBjYW5Gb2xkU291cmNlVmlzaWJpbGl0eShub2RlLCBjaGlsZClcclxuICAgICAgICAgICAgJiYgIXN1YnRyZWVIYXNFeHBsaWNpdENvbmZsaWN0KGNoaWxkLCBkZWNpc2lvbnMpXHJcbiAgICAgICAgICAgICYmIGZyYW1lc0VxdWl2YWxlbnQobm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94LCBjaGlsZC5hYnNvbHV0ZUJvdW5kaW5nQm94KVxyXG4gICAgICAgICAgICAmJiB0cmFuc2Zvcm1zRm9sZGFibGUobm9kZSwgY2hpbGQpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBmb2xkOiBmb2xkUGxhbignc2luZ2xlLXRleHQnLCBjaGlsZCksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBkZWNpc2lvbi5raW5kID09PSAncmljaFRleHQnID8gJ3JpY2hUZXh0JyA6ICdsYWJlbCcsXHJcbiAgICAgICAgICAgICAgICByZWFzb246ICdzaW5nbGUtdGV4dC1mb2xkJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAocm9sZSA9PT0gJ2ltYWdlJyAmJiBjaGlsZHJlbi5sZW5ndGggPT09IDEpIHtcclxuICAgICAgICBjb25zdCBjaGlsZCA9IGNoaWxkcmVuWzBdO1xyXG4gICAgICAgIGlmIChjYW5Vc2VDaGlsZEFzU3ByaXRlKGNoaWxkLCBkZWNpc2lvbnMpXHJcbiAgICAgICAgICAgICYmIGNhbkZvbGRTb3VyY2VWaXNpYmlsaXR5KG5vZGUsIGNoaWxkKVxyXG4gICAgICAgICAgICAmJiAhc3VidHJlZUhhc0V4cGxpY2l0Q29uZmxpY3QoY2hpbGQsIGRlY2lzaW9ucylcclxuICAgICAgICAgICAgJiYgZnJhbWVzRXF1aXZhbGVudChub2RlLmFic29sdXRlQm91bmRpbmdCb3gsIGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpXHJcbiAgICAgICAgICAgICYmIHRyYW5zZm9ybXNGb2xkYWJsZShub2RlLCBjaGlsZCkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGZvbGQ6IGZvbGRQbGFuKCdzaW5nbGUtaW1hZ2UnLCBjaGlsZCksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBkZWNpc2lvbi5raW5kID09PSAnYnV0dG9uJyA/ICdidXR0b24nIDogJ3Nwcml0ZScsXHJcbiAgICAgICAgICAgICAgICByZWFzb246ICdzaW5nbGUtaW1hZ2UtZm9sZCcsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKHJvbGUgPT09ICdidXR0b24nICYmIChkZWNpc2lvbi5raW5kID09PSAnYnV0dG9uJyB8fCBkZWNpc2lvbi5raW5kID09PSAnYXV0bycpKSB7XHJcbiAgICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNhblVzZUNoaWxkQXNTcHJpdGUoY2hpbGQsIGRlY2lzaW9ucylcclxuICAgICAgICAgICAgJiYgY2FuRm9sZFNvdXJjZVZpc2liaWxpdHkobm9kZSwgY2hpbGQpXHJcbiAgICAgICAgICAgICYmIGZyYW1lc0VxdWl2YWxlbnQobm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94LCBjaGlsZC5hYnNvbHV0ZUJvdW5kaW5nQm94KVxyXG4gICAgICAgICAgICAmJiB0cmFuc2Zvcm1zRm9sZGFibGUobm9kZSwgY2hpbGQpXHJcbiAgICAgICAgICAgICYmIG9wYWNpdHlJc05ldXRyYWwoY2hpbGQpKTtcclxuICAgICAgICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDFcclxuICAgICAgICAgICAgJiYgY2hpbGRyZW5bMF0gPT09IGNhbmRpZGF0ZXNbMF1cclxuICAgICAgICAgICAgJiYgIXN1YnRyZWVIYXNFeHBsaWNpdENvbmZsaWN0KGNhbmRpZGF0ZXNbMF0sIGRlY2lzaW9ucykpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGZvbGQ6IGZvbGRQbGFuKCdiYWNrZ3JvdW5kJywgY2FuZGlkYXRlc1swXSksXHJcbiAgICAgICAgICAgICAgICBraW5kOiAnYnV0dG9uJyxcclxuICAgICAgICAgICAgICAgIHJlYXNvbjogJ2JhY2tncm91bmQtcHJvbW90aW9uJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG4vKipcclxuICog57yW6K+R5LiA5qyh5a+85YWl5L2/55So55qE5ZSv5LiA6KeE5YiS6KGo44CC6LWE5rqQ5pS26ZuG5a6M5oiQ5ZCO5Y+v5YaN5qyh57yW6K+R77yM5Lul5o6l5pS25pys5Zyw5ZCM5ZCNXHJcbiAqIOi1hOa6kOWvuSBkZWNpc2lvbiDnmoTmj5DljYfvvJtTY2VuZU5vZGVTcGVjIOS4jumdouadv+ivtOaYjumDvea2iOi0ueWQjOS4gOWll+e6r+inhOWImeOAglxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNvbXBpbGVJbXBvcnRQbGFuKFxyXG4gICAgcm9vdHM6IEZpZ21hTm9kZVtdLFxyXG4gICAgZGVjaXNpb25zOiBSZWFkb25seU1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPixcclxuKTogTWFwPHN0cmluZywgTm9kZUltcG9ydFBsYW4+IHtcclxuICAgIGRlY2lzaW9ucyA9IHJlc29sdmVBdXRvbWF0aWNNZXJnZURlY2lzaW9ucyhyb290cywgZGVjaXNpb25zKTtcclxuICAgIGNvbnN0IHBsYW5zID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVJbXBvcnRQbGFuPigpO1xyXG4gICAgY29uc3QgdmlzaXQgPSAobm9kZTogRmlnbWFOb2RlLCBpc1Jvb3Q6IGJvb2xlYW4pID0+IHtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbiA9IHJlc29sdmVkRGVjaXNpb24obm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBjb25zdCByb2xlID0gc2VtYW50aWNSb2xlRm9yTm9kZShub2RlLCBpc1Jvb3QpO1xyXG4gICAgICAgIGNvbnN0IHByZWZhYlJlZmVyZW5jZSA9IGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2lnbm9yZScgJiYgQm9vbGVhbihub2RlLnByZWZhYk5hbWU/LnRyaW0oKSk7XHJcbiAgICAgICAgY29uc3QgcHJlZmFiRGVzY2VuZGFudCA9IG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHN1YnRyZWVIYXNQcmVmYWJCb3VuZGFyeShjaGlsZCwgZGVjaXNpb25zKSk7XHJcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSBlZmZlY3RpdmVDaGlsZHJlbihub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGNvbnN0IGZvbGQgPSB2aXN1YWxGb2xkRm9yTm9kZShub2RlLCByb2xlLCBkZWNpc2lvbiwgZGVjaXNpb25zKTtcclxuICAgICAgICBjb25zdCBlbXB0eVRleHRLaW5kID0gcGxhbm5lZEtpbmRGb3JFbXB0eVRleHRIb3N0KG5vZGUsIHJvbGUsIGRlY2lzaW9uLCBjaGlsZHJlbik7XHJcbiAgICAgICAgY29uc3QgcHJlZml4Q29uZmxpY3QgPSAhaXNSb290XHJcbiAgICAgICAgICAgICYmICFwcmVmYWJSZWZlcmVuY2VcclxuICAgICAgICAgICAgJiYgIXByZWZhYkRlc2NlbmRhbnRcclxuICAgICAgICAgICAgJiYgbm9kZS50eXBlICE9PSAnVEVYVCdcclxuICAgICAgICAgICAgJiYgaXNNZXJnZWRSZXNvdXJjZU5hbWUobm9kZS5uYW1lKVxyXG4gICAgICAgICAgICAmJiAhZGVjaXNpb24uZXhwbGljaXRcclxuICAgICAgICAgICAgJiYgZGVjaXNpb24uYWN0aW9uID09PSAnZ2VuZXJhdGUnXHJcbiAgICAgICAgICAgICYmICFkZWNpc2lvbi5uaW5lU2xpY2VcclxuICAgICAgICAgICAgJiYgIWhhc01hbnVhbEV4cG9ydChub2RlKVxyXG4gICAgICAgICAgICAmJiAhaXNOYW1lZFNsaWNlR3JvdXAobm9kZSlcclxuICAgICAgICAgICAgJiYgIWlzUGF0Y2hDYW5kaWRhdGUobm9kZSlcclxuICAgICAgICAgICAgPyBwcmVmaXhNZXJnZUNvbmZsaWN0KG5vZGUsIGRlY2lzaW9ucylcclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgY29uc3QgcmVhc29uID0gcHJlZmFiRGVzY2VuZGFudCAmJiAhZGVjaXNpb24uZXhwbGljaXQgJiYgZGVjaXNpb24uYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmICFwcmVmYWJSZWZlcmVuY2VcclxuICAgICAgICAgICAgPyAnZGVmYXVsdC1nZW5lcmF0ZSdcclxuICAgICAgICAgICAgOiBmb2xkPy5yZWFzb24gPz8gcHJlZml4Q29uZmxpY3RcclxuICAgICAgICAgICAgICAgID8/IChlbXB0eVRleHRLaW5kID8gJ2VkaXRhYmxlLXRleHQnIDogYmFzZVJlYXNvbihub2RlLCByb2xlLCBkZWNpc2lvbiwgaXNSb290KSk7XHJcbiAgICAgICAgcGxhbnMuc2V0KG5vZGUuaWQsIHtcclxuICAgICAgICAgICAgbm9kZUlkOiBub2RlLmlkLFxyXG4gICAgICAgICAgICByb2xlLFxyXG4gICAgICAgICAgICByZWFzb24sXHJcbiAgICAgICAgICAgIGtpbmQ6IHByZWZhYlJlZmVyZW5jZSA/ICdub2RlJyA6IGZvbGQ/LmtpbmQgPz8gZW1wdHlUZXh0S2luZCxcclxuICAgICAgICAgICAgZm9sZDogZm9sZD8uZm9sZCxcclxuICAgICAgICAgICAgd2FybmluZzogcHJlZmFiUmVmZXJlbmNlXHJcbiAgICAgICAgICAgICAgICA/IGDlvJXnlKjpobnnm64gUHJlZmFi4oCcJHtub2RlLnByZWZhYk5hbWV94oCd77yMJHtub2RlLnByZWZhYk5hbWUhLnJlcGxhY2UoL1xcLnByZWZhYiQvaSwgJycpLm5vcm1hbGl6ZSgnTkZLQycpLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpID09PSAncG9wdXAnID8gJ+aMiSBGaWdtYSDosIPmlbTlrr3pq5gnIDogJ+WunuS+i+S/neaMgeWOn+WwuuWvuCd977yb5LiN5a+85YWl5q2k6IqC54K555qE5Y6f5aeL5YaF5a655Y+K5a2Q5qCRYFxyXG4gICAgICAgICAgICAgICAgOiBwcmVmYWJEZXNjZW5kYW50ICYmICFkZWNpc2lvbi5leHBsaWNpdCAmJiBkZWNpc2lvbi5hY3Rpb24gPT09ICdnZW5lcmF0ZSdcclxuICAgICAgICAgICAgICAgICAgICA/ICflhoXpg6jlrZjlnKggUHJlZmFiIOW8leeUqO+8jOaZuuiDveaooeW8j+S/neeVmeiKgueCuee7k+aehO+8jOS4jeiHquWKqOWQiOW5tuS4uuWbvueJhydcclxuICAgICAgICAgICAgICAgIDogIWZvbGQgJiYgcHJlZml4Q29uZmxpY3RcclxuICAgICAgICAgICAgICAgID8gaW1wb3J0UGxhblJlYXNvblRleHQocHJlZml4Q29uZmxpY3QpXHJcbiAgICAgICAgICAgICAgICA6IHJlYXNvbiA9PT0gJ3ByZWZpeC1tZXJnZSdcclxuICAgICAgICAgICAgICAgICAgICA/ICdpY29uXy9pbWdfIOWJjee8gOaMiSBQTkcg5pW05bGC5ZCI5bm277yM6YeH55So5b2T5YmN5pi+6ZqQ5ZCI5oiQ77yb6ZqQ6JeP5a2Q5bGC5LiN55Sf5oiQ54us56uL6IqC54K5J1xyXG4gICAgICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBmYWxzZSkpO1xyXG4gICAgfTtcclxuICAgIHJvb3RzLmZvckVhY2goKHJvb3QpID0+IHZpc2l0KHJvb3QsIHRydWUpKTtcclxuICAgIHJldHVybiBwbGFucztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuKFxyXG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXSxcclxuICAgIHBsYW5zOiBSZWFkb25seU1hcDxzdHJpbmcsIE5vZGVJbXBvcnRQbGFuPixcclxuKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gdHJlZS5tYXAoKG5vZGUpID0+IHtcclxuICAgICAgICBjb25zdCBwbGFuID0gcGxhbnMuZ2V0KG5vZGUuaWQpO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIC4uLm5vZGUsXHJcbiAgICAgICAgICAgIHJlYXNvbjogcGxhbj8ucmVhc29uLFxyXG4gICAgICAgICAgICB3YXJuaW5nOiBub2RlLndhcm5pbmcgJiYgcGxhbj8ud2FybmluZyAmJiBub2RlLndhcm5pbmcuaW5jbHVkZXMocGxhbi53YXJuaW5nKVxyXG4gICAgICAgICAgICAgICAgPyBub2RlLndhcm5pbmdcclxuICAgICAgICAgICAgICAgIDogWy4uLm5ldyBTZXQoW25vZGUud2FybmluZywgcGxhbj8ud2FybmluZ10uZmlsdGVyKEJvb2xlYW4pKV0uam9pbign77ybJykgfHwgdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICBmb2xkOiBwbGFuPy5mb2xkPy5raW5kLFxyXG4gICAgICAgICAgICBhYnNvcmJlZE5vZGVJZHM6IHBsYW4/LmZvbGQ/LmFic29yYmVkTm9kZUlkcyxcclxuICAgICAgICAgICAgY2hpbGRyZW46IGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuKG5vZGUuY2hpbGRyZW4sIHBsYW5zKSxcclxuICAgICAgICB9O1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbXBvcnRQbGFuUmVhc29uVGV4dChyZWFzb246IEltcG9ydFBsYW5SZWFzb24gfCB1bmRlZmluZWQpOiBzdHJpbmcge1xyXG4gICAgc3dpdGNoIChyZWFzb24pIHtcclxuICAgICAgICBjYXNlICdpZ25vcmVkJzogcmV0dXJuICfoioLngrnnrZbnlaXorr7kuLrlv73nlaXvvIzkuI3lr7zlhaUnO1xyXG4gICAgICAgIGNhc2UgJ3ByZWZhYi1yZWZlcmVuY2UnOiByZXR1cm4gJ+W8leeUqOmhueebruW3suaciSBQcmVmYWInO1xyXG4gICAgICAgIGNhc2UgJ3Jvb3Qtc3RydWN0dXJlJzogcmV0dXJuICfkv53nlZnkuLogUHJlZmFiIOaguee7k+aehCc7XHJcbiAgICAgICAgY2FzZSAnbWFudWFsLWV4cG9ydCc6IHJldHVybiAn5qOA5rWL5YiwIEZpZ21hIEV4cG9ydO+8jOaMieaVtOWxgui1hOa6kOWvvOWFpSc7XHJcbiAgICAgICAgY2FzZSAnc2xpY2UtcmVzb3VyY2UnOiByZXR1cm4gJ+ivhuWIq+S4uuS4iS/kuZ3lrqvotYTmupAnO1xyXG4gICAgICAgIGNhc2UgJ3ByZWZpeC1tZXJnZSc6IHJldHVybiAnaWNvbl8vaW1nXyDliY3nvIDpu5jorqTlkIjlubbkuLrljZXkuKrotYTmupAnO1xyXG4gICAgICAgIGNhc2UgJ3ByZWZpeC1tZXJnZS1zbGljZS1jb25mbGljdCc6IHJldHVybiAn5YmN57yA5ZCI5bm25bey5Zue6YCA77ya5YaF6YOo5a2Y5Zyo54us56uL5LiJL+S5neWuq+i1hOa6kO+8jOS/neeVmeWFtue7k+aehOS4juWIh+eJh+iDveWKmyc7XHJcbiAgICAgICAgY2FzZSAncHJlZml4LW1lcmdlLW92ZXJyaWRlLWNvbmZsaWN0JzogcmV0dXJuICfliY3nvIDlkIjlubblt7Llm57pgIDvvJrlrZDlsYLlrZjlnKjmiYvliqjnrZbnlaXmiJblkb3lkI3vvIzkv53nlZnni6znq4vlrZDoioLngrknO1xyXG4gICAgICAgIGNhc2UgJ3NlbWFudGljLWNvbnRhaW5lcic6IHJldHVybiAn5L+d55WZIENvY29zIOi/kOihjOaXtuivreS5ieWuueWZqCc7XHJcbiAgICAgICAgY2FzZSAnZWRpdGFibGUtdGV4dCc6IHJldHVybiAn5L+d55WZ5Li65Y+v57yW6L6R5paH5a2XJztcclxuICAgICAgICBjYXNlICdzaW5nbGUtaW1hZ2UtZm9sZCc6IHJldHVybiAn5Y2V5LiA5Zu+54mH5a2Q5bGC5o+Q5Y2H5Yiw54i26IqC54K5JztcclxuICAgICAgICBjYXNlICdzaW5nbGUtdGV4dC1mb2xkJzogcmV0dXJuICfljZXkuIDmloflrZflrZDlsYLmj5DljYfliLDniLboioLngrknO1xyXG4gICAgICAgIGNhc2UgJ2JhY2tncm91bmQtcHJvbW90aW9uJzogcmV0dXJuICfog4zmma/otYTmupDmj5DljYfliLDniLboioLngrnvvIzkv53nlZnlhoXlrrnlrZDlsYInO1xyXG4gICAgICAgIGNhc2UgJ3Zpc3VhbC1mYWxsYmFjayc6IHJldHVybiAn57qv6KeG6KeJ5YaF5a655oyJIFBORyDlr7zlhaUnO1xyXG4gICAgICAgIGNhc2UgJ3VzZXItb3ZlcnJpZGUnOiByZXR1cm4gJ+mHh+eUqOaJi+WKqOiKgueCueetlueVpSc7XHJcbiAgICAgICAgY2FzZSAnZGVmYXVsdC1nZW5lcmF0ZSc6IHJldHVybiAn5oyJ5Y+v57yW6L6R6IqC54K557uT5p6E55Sf5oiQJztcclxuICAgICAgICBkZWZhdWx0OiByZXR1cm4gJyc7XHJcbiAgICB9XHJcbn1cclxuIl19