'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let nextUuid = 1;

class Component {
    constructor() {
        this.node = null;
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
Sprite.SizeMode = { CUSTOM: 1 };
Sprite.Type = { SIMPLE: 0, SLICED: 1 };

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

class Mask extends Component {}
Mask.Type = { GRAPHICS_RECT: 0, ELLIPSE: 1, RECT: 0 };

class Canvas extends Component {}
class Camera extends Component {}
class LabelOutline extends Component {}
class Layout extends Component {}
Layout.Type = { HORIZONTAL: 0, VERTICAL: 1, GRID: 2 };
Layout.AxisDirection = { HORIZONTAL: 0, VERTICAL: 1 };
Layout.ResizeMode = { NONE: 0 };
class ScrollView extends Component {}
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

    addChild(child) {
        child.parent = this;
    }

    removeFromParent() {
        if (this._parent) {
            this._parent.children = this._parent.children.filter((child) => child !== this);
        }
        this._parent = null;
    }

    destroy() {
        this.removeFromParent();
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
        if ([Graphics, Sprite, Label].includes(Type)
            && this.components.some((component) =>
                component instanceof Graphics || component instanceof Sprite || component instanceof Label)) {
            throw new Error(`render component conflict on ${this.name}`);
        }
        const component = new Type();
        component.node = this;
        this.components.push(component);
        if (Type === Mask && !this.getComponent(Graphics)) {
            this.addComponent(Graphics);
        }
        return component;
    }

    removeComponent(Type) {
        this.components = this.components.filter((component) => !(component instanceof Type));
    }

    setPosition(value, y = 0, z = 0) {
        this.position = typeof value === 'object'
            ? { x: value.x, y: value.y, z: value.z ?? 0, clone: this.position.clone }
            : { x: value, y, z, clone: this.position.clone };
    }

    setRotationFromEuler() {}
}

function makeSpec(overrides = {}) {
    return {
        figmaId: overrides.figmaId ?? '15:193',
        name: overrides.name ?? 'Layer',
        figmaType: overrides.figmaType ?? 'FRAME',
        action: overrides.action ?? 'generate',
        kind: overrides.kind ?? 'node',
        frame: overrides.frame ?? { x: 0, y: 0, width: 100, height: 80 },
        rotation: overrides.rotation ?? 0,
        opacity: 1,
        visible: true,
        clipsContent: overrides.clipsContent ?? false,
        cornerRadii: [0, 0, 0, 0],
        fills: overrides.fills ?? [],
        strokes: [],
        strokeWeight: 0,
        layout: {
            itemSpacing: 0,
            counterSpacing: 0,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
        },
        children: overrides.children ?? [],
        sprite: overrides.sprite,
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
            Color: class Color {},
            Size: class Size {},
            assetManager: {
                loadAny(_request, callback) {
                    callback(null, { width: 24, height: 16, widthFactor: 0.75 });
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

test('does not auto-create Widget for Figma constraints', async () => {
    const spec = makeSpec({
        frame: { x: 10, y: 12, width: 40, height: 24 },
    });
    spec.constraints = { horizontal: 'MIN', vertical: 'MIN' };
    const environment = await importWithFakeCocos(spec);
    const imported = environment.canvas.children[0];

    assert.equal(imported.getComponent(Widget), null);
});

test('uses NONE and centers a single-line Label on the Figma reference frame', async () => {
    const root = makeSpec({
        name: 'TextRoot',
        frame: { x: 0, y: 0, width: 100, height: 80 },
        children: [makeSpec({
            figmaId: '15:196',
            name: 'Title',
            figmaType: 'TEXT',
            kind: 'label',
            frame: { x: 10, y: 5, width: 40, height: 20 },
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
    root.children[0].strokeWeight = 2;
    const environment = await importWithFakeCocos(root);
    const imported = environment.canvas.children[0];
    const title = imported.children[0];
    const label = title.getComponent(Label);
    const transform = title.getComponent(UITransform);

    assert.ok(label);
    assert.equal(title.getComponent(LabelOutline), null);
    assert.equal(label.enableOutline, true);
    assert.equal(label.outlineWidth, 2);
    assert.equal(label.overflow, Label.Overflow.NONE);
    assert.equal(label.enableWrapText, false);
    assert.equal(label.horizontalAlign, Label.HorizontalAlign.CENTER);
    assert.equal(label.verticalAlign, Label.VerticalAlign.CENTER);
    assert.equal(label.lineHeight, 18);
    assert.deepEqual(transform.contentSize, { width: 20, height: 26.68 });
    assert.deepEqual(
        { x: title.position.x, y: title.position.y },
        { x: -20, y: 25 },
    );
});

test('uses NONE and keeps a multiline Label aligned to the Figma top-left', async () => {
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

    assert.equal(label.overflow, Label.Overflow.NONE);
    assert.equal(label.enableWrapText, false);
    assert.equal(label.horizontalAlign, Label.HorizontalAlign.LEFT);
    assert.equal(label.verticalAlign, Label.VerticalAlign.TOP);
    assert.equal(label.string, '第一行\n第二行');
    assert.equal(transform.width, 24);
    assert.ok(Math.abs(transform.height - 40.68) < 1e-9);
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

test('keeps a rotated multiline Label local top-left fixed after NONE measurement', async () => {
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

    const radians = -Math.PI / 2;
    const rotate = ({ x, y }) => ({
        x: x * Math.cos(radians) - y * Math.sin(radians),
        y: x * Math.sin(radians) + y * Math.cos(radians),
    });
    const originalTopLeft = rotate({ x: -20, y: 20 });
    const measuredTopLeft = rotate({ x: -transform.width / 2, y: transform.height / 2 });

    assert.ok(Math.abs(imported.position.x + measuredTopLeft.x - (-20 + originalTopLeft.x)) < 1e-9);
    assert.ok(Math.abs(imported.position.y + measuredTopLeft.y - (15 + originalTopLeft.y)) < 1e-9);
});

test('uses the mapped font final measurement before aligning multiline text', async () => {
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
    assert.equal(transform.width, 36);
    assert.equal(imported.position.x - transform.width / 2, -40);
    assert.ok(Math.abs(imported.position.y + transform.height / 2 - 35) < 1e-9);
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
        action: 'merge',
        kind: 'sprite',
        frame: { x: 0, y: 0, width: 180, height: 72 },
        sprite: { uuid: 'sprite-frame', url: 'db://assets/panel.png', sliced: true },
    }));
    const imported = environment.canvas.children[0];
    const transform = imported.getComponent(UITransform);
    const sprite = imported.getComponent(Sprite);

    assert.equal(sprite.type, Sprite.Type.SLICED);
    assert.deepEqual(transform.contentSize, { width: 180, height: 72 });
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

test('keeps ScrollView helpers top-left while importing content nodes with center anchors', async () => {
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

    assert.deepEqual(imported.getComponent(UITransform).anchorPoint, { x: 0.5, y: 0.5 });
    assert.deepEqual(view.getComponent(UITransform).anchorPoint, { x: 0, y: 1 });
    assert.deepEqual(content.getComponent(UITransform).anchorPoint, { x: 0, y: 1 });
    assert.deepEqual(child.getComponent(UITransform).anchorPoint, { x: 0.5, y: 0.5 });
    assert.deepEqual(
        { x: child.position.x, y: child.position.y },
        { x: 20, y: -10 },
    );
});
