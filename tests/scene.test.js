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

class Label extends Component {}
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
        rotation: 0,
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
                    callback(null, { width: 24, height: 16 });
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
        { x: -90, y: 36 },
    );
});
