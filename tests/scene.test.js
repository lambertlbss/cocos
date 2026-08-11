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

    setRotationFromEuler() {}
}
FakeNode.deferComponentRemoval = false;

function makeSpec(overrides = {}) {
    return {
        figmaId: overrides.figmaId ?? '15:193',
        name: overrides.name ?? 'Layer',
        figmaType: overrides.figmaType ?? 'FRAME',
        action: overrides.action ?? 'generate',
        kind: overrides.kind ?? 'node',
        frame: overrides.frame ?? { x: 0, y: 0, width: 100, height: 80 },
        rotation: overrides.rotation ?? 0,
        opacity: overrides.opacity ?? 1,
        visible: true,
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

test('resets reused Label font and color when the new Figma text has no mapping or fill', async () => {
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
            characters: '文字',
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
        assert.deepEqual(
            { r: label.color.r, g: label.color.g, b: label.color.b, a: label.color.a },
            { r: 255, g: 255, b: 255, a: 255 },
        );
    } finally {
        Module._load = originalLoad;
    }
});
