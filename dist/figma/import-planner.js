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
                ? `引用项目 Prefab“${node.prefabName}”，${(0, import_actions_1.prefabUsesFigmaSize)(node.prefabName) ? '按 Figma 调整宽高' : '按 Figma 实例相对母组件的倍率缩放'}；不导入此节点的原始内容及子树`
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1wb3J0LXBsYW5uZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvZmlnbWEvaW1wb3J0LXBsYW5uZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUErQ0Esa0RBNEJDO0FBY0Qsa0VBR0M7QUFHRCwwREFHQztBQW1KRCx3RUFtQ0M7QUFtSEQsOENBbURDO0FBRUQsZ0VBaUJDO0FBRUQsb0RBb0JDO0FBNWRELHlDQU9vQjtBQUNwQixzREFBbUc7QUFFbkcsTUFBTSxlQUFlLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDNUIsVUFBVTtJQUNWLFFBQVE7SUFDUixPQUFPO0lBQ1AsT0FBTztJQUNQLFNBQVM7SUFDVCxXQUFXO0lBQ1gsZUFBZTtJQUNmLFVBQVU7Q0FDYixDQUFDLENBQUM7QUFFSCxNQUFNLGlCQUFpQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQzlCLHNCQUFzQjtJQUN0QixvQkFBb0I7SUFDcEIsbUNBQW1DO0lBQ25DLFlBQVk7SUFDWixVQUFVO0lBQ1YsTUFBTTtDQUNULENBQUMsQ0FBQztBQUVILE1BQU0sV0FBVyxHQUFHLGlGQUFpRixDQUFDO0FBRXRHLFNBQVMsY0FBYyxDQUFDLElBQTZCO0lBQ2pELE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDOUMsQ0FBQztBQUVELFNBQWdCLG1CQUFtQixDQUMvQixJQUE2QixFQUM3QixNQUFNLEdBQUcsS0FBSztJQUVkLElBQUksTUFBTSxFQUFFLENBQUM7UUFDVCxPQUFPLE1BQU0sQ0FBQztJQUNsQixDQUFDO0lBQ0QsTUFBTSxJQUFJLEdBQUcsY0FBYyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2xDLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM5QyxJQUFJLEtBQUssS0FBSyxNQUFNO1FBQUUsT0FBTyxNQUFNLENBQUM7SUFDcEMs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QUVELFNBQWdCLG9CQUFvQixDQUFDLE1BQW9DO0lBQ3JFLFFBQVEsTUFBTSxFQUFFLENBQUM7UUFDYixLQUFLLFNBQVMsQ0FBQyxDQUFDLE9BQU8sY0FBYyxDQUFDO1FBQ3RDLEtBQUssa0JBQWtCLENBQUMsQ0FBQyxPQUFPLGVBQWUsQ0FBQztRQUNoRCxLQUFLLGdCQUFnQixDQUFDLENBQUMsT0FBTyxnQkFBZ0IsQ0FBQztRQUMvQyxLQUFLLGVBQWUsQ0FBQyxDQUFDLE9BQU8sMEJBQTBCLENBQUM7UUFDeEQsS0FBSyxnQkFBZ0IsQ0FBQyxDQUFDLE9BQU8sV0FBVyxDQUFDO1FBQzFDLEtBQUssY0FBYyxDQUFDLENBQUMsT0FBTyx3QkFBd0IsQ0FBQztRQUNyRCxLQUFLLDZCQUE2QixDQUFDLENBQUMsT0FBTyxpQ0FBaUMsQ0FBQztRQUM3RSxLQUFLLGdDQUFnQyxDQUFDLENBQUMsT0FBTyw2QkFBNkIsQ0FBQztRQUM1RSxLQUFLLG9CQUFvQixDQUFDLENBQUMsT0FBTyxrQkFBa0IsQ0FBQztRQUNyRCxLQUFLLGVBQWUsQ0FBQyxDQUFDLE9BQU8sVUFBVSxDQUFDO1FBQ3hDLEtBQUssbUJBQW1CLENBQUMsQ0FBQyxPQUFPLGNBQWMsQ0FBQztRQUNoRCxLQUFLLGtCQUFrQixDQUFDLENBQUMsT0FBTyxjQUFjLENBQUM7UUFDL0MsS0FBSyxzQkFBc0IsQ0FBQyxDQUFDLE9BQU8sbUJBQW1CLENBQUM7UUFDeEQsS0FBSyxpQkFBaUIsQ0FBQyxDQUFDLE9BQU8sZUFBZSxDQUFDO1FBQy9DLEtBQUssZUFBZSxDQUFDLENBQUMsT0FBTyxVQUFVLENBQUM7UUFDeEMsS0FBSyxrQkFBa0IsQ0FBQyxDQUFDLE9BQU8sWUFBWSxDQUFDO1FBQzdDLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDO0lBQ3ZCLENBQUM7QUFDTCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUge1xyXG4gICAgRmlnbWFOb2RlLFxyXG4gICAgSW1wb3J0RGVjaXNpb24sXHJcbiAgICBJbXBvcnRQbGFuUmVhc29uLFxyXG4gICAgTm9kZUltcG9ydFBsYW4sXHJcbiAgICBOb2RlS2luZCxcclxuICAgIE5vZGVTZW1hbnRpY1JvbGUsXHJcbiAgICBSZWN0LFxyXG4gICAgVHJlZU5vZGVEdG8sXHJcbiAgICBWaXN1YWxGb2xkUGxhbixcclxufSBmcm9tICcuLi90eXBlcyc7XHJcbmltcG9ydCB7XHJcbiAgICBoYXNIaWRkZW5EZXNjZW5kYW50LFxyXG4gICAgaGFzTWFudWFsRXhwb3J0LFxyXG4gICAgaW5mZXJBY3Rpb24sXHJcbiAgICBpbmZlcktpbmQsXHJcbiAgICBpc05hbWVkU2xpY2VHcm91cCxcclxuICAgIGlzUGF0Y2hDYW5kaWRhdGUsXHJcbn0gZnJvbSAnLi9hbmFseXplcic7XHJcbmltcG9ydCB7IGlzTWVyZ2VkUmVzb3VyY2VOYW1lLCBraW5kRm9ySW1wb3J0QWN0aW9uLCBwcmVmYWJVc2VzRmlnbWFTaXplIH0gZnJvbSAnLi4vaW1wb3J0LWFjdGlvbnMnO1xyXG5cclxuY29uc3QgQ09OVEFJTkVSX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnRE9DVU1FTlQnLFxyXG4gICAgJ0NBTlZBUycsXHJcbiAgICAnRlJBTUUnLFxyXG4gICAgJ0dST1VQJyxcclxuICAgICdTRUNUSU9OJyxcclxuICAgICdDT01QT05FTlQnLFxyXG4gICAgJ0NPTVBPTkVOVF9TRVQnLFxyXG4gICAgJ0lOU1RBTkNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBTQ1JPTExfRElSRUNUSU9OUyA9IG5ldyBTZXQoW1xyXG4gICAgJ0hPUklaT05UQUxfU0NST0xMSU5HJyxcclxuICAgICdWRVJUSUNBTF9TQ1JPTExJTkcnLFxyXG4gICAgJ0hPUklaT05UQUxfQU5EX1ZFUlRJQ0FMX1NDUk9MTElORycsXHJcbiAgICAnSE9SSVpPTlRBTCcsXHJcbiAgICAnVkVSVElDQUwnLFxyXG4gICAgJ0JPVEgnLFxyXG5dKTtcclxuXHJcbmNvbnN0IFJPTEVfUFJFRklYID0gL14ocGFuZWx8bGlzdHxsYXlvdXR8YnRufGJ1dHRvbnxpbWd8aW1hZ2V8aWNvbnxiZ3xzcHJpdGV8dHh0fHRleHR8bGFiZWwpKD86X3wkKS9pO1xyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplZE5hbWUobm9kZTogUGljazxGaWdtYU5vZGUsICduYW1lJz4pOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIG5vZGUubmFtZS50cmltKCkubm9ybWFsaXplKCdORktDJyk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzZW1hbnRpY1JvbGVGb3JOb2RlKFxyXG4gICAgbm9kZTogUGljazxGaWdtYU5vZGUsICduYW1lJz4sXHJcbiAgICBpc1Jvb3QgPSBmYWxzZSxcclxuKTogTm9kZVNlbWFudGljUm9sZSB7XHJcbiAgICBpZiAoaXNSb290KSB7XHJcbiAgICAgICAgcmV0dXJuICdyb290JztcclxuICAgIH1cclxuICAgIGNvbnN0IG5hbWUgPSBub3JtYWxpemVkTmFtZShub2RlKTtcclxuICAgIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgIGlmIChsb3dlciA9PT0gJ3ZpZXcnKSByZXR1cm4gJ3ZpZXcnO1xyXG4gICAgaWYgKGxvd2VyID09PSAnY29udGVudCcpIHJldHVybiAnY29udGVudCc7XHJcbiAgICBjb25zdCBtYXRjaCA9IFJPTEVfUFJFRklYLmV4ZWMobG93ZXIpO1xyXG4gICAgc3dpdGNoIChtYXRjaD8uWzFdKSB7XHJcbiAgICAgICAgY2FzZSAncGFuZWwnOiByZXR1cm4gJ3BhbmVsJztcclxuICAgICAgICBjYXNlICdsaXN0JzogcmV0dXJuICdsaXN0JztcclxuICAgICAgICBjYXNlICdsYXlvdXQnOiByZXR1cm4gJ2xheW91dCc7XHJcbiAgICAgICAgY2FzZSAnYnRuJzpcclxuICAgICAgICBjYXNlICdidXR0b24nOiByZXR1cm4gJ2J1dHRvbic7XHJcbiAgICAgICAgY2FzZSAnaW1nJzpcclxuICAgICAgICBjYXNlICdpbWFnZSc6XHJcbiAgICAgICAgY2FzZSAnaWNvbic6XHJcbiAgICAgICAgY2FzZSAnYmcnOlxyXG4gICAgICAgIGNhc2UgJ3Nwcml0ZSc6IHJldHVybiAnaW1hZ2UnO1xyXG4gICAgICAgIGNhc2UgJ3R4dCc6XHJcbiAgICAgICAgY2FzZSAndGV4dCc6XHJcbiAgICAgICAgY2FzZSAnbGFiZWwnOiByZXR1cm4gJ3RleHQnO1xyXG4gICAgICAgIGRlZmF1bHQ6IHJldHVybiAndW5rbm93bic7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlZmF1bHREZWNpc2lvbihub2RlOiBGaWdtYU5vZGUpOiBJbXBvcnREZWNpc2lvbiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGFjdGlvbjogaW5mZXJBY3Rpb24obm9kZSksXHJcbiAgICAgICAga2luZDogaW5mZXJLaW5kKG5vZGUpLFxyXG4gICAgICAgIG5pbmVTbGljZTogaXNQYXRjaENhbmRpZGF0ZShub2RlKSxcclxuICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICB9O1xyXG59XHJcblxyXG4vKiogVmFsaWQgRmlnbWEgc2xpY2UgZ2VvbWV0cnkgb3ducyBpdHMgc3RyYXRlZ3k7IGlnbm9yaW5nIHRoZSBub2RlIHN0aWxsIHdpbnMuXHJcbiAqIFRoZSByZW5kZXJlciBzdXBwbGllcyBpdHMgYW5hbHl6ZWQgcGF0Y2hDYW5kaWRhdGUgaW5zdGVhZCBvZiByZS1yZWFkaW5nIGdlb21ldHJ5LlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbjxUIGV4dGVuZHMgSW1wb3J0RGVjaXNpb24+KGRlY2lzaW9uOiBULCBoYXNGaWdtYVNsaWNlOiBib29sZWFuKTogVCB7XHJcbiAgICBpZiAoIWhhc0ZpZ21hU2xpY2UgfHwgZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuIGRlY2lzaW9uO1xyXG4gICAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIGtpbmQ6IGtpbmRGb3JJbXBvcnRBY3Rpb24oZGVjaXNpb24ua2luZCwgJ3JlbmRlcicsIHRydWUpLCBuaW5lU2xpY2U6IHRydWUgfTtcclxufVxyXG5cclxuLyoqIEFuIGV4cGxpY2l0IFByZWZhYiBwYXJhbWV0ZXIgb3ducyB0aGUgYm91bmRhcnk7IGlnbm9yaW5nIHN0aWxsIHdpbnMuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVQcmVmYWJEZWNpc2lvbjxUIGV4dGVuZHMgSW1wb3J0RGVjaXNpb24+KGRlY2lzaW9uOiBULCBwcmVmYWJOYW1lPzogc3RyaW5nKTogVCB7XHJcbiAgICBpZiAoIXByZWZhYk5hbWU/LnRyaW0oKSB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSByZXR1cm4gZGVjaXNpb247XHJcbiAgICByZXR1cm4geyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAnZ2VuZXJhdGUnLCBraW5kOiAnbm9kZScsIG5pbmVTbGljZTogZmFsc2UgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzb2x2ZWREZWNpc2lvbihcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIGRlY2lzaW9uczogUmVhZG9ubHlNYXA8c3RyaW5nLCBJbXBvcnREZWNpc2lvbj4sXHJcbik6IEltcG9ydERlY2lzaW9uIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKSA/PyBkZWZhdWx0RGVjaXNpb24obm9kZSk7XHJcbiAgICByZXR1cm4gbm9kZS5wcmVmYWJOYW1lPy50cmltKClcclxuICAgICAgICA/IG5vcm1hbGl6ZVByZWZhYkRlY2lzaW9uKGRlY2lzaW9uLCBub2RlLnByZWZhYk5hbWUpXHJcbiAgICAgICAgOiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oZGVjaXNpb24sIGlzUGF0Y2hDYW5kaWRhdGUobm9kZSkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzdWJ0cmVlSGFzUHJlZmFiQm91bmRhcnkobm9kZTogRmlnbWFOb2RlLCBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+KTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCkgPz8gZGVmYXVsdERlY2lzaW9uKG5vZGUpO1xyXG4gICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHJldHVybiBmYWxzZTtcclxuICAgIGlmIChub2RlLnByZWZhYk5hbWU/LnRyaW0oKSkgcmV0dXJuIHRydWU7XHJcbiAgICAvLyBBIGRlbGliZXJhdGUgYW5jZXN0b3IgdGVybWluYWwgc3RyYXRlZ3kgb3ducyBpdHMgZW50aXJlIHN1YnRyZWUuXHJcbiAgICBpZiAoZGVjaXNpb24uZXhwbGljaXQgJiYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcicgfHwgZGVjaXNpb24uYWN0aW9uID09PSAndHJhbnNmb3JtJykpIHJldHVybiBmYWxzZTtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBzdWJ0cmVlSGFzUHJlZmFiQm91bmRhcnkoY2hpbGQsIGRlY2lzaW9ucykpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlUGFpbnRzKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgaGFzRmlsbCA9IG5vZGUuZmlsbHMuc29tZSgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNTdHJva2UgPSBub2RlLnN0cm9rZVdlaWdodCA+IDBcclxuICAgICAgICAmJiBub2RlLnN0cm9rZXMuc29tZSgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNFZmZlY3QgPSBub2RlLmVmZmVjdHMuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpO1xyXG4gICAgcmV0dXJuIGhhc0ZpbGwgfHwgaGFzU3Ryb2tlIHx8IGhhc0VmZmVjdDtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzUnVudGltZUNvbnRhaW5lckJlaGF2aW9yKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3Qgb3ZlcmZsb3cgPSBub2RlLm92ZXJmbG93RGlyZWN0aW9uPy50cmltKCkudG9VcHBlckNhc2UoKSA/PyAnJztcclxuICAgIHJldHVybiBub2RlLmNsaXBzQ29udGVudFxyXG4gICAgICAgIHx8IFNDUk9MTF9ESVJFQ1RJT05TLmhhcyhvdmVyZmxvdylcclxuICAgICAgICB8fCBCb29sZWFuKG5vZGUubGF5b3V0TW9kZSAmJiBub2RlLmxheW91dE1vZGUgIT09ICdOT05FJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzU2FmZVZpc3VhbEhvc3Qobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpXHJcbiAgICAgICAgJiYgIXZpc2libGVQYWludHMobm9kZSlcclxuICAgICAgICAmJiAhaGFzUnVudGltZUNvbnRhaW5lckJlaGF2aW9yKG5vZGUpXHJcbiAgICAgICAgJiYgKCFub2RlLmJsZW5kTW9kZSB8fCBub2RlLmJsZW5kTW9kZSA9PT0gJ05PUk1BTCcgfHwgbm9kZS5ibGVuZE1vZGUgPT09ICdQQVNTX1RIUk9VR0gnKTtcclxufVxyXG5cclxuY29uc3QgR0VPTUVUUllfRVBTSUxPTiA9IDAuMDAwMTtcclxuXHJcbmZ1bmN0aW9uIGZyYW1lc0VxdWl2YWxlbnQocGFyZW50OiBSZWN0IHwgdW5kZWZpbmVkLCBjaGlsZDogUmVjdCB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFwYXJlbnQgfHwgIWNoaWxkKSByZXR1cm4gZmFsc2U7XHJcbiAgICByZXR1cm4gTWF0aC5hYnMocGFyZW50LnggLSBjaGlsZC54KSA8PSBHRU9NRVRSWV9FUFNJTE9OXHJcbiAgICAgICAgJiYgTWF0aC5hYnMocGFyZW50LnkgLSBjaGlsZC55KSA8PSBHRU9NRVRSWV9FUFNJTE9OXHJcbiAgICAgICAgJiYgTWF0aC5hYnMocGFyZW50LndpZHRoIC0gY2hpbGQud2lkdGgpIDw9IEdFT01FVFJZX0VQU0lMT05cclxuICAgICAgICAmJiBNYXRoLmFicyhwYXJlbnQuaGVpZ2h0IC0gY2hpbGQuaGVpZ2h0KSA8PSBHRU9NRVRSWV9FUFNJTE9OO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNUcmFuc2xhdGlvbk9ubHlUcmFuc2Zvcm0obm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLnJlbGF0aXZlVHJhbnNmb3JtO1xyXG4gICAgaWYgKCF0cmFuc2Zvcm0pIHJldHVybiB0cnVlO1xyXG4gICAgaWYgKHRyYW5zZm9ybS5sZW5ndGggPCAyIHx8IHRyYW5zZm9ybVswXT8ubGVuZ3RoIDwgMiB8fCB0cmFuc2Zvcm1bMV0/Lmxlbmd0aCA8IDIpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gTWF0aC5hYnModHJhbnNmb3JtWzBdWzBdIC0gMSkgPD0gR0VPTUVUUllfRVBTSUxPTlxyXG4gICAgICAgICYmIE1hdGguYWJzKHRyYW5zZm9ybVswXVsxXSkgPD0gR0VPTUVUUllfRVBTSUxPTlxyXG4gICAgICAgICYmIE1hdGguYWJzKHRyYW5zZm9ybVsxXVswXSkgPD0gR0VPTUVUUllfRVBTSUxPTlxyXG4gICAgICAgICYmIE1hdGguYWJzKHRyYW5zZm9ybVsxXVsxXSAtIDEpIDw9IEdFT01FVFJZX0VQU0lMT047XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRyYW5zZm9ybXNGb2xkYWJsZShwYXJlbnQ6IEZpZ21hTm9kZSwgY2hpbGQ6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIE1hdGguYWJzKHBhcmVudC5yb3RhdGlvbiA/PyAwKSA8PSBHRU9NRVRSWV9FUFNJTE9OXHJcbiAgICAgICAgJiYgTWF0aC5hYnMoY2hpbGQucm90YXRpb24gPz8gMCkgPD0gR0VPTUVUUllfRVBTSUxPTlxyXG4gICAgICAgICYmIGhhc1RyYW5zbGF0aW9uT25seVRyYW5zZm9ybShwYXJlbnQpXHJcbiAgICAgICAgJiYgaGFzVHJhbnNsYXRpb25Pbmx5VHJhbnNmb3JtKGNoaWxkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gb3BhY2l0eUlzTmV1dHJhbChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBNYXRoLmFicyhub2RlLm9wYWNpdHkgLSAxKSA8PSBHRU9NRVRSWV9FUFNJTE9OO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlZmZlY3RpdmVDaGlsZHJlbihcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIGRlY2lzaW9uczogUmVhZG9ubHlNYXA8c3RyaW5nLCBJbXBvcnREZWNpc2lvbj4sXHJcbik6IEZpZ21hTm9kZVtdIHtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IHJlc29sdmVkRGVjaXNpb24oY2hpbGQsIGRlY2lzaW9ucykuYWN0aW9uICE9PSAnaWdub3JlJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNhbkZvbGRTb3VyY2VWaXNpYmlsaXR5KGhvc3Q6IEZpZ21hTm9kZSwgc291cmNlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIC8vIEEgaGlkZGVuIHNvdXJjZSB1bmRlciBhIHZpc2libGUgaG9zdCBuZWVkcyBpdHMgb3duIEluYWN0aXZlIG5vZGUuIEZvbGRpbmdcclxuICAgIC8vIGl0IG9udG8gdGhlIGhvc3Qgd291bGQgbWFrZSB0aGUgdmlzdWFsIGFwcGVhciBpbW1lZGlhdGVseSBpbiBDb2Nvcy5cclxuICAgIHJldHVybiAoaG9zdC52aXNpYmxlID09PSBmYWxzZSB8fCBzb3VyY2UudmlzaWJsZSAhPT0gZmFsc2UpXHJcbiAgICAgICAgJiYgIWhhc0hpZGRlbkRlc2NlbmRhbnQoc291cmNlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29sbGVjdFN1YnRyZWVJZHMobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nW10ge1xyXG4gICAgcmV0dXJuIFtub2RlLmlkLCAuLi5ub2RlLmNoaWxkcmVuLmZsYXRNYXAoY29sbGVjdFN1YnRyZWVJZHMpXTtcclxufVxyXG5cclxuZnVuY3Rpb24gZm9sZFBsYW4oa2luZDogVmlzdWFsRm9sZFBsYW5bJ2tpbmQnXSwgc291cmNlOiBGaWdtYU5vZGUpOiBWaXN1YWxGb2xkUGxhbiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGtpbmQsXHJcbiAgICAgICAgc291cmNlTm9kZUlkOiBzb3VyY2UuaWQsXHJcbiAgICAgICAgYWJzb3JiZWROb2RlSWRzOiBjb2xsZWN0U3VidHJlZUlkcyhzb3VyY2UpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gY2FuVXNlQ2hpbGRBc1Nwcml0ZShcclxuICAgIGNoaWxkOiBGaWdtYU5vZGUsXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4pOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gcmVzb2x2ZWREZWNpc2lvbihjaGlsZCwgZGVjaXNpb25zKTtcclxuICAgIHJldHVybiBkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInIHx8IGRlY2lzaW9uLm5pbmVTbGljZTtcclxufVxyXG5cclxuZnVuY3Rpb24gc3VidHJlZUhhc0V4cGxpY2l0Q29uZmxpY3QoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4pOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gcmVzb2x2ZWREZWNpc2lvbihub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgcmV0dXJuIGRlY2lzaW9uLmV4cGxpY2l0ID09PSB0cnVlXHJcbiAgICAgICAgfHwgQm9vbGVhbihkZWNpc2lvbi5uYW1lKVxyXG4gICAgICAgIHx8IG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHN1YnRyZWVIYXNFeHBsaWNpdENvbmZsaWN0KGNoaWxkLCBkZWNpc2lvbnMpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc3VidHJlZUhhc1NsaWNlQm91bmRhcnkoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4pOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHJlc29sdmVkRGVjaXNpb24obm9kZSwgZGVjaXNpb25zKS5uaW5lU2xpY2UpXHJcbiAgICAgICAgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSlcclxuICAgICAgICB8fCBpc1BhdGNoQ2FuZGlkYXRlKG5vZGUpXHJcbiAgICAgICAgfHwgbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gc3VidHJlZUhhc1NsaWNlQm91bmRhcnkoY2hpbGQsIGRlY2lzaW9ucykpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmaXhNZXJnZUNvbmZsaWN0KFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgZGVjaXNpb25zOiBSZWFkb25seU1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPixcclxuKTogJ3ByZWZpeC1tZXJnZS1zbGljZS1jb25mbGljdCcgfCAncHJlZml4LW1lcmdlLW92ZXJyaWRlLWNvbmZsaWN0JyB8IHVuZGVmaW5lZCB7XHJcbiAgICBpZiAobm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gc3VidHJlZUhhc0V4cGxpY2l0Q29uZmxpY3QoY2hpbGQsIGRlY2lzaW9ucykpKSB7XHJcbiAgICAgICAgcmV0dXJuICdwcmVmaXgtbWVyZ2Utb3ZlcnJpZGUtY29uZmxpY3QnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHN1YnRyZWVIYXNTbGljZUJvdW5kYXJ5KGNoaWxkLCBkZWNpc2lvbnMpKVxyXG4gICAgICAgID8gJ3ByZWZpeC1tZXJnZS1zbGljZS1jb25mbGljdCdcclxuICAgICAgICA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJlc29sdmUgYXV0b21hdGljIHJlc291cmNlIGJvdW5kYXJpZXMgYmVmb3JlIGNvbGxlY3RpbmcgYXNzZXRzIGFuZCBidWlsZGluZ1xyXG4gKiBzY2VuZSBzcGVjcy4gRGVzY2VuZGFudCBvdmVycmlkZXMgYW5kIGluZGVwZW5kZW50IHNsaWNlcyBtdXN0IG5ldmVyIGJlIGxvc3RcclxuICogdG8gdGhlIG5hbWluZyBkZWZhdWx0LiBUaGUgaW5wdXQgbWFwIGFuZCBGaWdtYSBub2RlcyByZW1haW4gdW50b3VjaGVkLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVBdXRvbWF0aWNNZXJnZURlY2lzaW9ucyhcclxuICAgIHJvb3RzOiBGaWdtYU5vZGVbXSxcclxuICAgIGRlY2lzaW9uczogUmVhZG9ubHlNYXA8c3RyaW5nLCBJbXBvcnREZWNpc2lvbj4sXHJcbik6IE1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgTWFwKGRlY2lzaW9ucyk7XHJcbiAgICBjb25zdCB2aXNpdCA9IChub2RlOiBGaWdtYU5vZGUsIGlzUm9vdDogYm9vbGVhbik6IHZvaWQgPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gcmVzb2x2ZWREZWNpc2lvbihub2RlLCByZXN1bHQpO1xyXG4gICAgICAgIGlmIChub2RlLnByZWZhYk5hbWU/LnRyaW0oKSkge1xyXG4gICAgICAgICAgICByZXN1bHQuc2V0KG5vZGUuaWQsIG5vcm1hbGl6ZVByZWZhYkRlY2lzaW9uKGRlY2lzaW9uLCBub2RlLnByZWZhYk5hbWUpKTtcclxuICAgICAgICB9IGVsc2UgaWYgKCFkZWNpc2lvbi5leHBsaWNpdCAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnICYmIGRlY2lzaW9uLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybSdcclxuICAgICAgICAgICAgJiYgbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gc3VidHJlZUhhc1ByZWZhYkJvdW5kYXJ5KGNoaWxkLCByZXN1bHQpKSkge1xyXG4gICAgICAgICAgICByZXN1bHQuc2V0KG5vZGUuaWQsIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ2dlbmVyYXRlJywgbmluZVNsaWNlOiBmYWxzZSB9KTtcclxuICAgICAgICB9IGVsc2UgaWYgKG5vZGUudHlwZSAhPT0gJ1RFWFQnXHJcbiAgICAgICAgICAgICYmIGlzTWVyZ2VkUmVzb3VyY2VOYW1lKG5vZGUubmFtZSlcclxuICAgICAgICAgICAgJiYgIWRlY2lzaW9uLmV4cGxpY2l0XHJcbiAgICAgICAgICAgICYmIGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2lnbm9yZSdcclxuICAgICAgICAgICAgJiYgZGVjaXNpb24uYWN0aW9uICE9PSAndHJhbnNmb3JtJ1xyXG4gICAgICAgICAgICAvLyBSZWFsIG1hc2sgZ3JvdXBzIGhhdmUgYWxyZWFkeSBiZWVuIHJlc29sdmVkIGJ5IHRoZSBtYXNrIHBsYW5uZXJcclxuICAgICAgICAgICAgLy8gdG8gZWl0aGVyIGEgc2FmZSBiYXNlK3RpbnQgb3IgYSB3aG9sZSBjb21wb3NpdGUgZmFsbGJhY2suXHJcbiAgICAgICAgICAgICYmICFub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC5pc01hc2spXHJcbiAgICAgICAgICAgICYmICFkZWNpc2lvbi5uaW5lU2xpY2VcclxuICAgICAgICAgICAgJiYgIWhhc01hbnVhbEV4cG9ydChub2RlKVxyXG4gICAgICAgICAgICAmJiAhaXNOYW1lZFNsaWNlR3JvdXAobm9kZSlcclxuICAgICAgICAgICAgJiYgIWlzUGF0Y2hDYW5kaWRhdGUobm9kZSkpIHtcclxuICAgICAgICAgICAgcmVzdWx0LnNldChub2RlLmlkLCB7XHJcbiAgICAgICAgICAgICAgICAuLi5kZWNpc2lvbixcclxuICAgICAgICAgICAgICAgIGFjdGlvbjogaXNSb290IHx8IHByZWZpeE1lcmdlQ29uZmxpY3Qobm9kZSwgcmVzdWx0KSA/ICdnZW5lcmF0ZScgOiAncmVuZGVyJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgcmVzdWx0LnNldChub2RlLmlkLCBkZWNpc2lvbik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBmYWxzZSkpO1xyXG4gICAgfTtcclxuICAgIHJvb3RzLmZvckVhY2goKHJvb3QpID0+IHZpc2l0KHJvb3QsIHRydWUpKTtcclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhc2VSZWFzb24oXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICByb2xlOiBOb2RlU2VtYW50aWNSb2xlLFxyXG4gICAgZGVjaXNpb246IEltcG9ydERlY2lzaW9uLFxyXG4gICAgaXNSb290OiBib29sZWFuLFxyXG4pOiBJbXBvcnRQbGFuUmVhc29uIHtcclxuICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnICYmIG5vZGUucHJlZmFiTmFtZT8udHJpbSgpKSByZXR1cm4gJ3ByZWZhYi1yZWZlcmVuY2UnO1xyXG4gICAgaWYgKGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2lnbm9yZScgJiYgaXNQYXRjaENhbmRpZGF0ZShub2RlKSkgcmV0dXJuICdzbGljZS1yZXNvdXJjZSc7XHJcbiAgICBpZiAoZGVjaXNpb24uZXhwbGljaXQpIHJldHVybiAndXNlci1vdmVycmlkZSc7XHJcbiAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuICdpZ25vcmVkJztcclxuICAgIGlmIChpc1Jvb3QpIHJldHVybiAncm9vdC1zdHJ1Y3R1cmUnO1xyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSByZXR1cm4gJ2VkaXRhYmxlLXRleHQnO1xyXG4gICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKSB8fCBpc1BhdGNoQ2FuZGlkYXRlKG5vZGUpKSByZXR1cm4gJ3NsaWNlLXJlc291cmNlJztcclxuICAgIGlmIChoYXNNYW51YWxFeHBvcnQobm9kZSkpIHJldHVybiAnbWFudWFsLWV4cG9ydCc7XHJcbiAgICBpZiAoaXNNZXJnZWRSZXNvdXJjZU5hbWUobm9kZS5uYW1lKSkge1xyXG4gICAgICAgIHJldHVybiBkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInID8gJ3ByZWZpeC1tZXJnZScgOiAnZGVmYXVsdC1nZW5lcmF0ZSc7XHJcbiAgICB9XHJcbiAgICBpZiAoWydwYW5lbCcsICdsaXN0JywgJ2xheW91dCcsICdidXR0b24nLCAndmlldycsICdjb250ZW50J10uaW5jbHVkZXMocm9sZSkpIHtcclxuICAgICAgICByZXR1cm4gJ3NlbWFudGljLWNvbnRhaW5lcic7XHJcbiAgICB9XHJcbiAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJykgcmV0dXJuICd2aXN1YWwtZmFsbGJhY2snO1xyXG4gICAgcmV0dXJuICdkZWZhdWx0LWdlbmVyYXRlJztcclxufVxyXG5cclxuZnVuY3Rpb24gcGxhbm5lZEtpbmRGb3JFbXB0eVRleHRIb3N0KFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgcm9sZTogTm9kZVNlbWFudGljUm9sZSxcclxuICAgIGRlY2lzaW9uOiBJbXBvcnREZWNpc2lvbixcclxuICAgIGNoaWxkcmVuOiBGaWdtYU5vZGVbXSxcclxuKTogTm9kZUtpbmQgfCB1bmRlZmluZWQge1xyXG4gICAgaWYgKHJvbGUgIT09ICd0ZXh0J1xyXG4gICAgICAgIHx8IGNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgIHx8IGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2dlbmVyYXRlJ1xyXG4gICAgICAgIHx8IGRlY2lzaW9uLmV4cGxpY2l0XHJcbiAgICAgICAgfHwgIWlzU2FmZVZpc3VhbEhvc3Qobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICdsYWJlbCc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc3VhbEZvbGRGb3JOb2RlKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgcm9sZTogTm9kZVNlbWFudGljUm9sZSxcclxuICAgIGRlY2lzaW9uOiBJbXBvcnREZWNpc2lvbixcclxuICAgIGRlY2lzaW9uczogUmVhZG9ubHlNYXA8c3RyaW5nLCBJbXBvcnREZWNpc2lvbj4sXHJcbik6IHsgZm9sZDogVmlzdWFsRm9sZFBsYW47IGtpbmQ6IE5vZGVLaW5kOyByZWFzb246IEltcG9ydFBsYW5SZWFzb24gfSB8IHVuZGVmaW5lZCB7XHJcbiAgICBpZiAobm9kZS5wcmVmYWJOYW1lPy50cmltKClcclxuICAgICAgICB8fCBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBzdWJ0cmVlSGFzUHJlZmFiQm91bmRhcnkoY2hpbGQsIGRlY2lzaW9ucykpKSByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgY29uc3QgZXhwbGljaXRLaW5kUmVxdWVzdHNGb2xkID0gZGVjaXNpb24uZXhwbGljaXQgPT09IHRydWUgJiYgKFxyXG4gICAgICAgIChyb2xlID09PSAndGV4dCcgJiYgKGRlY2lzaW9uLmtpbmQgPT09ICdsYWJlbCcgfHwgZGVjaXNpb24ua2luZCA9PT0gJ3JpY2hUZXh0JykpXHJcbiAgICAgICAgfHwgKHJvbGUgPT09ICdpbWFnZScgJiYgKGRlY2lzaW9uLmtpbmQgPT09ICdzcHJpdGUnIHx8IGRlY2lzaW9uLmtpbmQgPT09ICdidXR0b24nKSlcclxuICAgICAgICB8fCAocm9sZSA9PT0gJ2J1dHRvbicgJiYgZGVjaXNpb24ua2luZCA9PT0gJ2J1dHRvbicpXHJcbiAgICApO1xyXG4gICAgaWYgKGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2dlbmVyYXRlJ1xyXG4gICAgICAgIHx8IGRlY2lzaW9uLm5pbmVTbGljZVxyXG4gICAgICAgIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpXHJcbiAgICAgICAgfHwgaXNQYXRjaENhbmRpZGF0ZShub2RlKVxyXG4gICAgICAgIHx8IChkZWNpc2lvbi5leHBsaWNpdCAmJiAhZXhwbGljaXRLaW5kUmVxdWVzdHNGb2xkKVxyXG4gICAgICAgIHx8ICFpc1NhZmVWaXN1YWxIb3N0KG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGNoaWxkcmVuID0gZWZmZWN0aXZlQ2hpbGRyZW4obm9kZSwgZGVjaXNpb25zKTtcclxuICAgIGlmIChyb2xlID09PSAndGV4dCcgJiYgY2hpbGRyZW4ubGVuZ3RoID09PSAxKSB7XHJcbiAgICAgICAgY29uc3QgY2hpbGQgPSBjaGlsZHJlblswXTtcclxuICAgICAgICBpZiAoY2hpbGQudHlwZSA9PT0gJ1RFWFQnXHJcbiAgICAgICAgICAgICYmIGNhbkZvbGRTb3VyY2VWaXNpYmlsaXR5KG5vZGUsIGNoaWxkKVxyXG4gICAgICAgICAgICAmJiAhc3VidHJlZUhhc0V4cGxpY2l0Q29uZmxpY3QoY2hpbGQsIGRlY2lzaW9ucylcclxuICAgICAgICAgICAgJiYgZnJhbWVzRXF1aXZhbGVudChub2RlLmFic29sdXRlQm91bmRpbmdCb3gsIGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpXHJcbiAgICAgICAgICAgICYmIHRyYW5zZm9ybXNGb2xkYWJsZShub2RlLCBjaGlsZCkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGZvbGQ6IGZvbGRQbGFuKCdzaW5nbGUtdGV4dCcsIGNoaWxkKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IGRlY2lzaW9uLmtpbmQgPT09ICdyaWNoVGV4dCcgPyAncmljaFRleHQnIDogJ2xhYmVsJyxcclxuICAgICAgICAgICAgICAgIHJlYXNvbjogJ3NpbmdsZS10ZXh0LWZvbGQnLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChyb2xlID09PSAnaW1hZ2UnICYmIGNoaWxkcmVuLmxlbmd0aCA9PT0gMSkge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkID0gY2hpbGRyZW5bMF07XHJcbiAgICAgICAgaWYgKGNhblVzZUNoaWxkQXNTcHJpdGUoY2hpbGQsIGRlY2lzaW9ucylcclxuICAgICAgICAgICAgJiYgY2FuRm9sZFNvdXJjZVZpc2liaWxpdHkobm9kZSwgY2hpbGQpXHJcbiAgICAgICAgICAgICYmICFzdWJ0cmVlSGFzRXhwbGljaXRDb25mbGljdChjaGlsZCwgZGVjaXNpb25zKVxyXG4gICAgICAgICAgICAmJiBmcmFtZXNFcXVpdmFsZW50KG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCwgY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveClcclxuICAgICAgICAgICAgJiYgdHJhbnNmb3Jtc0ZvbGRhYmxlKG5vZGUsIGNoaWxkKSkge1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgZm9sZDogZm9sZFBsYW4oJ3NpbmdsZS1pbWFnZScsIGNoaWxkKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IGRlY2lzaW9uLmtpbmQgPT09ICdidXR0b24nID8gJ2J1dHRvbicgOiAnc3ByaXRlJyxcclxuICAgICAgICAgICAgICAgIHJlYXNvbjogJ3NpbmdsZS1pbWFnZS1mb2xkJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAocm9sZSA9PT0gJ2J1dHRvbicgJiYgKGRlY2lzaW9uLmtpbmQgPT09ICdidXR0b24nIHx8IGRlY2lzaW9uLmtpbmQgPT09ICdhdXRvJykpIHtcclxuICAgICAgICBjb25zdCBjYW5kaWRhdGVzID0gY2hpbGRyZW4uZmlsdGVyKChjaGlsZCkgPT4gY2FuVXNlQ2hpbGRBc1Nwcml0ZShjaGlsZCwgZGVjaXNpb25zKVxyXG4gICAgICAgICAgICAmJiBjYW5Gb2xkU291cmNlVmlzaWJpbGl0eShub2RlLCBjaGlsZClcclxuICAgICAgICAgICAgJiYgZnJhbWVzRXF1aXZhbGVudChub2RlLmFic29sdXRlQm91bmRpbmdCb3gsIGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpXHJcbiAgICAgICAgICAgICYmIHRyYW5zZm9ybXNGb2xkYWJsZShub2RlLCBjaGlsZClcclxuICAgICAgICAgICAgJiYgb3BhY2l0eUlzTmV1dHJhbChjaGlsZCkpO1xyXG4gICAgICAgIGlmIChjYW5kaWRhdGVzLmxlbmd0aCA9PT0gMVxyXG4gICAgICAgICAgICAmJiBjaGlsZHJlblswXSA9PT0gY2FuZGlkYXRlc1swXVxyXG4gICAgICAgICAgICAmJiAhc3VidHJlZUhhc0V4cGxpY2l0Q29uZmxpY3QoY2FuZGlkYXRlc1swXSwgZGVjaXNpb25zKSkge1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgZm9sZDogZm9sZFBsYW4oJ2JhY2tncm91bmQnLCBjYW5kaWRhdGVzWzBdKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6ICdidXR0b24nLFxyXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnYmFja2dyb3VuZC1wcm9tb3Rpb24nLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDnvJbor5HkuIDmrKHlr7zlhaXkvb/nlKjnmoTllK/kuIDop4TliJLooajjgILotYTmupDmlLbpm4blrozmiJDlkI7lj6/lho3mrKHnvJbor5HvvIzku6XmjqXmlLbmnKzlnLDlkIzlkI1cclxuICog6LWE5rqQ5a+5IGRlY2lzaW9uIOeahOaPkOWNh++8m1NjZW5lTm9kZVNwZWMg5LiO6Z2i5p2/6K+05piO6YO95raI6LS55ZCM5LiA5aWX57qv6KeE5YiZ44CCXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY29tcGlsZUltcG9ydFBsYW4oXHJcbiAgICByb290czogRmlnbWFOb2RlW10sXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4pOiBNYXA8c3RyaW5nLCBOb2RlSW1wb3J0UGxhbj4ge1xyXG4gICAgZGVjaXNpb25zID0gcmVzb2x2ZUF1dG9tYXRpY01lcmdlRGVjaXNpb25zKHJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgY29uc3QgcGxhbnMgPSBuZXcgTWFwPHN0cmluZywgTm9kZUltcG9ydFBsYW4+KCk7XHJcbiAgICBjb25zdCB2aXNpdCA9IChub2RlOiBGaWdtYU5vZGUsIGlzUm9vdDogYm9vbGVhbikgPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gcmVzb2x2ZWREZWNpc2lvbihub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGNvbnN0IHJvbGUgPSBzZW1hbnRpY1JvbGVGb3JOb2RlKG5vZGUsIGlzUm9vdCk7XHJcbiAgICAgICAgY29uc3QgcHJlZmFiUmVmZXJlbmNlID0gZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJyAmJiBCb29sZWFuKG5vZGUucHJlZmFiTmFtZT8udHJpbSgpKTtcclxuICAgICAgICBjb25zdCBwcmVmYWJEZXNjZW5kYW50ID0gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gc3VidHJlZUhhc1ByZWZhYkJvdW5kYXJ5KGNoaWxkLCBkZWNpc2lvbnMpKTtcclxuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IGVmZmVjdGl2ZUNoaWxkcmVuKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgY29uc3QgZm9sZCA9IHZpc3VhbEZvbGRGb3JOb2RlKG5vZGUsIHJvbGUsIGRlY2lzaW9uLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGNvbnN0IGVtcHR5VGV4dEtpbmQgPSBwbGFubmVkS2luZEZvckVtcHR5VGV4dEhvc3Qobm9kZSwgcm9sZSwgZGVjaXNpb24sIGNoaWxkcmVuKTtcclxuICAgICAgICBjb25zdCBwcmVmaXhDb25mbGljdCA9ICFpc1Jvb3RcclxuICAgICAgICAgICAgJiYgIXByZWZhYlJlZmVyZW5jZVxyXG4gICAgICAgICAgICAmJiAhcHJlZmFiRGVzY2VuZGFudFxyXG4gICAgICAgICAgICAmJiBub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICAgICAmJiBpc01lcmdlZFJlc291cmNlTmFtZShub2RlLm5hbWUpXHJcbiAgICAgICAgICAgICYmICFkZWNpc2lvbi5leHBsaWNpdFxyXG4gICAgICAgICAgICAmJiBkZWNpc2lvbi5hY3Rpb24gPT09ICdnZW5lcmF0ZSdcclxuICAgICAgICAgICAgJiYgIWRlY2lzaW9uLm5pbmVTbGljZVxyXG4gICAgICAgICAgICAmJiAhaGFzTWFudWFsRXhwb3J0KG5vZGUpXHJcbiAgICAgICAgICAgICYmICFpc05hbWVkU2xpY2VHcm91cChub2RlKVxyXG4gICAgICAgICAgICAmJiAhaXNQYXRjaENhbmRpZGF0ZShub2RlKVxyXG4gICAgICAgICAgICA/IHByZWZpeE1lcmdlQ29uZmxpY3Qobm9kZSwgZGVjaXNpb25zKVxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCByZWFzb24gPSBwcmVmYWJEZXNjZW5kYW50ICYmICFkZWNpc2lvbi5leHBsaWNpdCAmJiBkZWNpc2lvbi5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgIXByZWZhYlJlZmVyZW5jZVxyXG4gICAgICAgICAgICA/ICdkZWZhdWx0LWdlbmVyYXRlJ1xyXG4gICAgICAgICAgICA6IGZvbGQ/LnJlYXNvbiA/PyBwcmVmaXhDb25mbGljdFxyXG4gICAgICAgICAgICAgICAgPz8gKGVtcHR5VGV4dEtpbmQgPyAnZWRpdGFibGUtdGV4dCcgOiBiYXNlUmVhc29uKG5vZGUsIHJvbGUsIGRlY2lzaW9uLCBpc1Jvb3QpKTtcclxuICAgICAgICBwbGFucy5zZXQobm9kZS5pZCwge1xyXG4gICAgICAgICAgICBub2RlSWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgICAgIHJvbGUsXHJcbiAgICAgICAgICAgIHJlYXNvbixcclxuICAgICAgICAgICAga2luZDogcHJlZmFiUmVmZXJlbmNlID8gJ25vZGUnIDogZm9sZD8ua2luZCA/PyBlbXB0eVRleHRLaW5kLFxyXG4gICAgICAgICAgICBmb2xkOiBmb2xkPy5mb2xkLFxyXG4gICAgICAgICAgICB3YXJuaW5nOiBwcmVmYWJSZWZlcmVuY2VcclxuICAgICAgICAgICAgICAgID8gYOW8leeUqOmhueebriBQcmVmYWLigJwke25vZGUucHJlZmFiTmFtZX3igJ3vvIwke3ByZWZhYlVzZXNGaWdtYVNpemUobm9kZS5wcmVmYWJOYW1lISkgPyAn5oyJIEZpZ21hIOiwg+aVtOWuvemrmCcgOiAn5oyJIEZpZ21hIOWunuS+i+ebuOWvueavjee7hOS7tueahOWAjeeOh+e8qeaUvid977yb5LiN5a+85YWl5q2k6IqC54K555qE5Y6f5aeL5YaF5a655Y+K5a2Q5qCRYFxyXG4gICAgICAgICAgICAgICAgOiBwcmVmYWJEZXNjZW5kYW50ICYmICFkZWNpc2lvbi5leHBsaWNpdCAmJiBkZWNpc2lvbi5hY3Rpb24gPT09ICdnZW5lcmF0ZSdcclxuICAgICAgICAgICAgICAgICAgICA/ICflhoXpg6jlrZjlnKggUHJlZmFiIOW8leeUqO+8jOaZuuiDveaooeW8j+S/neeVmeiKgueCuee7k+aehO+8jOS4jeiHquWKqOWQiOW5tuS4uuWbvueJhydcclxuICAgICAgICAgICAgICAgIDogIWZvbGQgJiYgcHJlZml4Q29uZmxpY3RcclxuICAgICAgICAgICAgICAgID8gaW1wb3J0UGxhblJlYXNvblRleHQocHJlZml4Q29uZmxpY3QpXHJcbiAgICAgICAgICAgICAgICA6IHJlYXNvbiA9PT0gJ3ByZWZpeC1tZXJnZSdcclxuICAgICAgICAgICAgICAgICAgICA/ICdpY29uXy9pbWdfIOWJjee8gOaMiSBQTkcg5pW05bGC5ZCI5bm277yM6YeH55So5b2T5YmN5pi+6ZqQ5ZCI5oiQ77yb6ZqQ6JeP5a2Q5bGC5LiN55Sf5oiQ54us56uL6IqC54K5J1xyXG4gICAgICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBmYWxzZSkpO1xyXG4gICAgfTtcclxuICAgIHJvb3RzLmZvckVhY2goKHJvb3QpID0+IHZpc2l0KHJvb3QsIHRydWUpKTtcclxuICAgIHJldHVybiBwbGFucztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuKFxyXG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXSxcclxuICAgIHBsYW5zOiBSZWFkb25seU1hcDxzdHJpbmcsIE5vZGVJbXBvcnRQbGFuPixcclxuKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gdHJlZS5tYXAoKG5vZGUpID0+IHtcclxuICAgICAgICBjb25zdCBwbGFuID0gcGxhbnMuZ2V0KG5vZGUuaWQpO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIC4uLm5vZGUsXHJcbiAgICAgICAgICAgIHJlYXNvbjogcGxhbj8ucmVhc29uLFxyXG4gICAgICAgICAgICB3YXJuaW5nOiBub2RlLndhcm5pbmcgJiYgcGxhbj8ud2FybmluZyAmJiBub2RlLndhcm5pbmcuaW5jbHVkZXMocGxhbi53YXJuaW5nKVxyXG4gICAgICAgICAgICAgICAgPyBub2RlLndhcm5pbmdcclxuICAgICAgICAgICAgICAgIDogWy4uLm5ldyBTZXQoW25vZGUud2FybmluZywgcGxhbj8ud2FybmluZ10uZmlsdGVyKEJvb2xlYW4pKV0uam9pbign77ybJykgfHwgdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICBmb2xkOiBwbGFuPy5mb2xkPy5raW5kLFxyXG4gICAgICAgICAgICBhYnNvcmJlZE5vZGVJZHM6IHBsYW4/LmZvbGQ/LmFic29yYmVkTm9kZUlkcyxcclxuICAgICAgICAgICAgY2hpbGRyZW46IGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuKG5vZGUuY2hpbGRyZW4sIHBsYW5zKSxcclxuICAgICAgICB9O1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbXBvcnRQbGFuUmVhc29uVGV4dChyZWFzb246IEltcG9ydFBsYW5SZWFzb24gfCB1bmRlZmluZWQpOiBzdHJpbmcge1xyXG4gICAgc3dpdGNoIChyZWFzb24pIHtcclxuICAgICAgICBjYXNlICdpZ25vcmVkJzogcmV0dXJuICfoioLngrnnrZbnlaXorr7kuLrlv73nlaXvvIzkuI3lr7zlhaUnO1xyXG4gICAgICAgIGNhc2UgJ3ByZWZhYi1yZWZlcmVuY2UnOiByZXR1cm4gJ+W8leeUqOmhueebruW3suaciSBQcmVmYWInO1xyXG4gICAgICAgIGNhc2UgJ3Jvb3Qtc3RydWN0dXJlJzogcmV0dXJuICfkv53nlZnkuLogUHJlZmFiIOaguee7k+aehCc7XHJcbiAgICAgICAgY2FzZSAnbWFudWFsLWV4cG9ydCc6IHJldHVybiAn5qOA5rWL5YiwIEZpZ21hIEV4cG9ydO+8jOaMieaVtOWxgui1hOa6kOWvvOWFpSc7XHJcbiAgICAgICAgY2FzZSAnc2xpY2UtcmVzb3VyY2UnOiByZXR1cm4gJ+ivhuWIq+S4uuS4iS/kuZ3lrqvotYTmupAnO1xyXG4gICAgICAgIGNhc2UgJ3ByZWZpeC1tZXJnZSc6IHJldHVybiAnaWNvbl8vaW1nXyDliY3nvIDpu5jorqTlkIjlubbkuLrljZXkuKrotYTmupAnO1xyXG4gICAgICAgIGNhc2UgJ3ByZWZpeC1tZXJnZS1zbGljZS1jb25mbGljdCc6IHJldHVybiAn5YmN57yA5ZCI5bm25bey5Zue6YCA77ya5YaF6YOo5a2Y5Zyo54us56uL5LiJL+S5neWuq+i1hOa6kO+8jOS/neeVmeWFtue7k+aehOS4juWIh+eJh+iDveWKmyc7XHJcbiAgICAgICAgY2FzZSAncHJlZml4LW1lcmdlLW92ZXJyaWRlLWNvbmZsaWN0JzogcmV0dXJuICfliY3nvIDlkIjlubblt7Llm57pgIDvvJrlrZDlsYLlrZjlnKjmiYvliqjnrZbnlaXmiJblkb3lkI3vvIzkv53nlZnni6znq4vlrZDoioLngrknO1xyXG4gICAgICAgIGNhc2UgJ3NlbWFudGljLWNvbnRhaW5lcic6IHJldHVybiAn5L+d55WZIENvY29zIOi/kOihjOaXtuivreS5ieWuueWZqCc7XHJcbiAgICAgICAgY2FzZSAnZWRpdGFibGUtdGV4dCc6IHJldHVybiAn5L+d55WZ5Li65Y+v57yW6L6R5paH5a2XJztcclxuICAgICAgICBjYXNlICdzaW5nbGUtaW1hZ2UtZm9sZCc6IHJldHVybiAn5Y2V5LiA5Zu+54mH5a2Q5bGC5o+Q5Y2H5Yiw54i26IqC54K5JztcclxuICAgICAgICBjYXNlICdzaW5nbGUtdGV4dC1mb2xkJzogcmV0dXJuICfljZXkuIDmloflrZflrZDlsYLmj5DljYfliLDniLboioLngrknO1xyXG4gICAgICAgIGNhc2UgJ2JhY2tncm91bmQtcHJvbW90aW9uJzogcmV0dXJuICfog4zmma/otYTmupDmj5DljYfliLDniLboioLngrnvvIzkv53nlZnlhoXlrrnlrZDlsYInO1xyXG4gICAgICAgIGNhc2UgJ3Zpc3VhbC1mYWxsYmFjayc6IHJldHVybiAn57qv6KeG6KeJ5YaF5a655oyJIFBORyDlr7zlhaUnO1xyXG4gICAgICAgIGNhc2UgJ3VzZXItb3ZlcnJpZGUnOiByZXR1cm4gJ+mHh+eUqOaJi+WKqOiKgueCueetlueVpSc7XHJcbiAgICAgICAgY2FzZSAnZGVmYXVsdC1nZW5lcmF0ZSc6IHJldHVybiAn5oyJ5Y+v57yW6L6R6IqC54K557uT5p6E55Sf5oiQJztcclxuICAgICAgICBkZWZhdWx0OiByZXR1cm4gJyc7XHJcbiAgICB9XHJcbn1cclxuIl19