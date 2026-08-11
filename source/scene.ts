import { join } from 'path';
import type { FigmaColor, FigmaPaint, Rect, SceneNodeSpec } from './types';

module.paths.push(join(Editor.App.path, 'node_modules'));

interface SceneImportPayload {
    packageName: string;
    fileKey: string;
    rootName: string;
    rootFrame: Rect;
    scale: number;
    updateExisting: boolean;
    existingMap: Record<string, string>;
    prefabUrl?: string;
    centerInCanvas?: boolean;
    roots: SceneNodeSpec[];
}

interface SceneImportResult {
    rootUuid: string;
    nodeMap: Record<string, string>;
    created: number;
    updated: number;
    temporaryRoot?: boolean;
}

const BACKGROUND_NODE_NAME = '__FigmaBackground';
const RASTER_VECTOR_TYPES = new Set([
    'VECTOR',
    'BOOLEAN_OPERATION',
    'STAR',
    'LINE',
    'REGULAR_POLYGON',
]);

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

function framePosition(
    frame: Rect,
    parentFrame: Rect | undefined,
    scale: number,
    parentTransform?: any,
    childTransform?: any,
): { x: number; y: number } {
    if (!parentFrame) {
        return { x: 0, y: 0 };
    }
    const parentAnchor = parentTransform?.anchorPoint ?? { x: 0, y: 1 };
    const parentSize = parentTransform?.contentSize ?? {};
    const parentWidth = Number(parentSize.width) > 0
        ? Number(parentSize.width)
        : parentFrame.width * scale;
    const parentHeight = Number(parentSize.height) > 0
        ? Number(parentSize.height)
        : parentFrame.height * scale;
    const width = frame.width * scale;
    const height = frame.height * scale;
    const childAnchor = childTransform?.anchorPoint ?? { x: 0.5, y: 0.5 };
    return {
        // Figma coordinates are measured from the parent's top-left. Convert
        // that rectangle to the local position of the node's center anchor.
        x: (frame.x - parentFrame.x) * scale
            - parentWidth * parentAnchor.x
            + width * childAnchor.x,
        y: parentHeight * (1 - parentAnchor.y)
            - (frame.y - parentFrame.y) * scale
            - height * (1 - childAnchor.y),
    };
}

function configureGeometry(node: any, spec: SceneNodeSpec, scale: number, cc: any): any {
    const { UITransform, Vec3 } = cc;
    const transform = node.getComponent(UITransform) ?? node.addComponent(UITransform);
    transform.setAnchorPoint(0.5, 0.5);
    transform.setContentSize(
        Math.max(0, spec.frame.width * scale),
        Math.max(0, spec.frame.height * scale),
    );
    const position = framePosition(
        spec.frame,
        spec.parentFrame,
        scale,
        node.parent?.getComponent(UITransform),
        transform,
    );
    node.setPosition(new Vec3(position.x, position.y, node.position?.z ?? 0));
    node.setRotationFromEuler(0, 0, -spec.rotation);
    node.active = spec.visible;
    return transform;
}

function visiblePaint(paints: FigmaPaint[]): FigmaPaint | undefined {
    return paints.find((paint) => paint.visible !== false && (paint.opacity ?? 1) > 0);
}

function drawGraphics(graphics: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const fill = spec.fills.find((paint) =>
        paint.visible !== false && (paint.opacity ?? 1) > 0 && paint.type === 'SOLID');
    const stroke = spec.strokes.find((paint) =>
        paint.visible !== false && (paint.opacity ?? 1) > 0 && paint.type === 'SOLID');
    if (!fill && !stroke) {
        return;
    }
    const width = spec.frame.width * scale;
    const height = spec.frame.height * scale;
    const radius = Math.max(
        0,
        Math.min(Math.min(...spec.cornerRadii) * scale, width / 2, height / 2),
    );
    if (spec.figmaType === 'ELLIPSE') {
        graphics.ellipse(0, 0, width / 2, height / 2);
    } else if (radius > 0) {
        graphics.roundRect(-width / 2, -height / 2, width, height, radius);
    } else {
        graphics.rect(-width / 2, -height / 2, width, height);
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

function configureGraphics(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const graphics = node.addComponent(cc.Graphics);
    graphics.clear();
    drawGraphics(graphics, spec, scale, cc);
}

function normalizeLabelText(characters: string | undefined): string {
    return (characters ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/[\r\u2028\u2029]/g, '\n');
}

function isMultilineLabel(characters: string): boolean {
    // Cocos Creator 3.8.7 disables automatic wrapping whenever overflow is
    // NONE. Only explicit line feeds can therefore produce real line breaks.
    return characters.includes('\n');
}

function configureLabel(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const { Label } = cc;
    const label = node.addComponent(Label);
    const style = spec.textStyle ?? {};
    const characters = normalizeLabelText(spec.characters);
    const multiline = isMultilineLabel(characters);
    label.fontSize = Math.max(1, (style.fontSize ?? 16) * scale);
    label.lineHeight = Math.max(1, (style.lineHeightPx ?? style.fontSize ?? 16) * scale);
    label.spacingX = (style.letterSpacing ?? 0) * scale;
    label.enableWrapText = false;
    label.overflow = Label.Overflow.NONE;
    label.horizontalAlign = multiline
        ? Label.HorizontalAlign.LEFT
        : Label.HorizontalAlign.CENTER;
    label.verticalAlign = multiline
        ? Label.VerticalAlign.TOP
        : Label.VerticalAlign.CENTER;
    label.string = characters;
    const fill = visiblePaint(spec.fills);
    if (fill?.color) {
        label.color = toColor(cc.Color, fill.color, fill.opacity ?? 1);
    }
    const stroke = visiblePaint(spec.strokes);
    if (stroke?.color && spec.strokeWeight > 0) {
        label.enableOutline = true;
        label.outlineColor = toColor(cc.Color, stroke.color, stroke.opacity ?? 1);
        label.outlineWidth = Math.max(1, spec.strokeWeight * scale);
    }
}

function finalizeLabelGeometry(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const label = node.getComponent(cc.Label);
    const transform = node.getComponent(cc.UITransform);
    if (!label || !transform) {
        return;
    }
    label.updateRenderData(true);
    if (!isMultilineLabel(label.string)) {
        return;
    }
    // Keep the original Figma frame's local top-left point fixed after NONE
    // replaces UITransform with the measured text size. Rotate the local size
    // delta with the node so rotated multiline labels keep the same reference.
    const localDeltaX = (transform.width - spec.frame.width * scale) / 2;
    const localDeltaY = (spec.frame.height * scale - transform.height) / 2;
    const radians = -spec.rotation * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const deltaX = localDeltaX * cos - localDeltaY * sin;
    const deltaY = localDeltaX * sin + localDeltaY * cos;
    node.setPosition(new cc.Vec3(
        (node.position?.x ?? 0) + deltaX,
        (node.position?.y ?? 0) + deltaY,
        node.position?.z ?? 0,
    ));
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
    const parentTransform = parent.getComponent(cc.UITransform);
    const parentAnchor = parentTransform?.anchorPoint ?? { x: 0.5, y: 0.5 };
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
            let topOffset = top;
            if (alignment === 'CENTER') {
                topOffset = top + (available - transform.height) / 2;
            } else if (alignment === 'MAX') {
                topOffset = parentHeight - bottom - transform.height;
            } else {
                if (alignment === 'STRETCH') {
                    transform.setContentSize(transform.width, available);
                }
            }
            position.y = parentHeight * (1 - parentAnchor.y)
                - topOffset
                - transform.height * (1 - (transform.anchorPoint?.y ?? 0.5));
        } else {
            const available = Math.max(0, parentWidth - left - right);
            let leftOffset = left;
            if (alignment === 'CENTER') {
                leftOffset = left + (available - transform.width) / 2;
            } else if (alignment === 'MAX') {
                leftOffset = parentWidth - right - transform.width;
            } else {
                if (alignment === 'STRETCH') {
                    transform.setContentSize(available, transform.height);
                }
            }
            position.x = leftOffset
                - parentWidth * parentAnchor.x
                + transform.width * (transform.anchorPoint?.x ?? 0.5);
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

function centerInCanvas(node: any, canvas: any, UITransform: any, Vec3: any): void {
    const nodeTransform = node.getComponent(UITransform);
    const canvasTransform = canvas?.getComponent(UITransform);
    if (!nodeTransform || !canvasTransform) {
        return;
    }
    const canvasSize = canvasTransform.contentSize ?? {
        width: canvasTransform.width,
        height: canvasTransform.height,
    };
    const width = Number(canvasSize?.width) > 0 ? Number(canvasSize.width) : 640;
    const height = Number(canvasSize?.height) > 0 ? Number(canvasSize.height) : 1136;
    const canvasAnchor = canvasTransform.anchorPoint ?? { x: 0.5, y: 0.5 };
    const nodeAnchor = nodeTransform.anchorPoint ?? { x: 0.5, y: 0.5 };
    const x = width * (0.5 - canvasAnchor.x)
        - nodeTransform.width * (0.5 - nodeAnchor.x);
    const y = height * (0.5 - canvasAnchor.y)
        - nodeTransform.height * (0.5 - nodeAnchor.y);
    node.setPosition(new Vec3(x, y, node.position?.z ?? 0));
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
            UIOpacity,
            Camera,
        } = cc;
        const scene = director.getScene();
        if (!scene) {
            throw new Error('当前没有打开的场景。');
        }
        const fallbackParent = findCanvas(scene, Canvas) ?? scene;
        const directRoot = payload.roots.length === 1;
        const canvas = findCanvas(scene, Canvas);
        const generatedClasses = [
            Mask,
            Graphics,
            Sprite,
            Label,
            LabelOutline,
            Layout,
            ScrollView,
            Button,
            UIOpacity,
        ];
        const nodeMap: Record<string, string> = {};
        let created = 0;
        let updated = 0;
        const totalNodes = Math.max(1, countSpecs(payload.roots));
        let completedNodes = 0;

        const mappedRootUuid = directRoot
            ? payload.existingMap[payload.roots[0].figmaId]
            : payload.existingMap.__root__;
        let importRoot = payload.updateExisting && mappedRootUuid
            ? findByUuid(scene, mappedRootUuid)
            : null;
        if (importRoot?.getComponent(Camera)) {
            importRoot = null;
        }
        const legacyWrapper = directRoot && importRoot?.parent?.name.startsWith('Figma · ')
            ? importRoot.parent
            : null;
        const reusedImportRoot = Boolean(importRoot);
        const parent = fallbackParent;
        if (!directRoot) {
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
            rootTransform.setAnchorPoint(0.5, 0.5);
            rootTransform.setContentSize(
                payload.rootFrame.width * payload.scale,
                payload.rootFrame.height * payload.scale,
            );
            importRoot.setPosition(0, 0, 0);
            nodeMap.__root__ = importRoot.uuid;
        } else if (!importRoot) {
            importRoot = new Node(cleanName(payload.roots[0].name));
            parent.addChild(importRoot);
        }

        const build = async (
            spec: SceneNodeSpec,
            nodeParent: any,
            providedNode?: any,
        ): Promise<void> => {
            let node = providedNode ?? (payload.updateExisting && payload.existingMap[spec.figmaId]
                ? findByUuid(scene, payload.existingMap[spec.figmaId])
                : null);
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
                    finalizeLabelGeometry(node, spec, payload.scale, cc);
                } else if (spec.sprite) {
                    await configureSprite(node, spec, payload.scale, cc);
                } else if (RASTER_VECTOR_TYPES.has(spec.figmaType)) {
                    throw new Error(`矢量节点“${spec.name}”没有绑定 SpriteFrame，PNG 资源可能未成功导入。`);
                } else if (clipsChildren) {
                    configureClip(node, spec, cc);
                } else {
                    configureGraphics(node, spec, payload.scale, cc);
                }
                configureOpacity(node, spec, cc);
                configureButton(node, spec, cc);
            }

            const transform = node.getComponent(UITransform);
            const childParent = spec.action === 'transform'
                ? node
                : configureScroll(node, spec, transform, cc);
            if (spec.action !== 'transform') {
                configureLayout(childParent, spec, payload.scale, cc);
            }
            for (const child of spec.children) {
                await build(child, childParent);
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
                await build(root, directRoot ? parent : importRoot, directRoot ? importRoot : undefined);
            }
            if (directRoot) {
                nodeMap.__root__ = importRoot.uuid;
                if (payload.centerInCanvas && canvas) {
                    centerInCanvas(importRoot, canvas, UITransform, cc.Vec3);
                }
            }
            if (legacyWrapper && legacyWrapper !== importRoot && !legacyWrapper.children.length) {
                legacyWrapper.removeFromParent();
                legacyWrapper.destroy();
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
            temporaryRoot: directRoot && !reusedImportRoot,
        };
    },

    removeImportedNode(payload: { rootUuid: string }): boolean {
        const cc = require('cc') as any;
        const scene = cc.director.getScene();
        const node = scene ? findByUuid(scene, payload.rootUuid) : null;
        if (!node) {
            return false;
        }
        // Stop rendering immediately. Cocos destroys nodes at the end of the
        // frame, so removing the parent alone can leave a one-frame ghost.
        node.active = false;
        node.removeFromParent();
        node.destroy();
        return true;
    },
};
