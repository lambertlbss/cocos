'use strict';

// The panel runs inside Cocos' renderer. This intentionally small DOM fixture
// exercises its real event handlers without starting Cocos, a browser, or IO.
class PanelElement {
    constructor(tagName = 'div', ownerDocument) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.dataset = {};
        this.events = new Map();
        this.style = { setProperty(name, value) { this[name] = value; } };
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.hidden = false;
        this.open = false;
        this.scrollTop = 0;
        this.scrollLeft = 0;
        this._text = '';
        this.classList = {
            contains: (name) => this.className.split(/\s+/).includes(name),
            add: (...names) => this._classes((classes) => names.forEach((name) => classes.add(name))),
            remove: (...names) => this._classes((classes) => names.forEach((name) => classes.delete(name))),
            toggle: (name, force) => {
                const enabled = force === undefined ? !this.classList.contains(name) : force;
                this.classList[enabled ? 'add' : 'remove'](name);
                return enabled;
            },
        };
    }

    _classes(change) {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        change(classes);
        this.className = [...classes].join(' ');
    }

    get className() { return this.getAttribute('class') ?? ''; }
    set className(value) { this.attributes.set('class', String(value)); }
    get id() { return this.getAttribute('id') ?? ''; }
    set id(value) { this.attributes.set('id', value); }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this._text = String(value ?? ''); this.replaceChildren(); }
    get innerHTML() { return this.textContent; }
    set innerHTML(value) { this.textContent = value; }
    get childNodes() { return this.children; }
    get firstElementChild() { return this.children[0] ?? null; }
    get firstChild() { return this.children[0] ?? null; }
    get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
    get src() { return this.getAttribute('src') ?? ''; }
    set src(value) {
        this.setAttribute('src', value);
        queueMicrotask(() => this.onload?.());
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name.startsWith('data-')) this.dataset[dataKey(name.slice(5))] = String(value);
        if (name === 'value') this.value = String(value);
        if (name === 'disabled') this.disabled = true;
        if (name === 'checked') this.checked = true;
        if (name === 'hidden') this.hidden = true;
        if (name === 'open') this.open = true;
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) {
        this.attributes.delete(name);
        if (name === 'hidden') this.hidden = false;
        if (name === 'disabled') this.disabled = false;
    }
    append(...children) {
        for (const child of children) {
            if (typeof child === 'string') {
                const node = new PanelElement('#text', this.ownerDocument);
                node.textContent = child;
                this.append(node);
            } else {
                child.parentElement = this;
                this.children.push(child);
            }
        }
    }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) {
        for (const child of this.children) child.parentElement = null;
        this.children = [];
        this.append(...children);
    }
    remove() {
        if (this.parentElement) {
            const siblings = this.parentElement.children;
            siblings.splice(siblings.indexOf(this), 1);
            this.parentElement = null;
        }
    }
    matches(selector) {
        return selector.split(',').some((part) => matchesSelector(this, part.trim()));
    }
    querySelectorAll(selector) {
        return this.children.flatMap((child) => [
            ...(child.matches(selector) ? [child] : []),
            ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) {
        return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null;
    }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    addEventListener(type, handler) {
        const listeners = this.events.get(type) ?? [];
        listeners.push(handler);
        this.events.set(type, listeners);
    }
    removeEventListener(type, handler) {
        this.events.set(type, (this.events.get(type) ?? []).filter((item) => item !== handler));
    }
    async emit(type, properties = {}) {
        const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...properties };
        for (const handler of this.events.get(type) ?? []) await handler(event);
        if (typeof this[`on${type}`] === 'function') await this[`on${type}`](event);
    }
    click() { if (!this.disabled) return this.emit('click'); }
    focus() { this.ownerDocument.activeElement = this; }
    blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
    scrollIntoView() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
}

function dataKey(name) { return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); }

function matchesSelector(node, selector) {
    if (!selector) return false;
    const parts = selector.split(/\s+/);
    if (parts.length > 1) {
        if (!matchesSelector(node, parts.pop())) return false;
        let parent = node.parentElement;
        while (parts.length && parent) {
            if (matchesSelector(parent, parts.at(-1))) parts.pop();
            parent = parent.parentElement;
        }
        return parts.length === 0;
    }
    const attributes = [...selector.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g)];
    for (const [, name, value] of attributes) {
        const actual = name.startsWith('data-') ? node.dataset[dataKey(name.slice(5))] : node.getAttribute(name);
        if (actual === null || actual === undefined || (value !== undefined && actual !== value)) return false;
    }
    selector = selector.replace(/\[[^\]]+\]/g, '');
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    const id = selector.match(/#([\w-]+)/)?.[1];
    if (id && node.id !== id) return false;
    return [...selector.matchAll(/\.([\w-]+)/g)].every(([, name]) => node.classList.contains(name));
}

function createPanelDocument(html) {
    const document = {
        activeElement: null,
        createElement(tag) { return new PanelElement(tag, document); },
        createDocumentFragment() { return new PanelElement('fragment', document); },
    };
    const body = document.createElement('body');
    document.body = body;
    document.querySelector = (selector) => body.querySelector(selector);
    document.querySelectorAll = (selector) => body.querySelectorAll(selector);
    const stack = [body];
    const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
    for (const match of html.matchAll(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>|[^<]+/gi)) {
        const token = match[0];
        if (token.startsWith('<!--')) continue;
        if (token.startsWith('</')) { stack.pop(); continue; }
        if (!token.startsWith('<')) { stack.at(-1)._text += token; continue; }
        const tag = token.match(/^<([a-z][\w-]*)/i)[1];
        const node = document.createElement(tag);
        const content = token.slice(tag.length + 1, -1);
        for (const [, name, quoted, single, bare] of content.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
            node.setAttribute(name, quoted ?? single ?? bare ?? '');
        }
        stack.at(-1).appendChild(node);
        if (!voidTags.has(tag.toLowerCase()) && !token.endsWith('/>')) stack.push(node);
    }
    return document;
}

module.exports = { createPanelDocument };
