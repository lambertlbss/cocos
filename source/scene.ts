import { join } from 'path';
import type { FigmaColor, FigmaPaint, Rect, SceneNodeSpec } from './types';

module.paths.push(join(Editor.App.path, 'node_modules'));

interface SceneImportPayload {
    packageName: string;
    fileKey: string;
    rootName: string;
    rootFrame: Rect;
    scale: number;
    targetUuid?: string;
    updateExisting: boolean;
    existingMap: Record<string, string>;
    roots: SceneNodeSpec[];
}

interface SceneImportResult {
    rootUuid: string;
    nodeMap: Record<string, string>;
    created: number;
    updated: number;
}

const BACKGROUND_NODE_NAME = '__FigmaBackground';

function cleanName(input: string): string {
    return input.replace(/[\u0000-\u001f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 96) || 'Figma Node';
}

function toColor(Color: any, value: FigmaColor | undefined, opacity = 1): any {
    const source = value ?? { r: 0, g: 0, b: 0, a: 1 };
    return new Color(
        Math.round(Math.max(0, Math.min(1, source.r)) * 255),
        Math.round(Math.max(0, Math.min(1, source.g)) * 255),
        Math.round(Math.max(0, Math.min(1, source.b)) * 255),
        Math.round(Math.max(0, Math.min(1, (source.a ?? 1) * opacity)) * 255),
    );
}

function findByUuid(root: any, uuid: string): any | null {
    if (root.uuid === uuid) {
        return root;
    }
    for (const child of root.children) {
        const found = findByUuid(child, uuid);
        if (found) {
            return found;
        }
    }
    return null;
}

function findCanvas(root: any, Canvas: any): any | null {
    if (root.getComponent(Canvas)) {
        return root;
    }
    for (const child of root.children) {
        const found = findCanvas(child, Canvas);
        if (found) {
            return found;
        }
    }
    return null;
}

function containsNode(root: any, target: any): boolean {
    if (!root || !target) {
        return false;
    }
    if (root === target) {
        return true;
    }
    return root.children.some((child: any) => containsNode(child, target));
}

function removeGeneratedComponents(node: any, classes: any[]): void {
    for (const type of classes) {
        const component = node.getComponent(type);
        if (component) {
            node.removeComponent(component);
        }
    }
}

function removeGeneratedBackground(node: any): void {
    const background = node.getChildByName(BACKGROUND_NODE_NAME);
    if (!background) {
        return;
    }
    background.removeFromParent();
    background.destroy();
}

function framePosition(frame: Rect, parentFrame: Rect | undefined, scale: number): { x: number; y: number } {
    if (!parentFrame) {
        return { x: 0, y: 0 };
    }
    return {
        x: (frame.x - parentFrame.x) * scale,
        y: -(frame.y - parentFrame.y) * scale,
    };
}

function configureGeometry(node: any, spec: SceneNodeSpec, scale: number, cc: any): any {
    const { UITransform, Vec3 } = cc;
    const transform = node.getComponent(UITransform) ?? node.addComponent(UITransform);
    transform.setAnchorPoint(0, 1);
    transform.setContentSize(
        Math.max(0, spec.frame.width * scale),
        Math.max(0, spec.frame.height * scale),
    );
    const position = framePosition(spec.frame, spec.parentFrame, scale);
    node.setPosition(new Vec3(position.x, position.y, node.position?.z ?? 0));
    node.setRotationFromEuler(0, 0, -spec.rotation);
    node.active = spec.visible;
    return transform;
}

function visiblePaint(paints: FigmaPaint[]): FigmaPaint | undefined {
    return paints.find((paint) => paint.visible !== false && (paint.opacity ?? 1) > 0);
}

function configureGraphics(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const { Graphics } = cc;
    const fill = spec.fills.find((paint) =>
        paint.visible !== false && (paint.opacity ?? 1) > 0 && paint.type === 'SOLID');
    const stroke = spec.strokes.find((paint) =>
        paint.visible !== false && (paint.opacity ?? 1) > 0 && paint.type === 'SOLID');
    if (!fill && !stroke) {
        return;
    }
    const graphics = node.addComponent(Graphics);
    graphics.clear();
    const width = spec.frame.width * scale;
    const height = spec.frame.height * scale;
    const radius = Math.max(
        0,
        Math.min(Math.min(...spec.cornerRadii) * scale, width / 2, height / 2),
    );
    if (spec.figmaType === 'ELLIPSE') {
        graphics.ellipse(width / 2, -height / 2, width / 2, height / 2);
    } else if (radius > 0) {
        graphics.roundRect(0, -height, width, height, radius);
    } else {
        graphics.rect(0, -height, width, height);
    }
    if (fill?.color) {
        graphics.fillColor = toColor(cc.Color, fill.color, fill.opacity ?? 1);
        graphics.fill();
    }
    if (stroke?.color && spec.strokeWeight > 0) {
        graphics.lineWidth = Math.max(0.5, spec.strokeWeight * scale);
        graphics.strokeColor = toColor(cc.Color, stroke.color, stroke.opacity ?? 1);
        graphics.stroke();
    }
}

function configureLabel(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const { Label, LabelOutline } = cc;
    const label = node.addComponent(Label);
    const style = spec.textStyle ?? {};
    label.string = spec.characters ?? '';
    label.fontSize = Math.max(1, (style.fontSize ?? 16) * scale);
    label.lineHeight = Math.max(label.fontSize, (style.lineHeightPx ?? style.fontSize ?? 16) * scale);
    label.spacingX = (style.letterSpacing ?? 0) * scale;
    label.enableWrapText = style.textAutoResize !== 'WIDTH_AND_HEIGHT';
    label.horizontalAlign = ({
        LEFT: Label.HorizontalAlign.LEFT,
        CENTER: Label.HorizontalAlign.CENTER,
        RIGHT: Label.HorizontalAlign.RIGHT,
        JUSTIFIED: Label.HorizontalAlign.LEFT,
    } as Record<string, number>)[style.textAlignHorizontal ?? 'LEFT'] ?? Label.HorizontalAlign.LEFT;
    label.verticalAlign = ({
        TOP: Label.VerticalAlign.TOP,
        CENTER: Label.VerticalAlign.CENTER,
        BOTTOM: Label.VerticalAlign.BOTTOM,
    } as Record<string, number>)[style.textAlignVertical ?? 'TOP'] ?? Label.VerticalAlign.TOP;
    label.overflow = style.textAutoResize === 'HEIGHT'
        ? Label.Overflow.RESIZE_HEIGHT
        : style.textAutoResize === 'WIDTH_AND_HEIGHT'
            ? Label.Overflow.NONE
            : Label.Overflow.CLAMP;
    const fill = visiblePaint(spec.fills);
    if (fill?.color) {
        label.color = toColor(cc.Color, fill.color, fill.opacity ?? 1);
    }
    const stroke = visiblePaint(spec.strokes);
    if (stroke?.color && spec.strokeWeight > 0) {
        const outline = node.addComponent(LabelOutline);
        outline.color = toColor(cc.Color, stroke.color, stroke.opacity ?? 1);
        outline.width = Math.max(1, spec.strokeWeight * scale);
    }
}

function loadAsset(assetManager: any, uuid: string): Promise<any> {
    return new Promise((resolve, reject) => {
        assetManager.loadAny({ uuid }, (error: Error | null, asset: any) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(asset);
        });
    });
}

async function configureSprite(node: any, spec: SceneNodeSpec, scale: number, cc: any): Promise<void> {
    if (!spec.sprite) {
        return;
    }
    const { Sprite, UITransform, assetManager } = cc;
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.type = spec.sprite.sliced ? Sprite.Type.SLICED : Sprite.Type.SIMPLE;
    sprite.spriteFrame = await loadAsset(assetManager, spec.sprite.uuid);
    const transform = node.getComponent(UITransform);
    transform?.setContentSize(
        Math.max(0, spec.frame.width * scale),
        Math.max(0, spec.frame.height * scale),
    );
}

function configureOpacity(node: any, spec: SceneNodeSpec, cc: any): void {
    if (spec.opacity >= 0.999) {
        return;
    }
    const opacity = node.addComponent(cc.UIOpacity);
    opacity.opacity = Math.round(Math.max(0, Math.min(1, spec.opacity)) * 255);
}

function configureWidget(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    if (!spec.parentFrame || !spec.constraints) {
        return;
    }
    const { Widget } = cc;
    const horizontal = spec.constraints.horizontal;
    const vertical = spec.constraints.vertical;
    if (!horizontal && !vertical) {
        return;
    }
    const widget = node.addComponent(Widget);
    widget.alignMode = Widget.AlignMode.ALWAYS;
    const parent = spec.parentFrame;
    const left = (spec.frame.x - parent.x) * scale;
    const right = (parent.x + parent.width - spec.frame.x - spec.frame.width) * scale;
    const top = (spec.frame.y - parent.y) * scale;
    const bottom = (parent.y + parent.height - spec.frame.y - spec.frame.height) * scale;
    if (horizontal === 'MIN') {
        widget.isAlignLeft = true;
        widget.left = left;
    } else if (horizontal === 'MAX') {
        widget.isAlignRight = true;
        widget.right = right;
    } else if (horizontal === 'CENTER') {
        widget.isAlignHorizontalCenter = true;
        widget.horizontalCenter = (left - right) / 2;
    } else if (horizontal === 'STRETCH' || horizontal === 'SCALE') {
        widget.isAlignLeft = true;
        widget.isAlignRight = true;
        widget.left = left;
        widget.right = right;
    }
    if (vertical === 'MIN') {
        widget.isAlignTop = true;
        widget.top = top;
    } else if (vertical === 'MAX') {
        widget.isAlignBottom = true;
        widget.bottom = bottom;
    } else if (vertical === 'CENTER') {
        widget.isAlignVerticalCenter = true;
        widget.verticalCenter = (bottom - top) / 2;
    } else if (vertical === 'STRETCH' || vertical === 'SCALE') {
        widget.isAlignTop = true;
        widget.isAlignBottom = true;
        widget.top = top;
        widget.bottom = bottom;
    }
}

function configureLayout(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const mode = spec.layout?.mode;
    if (!mode || mode === 'NONE') {
        return;
    }
    const { Layout, Size } = cc;
    const layout = node.getComponent(Layout) ?? node.addComponent(Layout);
    layout.type = mode === 'HORIZONTAL'
        ? Layout.Type.HORIZONTAL
        : mode === 'VERTICAL'
            ? Layout.Type.VERTICAL
            : Layout.Type.GRID;
    if (mode === 'GRID') {
        layout.startAxis = spec.layout?.sourceMode === 'VERTICAL'
            ? Layout.AxisDirection.VERTICAL
            : Layout.AxisDirection.HORIZONTAL;
    }
    layout.resizeMode = Layout.ResizeMode.NONE;
    layout.paddingLeft = spec.layout!.paddingLeft * scale;
    layout.paddingRight = spec.layout!.paddingRight * scale;
    layout.paddingTop = spec.layout!.paddingTop * scale;
    layout.paddingBottom = spec.layout!.paddingBottom * scale;
    layout.spacingX = spec.layout!.itemSpacing * scale;
    layout.spacingY = (mode === 'GRID' ? spec.layout!.counterSpacing : spec.layout!.itemSpacing) * scale;
    const activeChildren = spec.children.filter((child) => child.visible);
    if (mode === 'HORIZONTAL' && activeChildren.length) {
        const childrenWidth = activeChildren.reduce((total, child) => total + child.frame.width * scale, 0);
        const innerWidth = spec.frame.width * scale - layout.paddingLeft - layout.paddingRight;
        if (spec.layout!.primaryAlign === 'SPACE_BETWEEN' && activeChildren.length > 1) {
            layout.spacingX = Math.max(0, (innerWidth - childrenWidth) / (activeChildren.length - 1));
        } else {
            const used = childrenWidth + layout.spacingX * Math.max(0, activeChildren.length - 1);
            const remaining = Math.max(0, innerWidth - used);
            if (spec.layout!.primaryAlign === 'CENTER') {
                layout.paddingLeft += remaining / 2;
            } else if (spec.layout!.primaryAlign === 'MAX') {
                layout.paddingLeft += remaining;
            }
        }
    } else if (mode === 'VERTICAL' && activeChildren.length) {
        const childrenHeight = activeChildren.reduce((total, child) => total + child.frame.height * scale, 0);
        const innerHeight = spec.frame.height * scale - layout.paddingTop - layout.paddingBottom;
        if (spec.layout!.primaryAlign === 'SPACE_BETWEEN' && activeChildren.length > 1) {
            layout.spacingY = Math.max(0, (innerHeight - childrenHeight) / (activeChildren.length - 1));
        } else {
            const used = childrenHeight + layout.spacingY * Math.max(0, activeChildren.length - 1);
            const remaining = Math.max(0, innerHeight - used);
            if (spec.layout!.primaryAlign === 'CENTER') {
                layout.paddingTop += remaining / 2;
            } else if (spec.layout!.primaryAlign === 'MAX') {
                layout.paddingTop += remaining;
            }
        }
    }
    if (mode === 'GRID' && spec.children.length) {
        layout.cellSize = new Size(
            Math.max(...spec.children.map((child) => child.frame.width)) * scale,
            Math.max(...spec.children.map((child) => child.frame.height)) * scale,
        );
    }
}

function applyCounterAlignment(
    parent: any,
    spec: SceneNodeSpec,
    nodeMap: Record<string, string>,
    scale: number,
    cc: any,
): void {
    const mode = spec.layout?.mode;
    const alignment = spec.layout?.counterAlign;
    if (!mode || !alignment || !['HORIZONTAL', 'VERTICAL'].includes(mode)) {
        return;
    }
    const parentWidth = spec.frame.width * scale;
    const parentHeight = spec.frame.height * scale;
    const left = spec.layout!.paddingLeft * scale;
    const right = spec.layout!.paddingRight * scale;
    const top = spec.layout!.paddingTop * scale;
    const bottom = spec.layout!.paddingBottom * scale;
    for (const childSpec of spec.children) {
        const uuid = nodeMap[childSpec.figmaId];
        const child = uuid ? findByUuid(parent, uuid) : null;
        const transform = child?.getComponent(cc.UITransform);
        if (!child || !transform) {
            continue;
        }
        const position = child.position.clone();
        if (mode === 'HORIZONTAL') {
            const available = Math.max(0, parentHeight - top - bottom);
            if (alignment === 'CENTER') {
                position.y = -(top + (available - transform.height) / 2);
            } else if (alignment === 'MAX') {
                position.y = -(parentHeight - bottom - transform.height);
            } else {
                position.y = -top;
                if (alignment === 'STRETCH') {
                    transform.setContentSize(transform.width, available);
                }
            }
        } else {
            const available = Math.max(0, parentWidth - left - right);
            if (alignment === 'CENTER') {
                position.x = left + (available - transform.width) / 2;
            } else if (alignment === 'MAX') {
                position.x = parentWidth - right - transform.width;
            } else {
                position.x = left;
                if (alignment === 'STRETCH') {
                    transform.setContentSize(available, transform.height);
                }
            }
        }
        child.setPosition(position);
    }
}

function configureClip(node: any, spec: SceneNodeSpec, cc: any): void {
    const mask = node.getComponent(cc.Mask) ?? node.addComponent(cc.Mask);
    mask.type = spec.figmaType === 'ELLIPSE'
        ? cc.Mask.Type.ELLIPSE
        : cc.Mask.Type.GRAPHICS_RECT ?? cc.Mask.Type.RECT;
}

function clipsGeneratedChildren(spec: SceneNodeSpec): boolean {
    return spec.clipsContent
        && spec.kind !== 'scrollView'
        && spec.children.length > 0
        && spec.action === 'generate';
}

function configureButton(node: any, spec: SceneNodeSpec, cc: any): void {
    if (spec.kind === 'button') {
        const button = node.addComponent(cc.Button);
        button.target = node;
        button.transition = cc.Button.Transition.SCALE;
        button.zoomScale = 0.9;
        button.duration = 0.1;
    }
}

function configureScroll(
    node: any,
    spec: SceneNodeSpec,
    transform: any,
    cc: any,
): any {
    if (spec.kind !== 'scrollView') {
        return node;
    }
    const { Node, UITransform, Mask, ScrollView } = cc;
    const scroll = node.addComponent(ScrollView);
    let view = node.getChildByName('view');
    if (!view) {
        view = new Node('view');
        view.layer = node.layer;
        node.addChild(view);
    }
    const viewTransform = view.getComponent(UITransform) ?? view.addComponent(UITransform);
    viewTransform.setAnchorPoint(0, 1);
    viewTransform.setContentSize(transform.contentSize.width, transform.contentSize.height);
    view.setPosition(0, 0, 0);
    const mask = view.getComponent(Mask) ?? view.addComponent(Mask);
    mask.type = Mask.Type.GRAPHICS_RECT ?? Mask.Type.RECT;
    let content = view.getChildByName('content');
    if (!content) {
        content = new Node('content');
        content.layer = node.layer;
        view.addChild(content);
    }
    const contentTransform = content.getComponent(UITransform) ?? content.addComponent(UITransform);
    contentTransform.setAnchorPoint(0, 1);
    contentTransform.setContentSize(transform.contentSize.width, transform.contentSize.height);
    content.setPosition(0, 0, 0);
    const legacy = node.getChildByName('__FigmaContent');
    if (legacy && legacy !== content) {
        for (const child of [...legacy.children]) {
            child.parent = content;
        }
        legacy.destroy();
    }
    scroll.content = contentTransform;
    scroll.view = viewTransform;
    const direction = spec.overflowDirection ?? 'VERTICAL_SCROLLING';
    scroll.horizontal = direction === 'HORIZONTAL_SCROLLING' || direction === 'HORIZONTAL_AND_VERTICAL_SCROLLING';
    scroll.vertical = direction === 'VERTICAL_SCROLLING' || direction === 'HORIZONTAL_AND_VERTICAL_SCROLLING';
    return content;
}

function finalizeScroll(
    node: any,
    spec: SceneNodeSpec,
    content: any,
    viewport: any,
    scale: number,
    cc: any,
): void {
    if (spec.kind !== 'scrollView' || content === node) {
        return;
    }
    const transform = content.getComponent(cc.UITransform);
    if (!transform) {
        return;
    }
    const childRight = spec.children.map((child) =>
        (child.frame.x - spec.frame.x + child.frame.width) * scale);
    const childBottom = spec.children.map((child) =>
        (child.frame.y - spec.frame.y + child.frame.height) * scale);
    transform.setContentSize(
        Math.max(viewport.contentSize.width, 0, ...childRight),
        Math.max(viewport.contentSize.height, 0, ...childBottom),
    );
    content.setPosition(0, 0, 0);
}

function countSpecs(specs: SceneNodeSpec[]): number {
    return specs.reduce((total, spec) => total + 1 + countSpecs(spec.children), 0);
}

function emitSceneProgress(
    payload: SceneImportPayload,
    value: number,
    message: string,
): void {
    try {
        Editor.Message.send(payload.packageName, 'progress', {
            phase: 'scene',
            value,
            message,
        });
    } catch {
        // 进度反馈不可用时不应中断场景导入。
    }
}

export function load(): void {}

export function unload(): void {}

export const methods = {
    async importDocument(payload: SceneImportPayload): Promise<SceneImportResult> {
        const cc = require('cc') as any;
        const {
            director,
            Node,
            UITransform,
            Canvas,
            Graphics,
            Sprite,
            Label,
            LabelOutline,
            Layout,
            ScrollView,
            Mask,
            Button,
            Widget,
            UIOpacity,
            Camera,
        } = cc;
        const scene = director.getScene();
        if (!scene) {
            throw new Error('当前没有打开的场景。');
        }
        const selectedTarget = payload.targetUuid ? findByUuid(scene, payload.targetUuid) : null;
        const target = selectedTarget?.getComponent(Camera) ? null : selectedTarget;
        const fallbackParent = findCanvas(scene, Canvas) ?? scene;
        const generatedClasses = [
            Mask,
            Graphics,
            Sprite,
            Label,
            LabelOutline,
            Layout,
            ScrollView,
            Button,
            Widget,
            UIOpacity,
        ];
        const nodeMap: Record<string, string> = {};
        let created = 0;
        let updated = 0;
        const totalNodes = Math.max(1, countSpecs(payload.roots));
        let completedNodes = 0;

        let importRoot = payload.updateExisting && payload.existingMap.__root__
            ? findByUuid(scene, payload.existingMap.__root__)
            : null;
        if (importRoot && (!importRoot.name.startsWith('Figma · ') || importRoot.getComponent(Camera))) {
            importRoot = null;
        }
        const reusedImportRoot = Boolean(importRoot);
        const parent = importRoot && containsNode(importRoot, target)
            ? importRoot.parent ?? fallbackParent
            : target ?? fallbackParent;
        if (!importRoot) {
            importRoot = new Node(`Figma · ${cleanName(payload.rootName)}`);
            parent.addChild(importRoot);
            created += 1;
        } else {
            importRoot.parent = parent;
            importRoot.name = `Figma · ${cleanName(payload.rootName)}`;
            updated += 1;
        }
        const rootTransform = importRoot.getComponent(UITransform) ?? importRoot.addComponent(UITransform);
        rootTransform.setAnchorPoint(0, 1);
        rootTransform.setContentSize(
            payload.rootFrame.width * payload.scale,
            payload.rootFrame.height * payload.scale,
        );
        importRoot.setPosition(0, 0, 0);
        nodeMap.__root__ = importRoot.uuid;

        const build = async (spec: SceneNodeSpec, nodeParent: any, parentHasLayout: boolean): Promise<void> => {
            let node = payload.updateExisting && payload.existingMap[spec.figmaId]
                ? findByUuid(scene, payload.existingMap[spec.figmaId])
                : null;
            const existed = Boolean(node);
            if (!node) {
                node = new Node(cleanName(spec.name));
                created += 1;
            } else {
                updated += 1;
            }
            node.parent = nodeParent;
            node.name = cleanName(spec.name);
            nodeMap[spec.figmaId] = node.uuid;
            configureGeometry(node, spec, payload.scale, cc);

            if (spec.action !== 'transform') {
                removeGeneratedComponents(node, generatedClasses);
                removeGeneratedBackground(node);
                configureGeometry(node, spec, payload.scale, cc);
                const clipsChildren = clipsGeneratedChildren(spec);
                if (spec.kind === 'label' || spec.figmaType === 'TEXT') {
                    configureLabel(node, spec, payload.scale, cc);
                    if (spec.fontUuid) {
                        const label = node.getComponent(Label);
                        label.font = await loadAsset(cc.assetManager, spec.fontUuid);
                    }
                } else if (spec.sprite) {
                    await configureSprite(node, spec, payload.scale, cc);
                } else if (clipsChildren) {
                    configureClip(node, spec, cc);
                } else {
                    configureGraphics(node, spec, payload.scale, cc);
                }
                configureOpacity(node, spec, cc);
                configureButton(node, spec, cc);
                if (!parentHasLayout) {
                    configureWidget(node, spec, payload.scale, cc);
                }
            }

            const transform = node.getComponent(UITransform);
            const childParent = spec.action === 'transform'
                ? node
                : configureScroll(node, spec, transform, cc);
            if (spec.action !== 'transform') {
                configureLayout(childParent, spec, payload.scale, cc);
            }
            const hasLayout = Boolean(spec.layout?.mode && spec.layout.mode !== 'NONE');
            for (const child of spec.children) {
                await build(child, childParent, hasLayout);
            }
            const layout = childParent.getComponent(Layout);
            layout?.updateLayout();
            if (layout) {
                applyCounterAlignment(childParent, spec, nodeMap, payload.scale, cc);
            }
            finalizeScroll(node, spec, childParent, transform, payload.scale, cc);
            if (!existed && spec.action === 'transform') {
                node.name += ' · Transform';
            }
            completedNodes += 1;
            emitSceneProgress(
                payload,
                completedNodes / totalNodes,
                `构建节点 ${completedNodes}/${totalNodes} · ${spec.name}`,
            );
        };

        try {
            for (const root of payload.roots) {
                await build(root, importRoot, false);
            }
        } catch (error) {
            if (!reusedImportRoot) {
                importRoot.removeFromParent();
                importRoot.destroy();
            }
            throw error;
        }
        return {
            rootUuid: importRoot.uuid,
            nodeMap,
            created,
            updated,
        };
    },
};
