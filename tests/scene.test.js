'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let nextUuid = 1;

class Component {
    constructor() {
        this.node = null;
        this.enabled = true;
    }
}

class UITransform extends Component {
    constructor() {
        super();
        this.width = 0;
        this.height = 0;
        this.contentSize = { width: 0, height: 0 };
        this.anchorPoint = { x: 0.5, y: 0.5 };
    }

    setAnchorPoint(x, y) {
        this.anchorPoint = { x, y };
    }

    setContentSize(width, height) {
        this.width = width;
        this.height = height;
        this.contentSize = { width, height };
    }
}

class Graphics extends Component {
    clear() {}
    rect() {}
    roundRect() {}
    ellipse() {}
    fill() {}
    stroke() {}
}

class Sprite extends Component {
    set sizeMode(value) {
        this._sizeMode = value;
        if (value !== Sprite.SizeMode.CUSTOM && this._spriteFrame) {
            this.node.getComponent(UITransform)?.setContentSize(
                this._spriteFrame.width ?? 0,
                this._spriteFrame.height ?? 0,
            );
        }
    }

    get sizeMode() {
        return this._sizeMode;
    }

    set spriteFrame(value) {
        this._spriteFrame = value;
        if (this.sizeMode !== Sprite.SizeMode.CUSTOM) {
            this.node.getComponent(UITransform)?.setContentSize(
                value.width ?? 0,
                value.height ?? 0,
            );
        }
    }

    get spriteFrame() {
        return this._spriteFrame;
    }
}
Sprite.SizeMode = { CUSTOM: 0, TRIMMED: 1, RAW: 2 };
Sprite.Type = { SIMPLE: 0, SLICED: 1, TILED: 2 };

class Label extends Component {
    updateRenderData() {
        if (this.overflow !== Label.Overflow.NONE) {
            return;
        }
        const transform = this.node.getComponent(UITransform);
        if (!transform) {
            return;
        }
        const lineHeight = Math.max(1, this.lineHeight ?? 1);
        const lines = String(this.string ?? '').split('\n');
        const outline = this.enableOutline ? Math.max(0, this.outlineWidth ?? 0) : 0;
        const widthFactor = this.font?.widthFactor ?? 0.5;
        const measuredWidth = Math.max(
            0,
            ...lines.map((line) => Array.from(line).length * (this.fontSize ?? 1) * widthFactor),
        );
        transform.setContentSize(
            measuredWidth + outline * 2,
            (lines.length + 0.26) * lineHeight + outline * 2,
        );
    }
}
Label.HorizontalAlign = { LEFT: 0, CENTER: 1, RIGHT: 2 };
Label.VerticalAlign = { TOP: 0, CENTER: 1, BOTTOM: 2 };
Label.Overflow = { NONE: 0, CLAMP: 1, RESIZE_HEIGHT: 2 };

class RichText extends Component {}
RichText.HorizontalAlign = { LEFT: 0, CENTER: 1, RIGHT: 2 };
RichText.VerticalAlign = { TOP: 0, CENTER: 1, BOTTOM: 2 };
class TTFFont {
    constructor() {
        this.width = 24;
        this.height = 16;
        this.widthFactor = 0.75;
    }
}
class BitmapFont {}

class Mask extends Component {}
Mask.Type = { GRAPHICS_RECT: 0, GRAPHICS_ELLIPSE: 1, ELLIPSE: 1, RECT: 0 };

class Canvas extends Component {}
class Camera extends Component {}
class LabelOutline extends Component {}
class Layout extends Component {
    updateLayout() {}
}
Layout.Type = { HORIZONTAL: 0, VERTICAL: 1, GRID: 2 };
Layout.AxisDirection = { HORIZONTAL: 0, VERTICAL: 1 };
Layout.ResizeMode = { NONE: 0 };
class ScrollView extends Component {
    get content() {
        return this._content ?? null;
    }

    set content(value) {
        if (value && typeof value.getComponent !== 'function') {
            return;
        }
        this._content = value;
    }

    get view() {
        return this._content?.parent?.getComponent(UITransform) ?? null;
    }
}
class Button extends Component {}
Button.Transition = { SCALE: 0 };
class Widget extends Component {}
Widget.AlignMode = { ALWAYS: 0 };
class UIOpacity extends Component {}

class FakeNode {
    constructor(name) {
        this.name = name;
        this.uuid = `node-${nextUuid++}`;
        this.children = [];
        this.components = [];
        this.layer = 0;
        this.active = true;
        this.scale = { x: 1, y: 1, z: 1 };
        this.euler = { x: 0, y: 0, z: 0 };
        this._parent = null;
        this.position = {
            x: 0,
            y: 0,
            z: 0,
            clone() {
                return { ...this };
            },
        };
    }

    get parent() {
        return this._parent;
    }

    set parent(value) {
        this.removeFromParent();
        this._parent = value;
        if (value && !value.children.includes(this)) {
            value.children.push(this);
        }
    }

    worldPosition() {
        let x = this.position.x;
        let y = this.position.y;
        let z = this.position.z;
        let ancestor = this._parent;
        while (ancestor) {
            x += ancestor.position.x;
            y += ancestor.position.y;
            z += ancestor.position.z;
            ancestor = ancestor.parent;
        }
        return { x, y, z };
    }

    setParent(value, keepWorldTransform = false) {
        const world = keepWorldTransform ? this.worldPosition() : null;
        this.parent = value;
        this.lastKeepWorldTransform = keepWorldTransform;
        if (world) {
            const parentWorld = value?.worldPosition?.() ?? { x: 0, y: 0, z: 0 };
            this.setPosition(
                world.x - parentWorld.x,
                world.y - parentWorld.y,
                world.z - parentWorld.z,
            );
        }
    }

    addChild(child) {
        child.parent = this;
        FakeNode.onAddChild?.(child);
    }

    removeFromParent() {
        if (this._parent) {
            this._parent.children = this._parent.children.filter((child) => child !== this);
        }
        this._parent = null;
    }

    destroy() {
        this.removeFromParent();
        if (FakeNode.deferNodeDestruction) {
            setTimeout(() => {
                for (const child of [...this.children]) {
                    child.destroy();
                }
                this.children = [];
                this.destroyed = true;
            }, 0);
        }
    }

    getChildByName(name) {
        return this.children.find((child) => child.name === name) ?? null;
    }

    setSiblingIndex(index) {
        if (!this._parent) {
            return;
        }
        this._parent.children = this._parent.children.filter((child) => child !== this);
        this._parent.children.splice(index, 0, this);
    }

    getComponent(Type) {
        return this.components.find((component) => component instanceof Type) ?? null;
    }

    addComponent(Type) {
        if ([Graphics, Sprite, Label, RichText].includes(Type)
            && this.components.some((component) =>
                component instanceof Graphics
                || component instanceof Sprite
                || component instanceof Label
                || component instanceof RichText)) {
            throw new Error(`render component conflict on ${this.name}`);
        }
        const component = new Type();
        component.node = this;
        this.components.push(component);
        FakeNode.onAddComponent?.(component);
        if (Type === Mask && !this.getComponent(Graphics)) {
            this.addComponent(Graphics);
        }
        return component;
    }

    removeComponent(value) {
        const remove = () => {
            if (value instanceof LabelOutline) {
                const label = this.getComponent(Label);
                if (label) {
                    label.enableOutline = false;
                }
            }
            if (value instanceof Mask) {
                const graphics = this.getComponent(Graphics);
                if (graphics) {
                    graphics.enabled = false;
                }
            }
            this.components = this.components.filter((component) =>
                component !== value
                && !(typeof value === 'function' && component instanceof value));
        };
        if (value instanceof Label && this.getComponent(LabelOutline)) {
            return;
        }
        if (FakeNode.deferComponentRemoval) {
            setTimeout(remove, 0);
        } else {
            remove();
        }
    }

    setPosition(value, y = 0, z = 0) {
        this.position = typeof value === 'object'
            ? { x: value.x, y: value.y, z: value.z ?? 0, clone: this.position.clone }
            : { x: value, y, z, clone: this.position.clone };
    }

    setRotationFromEuler(x, y, z) {
        this.euler = { x, y, z };
    }

    setScale(value, y = 1, z = 1) {
        this.scale = typeof value === 'object'
            ? { x: value.x, y: value.y, z: value.z ?? 1 }
            : { x: value, y, z };
    }
}
FakeNode.deferComponentRemoval = false;
FakeNode.deferNodeDestruction = false;
FakeNode.onAddChild = null;
FakeNode.onAddComponent = null;

function makeSpec(overrides = {}) {
    return {
        figmaId: overrides.figmaId ?? '15:193',
        name: overrides.name ?? 'Layer',
        figmaType: overrides.figmaType ?? 'FRAME',
        action: overrides.action ?? 'generate',
        kind: overrides.kind ?? 'node',
        frame: overrides.frame ?? { x: 0, y: 0, width: 100, height: 80 },
        intrinsicSize: overrides.intrinsicSize,
        isRoot: overrides.isRoot,
        relativeTransform: overrides.relativeTransform,
        rotation: overrides.rotation ?? 0,
        opacity: overrides.opacity ?? 1,
        visible: overrides.visible ?? true,
        clipsContent: overrides.clipsContent ?? false,
        cornerRadii: [0, 0, 0, 0],
        fills: overrides.fills ?? [],
        strokes: overrides.strokes ?? [],
        strokeWeight: overrides.strokeWeight ?? 0,
        layout: {
            itemSpacing: 0,
            counterSpacing: 0,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
            ...(overrides.layout ?? {}),
        },
        children: overrides.children ?? [],
        sprite: overrides.sprite,
        aliasFigmaIds: overrides.aliasFigmaIds,
        flattenBoundary: overrides.flattenBoundary,
        overflowDirection: overrides.overflowDirection,
        characters: overrides.characters,
        textStyle: overrides.textStyle,
        fontUuid: overrides.fontUuid,
    };
}

function fakeCocos() {
    const scene = new FakeNode('Scene');
    const canvas = new FakeNode('Canvas');
    canvas.addComponent(Canvas);
    const canvasTransform = canvas.addComponent(UITransform);
    canvasTransform.setAnchorPoint(0.5, 0.5);
    canvasTransform.setContentSize(640, 1136);
    scene.addChild(canvas);
    return {
        scene,
        canvas,
        cc: {
            director: { getScene: () => scene },
            Node: FakeNode,
            UITransform,
            Canvas,
            Camera,
            Graphics,
            Sprite,
            Label,
            RichText,
            TTFFont,
            BitmapFont,
            LabelOutline,
            Layout,
            ScrollView,
            Mask,
            Button,
            Widget,
            UIOpacity,
            Vec3: class Vec3 {
                constructor(x, y, z) {
                    this.x = x;
                    this.y = y;
                    this.z = z;
                }
            },
            Color: class Color {
                constructor(r = 0, g = 0, b = 0, a = 255) {
                    this.r = r;
                    this.g = g;
                    this.b = b;
                    this.a = a;
                }
            },
            Size: class Size {},
            assetManager: {
                loadAny(request, callback) {
                    if (request.uuid === 'bitmap-font') {
                        callback(null, new BitmapFont());
                        return;
                    }
                    if (request.uuid === 'mapped-font') {
                        callback(null, new TTFFont());
                        return;
                    }
                    const trimmed = request.uuid === 'trimmed-sprite-frame';
                    callback(null, {
                        width: 24,
                        height: 16,
                        rect: { width: 24, height: 16 },
                        originalSize: trimmed
                            ? { width: 30, height: 20 }
                            : { width: 24, height: 16 },
                    });
                },
            },
        },
    };
}

global.Editor = {
    App: { path: process.cwd() },
    Message: { send() {} },
};

const { methods } = require('../dist/scene');

async function importWithFakeCocos(spec) {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const result = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: { x: 0, y: 0, width: 100, height: 80 },
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [spec],
        });
        return { ...environment, result };
    } finally {
        Module._load = originalLoad;
    }
}

async function importWithPrefabContext(environment, spec, prefabContext) {
    const originalLoad = Module._load;
    const originalCce = global.cce;
    const prefabRoot = environment.canvas;
    let nextFileId = environment.nextFileId ?? 1;
    global.cce = {
        SceneFacadeManager: {
            queryMode: () => 'prefab',
            queryCurrentSceneUuid: () => environment.reportedPrefabUuid ?? prefabContext.prefabUuid,
        },
        Scene: { rootNode: prefabRoot },
        Prefab: {
            onAddNode(node) {
                node._prefab ??= {
                    fileId: `managedNodeFile${nextFileId++}`,
                    root: prefabRoot,
                    asset: { uuid: prefabContext.prefabUuid },
                };
            },
            onAddComponent(component) {
                component.__prefab ??= { fileId: `managedCompFile${nextFileId++}` };
            },
        },
    };
    const originalOnAddChild = FakeNode.onAddChild;
    const originalOnAddComponent = FakeNode.onAddComponent;
    if (environment.autoAssignPrefabInfo) {
        FakeNode.onAddChild = (node) => global.cce.Prefab.onAddNode(node);
        FakeNode.onAddComponent = (component) => global.cce.Prefab.onAddComponent(component);
    }
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const result = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Prefab',
            rootFrame: spec.frame,
            scale: 1,
            updateExisting: true,
            existingMap: {},
            roots: [spec],
            prefabContext,
        });
        environment.nextFileId = nextFileId;
        return result;
    } finally {
        FakeNode.onAddChild = originalOnAddChild;
        FakeNode.onAddComponent = originalOnAddComponent;
        Module._load = originalLoad;
        global.cce = originalCce;
    }
}

test('does not add a clipping Mask to a terminal Sprite layer', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        action: 'render',
        kind: 'sprite',
        clipsContent: true,
        sprite: { uuid: 'sprite-frame', url: 'db://assets/red.png', sliced: false },
    }));
    const imported = environment.canvas.children[0];

    assert.ok(imported.getComponent(Sprite));
    assert.equal(imported.getComponent(Mask), null);
    assert.equal(imported.getComponent(Graphics), null);
});

test('normalizes legacy merge and svg SceneSpecs to terminal Sprite or Button nodes', async () => {
    const cases = [
        {
            action: 'merge',
            kind: 'scrollView',
            figmaType: 'FRAME',
            expectedButton: false,
        },
        {
            action: 'svg',
            kind: 'button',
            figmaType: 'FRAME',
            expectedButton: true,
        },
        {
            action: 'merge',
            kind: 'label',
            figmaType: 'TEXT',
            expectedButton: false,
        },
    ];
    for (const [index, legacy] of cases.entries()) {
        const childId = `legacy-child-${index}`;
        const environment = await importWithFakeCocos(makeSpec({
            figmaId: `legacy-root-${index}`,
            name: `Legacy ${legacy.action}`,
            action: legacy.action,
            kind: legacy.kind,
            figmaType: legacy.figmaType,
            layout: { mode: 'VERTICAL' },
            sprite: { uuid: `legacy-sprite-${index}`, url: `db://assets/legacy-${index}.png`, sliced: false },
            children: [makeSpec({ figmaId: childId, name: 'MustNotImport' })],
        }));
        const imported = environment.canvas.children[0];

        assert.ok(imported.getComponent(Sprite), `${legacy.action} should use Sprite`);
        assert.equal(imported.getComponent(Label), null);
        assert.equal(imported.getComponent(Graphics), null);
        assert.equal(imported.getComponent(ScrollView), null);
        assert.equal(imported.getComponent(Layout), null);
        assert.equal(Boolean(imported.getComponent(Button)), legacy.expectedButton);
        assert.equal(imported.children.length, 0);
        assert.equal(environment.result.nodeMap[childId], undefined);
    }
});

test('does not build descendants carried by a terminal transform SceneSpec', async () => {
    const childId = 'transform-child';
    const environment = await importWithFakeCocos(makeSpec({
        figmaId: 'transform-root',
        name: 'TransformOnly',
        action: 'transform',
        kind: 'node',
        children: [makeSpec({ figmaId: childId, name: 'MustNotImport' })],
    }));
    const imported = environment.canvas.children[0];

    assert.equal(imported.children.length, 0);
    assert.equal(environment.result.nodeMap[childId], undefined);
});

test('imports Figma vector nodes as Sprite instead of Graphics', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        figmaType: 'VECTOR',
        action: 'render',
        kind: 'sprite',
        sprite: { uuid: 'vector-frame', url: 'db://assets/vector.png', sliced: false },
    }));
    const imported = environment.canvas.children[0];

    assert.ok(imported.getComponent(Sprite));
    assert.equal(imported.getComponent(Graphics), null);
});

test('keeps a structural container as UITransform only', async () => {
    const environment = await importWithFakeCocos(makeSpec());
    const imported = environment.canvas.children[0];

    assert.ok(imported.getComponent(UITransform));
    assert.equal(imported.getComponent(Graphics), null);
    assert.equal(imported.components.length, 1);
});

test('removes Graphics when an existing visual node becomes a structural container', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const visual = makeSpec({
            fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
        });
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: visual.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [visual],
        });
        const imported = environment.canvas.children[0];
        assert.ok(imported.getComponent(Graphics));

        const structural = makeSpec();
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: structural.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [structural],
        });

        assert.equal(imported.getComponent(Graphics), null);
        assert.ok(imported.getComponent(UITransform));
        assert.equal(imported.components.length, 1);
    } finally {
        Module._load = originalLoad;
    }
});

test('adds Graphics only for a visible solid fill or a valid solid stroke', async () => {
    const cases = [
        {
            name: 'visible solid fill',
            overrides: {
                fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0 } }],
            },
            expected: true,
        },
        {
            name: 'visible solid stroke',
            overrides: {
                strokes: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0 } }],
                strokeWeight: 2,
            },
            expected: true,
        },
        {
            name: 'hidden fill',
            overrides: {
                fills: [{ type: 'SOLID', visible: false, color: { r: 1, g: 0, b: 0 } }],
            },
            expected: false,
        },
        {
            name: 'transparent fill',
            overrides: {
                fills: [{ type: 'SOLID', opacity: 0, color: { r: 1, g: 0, b: 0 } }],
            },
            expected: false,
        },
        {
            name: 'transparent fill color',
            overrides: {
                fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 0 } }],
            },
            expected: false,
        },
        {
            name: 'non-solid fill',
            overrides: {
                fills: [{ type: 'GRADIENT_LINEAR', visible: true }],
            },
            expected: false,
        },
        {
            name: 'zero-width stroke',
            overrides: {
                strokes: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0 } }],
                strokeWeight: 0,
            },
            expected: false,
        },
        {
            name: 'stroke without color',
            overrides: {
                strokes: [{ type: 'SOLID', visible: true }],
                strokeWeight: 2,
            },
            expected: false,
        },
    ];

    for (const [index, entry] of cases.entries()) {
        const environment = await importWithFakeCocos(makeSpec({
            figmaId: `graphics-case-${index}`,
            name: entry.name,
            ...entry.overrides,
        }));
        const imported = environment.canvas.children[0];
        assert.equal(Boolean(imported.getComponent(Graphics)), entry.expected, entry.name);
    }
});

test('keeps Graphics when a structural container needs Mask clipping', async () => {
    const root = makeSpec({
        clipsContent: true,
        children: [makeSpec({ figmaId: 'mask-child' })],
    });
    root.children[0].parentFrame = root.frame;
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];

    assert.ok(imported.getComponent(Mask));
    assert.ok(imported.getComponent(Graphics));
});

test('does not auto-create Widget for Figma constraints', async () => {
    const spec = makeSpec({
        frame: { x: 10, y: 12, width: 40, height: 24 },
    });
    spec.constraints = { horizontal: 'MIN', vertical: 'MIN' };
    const environment = await importWithFakeCocos(spec);
    const imported = environment.canvas.children[0];

    assert.equal(imported.getComponent(Widget), null);
});

test('imports hidden Figma layers with their full subtree and keeps only hidden nodes inactive', async () => {
    const text = makeSpec({
        figmaId: 'inactive:text',
        name: 'txt_inactive_child',
        figmaType: 'TEXT',
        kind: 'label',
        frame: { x: 20, y: 20, width: 100, height: 24 },
        characters: '稍后显示',
        textStyle: { fontSize: 18, lineHeightPx: 22 },
        visible: true,
    });
    const hiddenPanel = makeSpec({
        figmaId: 'inactive:panel',
        name: 'panel_inactive',
        frame: { x: 10, y: 10, width: 140, height: 60 },
        visible: false,
        children: [text],
    });
    const root = makeSpec({
        figmaId: 'inactive:root',
        name: 'InactiveRoot',
        frame: { x: 0, y: 0, width: 200, height: 100 },
        children: [hiddenPanel],
    });
    hiddenPanel.parentFrame = root.frame;
    text.parentFrame = hiddenPanel.frame;

    const environment = await importWithFakeCocos(root);
    const importedRoot = environment.canvas.children[0];
    const importedPanel = importedRoot.children[0];
    const importedText = importedPanel.children[0];

    assert.equal(importedPanel.name, 'panel_inactive');
    assert.equal(importedPanel.active, false);
    assert.equal(importedText.name, 'txt_inactive_child');
    assert.equal(importedText.active, true);
    assert.ok(importedText.getComponent(Label));
});

test('expands a single-line Label equally on both sides by its outline width', async () => {
    const root = makeSpec({
        name: 'TextRoot',
        frame: { x: 0, y: 0, width: 200, height: 80 },
        children: [makeSpec({
            figmaId: '15:196',
            name: 'Title',
            figmaType: 'TEXT',
            kind: 'label',
            frame: { x: 50, y: 5, width: 100, height: 20 },
        })],
    });
    root.children[0].parentFrame = root.frame;
    root.children[0].characters = '标题';
    root.children[0].textStyle = {
        fontSize: 16,
        lineHeightPx: 18,
        textAlignHorizontal: 'CENTER',
        textAlignVertical: 'CENTER',
        textAutoResize: 'NONE',
    };
    root.children[0].strokes = [{
        type: 'SOLID',
        visible: true,
        color: { r: 1, g: 0, b: 0, a: 1 },
    }];
    root.children[0].strokeWeight = 5;
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];
    const title = imported.children[0];
    const label = title.getComponent(Label);
    const transform = title.getComponent(UITransform);

    assert.ok(label);
    assert.equal(title.getComponent(LabelOutline), null);
    assert.equal(label.enableOutline, true);
    assert.equal(label.outlineWidth, 5);
    assert.equal(label.overflow, Label.Overflow.CLAMP);
    assert.equal(label.enableWrapText, false);
    assert.equal(label.horizontalAlign, Label.HorizontalAlign.CENTER);
    assert.equal(label.verticalAlign, Label.VerticalAlign.CENTER);
    assert.equal(label.lineHeight, 18);
    assert.deepEqual(transform.contentSize, { width: 110, height: 20 });
    assert.deepEqual(
        { x: title.position.x, y: title.position.y },
        { x: 0, y: 25 },
    );
    assert.equal(title.position.x - transform.width / 2, -55);
    assert.equal(title.position.x + transform.width / 2, 55);
});

test('expands an undersized Label vertically to font size plus both outline widths', async () => {
    const root = makeSpec({
        name: 'TextRoot',
        frame: { x: 0, y: 0, width: 200, height: 80 },
        children: [makeSpec({
            figmaId: '15:196:height',
            name: 'ShortTitle',
            figmaType: 'TEXT',
            kind: 'label',
            frame: { x: 50, y: 10, width: 100, height: 12 },
        })],
    });
    root.children[0].parentFrame = root.frame;
    root.children[0].characters = '标题';
    root.children[0].textStyle = {
        fontSize: 16,
        lineHeightPx: 18,
        textAlignHorizontal: 'CENTER',
        textAlignVertical: 'CENTER',
        textAutoResize: 'NONE',
    };
    root.children[0].strokes = [{
        type: 'SOLID',
        visible: true,
        color: { r: 1, g: 0, b: 0, a: 1 },
    }];
    root.children[0].strokeWeight = 5;
    const environment = await importWithFakeCocos(root);
    const title = environment.canvas.children[0].children[0];
    const label = title.getComponent(Label);
    const transform = title.getComponent(UITransform);

    assert.equal(label.fontSize, 16);
    assert.equal(label.outlineWidth, 5);
    assert.deepEqual(transform.contentSize, { width: 110, height: 26 });
    assert.deepEqual(
        { x: title.position.x, y: title.position.y },
        { x: 0, y: 24 },
    );
    assert.equal(title.position.y - transform.height / 2, 11);
    assert.equal(title.position.y + transform.height / 2, 37);
});

test('keeps a multiline Label at the Figma frame size', async () => {
    const root = makeSpec({
        name: 'TextRoot',
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:197',
            name: 'Description',
            figmaType: 'TEXT',
            kind: 'label',
            frame: { x: 10, y: 5, width: 40, height: 40 },
        })],
    });
    root.children[0].parentFrame = root.frame;
    root.children[0].characters = '第一行\r\n第二行';
    root.children[0].textStyle = {
        fontSize: 16,
        lineHeightPx: 18,
        textAutoResize: 'HEIGHT',
    };
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];
    const description = imported.children[0];
    const label = description.getComponent(Label);
    const transform = description.getComponent(UITransform);

    assert.equal(label.overflow, Label.Overflow.CLAMP);
    assert.equal(label.enableWrapText, false);
    assert.equal(label.horizontalAlign, Label.HorizontalAlign.LEFT);
    assert.equal(label.verticalAlign, Label.VerticalAlign.TOP);
    assert.equal(label.string, '第一行\n第二行');
    assert.equal(transform.width, 40);
    assert.equal(transform.height, 40);
    assert.equal(description.position.x - transform.width / 2, -40);
    assert.ok(Math.abs(description.position.y + transform.height / 2 - 35) < 1e-9);
});

test('does not misclassify a single line from maxLines or a tall Figma frame', async () => {
    const root = makeSpec({
        name: 'TextRoot',
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:198',
            name: 'TallTitle',
            figmaType: 'TEXT',
            kind: 'label',
            frame: { x: 10, y: 5, width: 60, height: 40 },
        })],
    });
    root.children[0].parentFrame = root.frame;
    root.children[0].characters = '仍是单行';
    root.children[0].textStyle = {
        fontSize: 16,
        lineHeightPx: 18,
        textAutoResize: 'HEIGHT',
        maxLines: 3,
    };
    const environment = await importWithFakeCocos(root);
    const title = environment.canvas.children[0].children[0];
    const label = title.getComponent(Label);

    assert.equal(label.horizontalAlign, Label.HorizontalAlign.CENTER);
    assert.equal(label.verticalAlign, Label.VerticalAlign.CENTER);
    assert.deepEqual(
        { x: title.position.x, y: title.position.y },
        { x: -10, y: 15 },
    );
});

test('keeps a rotated multiline Label at the Figma frame size and position', async () => {
    const root = makeSpec({
        name: 'TextRoot',
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:199',
            name: 'RotatedDescription',
            figmaType: 'TEXT',
            kind: 'label',
            frame: { x: 10, y: 5, width: 40, height: 40 },
            rotation: 90,
        })],
    });
    const description = root.children[0];
    description.parentFrame = root.frame;
    description.characters = '第一行\n第二行';
    description.textStyle = { fontSize: 16, lineHeightPx: 18 };
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0].children[0];
    const transform = imported.getComponent(UITransform);

    assert.deepEqual(transform.contentSize, { width: 40, height: 40 });
    assert.deepEqual(
        { x: imported.position.x, y: imported.position.y },
        { x: -20, y: 15 },
    );
});

test('does not let a mapped font resize the Figma text frame', async () => {
    const root = makeSpec({
        name: 'TextRoot',
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:200',
            name: 'MappedDescription',
            figmaType: 'TEXT',
            kind: 'label',
            frame: { x: 10, y: 5, width: 40, height: 40 },
        })],
    });
    const description = root.children[0];
    description.parentFrame = root.frame;
    description.characters = '第一行\n第二行';
    description.textStyle = { fontSize: 16, lineHeightPx: 18 };
    description.fontUuid = 'mapped-font';
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0].children[0];
    const transform = imported.getComponent(UITransform);

    assert.equal(imported.getComponent(Label).font.widthFactor, 0.75);
    assert.equal(transform.width, 40);
    assert.equal(transform.height, 40);
    assert.equal(imported.position.x - transform.width / 2, -40);
    assert.equal(imported.position.y + transform.height / 2, 35);
});

test('does not import a __FigmaBackground child for clipped containers', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        clipsContent: true,
        fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0 } }],
        children: [makeSpec({
            figmaId: '15:194',
            name: 'Child',
            frame: { x: 0, y: 0, width: 40, height: 30 },
        })],
    }));
    const imported = environment.canvas.children[0];
    const background = imported.getChildByName('__FigmaBackground');

    assert.ok(imported.getComponent(Mask));
    assert.equal(imported.getComponent(Sprite), null);
    assert.equal(background, null);
});

test('keeps the Figma node size when an existing sliced SpriteFrame is assigned', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        action: 'render',
        kind: 'sprite',
        frame: { x: 0, y: 0, width: 180, height: 72 },
        sprite: { uuid: 'sprite-frame', url: 'db://assets/panel.png', sliced: true },
    }));
    const imported = environment.canvas.children[0];
    const transform = imported.getComponent(UITransform);
    const sprite = imported.getComponent(Sprite);

    assert.equal(sprite.type, Sprite.Type.SLICED);
    assert.equal(sprite.sizeMode, Sprite.SizeMode.CUSTOM);
    assert.deepEqual(transform.contentSize, { width: 180, height: 72 });
});

test('keeps an unscaled simple Sprite in TRIMMED size mode', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        action: 'render',
        kind: 'sprite',
        frame: { x: 0, y: 0, width: 24, height: 16 },
        sprite: { uuid: 'sprite-frame', url: 'db://assets/icon.png', sliced: false },
    }));
    const imported = environment.canvas.children[0];
    const transform = imported.getComponent(UITransform);
    const sprite = imported.getComponent(Sprite);

    assert.equal(sprite.type, Sprite.Type.SIMPLE);
    assert.equal(sprite.sizeMode, Sprite.SizeMode.TRIMMED);
    assert.deepEqual(transform.contentSize, { width: 24, height: 16 });
});

test('keeps TRIMMED when only transparent pixels make the SpriteFrame rect smaller', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        action: 'render',
        kind: 'sprite',
        frame: { x: 0, y: 0, width: 30, height: 20 },
        sprite: { uuid: 'trimmed-sprite-frame', url: 'db://assets/icon.png', sliced: false },
    }));
    const imported = environment.canvas.children[0];
    const transform = imported.getComponent(UITransform);
    const sprite = imported.getComponent(Sprite);

    assert.equal(sprite.sizeMode, Sprite.SizeMode.TRIMMED);
    assert.deepEqual(transform.contentSize, { width: 24, height: 16 });
});

test('scales the trimmed rect proportionally when the raw SpriteFrame was resized', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        action: 'render',
        kind: 'sprite',
        frame: { x: 0, y: 0, width: 60, height: 40 },
        sprite: { uuid: 'trimmed-sprite-frame', url: 'db://assets/icon.png', sliced: false },
    }));
    const imported = environment.canvas.children[0];
    const transform = imported.getComponent(UITransform);
    const sprite = imported.getComponent(Sprite);

    assert.equal(sprite.sizeMode, Sprite.SizeMode.CUSTOM);
    assert.deepEqual(transform.contentSize, { width: 48, height: 32 });
});

test('switches a resized simple Sprite to CUSTOM while preserving the Figma size', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        action: 'render',
        kind: 'sprite',
        frame: { x: 0, y: 0, width: 48, height: 32 },
        sprite: { uuid: 'sprite-frame', url: 'db://assets/icon.png', sliced: false },
    }));
    const imported = environment.canvas.children[0];
    const transform = imported.getComponent(UITransform);
    const sprite = imported.getComponent(Sprite);

    assert.equal(sprite.type, Sprite.Type.SIMPLE);
    assert.equal(sprite.sizeMode, Sprite.SizeMode.CUSTOM);
    assert.deepEqual(transform.contentSize, { width: 48, height: 32 });
});

test('preserves a non-uniform Figma resize as CUSTOM content size', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        action: 'render',
        kind: 'sprite',
        frame: { x: 0, y: 0, width: 48, height: 40 },
        sprite: { uuid: 'sprite-frame', url: 'db://assets/icon.png', sliced: false },
    }));
    const imported = environment.canvas.children[0];
    const transform = imported.getComponent(UITransform);
    const sprite = imported.getComponent(Sprite);

    assert.equal(sprite.sizeMode, Sprite.SizeMode.CUSTOM);
    assert.deepEqual(transform.contentSize, { width: 48, height: 40 });
});

test('uses Cocos tiled rendering for a Figma TILE image fill', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        action: 'render',
        kind: 'sprite',
        frame: { x: 0, y: 0, width: 180, height: 72 },
        sprite: { uuid: 'sprite-frame', url: 'db://assets/tile.png', sliced: true, tiled: true },
    }));
    const imported = environment.canvas.children[0];
    const transform = imported.getComponent(UITransform);
    const sprite = imported.getComponent(Sprite);

    assert.equal(sprite.type, Sprite.Type.TILED);
    assert.equal(sprite.sizeMode, Sprite.SizeMode.CUSTOM);
    assert.deepEqual(transform.contentSize, { width: 180, height: 72 });
});

test('clips an elliptical native tile with a Mask and a TILED Sprite helper', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        action: 'render',
        kind: 'sprite',
        figmaType: 'ELLIPSE',
        frame: { x: 0, y: 0, width: 163, height: 154 },
        sprite: {
            uuid: 'source-node-sprite-frame',
            url: 'db://assets/Ellipse 1__tile.png',
            sliced: false,
            tiled: true,
        },
    }));
    const imported = environment.canvas.children[0];
    const maskNode = imported.getChildByName('__FigmaTiledMask');
    const tiledNode = maskNode?.getChildByName('__FigmaTiledSprite');

    assert.equal(imported.getComponent(Sprite), null);
    assert.equal(imported.getComponent(Mask), null);
    assert.equal(imported.getComponent(Graphics), null);
    assert.ok(maskNode);
    assert.ok(maskNode.getComponent(Mask));
    assert.equal(maskNode.getComponent(Mask).type, Mask.Type.GRAPHICS_ELLIPSE);
    assert.ok(maskNode.getComponent(Graphics));
    assert.ok(tiledNode);
    assert.equal(tiledNode.getComponent(Sprite).type, Sprite.Type.TILED);
    assert.deepEqual(tiledNode.getComponent(UITransform).contentSize, { width: 163, height: 154 });
});

test('scales an IMAGE tile with an isolated helper without masking manual children', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        action: 'render',
        kind: 'sprite',
        figmaType: 'RECTANGLE',
        frame: { x: 0, y: 0, width: 180, height: 72 },
        sprite: {
            uuid: 'image-fill-sprite-frame',
            url: 'db://assets/tile.png',
            sliced: false,
            tiled: true,
            tileScale: 2,
        },
    }));
    const imported = environment.canvas.children[0];
    const tiledNode = imported.getChildByName('__FigmaTiledSprite');

    assert.equal(imported.getComponent(Sprite), null);
    assert.equal(imported.getComponent(Mask), null);
    assert.ok(tiledNode);
    assert.equal(tiledNode.getComponent(Sprite).type, Sprite.Type.TILED);
    assert.deepEqual(tiledNode.getComponent(UITransform).contentSize, { width: 90, height: 36 });
    assert.deepEqual(tiledNode.scale, { x: 2, y: 2, z: 1 });
});

test('keeps manual children outside the tile Mask and synchronizes helper layers on reimport', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const firstSpec = makeSpec({
            figmaId: '410:4754',
            name: 'Ellipse 1',
            figmaType: 'FRAME',
        });
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstSpec.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstSpec],
        });
        const imported = environment.canvas.children[0];
        imported.layer = 17;
        const manualChild = new FakeNode('ManualBadge');
        imported.addChild(manualChild);

        const secondSpec = makeSpec({
            figmaId: '410:4754',
            name: 'Ellipse 1',
            figmaType: 'ELLIPSE',
            action: 'render',
            kind: 'sprite',
            frame: { x: 0, y: 0, width: 163, height: 154 },
            sprite: {
                uuid: 'source-node-sprite-frame',
                url: 'db://assets/Ellipse 1__tile.png',
                sliced: false,
                tiled: true,
            },
        });
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondSpec.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondSpec],
        });
        const maskNode = imported.getChildByName('__FigmaTiledMask');
        const tiledNode = maskNode.getChildByName('__FigmaTiledSprite');

        assert.equal(manualChild.parent, imported);
        assert.equal(imported.getComponent(Mask), null);
        assert.equal(maskNode.layer, 17);
        assert.equal(tiledNode.layer, 17);
    } finally {
        Module._load = originalLoad;
    }
});

test('uses the outermost Figma Frame as the root and centers it on a 640x1136 Canvas', async () => {
    const environment = await importWithFakeCocos(makeSpec({
        name: 'PopupMaster',
        frame: { x: 0, y: 0, width: 180, height: 72 },
    }));
    const imported = environment.canvas.children[0];
    const transform = imported.getComponent(UITransform);

    assert.equal(imported.name, 'PopupMaster');
    assert.equal(imported.children.length, 0);
    assert.deepEqual(transform.contentSize, { width: 180, height: 72 });
    assert.deepEqual(
        { x: imported.position.x, y: imported.position.y },
        { x: 0, y: 0 },
    );
    assert.deepEqual(transform.anchorPoint, { x: 0.5, y: 0.5 });
    assert.equal(environment.result.temporaryRoot, true);
});

test('imports the right common_xian_01 as an exact 180-degree local transform', async () => {
    const root = makeSpec({
        name: 'PopupHongbaoView',
        isRoot: true,
        intrinsicSize: { width: 400, height: 100 },
        frame: { x: 1000, y: 500, width: 400, height: 100 },
        children: [makeSpec({
            figmaId: '231:common-right',
            name: 'common_xian_01',
            kind: 'sprite',
            intrinsicSize: { width: 68, height: 17 },
            frame: { x: 1328, y: 541.5, width: 68, height: 17 },
            relativeTransform: [
                [-1, 0, 396],
                [0, -1, 58.5],
            ],
            rotation: 180,
        })],
    });
    root.children[0].parentFrame = root.frame;

    const environment = await importWithFakeCocos(root);
    const importedRoot = environment.canvas.children[0];
    const line = importedRoot.children[0];

    assert.deepEqual(line.getComponent(UITransform).contentSize, { width: 68, height: 17 });
    assert.deepEqual({ x: line.position.x, y: line.position.y }, { x: 162, y: 0 });
    assert.deepEqual(line.euler, { x: 0, y: 0, z: 180 });
});

test('keeps nested rotated nodes in their Figma parent-local coordinate systems', async () => {
    const child = makeSpec({
        figmaId: 'rotation:child',
        name: 'NestedChild',
        intrinsicSize: { width: 20, height: 10 },
        frame: { x: 0, y: 0, width: 20, height: 10 },
        relativeTransform: [[1, 0, 10], [0, 1, 20]],
        rotation: 0,
    });
    const parent = makeSpec({
        figmaId: 'rotation:parent',
        name: 'RotatedParent',
        intrinsicSize: { width: 100, height: 80 },
        frame: { x: 0, y: 0, width: 80, height: 100 },
        relativeTransform: [[0, 1, 110], [-1, 0, 200]],
        rotation: 90,
        children: [child],
    });
    const root = makeSpec({
        name: 'RotationRoot',
        isRoot: true,
        intrinsicSize: { width: 300, height: 300 },
        frame: { x: 0, y: 0, width: 300, height: 300 },
        children: [parent],
    });
    parent.parentFrame = root.frame;
    child.parentFrame = parent.frame;

    const environment = await importWithFakeCocos(root);
    const importedParent = environment.canvas.children[0].children[0];
    const importedChild = importedParent.children[0];

    assert.deepEqual(importedParent.getComponent(UITransform).contentSize, { width: 100, height: 80 });
    assert.deepEqual({ x: importedParent.position.x, y: importedParent.position.y }, { x: 0, y: 0 });
    assert.equal(importedParent.euler.z, 90);
    assert.deepEqual({ x: importedChild.position.x, y: importedChild.position.y }, { x: -30, y: 15 });
});

test('converts child nodes to center anchors without changing their Figma placement', async () => {
    const root = makeSpec({
        name: 'PopupMaster',
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:194',
            name: 'Icon',
            frame: { x: 10, y: 5, width: 20, height: 10 },
        })],
    });
    root.children[0].parentFrame = root.frame;
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];
    const child = imported.children[0];

    assert.deepEqual(imported.getComponent(UITransform).anchorPoint, { x: 0.5, y: 0.5 });
    assert.deepEqual(child.getComponent(UITransform).anchorPoint, { x: 0.5, y: 0.5 });
    assert.deepEqual(
        { x: child.position.x, y: child.position.y },
        { x: -30, y: 30 },
    );
});

test('uses center anchors for ScrollView helpers without changing child placement', async () => {
    const root = makeSpec({
        name: 'Scroll',
        kind: 'scrollView',
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:195',
            name: 'Item',
            frame: { x: 10, y: 5, width: 20, height: 10 },
        })],
    });
    root.children[0].parentFrame = root.frame;
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];
    const view = imported.getChildByName('view');
    const content = view.getChildByName('content');
    const child = content.children[0];
    const scroll = imported.getComponent(ScrollView);

    assert.deepEqual(imported.getComponent(UITransform).anchorPoint, { x: 0.5, y: 0.5 });
    assert.deepEqual(view.getComponent(UITransform).anchorPoint, { x: 0.5, y: 0.5 });
    assert.deepEqual(content.getComponent(UITransform).anchorPoint, { x: 0.5, y: 0.5 });
    assert.deepEqual(
        { x: view.position.x, y: view.position.y },
        { x: 0, y: 0 },
    );
    assert.deepEqual(
        { x: content.position.x, y: content.position.y },
        { x: 0, y: 0 },
    );
    assert.equal(scroll.content, content);
    assert.equal(scroll.view, view.getComponent(UITransform));
    assert.deepEqual(child.getComponent(UITransform).anchorPoint, { x: 0.5, y: 0.5 });
    assert.deepEqual(
        { x: child.position.x, y: child.position.y },
        { x: -30, y: 30 },
    );
});

test('keeps an oversized centered ScrollView content aligned to the viewport top-left', async () => {
    const root = makeSpec({
        name: 'Scroll',
        kind: 'scrollView',
        overflowDirection: 'HORIZONTAL_AND_VERTICAL_SCROLLING',
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:196',
            name: 'Overflow item',
            frame: { x: 90, y: 70, width: 30, height: 30 },
        })],
    });
    root.children[0].parentFrame = root.frame;
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];
    const view = imported.getChildByName('view');
    const content = view.getChildByName('content');
    const child = content.children[0];

    assert.deepEqual(content.getComponent(UITransform).contentSize, { width: 120, height: 100 });
    assert.deepEqual(
        { x: content.position.x, y: content.position.y },
        { x: 10, y: -10 },
    );
    assert.deepEqual(
        { x: child.position.x, y: child.position.y },
        { x: 45, y: -35 },
    );
    assert.deepEqual(
        {
            x: content.position.x + child.position.x,
            y: content.position.y + child.position.y,
        },
        { x: 55, y: -45 },
    );
});

test('does not expand the cross axis of a single-axis ScrollView', async () => {
    const root = makeSpec({
        name: 'VerticalScroll',
        kind: 'scrollView',
        overflowDirection: 'VERTICAL_SCROLLING',
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:197',
            name: 'Clipped item',
            frame: { x: 90, y: 70, width: 30, height: 30 },
        })],
    });
    root.children[0].parentFrame = root.frame;
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];
    const view = imported.getChildByName('view');
    const content = view.getChildByName('content');
    const scroll = imported.getComponent(ScrollView);

    assert.deepEqual(content.getComponent(UITransform).contentSize, { width: 100, height: 100 });
    assert.deepEqual(
        { x: content.position.x, y: content.position.y },
        { x: 0, y: -10 },
    );
    assert.equal(scroll.horizontal, false);
    assert.equal(scroll.vertical, true);
});

test('supports a horizontal-only ScrollView without expanding its vertical axis', async () => {
    const root = makeSpec({
        name: 'HorizontalScroll',
        kind: 'scrollView',
        overflowDirection: 'HORIZONTAL_SCROLLING',
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:199',
            name: 'Clipped item',
            frame: { x: 90, y: 70, width: 30, height: 30 },
        })],
    });
    root.children[0].parentFrame = root.frame;
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];
    const content = imported.getChildByName('view').getChildByName('content');
    const scroll = imported.getComponent(ScrollView);

    assert.deepEqual(content.getComponent(UITransform).contentSize, { width: 120, height: 80 });
    assert.deepEqual(
        { x: content.position.x, y: content.position.y },
        { x: 10, y: 0 },
    );
    assert.equal(scroll.horizontal, true);
    assert.equal(scroll.vertical, false);
});

test('uses the centered content size for ScrollView counter-axis alignment', async () => {
    const root = makeSpec({
        name: 'BothAxesScroll',
        kind: 'scrollView',
        overflowDirection: 'HORIZONTAL_AND_VERTICAL_SCROLLING',
        layout: {
            mode: 'VERTICAL',
            paddingLeft: 90,
            counterAlign: 'MIN',
        },
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:198',
            name: 'Wide offset item',
            frame: { x: 90, y: 70, width: 30, height: 30 },
        })],
    });
    root.children[0].parentFrame = root.frame;
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];
    const content = imported.getChildByName('view').getChildByName('content');
    const child = content.children[0];

    assert.deepEqual(content.getComponent(UITransform).contentSize, { width: 120, height: 100 });
    assert.equal(child.position.x, 45);
    assert.equal(content.position.x + child.position.x, 55);
});

test('keeps CENTER counter-alignment relative to the Figma viewport after content expansion', async () => {
    const root = makeSpec({
        name: 'CenteredBothAxesScroll',
        kind: 'scrollView',
        overflowDirection: 'HORIZONTAL_AND_VERTICAL_SCROLLING',
        layout: {
            mode: 'VERTICAL',
            counterAlign: 'CENTER',
        },
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [
            makeSpec({
                figmaId: '15:201',
                name: 'Wide item',
                frame: { x: -10, y: 0, width: 120, height: 20 },
            }),
            makeSpec({
                figmaId: '15:202',
                name: 'Centered item',
                frame: { x: 40, y: 30, width: 20, height: 20 },
            }),
        ],
    });
    for (const child of root.children) {
        child.parentFrame = root.frame;
    }
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];
    const content = imported.getChildByName('view').getChildByName('content');
    const centered = content.children.find((child) => child.name === 'Centered item');

    assert.deepEqual(content.getComponent(UITransform).contentSize, { width: 110, height: 80 });
    assert.equal(content.position.x, 5);
    assert.equal(centered.position.x, -5);
    assert.equal(content.position.x + centered.position.x, 0);
});

test('reuses content Layout across reimports and clears it when auto-layout is removed', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    const firstRoot = makeSpec({
        figmaId: '15:220',
        name: 'Scroll',
        kind: 'scrollView',
        layout: { mode: 'VERTICAL' },
    });
    try {
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstRoot],
        });
        const imported = environment.canvas.children[0];
        const content = imported.getChildByName('view').getChildByName('content');
        const firstScroll = imported.getComponent(ScrollView);
        const firstLayout = content.getComponent(Layout);
        assert.ok(firstLayout);

        const secondRoot = makeSpec({
            figmaId: '15:220',
            name: 'Scroll',
            kind: 'scrollView',
            layout: { mode: 'HORIZONTAL' },
        });
        const second = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondRoot],
        });
        assert.equal(imported.getComponent(ScrollView), firstScroll);
        assert.equal(content.getComponent(Layout), firstLayout);
        assert.equal(firstLayout.type, Layout.Type.HORIZONTAL);

        const thirdRoot = makeSpec({
            figmaId: '15:220',
            name: 'Scroll',
            kind: 'scrollView',
        });
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: thirdRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: second.nodeMap,
            centerInCanvas: true,
            roots: [thirdRoot],
        });

        assert.equal(content.getComponent(Layout), null);
    } finally {
        Module._load = originalLoad;
    }
});

test('reuses ordinary Layout and Mask components across incremental imports', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    const makeClippedLayout = () => {
        const root = makeSpec({
            figmaId: '15:230',
            name: 'panel_list',
            clipsContent: true,
            layout: { mode: 'HORIZONTAL' },
            children: [makeSpec({
                figmaId: '15:231',
                name: 'Header',
                frame: { x: 0, y: 0, width: 100, height: 20 },
            })],
        });
        root.children[0].parentFrame = root.frame;
        return root;
    };
    try {
        const firstRoot = makeClippedLayout();
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstRoot],
        });
        const imported = environment.canvas.children[0];
        const firstMask = imported.getComponent(Mask);
        const firstGraphics = imported.getComponent(Graphics);
        const firstLayout = imported.getComponent(Layout);

        const secondRoot = makeClippedLayout();
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondRoot],
        });

        assert.equal(imported.getComponent(Mask), firstMask);
        assert.equal(imported.getComponent(Graphics), firstGraphics);
        assert.equal(imported.getComponent(Layout), firstLayout);
    } finally {
        Module._load = originalLoad;
    }
});

test('waits for Cocos deferred renderer removal before adding an incompatible renderer', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    FakeNode.deferComponentRemoval = true;
    try {
        const spriteRoot = makeSpec({
            figmaId: '15:240',
            name: 'ChangingRenderer',
            action: 'render',
            kind: 'sprite',
            sprite: { uuid: 'sprite-frame', url: 'db://assets/image.png', sliced: false },
        });
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: spriteRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [spriteRoot],
        });
        const imported = environment.canvas.children[0];
        assert.ok(imported.getComponent(Sprite));

        const graphicsRoot = makeSpec({
            figmaId: '15:240',
            name: 'ChangingRenderer',
            fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0 } }],
        });
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: graphicsRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [graphicsRoot],
        });

        assert.equal(imported.getComponent(Sprite), null);
        assert.ok(imported.getComponent(Graphics));
    } finally {
        FakeNode.deferComponentRemoval = false;
        Module._load = originalLoad;
    }
});

test('removes obsolete ScrollView helpers when a reimported node becomes a normal container', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    const firstRoot = makeSpec({
        figmaId: '15:210',
        name: 'list_rewards',
        kind: 'scrollView',
        children: [makeSpec({
            figmaId: '15:211',
            name: 'Reward',
            frame: { x: 10, y: 5, width: 20, height: 10 },
        })],
    });
    firstRoot.children[0].parentFrame = firstRoot.frame;
    try {
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstRoot],
        });
        const imported = environment.canvas.children[0];
        assert.ok(imported.getChildByName('view'));
        imported.getComponent(ScrollView)._content = null;
        const legacy = new FakeNode('__FigmaContent');
        imported.addChild(legacy);

        const secondRoot = makeSpec({
            figmaId: '15:210',
            name: 'list_rewards',
            kind: 'node',
            children: [makeSpec({
                figmaId: '15:211',
                name: 'Reward',
                frame: { x: 10, y: 5, width: 20, height: 10 },
            })],
        });
        secondRoot.children[0].parentFrame = secondRoot.frame;
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondRoot],
        });

        assert.equal(imported.getComponent(ScrollView), null);
        assert.equal(imported.getChildByName('view'), null);
        assert.equal(imported.getChildByName('__FigmaContent'), null);
        assert.equal(imported.children.length, 1);
        assert.equal(imported.children[0].name, 'Reward');
        assert.deepEqual(imported.children[0].getComponent(UITransform).anchorPoint, { x: 0.5, y: 0.5 });
        assert.deepEqual(
            { x: imported.children[0].position.x, y: imported.children[0].position.y },
            { x: -30, y: 30 },
        );
    } finally {
        Module._load = originalLoad;
    }
});

test('recreates Graphics after removing a deferred Mask so the renderer stays enabled', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const firstRoot = makeSpec({
            figmaId: '15:250',
            name: 'ClippedContainer',
            clipsContent: true,
            children: [makeSpec({ figmaId: '15:251', name: 'Child' })],
        });
        firstRoot.children[0].parentFrame = firstRoot.frame;
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstRoot],
        });
        const imported = environment.canvas.children[0];
        const oldGraphics = imported.getComponent(Graphics);
        assert.ok(imported.getComponent(Mask));
        assert.ok(oldGraphics);

        FakeNode.deferComponentRemoval = true;
        const secondRoot = makeSpec({
            figmaId: '15:250',
            name: 'ClippedContainer',
            fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0 } }],
            children: [makeSpec({ figmaId: '15:251', name: 'Child' })],
        });
        secondRoot.children[0].parentFrame = secondRoot.frame;
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondRoot],
        });

        const graphics = imported.getComponent(Graphics);
        assert.equal(imported.getComponent(Mask), null);
        assert.ok(graphics);
        assert.notEqual(graphics, oldGraphics);
        assert.equal(graphics.enabled, true);
    } finally {
        FakeNode.deferComponentRemoval = false;
        Module._load = originalLoad;
    }
});

test('waits for obsolete LabelOutline before configuring built-in Label outline', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const firstRoot = makeSpec({
            figmaId: '15:260',
            name: 'Title',
            figmaType: 'TEXT',
            kind: 'label',
            characters: '标题',
            textStyle: { fontSize: 18, lineHeightPx: 20 },
        });
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstRoot],
        });
        const imported = environment.canvas.children[0];
        const label = imported.getComponent(Label);
        imported.addComponent(LabelOutline);

        FakeNode.deferComponentRemoval = true;
        const secondRoot = makeSpec({
            figmaId: '15:260',
            name: 'Title',
            figmaType: 'TEXT',
            kind: 'label',
            characters: '标题',
            textStyle: { fontSize: 18, lineHeightPx: 20 },
            strokes: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0 } }],
            strokeWeight: 2,
        });
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondRoot],
        });

        assert.equal(imported.getComponent(Label), label);
        assert.equal(imported.getComponent(LabelOutline), null);
        assert.equal(label.enableOutline, true);
        assert.equal(label.outlineWidth, 2);
    } finally {
        FakeNode.deferComponentRemoval = false;
        Module._load = originalLoad;
    }
});

test('removes legacy LabelOutline before changing Label into Sprite', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const firstRoot = makeSpec({
            figmaId: '15:270',
            name: 'ChangingText',
            figmaType: 'TEXT',
            kind: 'label',
            characters: '旧文字',
            textStyle: { fontSize: 18, lineHeightPx: 20 },
        });
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstRoot],
        });
        const imported = environment.canvas.children[0];
        imported.addComponent(LabelOutline);

        FakeNode.deferComponentRemoval = true;
        const secondRoot = makeSpec({
            figmaId: '15:270',
            name: 'ChangingText',
            action: 'render',
            kind: 'sprite',
            sprite: { uuid: 'sprite-frame', url: 'db://assets/text.png', sliced: false },
        });
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondRoot],
        });

        assert.equal(imported.getComponent(LabelOutline), null);
        assert.equal(imported.getComponent(Label), null);
        assert.ok(imported.getComponent(Sprite));
    } finally {
        FakeNode.deferComponentRemoval = false;
        Module._load = originalLoad;
    }
});

test('resets reused Label state and keeps the updated Figma text frame', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const firstRoot = makeSpec({
            figmaId: '15:280',
            name: 'StatefulText',
            figmaType: 'TEXT',
            kind: 'label',
            characters: '文字',
            textStyle: { fontSize: 18, lineHeightPx: 20 },
            fontUuid: 'mapped-font',
            fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0 } }],
        });
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstRoot],
        });
        const imported = environment.canvas.children[0];
        const label = imported.getComponent(Label);
        assert.ok(label.font);
        assert.equal(label.color.r, 255);
        assert.equal(label.color.g, 0);

        const secondRoot = makeSpec({
            figmaId: '15:280',
            name: 'StatefulText',
            figmaType: 'TEXT',
            kind: 'label',
            frame: { x: 0, y: 0, width: 72, height: 36 },
            characters: '更长的文字\n第二行',
            textStyle: { fontSize: 18, lineHeightPx: 20 },
        });
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondRoot],
        });

        assert.equal(imported.getComponent(Label), label);
        assert.equal(label.font, null);
        assert.equal(label.overflow, Label.Overflow.CLAMP);
        assert.deepEqual(
            imported.getComponent(UITransform).contentSize,
            { width: 72, height: 36 },
        );
        assert.deepEqual(
            { r: label.color.r, g: label.color.g, b: label.color.b, a: label.color.a },
            { r: 255, g: 255, b: 255, a: 255 },
        );
    } finally {
        Module._load = originalLoad;
    }
});

test('creates an editable RichText placeholder without a Label renderer', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const root = makeSpec({
            figmaId: '15:310',
            name: 'txt_msg',
            kind: 'richText',
            frame: { x: 0, y: 0, width: 400, height: 28 },
            characters: '',
            textStyle: { fontSize: 20, lineHeightPx: 22 },
            fontUuid: 'mapped-font',
            fills: [{ type: 'SOLID', visible: true, color: { r: 0.47, g: 0.3, b: 0.23 } }],
        });
        await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: root.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [root],
        });
        const imported = environment.canvas.children[0];
        const richText = imported.getComponent(RichText);

        assert.ok(richText);
        assert.equal(imported.getComponent(Label), null);
        assert.equal(richText.string, '');
        assert.equal(richText.fontSize, 20);
        assert.equal(richText.lineHeight, 22);
        assert.equal(richText.maxWidth, 400);
        assert.equal(richText.horizontalAlign, RichText.HorizontalAlign.LEFT);
        assert.equal(richText.verticalAlign, RichText.VerticalAlign.TOP);
        assert.equal(richText.useSystemFont, false);
        assert.ok(richText.font);
        assert.deepEqual(imported.getComponent(UITransform).contentSize, { width: 400, height: 28 });
    } finally {
        Module._load = originalLoad;
    }
});

test('rejects a BitmapFont mapping for RichText with an actionable error', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') return environment.cc;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const root = makeSpec({
            figmaId: '15:310:bitmap',
            name: 'txt_msg',
            kind: 'richText',
            frame: { x: 0, y: 0, width: 400, height: 28 },
            characters: '内容',
            textStyle: { fontSize: 20, lineHeightPx: 22 },
            fontUuid: 'bitmap-font',
        });
        await assert.rejects(methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: root.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [root],
        }), /RichText.*TTF\/OTF.*BitmapFont/);
        assert.equal(environment.canvas.children.length, 0);
    } finally {
        Module._load = originalLoad;
    }
});

test('switches safely between Label and RichText renderers on repeated imports', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') return environment.cc;
        return originalLoad.call(this, request, parent, isMain);
    };
    const importRoot = (kind, existingMap = {}, updateExisting = false) => {
        const root = makeSpec({
            figmaId: '15:311',
            name: 'txt_msg',
            figmaType: 'TEXT',
            kind,
            characters: '内容',
            textStyle: { fontSize: 20, lineHeightPx: 22 },
        });
        return methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: root.frame,
            scale: 1,
            updateExisting,
            existingMap,
            centerInCanvas: true,
            roots: [root],
        });
    };
    try {
        const first = await importRoot('label');
        const imported = environment.canvas.children[0];
        assert.ok(imported.getComponent(Label));

        FakeNode.deferComponentRemoval = true;
        const second = await importRoot('richText', first.nodeMap, true);
        assert.equal(imported.getComponent(Label), null);
        assert.ok(imported.getComponent(RichText));

        await importRoot('label', second.nodeMap, true);
        assert.equal(imported.getComponent(RichText), null);
        assert.ok(imported.getComponent(Label));
    } finally {
        FakeNode.deferComponentRemoval = false;
        Module._load = originalLoad;
    }
});

test('maps folded Figma aliases onto one node for a fresh linked-prefab build', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const folded = makeSpec({
            figmaId: '15:320',
            aliasFigmaIds: ['15:321', '15:321', '', '__root__'],
            flattenBoundary: true,
            name: 'txt_title',
            kind: 'label',
            characters: '规则详情',
            children: [makeSpec({ figmaId: '15:321', name: 'MustNotBuild' })],
        });
        const result = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: folded.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            prefabUrl: 'db://assets/generated/PopupInstructionView.prefab',
            centerInCanvas: true,
            roots: [folded],
        });
        const imported = environment.canvas.children[0];

        assert.equal(result.nodeMap.__root__, imported.uuid);
        assert.equal(result.nodeMap['15:320'], imported.uuid);
        assert.equal(result.nodeMap['15:321'], imported.uuid);
        assert.equal(result.nodeMap[''], undefined);
        assert.equal(imported.getComponent(Label).string, '规则详情');
        assert.equal(imported.children.length, 0);
    } finally {
        Module._load = originalLoad;
    }
});

test('promotes one aliased background while retaining semantic siblings and manual nodes', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    const importRoot = (root, existingMap = {}, updateExisting = false) => methods.importDocument({
        packageName: 'figma-importer-cocos',
        fileKey: 'file-key',
        rootName: 'Test',
        rootFrame: root.frame,
        scale: 1,
        updateExisting,
        existingMap,
        centerInCanvas: true,
        roots: [root],
    });
    const labelSpec = () => makeSpec({
        figmaId: '15:343',
        name: 'txt_btns_0',
        figmaType: 'TEXT',
        kind: 'label',
        characters: '确定',
        frame: { x: 20, y: 15, width: 60, height: 30 },
    });
    const layeredSpec = () => {
        const background = makeSpec({
            figmaId: '15:342',
            name: 'common_btn_tyanniu_01',
        });
        const label = labelSpec();
        const root = makeSpec({
            figmaId: '15:341',
            name: 'btn_sure',
            children: [background, label],
        });
        background.parentFrame = root.frame;
        label.parentFrame = root.frame;
        return root;
    };
    const promotedSpec = () => {
        const label = labelSpec();
        const root = makeSpec({
            figmaId: '15:341',
            aliasFigmaIds: ['15:342'],
            flattenBoundary: false,
            name: 'btn_sure',
            kind: 'button',
            sprite: { uuid: 'button-bg', url: 'db://assets/button-bg.png', sliced: true },
            children: [label],
        });
        label.parentFrame = root.frame;
        return root;
    };
    try {
        const first = await importRoot(layeredSpec());
        const imported = environment.canvas.children[0];
        const oldBackground = imported.getChildByName('common_btn_tyanniu_01');
        const existingLabel = imported.getChildByName('txt_btns_0');
        const manualChild = new FakeNode('ManualBadge');
        oldBackground.addChild(manualChild);

        const second = await importRoot(promotedSpec(), first.nodeMap, true);

        assert.ok(imported.getComponent(Sprite));
        assert.ok(imported.getComponent(Button));
        assert.equal(oldBackground.parent, null);
        assert.equal(manualChild.parent, imported);
        assert.equal(imported.getChildByName('txt_btns_0'), existingLabel);
        assert.equal(second.nodeMap['15:341'], imported.uuid);
        assert.equal(second.nodeMap['15:342'], imported.uuid);
        assert.equal(second.nodeMap['15:343'], existingLabel.uuid);
        assert.equal(
            imported.children.filter((child) => child.name === 'txt_btns_0').length,
            1,
        );

        const third = await importRoot(promotedSpec(), second.nodeMap, true);

        assert.equal(third.created, 0);
        assert.equal(imported.getChildByName('txt_btns_0'), existingLabel);
        assert.equal(manualChild.parent, imported);

        const fourth = await importRoot(layeredSpec(), third.nodeMap, true);
        const expandedBackground = imported.getChildByName('common_btn_tyanniu_01');

        assert.ok(expandedBackground);
        assert.notEqual(expandedBackground, imported);
        assert.equal(imported.getComponent(Sprite), null);
        assert.equal(imported.getComponent(Button), null);
        assert.equal(imported.getChildByName('txt_btns_0'), existingLabel);
        assert.equal(manualChild.parent, imported);
        assert.notEqual(fourth.nodeMap['15:341'], fourth.nodeMap['15:342']);
        assert.equal(
            imported.children.filter((child) => child.name === 'common_btn_tyanniu_01').length,
            1,
        );
    } finally {
        Module._load = originalLoad;
    }
});

test('switches repeatedly between layered and folded Label specs without stale or duplicate nodes', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    const importRoot = (root, existingMap = {}, updateExisting = false) => methods.importDocument({
        packageName: 'figma-importer-cocos',
        fileKey: 'file-key',
        rootName: 'Test',
        rootFrame: root.frame,
        scale: 1,
        updateExisting,
        existingMap,
        centerInCanvas: true,
        roots: [root],
    });
    const layeredSpec = () => {
        const text = makeSpec({
            figmaId: '15:331',
            name: 'RawText',
            figmaType: 'TEXT',
            kind: 'label',
            frame: { x: 10, y: 8, width: 80, height: 24 },
            characters: '规则详情',
        });
        const root = makeSpec({
            figmaId: '15:330',
            name: 'txt_title',
            flattenBoundary: false,
            children: [text],
        });
        text.parentFrame = root.frame;
        return root;
    };
    const foldedSpec = (characters) => makeSpec({
        figmaId: '15:330',
        aliasFigmaIds: ['15:331'],
        flattenBoundary: true,
        name: 'txt_title',
        kind: 'label',
        characters,
        children: [],
    });
    try {
        const first = await importRoot(layeredSpec());
        const imported = environment.canvas.children[0];
        const oldText = imported.getChildByName('RawText');
        const manualChild = new FakeNode('ManualBadge');
        oldText.addChild(manualChild);

        const second = await importRoot(foldedSpec('折叠一'), first.nodeMap, true);

        assert.equal(oldText.parent, null);
        assert.equal(manualChild.parent, imported);
        assert.deepEqual(imported.children.map((child) => child.name), ['ManualBadge']);
        assert.equal(second.nodeMap['15:330'], imported.uuid);
        assert.equal(second.nodeMap['15:331'], imported.uuid);
        assert.equal(imported.getComponent(Label).string, '折叠一');

        const third = await importRoot(foldedSpec('折叠二'), second.nodeMap, true);

        assert.equal(third.created, 0);
        assert.equal(third.nodeMap['15:330'], imported.uuid);
        assert.equal(third.nodeMap['15:331'], imported.uuid);
        assert.deepEqual(imported.children.map((child) => child.name), ['ManualBadge']);
        assert.equal(imported.getComponent(Label).string, '折叠二');

        const fourth = await importRoot(layeredSpec(), third.nodeMap, true);
        const expandedText = imported.getChildByName('RawText');

        assert.ok(expandedText);
        assert.notEqual(expandedText, imported);
        assert.equal(imported.getComponent(Label), null);
        assert.ok(expandedText.getComponent(Label));
        assert.equal(manualChild.parent, imported);
        assert.notEqual(fourth.nodeMap['15:330'], fourth.nodeMap['15:331']);
        assert.equal(
            imported.children.filter((child) => child.name === 'RawText').length,
            1,
        );

        const fifth = await importRoot(layeredSpec(), fourth.nodeMap, true);

        assert.equal(fifth.created, 0);
        assert.equal(imported.getChildByName('RawText'), expandedText);
        assert.equal(
            imported.children.filter((child) => child.name === 'RawText').length,
            1,
        );
        assert.equal(manualChild.parent, imported);
    } finally {
        Module._load = originalLoad;
    }
});

test('removes stale imported descendants when a layered node becomes one PNG while preserving manual children', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const firstRoot = makeSpec({
            figmaId: '15:290',
            name: 'img_reward_bg',
            children: [makeSpec({
                figmaId: '15:291',
                name: 'Group 91',
                kind: 'scrollView',
                overflowDirection: 'VERTICAL_SCROLLING',
                frame: { x: 10, y: 10, width: 40, height: 30 },
                children: [makeSpec({
                    figmaId: '15:292',
                    name: 'OldGeneratedItem',
                    frame: { x: 10, y: 10, width: 20, height: 10 },
                })],
            })],
        });
        firstRoot.children[0].parentFrame = firstRoot.frame;
        firstRoot.children[0].children[0].parentFrame = firstRoot.children[0].frame;
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstRoot],
        });
        const imported = environment.canvas.children[0];
        const oldChild = imported.children[0];
        const oldView = oldChild.getChildByName('view');
        const oldContent = oldView.getChildByName('content');
        const manualChild = new FakeNode('ManualBadge');
        oldContent.addChild(manualChild);

        const secondRoot = makeSpec({
            figmaId: '15:290',
            name: 'img_reward_bg',
            action: 'render',
            kind: 'sprite',
            sprite: { uuid: 'whole-layer', url: 'db://assets/img_reward_bg.png', sliced: false },
            children: [],
        });
        const second = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondRoot],
        });

        assert.ok(imported.getComponent(Sprite));
        assert.equal(oldChild.parent, null);
        assert.equal(oldView.parent, null);
        assert.equal(oldContent.parent, null);
        assert.equal(manualChild.parent, imported);
        assert.deepEqual(imported.children.map((child) => child.name), ['ManualBadge']);
        assert.equal(second.nodeMap['15:291'], undefined);
        assert.equal(second.nodeMap['15:292'], undefined);
    } finally {
        Module._load = originalLoad;
    }
});

test('preserves manual children when the same nested ScrollView becomes one PNG', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const oldGeneratedSpec = makeSpec({
            figmaId: '15:312',
            name: 'OldGeneratedItem',
            frame: { x: 14, y: 14, width: 20, height: 10 },
        });
        const firstTarget = makeSpec({
            figmaId: '15:311',
            name: 'img_reward_bg',
            kind: 'scrollView',
            overflowDirection: 'VERTICAL_SCROLLING',
            frame: { x: 10, y: 10, width: 60, height: 40 },
            children: [oldGeneratedSpec],
        });
        const firstRoot = makeSpec({
            figmaId: '15:310',
            name: 'ScreenRoot',
            children: [firstTarget],
        });
        firstTarget.parentFrame = firstRoot.frame;
        oldGeneratedSpec.parentFrame = firstTarget.frame;
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstRoot],
        });
        const imported = environment.canvas.children[0];
        const target = imported.getChildByName('img_reward_bg');
        const oldView = target.getChildByName('view');
        const oldContent = oldView.getChildByName('content');
        const oldGenerated = oldContent.getChildByName('OldGeneratedItem');
        oldContent.setPosition(7, -9, 0);

        const manualChild = new FakeNode('ManualBadge');
        manualChild.setPosition(3, 4, 0);
        oldContent.addChild(manualChild);
        const manualWorldBefore = manualChild.worldPosition();

        const viewManual = new FakeNode('ViewOverlay');
        viewManual.setPosition(-5, 6, 0);
        oldView.addChild(viewManual);
        const viewManualWorldBefore = viewManual.worldPosition();

        const legacy = new FakeNode('__FigmaContent');
        legacy.setPosition(-6, 8, 0);
        target.addChild(legacy);
        const legacyManual = new FakeNode('LegacyManualBadge');
        legacyManual.setPosition(2, 5, 0);
        legacy.addChild(legacyManual);
        const legacyWorldBefore = legacyManual.worldPosition();

        const background = new FakeNode('__FigmaBackground');
        background.setPosition(4, -7, 0);
        target.addChild(background);
        const backgroundManual = new FakeNode('BackgroundManualBadge');
        backgroundManual.setPosition(8, 3, 0);
        background.addChild(backgroundManual);
        const backgroundManualWorldBefore = backgroundManual.worldPosition();

        const secondTarget = makeSpec({
            figmaId: '15:311',
            name: 'img_reward_bg',
            action: 'render',
            kind: 'sprite',
            frame: firstTarget.frame,
            sprite: { uuid: 'whole-layer', url: 'db://assets/img_reward_bg.png', sliced: false },
            children: [],
        });
        const secondRoot = makeSpec({
            figmaId: '15:310',
            name: 'ScreenRoot',
            children: [secondTarget],
        });
        secondTarget.parentFrame = secondRoot.frame;
        FakeNode.deferNodeDestruction = true;
        const second = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondRoot],
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.ok(target.getComponent(Sprite));
        assert.equal(target.getComponent(ScrollView), null);
        assert.equal(target.getChildByName('view'), null);
        assert.equal(target.getChildByName('__FigmaContent'), null);
        assert.equal(target.getChildByName('__FigmaBackground'), null);
        assert.equal(oldView.parent, null);
        assert.equal(oldContent.parent, null);
        assert.equal(legacy.parent, null);
        assert.equal(background.parent, null);
        assert.equal(oldGenerated.parent, null);
        assert.equal(oldGenerated.destroyed, true);
        assert.equal(background.destroyed, true);
        assert.equal(manualChild.parent, target);
        assert.equal(viewManual.parent, target);
        assert.equal(legacyManual.parent, target);
        assert.equal(backgroundManual.parent, target);
        assert.notEqual(manualChild.destroyed, true);
        assert.notEqual(viewManual.destroyed, true);
        assert.notEqual(legacyManual.destroyed, true);
        assert.notEqual(backgroundManual.destroyed, true);
        assert.equal(manualChild.lastKeepWorldTransform, true);
        assert.equal(viewManual.lastKeepWorldTransform, true);
        assert.equal(legacyManual.lastKeepWorldTransform, true);
        assert.equal(backgroundManual.lastKeepWorldTransform, true);
        assert.deepEqual(manualChild.worldPosition(), manualWorldBefore);
        assert.deepEqual(viewManual.worldPosition(), viewManualWorldBefore);
        assert.deepEqual(legacyManual.worldPosition(), legacyWorldBefore);
        assert.deepEqual(backgroundManual.worldPosition(), backgroundManualWorldBefore);
        assert.equal(second.nodeMap['15:312'], undefined);
    } finally {
        FakeNode.deferNodeDestruction = false;
        Module._load = originalLoad;
    }
});

test('does not delete an omitted mapped node outside a PNG whole-layer boundary', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const makeRoot = (includeOmitted) => {
            const children = [makeSpec({
                figmaId: '15:301',
                name: 'KeptLayer',
                frame: { x: 0, y: 0, width: 30, height: 20 },
            })];
            if (includeOmitted) {
                children.push(makeSpec({
                    figmaId: '15:302',
                    name: 'OmittedLayer',
                    frame: { x: 40, y: 0, width: 30, height: 20 },
                }));
            }
            const root = makeSpec({
                figmaId: '15:300',
                name: 'panel_content',
                children,
            });
            for (const child of root.children) {
                child.parentFrame = root.frame;
            }
            return root;
        };
        const firstRoot = makeRoot(true);
        const first = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: firstRoot.frame,
            scale: 1,
            updateExisting: false,
            existingMap: {},
            centerInCanvas: true,
            roots: [firstRoot],
        });
        const imported = environment.canvas.children[0];
        const omitted = imported.getChildByName('OmittedLayer');

        const secondRoot = makeRoot(false);
        const second = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: secondRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: first.nodeMap,
            centerInCanvas: true,
            roots: [secondRoot],
        });

        assert.equal(omitted.parent, imported);
        assert.equal(imported.getChildByName('OmittedLayer'), omitted);
        assert.equal(second.nodeMap['15:302'], omitted.uuid);

        const thirdRoot = makeRoot(true);
        const third = await methods.importDocument({
            packageName: 'figma-importer-cocos',
            fileKey: 'file-key',
            rootName: 'Test',
            rootFrame: thirdRoot.frame,
            scale: 1,
            updateExisting: true,
            existingMap: second.nodeMap,
            centerInCanvas: true,
            roots: [thirdRoot],
        });

        assert.equal(imported.getChildByName('OmittedLayer'), omitted);
        assert.equal(
            imported.children.filter((child) => child.name === 'OmittedLayer').length,
            1,
        );
        assert.equal(third.nodeMap['15:302'], omitted.uuid);
    } finally {
        Module._load = originalLoad;
    }
});

test('switches safely between direct and multi-root imports without orphaning old roots', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    const importRoots = (roots, existingMap, updateExisting) => methods.importDocument({
        packageName: 'figma-importer-cocos',
        fileKey: 'file-key',
        rootName: 'Root Mode Test',
        rootFrame: { x: 0, y: 0, width: 240, height: 120 },
        scale: 1,
        updateExisting,
        existingMap,
        centerInCanvas: false,
        roots,
    });
    try {
        const firstSpec = makeSpec({ figmaId: 'root:a', name: 'RootA' });
        const first = await importRoots([firstSpec], {}, false);
        const rootA = environment.canvas.getChildByName('RootA');
        assert.equal(first.nodeMap.__root__, rootA.uuid);
        assert.equal(first.nodeMap['root:a'], rootA.uuid);

        const second = await importRoots([
            makeSpec({ figmaId: 'root:a', name: 'RootA' }),
            makeSpec({ figmaId: 'root:b', name: 'RootB' }),
        ], first.nodeMap, true);
        const wrapper = environment.canvas.children.find((node) => node.uuid === second.rootUuid);
        const rootB = wrapper.getChildByName('RootB');

        assert.notEqual(wrapper, rootA);
        assert.equal(wrapper.parent, environment.canvas);
        assert.notEqual(wrapper.parent, wrapper);
        assert.equal(rootA.parent, wrapper);
        assert.equal(rootB.parent, wrapper);
        assert.equal(second.nodeMap.__root__, wrapper.uuid);
        assert.equal(second.nodeMap['root:a'], rootA.uuid);

        wrapper.setPosition(20, -30, 0);
        rootB.setPosition(40, 5, 0);
        const siblingManual = new FakeNode('SiblingManual');
        siblingManual.setPosition(3, 7, 0);
        rootB.addChild(siblingManual);
        const siblingManualWorld = siblingManual.worldPosition();
        const wrapperManual = new FakeNode('WrapperManual');
        wrapperManual.setPosition(-4, 9, 0);
        wrapper.addChild(wrapperManual);
        const wrapperManualWorld = wrapperManual.worldPosition();

        FakeNode.deferNodeDestruction = true;
        const third = await importRoots([
            makeSpec({ figmaId: 'root:a', name: 'RootA' }),
        ], second.nodeMap, true);
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(third.rootUuid, rootA.uuid);
        assert.equal(rootA.parent, environment.canvas);
        assert.equal(wrapper.parent, null);
        assert.equal(rootB.parent, null);
        assert.equal(wrapper.destroyed, true);
        assert.equal(rootB.destroyed, true);
        assert.equal(environment.canvas.getChildByName('RootB'), null);
        assert.equal(environment.canvas.children.includes(wrapper), false);
        assert.equal(siblingManual.parent, environment.canvas);
        assert.equal(wrapperManual.parent, environment.canvas);
        assert.notEqual(siblingManual.destroyed, true);
        assert.notEqual(wrapperManual.destroyed, true);
        assert.deepEqual(siblingManual.worldPosition(), siblingManualWorld);
        assert.deepEqual(wrapperManual.worldPosition(), wrapperManualWorld);
        assert.equal(third.nodeMap.__root__, rootA.uuid);
        assert.equal(third.nodeMap['root:b'], undefined);
    } finally {
        FakeNode.deferNodeDestruction = false;
        Module._load = originalLoad;
    }
});

test('restores reused roots when a direct-to-multi import fails', async () => {
    const environment = fakeCocos();
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'cc') {
            return environment.cc;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    const importRoots = (roots, existingMap, updateExisting) => methods.importDocument({
        packageName: 'figma-importer-cocos',
        fileKey: 'file-key',
        rootName: 'Failed Root Mode Test',
        rootFrame: { x: 0, y: 0, width: 240, height: 120 },
        scale: 1,
        updateExisting,
        existingMap,
        centerInCanvas: false,
        roots,
    });
    try {
        const first = await importRoots([
            makeSpec({ figmaId: 'root:stable', name: 'StableRoot' }),
        ], {}, false);
        const stableRoot = environment.canvas.getChildByName('StableRoot');
        const manual = new FakeNode('StableManual');
        stableRoot.addChild(manual);

        FakeNode.deferNodeDestruction = true;
        await assert.rejects(
            importRoots([
                makeSpec({ figmaId: 'root:stable', name: 'StableRoot' }),
                makeSpec({
                    figmaId: 'root:broken',
                    name: 'BrokenPng',
                    action: 'render',
                    kind: 'sprite',
                }),
            ], first.nodeMap, true),
            /没有绑定 SpriteFrame/,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(stableRoot.parent, environment.canvas);
        assert.equal(manual.parent, stableRoot);
        assert.notEqual(stableRoot.destroyed, true);
        assert.notEqual(manual.destroyed, true);
        assert.equal(
            environment.canvas.children.some((child) => child.name.startsWith('Figma · ')),
            false,
        );
    } finally {
        FakeNode.deferNodeDestruction = false;
        Module._load = originalLoad;
    }
});

test('updates an opened Prefab by fileId after runtime UUIDs change', async () => {
    const environment = fakeCocos();
    const prefabUuid = 'prefab-asset-uuid';
    const rootFileId = 'prefabRootFileId';
    const rootTransformFileId = 'prefabRootTransformFileId';
    environment.canvas._prefab = {
        fileId: rootFileId,
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    environment.canvas.getComponent(UITransform).__prefab = { fileId: rootTransformFileId };

    const rootFrame = { x: 0, y: 0, width: 320, height: 240 };
    const leftFrame = { x: 0, y: 0, width: 150, height: 240 };
    const rightFrame = { x: 170, y: 0, width: 150, height: 240 };
    const itemFrame = { x: 10, y: 20, width: 40, height: 30 };
    const item = makeSpec({
        figmaId: 'item-id',
        name: 'Item Before',
        action: 'render',
        kind: 'sprite',
        frame: itemFrame,
        sprite: { uuid: 'sprite-frame', url: 'db://assets/item.png', sliced: false },
    });
    item.parentFrame = leftFrame;
    const left = makeSpec({
        figmaId: 'left-id',
        name: 'Left',
        frame: leftFrame,
        children: [item],
    });
    left.parentFrame = rootFrame;
    const right = makeSpec({
        figmaId: 'right-id',
        name: 'Right',
        frame: rightFrame,
    });
    right.parentFrame = rootFrame;
    const firstRoot = makeSpec({
        figmaId: 'root-id',
        name: 'Frame Prefab',
        frame: rootFrame,
        children: [left, right],
    });
    const first = await importWithPrefabContext(environment, firstRoot, {
        prefabUuid,
        rootFileId,
        existingNodeFileIds: { 'root-id': rootFileId },
        managedNodeFileIds: [rootFileId],
        managedComponentFileIds: [rootTransformFileId],
        managedHelperFileIds: [],
    });
    assert.ok(first.prefabSync);
    const importedItem = environment.canvas.children[0].children[0];
    const stableItemFileId = importedItem._prefab.fileId;
    class ManualScript extends Component {}
    const manualScript = importedItem.addComponent(ManualScript);
    manualScript.__prefab = { fileId: 'manualScriptFileId' };
    const manualChild = new FakeNode('Manual Child');
    manualChild._prefab = {
        fileId: 'manualChildFileId',
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    environment.canvas.children[1].addChild(manualChild);

    let runtimeUuid = 1000;
    const replaceRuntimeUuids = (node) => {
        node.uuid = `reopened-${runtimeUuid++}`;
        node.children.forEach(replaceRuntimeUuids);
    };
    replaceRuntimeUuids(environment.canvas);

    const movedItem = makeSpec({
        figmaId: 'item-id',
        name: 'Item After',
        action: 'render',
        kind: 'sprite',
        frame: { x: 180, y: 40, width: 40, height: 30 },
        sprite: { uuid: 'sprite-frame', url: 'db://assets/item.png', sliced: false },
    });
    movedItem.parentFrame = rightFrame;
    const secondLeft = makeSpec({
        figmaId: 'left-id',
        name: 'Left',
        frame: leftFrame,
    });
    secondLeft.parentFrame = rootFrame;
    const secondRight = makeSpec({
        figmaId: 'right-id',
        name: 'Right',
        frame: rightFrame,
        children: [movedItem],
    });
    secondRight.parentFrame = rootFrame;
    const secondRoot = makeSpec({
        figmaId: 'root-id',
        name: 'Frame Prefab',
        frame: rootFrame,
        children: [secondLeft, secondRight],
    });
    const second = await importWithPrefabContext(environment, secondRoot, {
        prefabUuid,
        rootFileId,
        existingNodeFileIds: first.prefabSync.nodeFileIds,
        managedNodeFileIds: first.prefabSync.managedNodeFileIds,
        managedComponentFileIds: first.prefabSync.managedComponentFileIds,
        managedHelperFileIds: first.prefabSync.managedHelperFileIds,
    });

    const updatedRight = environment.canvas.children.find((node) => node.name === 'Right');
    assert.equal(second.created, 0);
    assert.equal(importedItem.name, 'Item After');
    assert.equal(importedItem.parent, updatedRight);
    assert.equal(importedItem._prefab.fileId, stableItemFileId);
    assert.equal(importedItem.getComponent(ManualScript), manualScript);
    assert.deepEqual(updatedRight.children.map((node) => node.name), ['Item After', 'Manual Child']);
    assert.equal(second.prefabSync.nodeFileIds['item-id'], stableItemFileId);
    assert.equal(environment.scene.children.length, 1);
});

test('removes only stale managed Prefab nodes and salvages manual descendants', async () => {
    const environment = fakeCocos();
    const prefabUuid = 'prefab-stale-uuid';
    const rootFileId = 'staleRootFileId';
    const rootTransformFileId = 'staleRootTransformFileId';
    environment.canvas._prefab = {
        fileId: rootFileId,
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    environment.canvas.getComponent(UITransform).__prefab = { fileId: rootTransformFileId };
    const rootFrame = { x: 0, y: 0, width: 200, height: 200 };
    const branchFrame = { x: 20, y: 20, width: 100, height: 100 };
    const leaf = makeSpec({
        figmaId: 'obsolete-leaf',
        name: 'Obsolete Leaf',
        frame: { x: 30, y: 30, width: 20, height: 20 },
    });
    leaf.parentFrame = branchFrame;
    const branch = makeSpec({
        figmaId: 'obsolete-branch',
        name: 'Obsolete Branch',
        frame: branchFrame,
        children: [leaf],
    });
    branch.parentFrame = rootFrame;
    const firstRoot = makeSpec({
        figmaId: 'stale-root',
        name: 'Stale Root',
        frame: rootFrame,
        children: [branch],
    });
    const first = await importWithPrefabContext(environment, firstRoot, {
        prefabUuid,
        rootFileId,
        existingNodeFileIds: { 'stale-root': rootFileId },
        managedNodeFileIds: [rootFileId],
        managedComponentFileIds: [rootTransformFileId],
        managedHelperFileIds: [],
    });
    const importedBranch = environment.canvas.children[0];
    const importedLeaf = importedBranch.children[0];
    const manualGrandchild = new FakeNode('Manual Grandchild');
    manualGrandchild._prefab = {
        fileId: 'manualGrandchildFileId',
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    importedLeaf.addChild(manualGrandchild);
    const worldBefore = manualGrandchild.worldPosition();

    const secondRoot = makeSpec({
        figmaId: 'stale-root',
        name: 'Stale Root',
        frame: rootFrame,
        children: [],
    });
    await importWithPrefabContext(environment, secondRoot, {
        prefabUuid,
        rootFileId,
        existingNodeFileIds: first.prefabSync.nodeFileIds,
        managedNodeFileIds: first.prefabSync.managedNodeFileIds,
        managedComponentFileIds: first.prefabSync.managedComponentFileIds,
        managedHelperFileIds: first.prefabSync.managedHelperFileIds,
    });

    assert.equal(importedBranch.parent, null);
    assert.equal(importedLeaf.parent, importedBranch);
    assert.equal(manualGrandchild.parent, environment.canvas);
    assert.deepEqual(manualGrandchild.worldPosition(), worldBefore);
    assert.deepEqual(environment.canvas.children.map((node) => node.name), ['Manual Grandchild']);
});

test('rejects a mismatched Prefab editor context before mutating its root', async () => {
    const environment = fakeCocos();
    environment.reportedPrefabUuid = 'another-prefab-uuid';
    environment.canvas.name = 'Untouched Root';
    environment.canvas._prefab = {
        fileId: 'contextRootFileId',
        root: environment.canvas,
        asset: { uuid: 'expected-prefab-uuid' },
    };
    environment.canvas.getComponent(UITransform).__prefab = {
        fileId: 'contextRootTransformFileId',
    };
    await assert.rejects(
        importWithPrefabContext(environment, makeSpec({
            figmaId: 'context-root',
            name: 'Must Not Apply',
        }), {
            prefabUuid: 'expected-prefab-uuid',
            rootFileId: 'contextRootFileId',
            existingNodeFileIds: { 'context-root': 'contextRootFileId' },
            managedNodeFileIds: ['contextRootFileId'],
            managedComponentFileIds: ['contextRootTransformFileId'],
            managedHelperFileIds: [],
        }),
        /目标 Prefab 尚未安全打开/,
    );
    assert.equal(environment.canvas.name, 'Untouched Root');
    assert.equal(environment.canvas.children.length, 0);
});

test('captures helpers and components that Creator assigns fileIds during creation', async () => {
    const environment = fakeCocos();
    environment.autoAssignPrefabInfo = true;
    const prefabUuid = 'prefab-auto-fileid-uuid';
    const rootFileId = 'autoRootFileId';
    const rootTransformFileId = 'autoRootTransformFileId';
    environment.canvas._prefab = {
        fileId: rootFileId,
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    environment.canvas.getComponent(UITransform).__prefab = { fileId: rootTransformFileId };
    const result = await importWithPrefabContext(environment, makeSpec({
        figmaId: 'auto-root',
        name: 'Auto FileId Scroll',
        kind: 'scrollView',
        overflowDirection: 'VERTICAL_SCROLLING',
        layout: { mode: 'VERTICAL' },
    }), {
        prefabUuid,
        rootFileId,
        existingNodeFileIds: { 'auto-root': rootFileId },
        managedNodeFileIds: [rootFileId],
        managedComponentFileIds: [rootTransformFileId],
        managedHelperFileIds: [],
    });

    const view = environment.canvas.getChildByName('view');
    const content = view.getChildByName('content');
    assert.ok(view._prefab.fileId);
    assert.ok(content._prefab.fileId);
    assert.ok(result.prefabSync.managedHelperFileIds.includes(view._prefab.fileId));
    assert.ok(result.prefabSync.managedHelperFileIds.includes(content._prefab.fileId));
    for (const component of [...view.components, ...content.components]) {
        assert.ok(result.prefabSync.managedComponentFileIds.includes(component.__prefab.fileId));
    }
});

test('blocks helper deletion when a user component is attached and keeps the subtree intact', async () => {
    const environment = fakeCocos();
    const prefabUuid = 'prefab-helper-guard-uuid';
    const rootFileId = 'helperGuardRootFileId';
    const rootTransformFileId = 'helperGuardRootTransformFileId';
    environment.canvas._prefab = {
        fileId: rootFileId,
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    environment.canvas.getComponent(UITransform).__prefab = { fileId: rootTransformFileId };
    const first = await importWithPrefabContext(environment, makeSpec({
        figmaId: 'helper-root',
        name: 'Guarded Scroll',
        kind: 'scrollView',
        overflowDirection: 'VERTICAL_SCROLLING',
        layout: { mode: 'VERTICAL' },
    }), {
        prefabUuid,
        rootFileId,
        existingNodeFileIds: { 'helper-root': rootFileId },
        managedNodeFileIds: [rootFileId],
        managedComponentFileIds: [rootTransformFileId],
        managedHelperFileIds: [],
    });
    const view = environment.canvas.getChildByName('view');
    class ManualHelperScript extends Component {}
    const manual = view.addComponent(ManualHelperScript);
    manual.__prefab = { fileId: 'manualHelperScriptFileId' };

    await assert.rejects(
        importWithPrefabContext(environment, makeSpec({
            figmaId: 'helper-root',
            name: 'Must Not Mutate',
            kind: 'node',
        }), {
            prefabUuid,
            rootFileId,
            existingNodeFileIds: first.prefabSync.nodeFileIds,
            managedNodeFileIds: first.prefabSync.managedNodeFileIds,
            managedComponentFileIds: first.prefabSync.managedComponentFileIds,
            managedHelperFileIds: first.prefabSync.managedHelperFileIds,
        }),
        /不是 Figma Importer 创建的/,
    );
    assert.equal(environment.canvas.name, 'Guarded Scroll');
    assert.equal(environment.canvas.getChildByName('view'), view);
    assert.equal(view.getComponent(ManualHelperScript), manual);
    assert.notEqual(view.destroyed, true);
});

test('rejects an unowned UITransform before changing a managed Prefab node', async () => {
    const environment = fakeCocos();
    const prefabUuid = 'prefab-transform-guard-uuid';
    const rootFileId = 'transformGuardRootFileId';
    const rootTransformFileId = 'transformGuardRootTransformFileId';
    environment.canvas.name = 'Original Root';
    environment.canvas._prefab = {
        fileId: rootFileId,
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    environment.canvas.getComponent(UITransform).__prefab = { fileId: 'manualTransformFileId' };

    await assert.rejects(
        importWithPrefabContext(environment, makeSpec({
            figmaId: 'transform-root',
            name: 'Must Not Rename',
        }), {
            prefabUuid,
            rootFileId,
            existingNodeFileIds: { 'transform-root': rootFileId },
            managedNodeFileIds: [rootFileId],
            managedComponentFileIds: [rootTransformFileId],
            managedHelperFileIds: [],
        }),
        /UITransform 不是 Figma Importer 创建的/,
    );
    assert.equal(environment.canvas.name, 'Original Root');
});

test('rejects a user-replaced ScrollView content slot before any mutation', async () => {
    const environment = fakeCocos();
    const prefabUuid = 'prefab-content-slot-uuid';
    const rootFileId = 'contentSlotRootFileId';
    const rootTransformFileId = 'contentSlotRootTransformFileId';
    environment.canvas._prefab = {
        fileId: rootFileId,
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    environment.canvas.getComponent(UITransform).__prefab = { fileId: rootTransformFileId };
    const scrollSpec = makeSpec({
        figmaId: 'content-slot-root',
        name: 'Owned Scroll Root',
        kind: 'scrollView',
        overflowDirection: 'VERTICAL_SCROLLING',
        layout: { mode: 'VERTICAL' },
    });
    const first = await importWithPrefabContext(environment, scrollSpec, {
        prefabUuid,
        rootFileId,
        existingNodeFileIds: { 'content-slot-root': rootFileId },
        managedNodeFileIds: [rootFileId],
        managedComponentFileIds: [rootTransformFileId],
        managedHelperFileIds: [],
    });
    const view = environment.canvas.getChildByName('view');
    view.getChildByName('content').removeFromParent();
    const manualContent = new FakeNode('content');
    manualContent._prefab = {
        fileId: 'manualContentSlotFileId',
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    const manualTransform = manualContent.addComponent(UITransform);
    manualTransform.__prefab = { fileId: 'manualContentTransformFileId' };
    manualTransform.setAnchorPoint(0.25, 0.75);
    manualTransform.setContentSize(37, 19);
    manualContent.setPosition(8, -6, 0);
    view.addChild(manualContent);

    await assert.rejects(
        importWithPrefabContext(environment, makeSpec({
            ...scrollSpec,
            figmaId: 'content-slot-root',
            name: 'Must Not Rename',
            kind: 'scrollView',
            overflowDirection: 'VERTICAL_SCROLLING',
            layout: { mode: 'VERTICAL' },
        }), {
            prefabUuid,
            rootFileId,
            existingNodeFileIds: first.prefabSync.nodeFileIds,
            managedNodeFileIds: first.prefabSync.managedNodeFileIds,
            managedComponentFileIds: first.prefabSync.managedComponentFileIds,
            managedHelperFileIds: first.prefabSync.managedHelperFileIds,
        }),
        /content.*不是 Figma Importer 创建的/,
    );
    assert.equal(environment.canvas.name, 'Owned Scroll Root');
    assert.equal(manualContent.parent, view);
    assert.deepEqual(manualTransform.anchorPoint, { x: 0.25, y: 0.75 });
    assert.deepEqual(manualTransform.contentSize, { width: 37, height: 19 });
    assert.deepEqual(
        { x: manualContent.position.x, y: manualContent.position.y },
        { x: 8, y: -6 },
    );
});

test('rejects a user-replaced nested tiled Sprite slot before any mutation', async () => {
    const environment = fakeCocos();
    const prefabUuid = 'prefab-tiled-slot-uuid';
    const rootFileId = 'tiledSlotRootFileId';
    const rootTransformFileId = 'tiledSlotRootTransformFileId';
    environment.canvas._prefab = {
        fileId: rootFileId,
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    environment.canvas.getComponent(UITransform).__prefab = { fileId: rootTransformFileId };
    const tiledSpec = makeSpec({
        figmaId: 'tiled-slot-root',
        name: 'Owned Tiled Root',
        figmaType: 'ELLIPSE',
        action: 'render',
        kind: 'sprite',
        sprite: {
            uuid: 'tiled-frame',
            url: 'db://assets/tiled.png',
            sliced: false,
            tiled: true,
        },
    });
    const first = await importWithPrefabContext(environment, tiledSpec, {
        prefabUuid,
        rootFileId,
        existingNodeFileIds: { 'tiled-slot-root': rootFileId },
        managedNodeFileIds: [rootFileId],
        managedComponentFileIds: [rootTransformFileId],
        managedHelperFileIds: [],
    });
    const tiledMask = environment.canvas.getChildByName('__FigmaTiledMask');
    tiledMask.getChildByName('__FigmaTiledSprite').removeFromParent();
    const manualTiledSprite = new FakeNode('__FigmaTiledSprite');
    manualTiledSprite._prefab = {
        fileId: 'manualTiledSpriteFileId',
        root: environment.canvas,
        asset: { uuid: prefabUuid },
    };
    const manualTransform = manualTiledSprite.addComponent(UITransform);
    manualTransform.__prefab = { fileId: 'manualTiledTransformFileId' };
    manualTransform.setContentSize(13, 17);
    const manualSprite = manualTiledSprite.addComponent(Sprite);
    manualSprite.__prefab = { fileId: 'manualTiledSpriteCompFileId' };
    manualSprite._spriteFrame = 'manual-frame';
    tiledMask.addChild(manualTiledSprite);

    await assert.rejects(
        importWithPrefabContext(environment, makeSpec({
            ...tiledSpec,
            figmaId: 'tiled-slot-root',
            name: 'Must Not Rename',
            figmaType: 'ELLIPSE',
            action: 'render',
            kind: 'sprite',
            sprite: tiledSpec.sprite,
        }), {
            prefabUuid,
            rootFileId,
            existingNodeFileIds: first.prefabSync.nodeFileIds,
            managedNodeFileIds: first.prefabSync.managedNodeFileIds,
            managedComponentFileIds: first.prefabSync.managedComponentFileIds,
            managedHelperFileIds: first.prefabSync.managedHelperFileIds,
        }),
        /__FigmaTiledSprite.*不是 Figma Importer 创建的/,
    );
    assert.equal(environment.canvas.name, 'Owned Tiled Root');
    assert.equal(manualTiledSprite.parent, tiledMask);
    assert.deepEqual(manualTransform.contentSize, { width: 13, height: 17 });
    assert.equal(manualSprite._spriteFrame, 'manual-frame');
});
