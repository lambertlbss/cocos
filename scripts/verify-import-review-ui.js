'use strict';
// Browser verification of the actual compiled panel, without a running Creator project.
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { readFile, mkdtemp, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

async function main() {
    const root = resolve(__dirname, '..');
    const chrome = process.env.CHROME_PATH || [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/google-chrome', '/usr/bin/chromium',
    ].find(existsSync);
    if (!chrome) throw new Error('Set CHROME_PATH to a Chrome/Edge executable.');
    const temp = await mkdtemp(join(tmpdir(), 'cocos-review-ui-'));
    const [css, template, code] = await Promise.all([
        readFile(join(root, 'static/style/default/index.css'), 'utf8'),
        readFile(join(root, 'static/template/default/index.html'), 'utf8'),
        readFile(join(root, 'dist/panels/default/import-review.js'), 'utf8'),
    ]);
    const node = (id, name, depth, components = []) => ({ id, uuid: id, name, depth, order: 0,
        active: true, parentId: depth ? 'root' : null, geometry: [0, 0, 0, 120, 80], figmaIds: [id], components });
    const sprite = { id: 'sprite', type: 'cc.Sprite', managed: true, properties: { spriteFrame: 'new-sprite', enabled: true } };
    const before = node('root', 'YushiView', 0);
    const after = node('root', 'YushiView', 0);
    const child = node('child', 'huodong_img_gou_01', 1, [sprite]);
    const report = { id: 'demo', fileName: '导入结果测试', createdAt: new Date().toISOString(),
        assets: [
            { id: 'new', uuid: 'new-sprite', url: 'db://assets/images/huodong_img_gou_01.png', name: 'huodong_img_gou_01.png', state: 'new', sources: ['figma'], figmaIds: ['child'], nodeNames: [child.name], canRemove: true, hasBefore: false },
            { id: 'old', uuid: 'old-sprite', url: 'db://assets/images/common_bg_frame_10.png', name: 'common_bg_frame_10.png', state: 'reused', sources: ['local'], figmaIds: ['background'], nodeNames: ['common_bg'], canRemove: false, hasBefore: false },
            { id: 'update', uuid: 'update-sprite', url: 'db://assets/images/title.png', name: 'title.png', state: 'updated', sources: ['cache'], figmaIds: ['title'], nodeNames: ['title'], canRemove: false, hasBefore: true },
        ],
        before: { rootUuid: 'root', targetUuid: 'target', mode: 'prefab', nodes: [before] },
        after: { rootUuid: 'root', targetUuid: 'target', mode: 'prefab', nodes: [after, child] },
        changes: [{ id: 'root', status: 'unchanged', fields: [], before, after }, { id: 'child', status: 'added', fields: ['新增节点'], after: child }],
        sourceTree: [{ id: 'root', name: 'YushiView', depth: 0, type: 'FRAME', visible: true }, { id: 'child', name: child.name, depth: 1, type: 'RECTANGLE', visible: true }],
        warnings: [], confirmed: false,
    };
    const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect x="5" y="5" width="70" height="70" rx="14" fill="#385559"/><path d="M20 40l13 13 28-29" stroke="#d8ff52" stroke-width="8" fill="none"/></svg>');
    const html = `<!doctype html><html><body style="margin:0"><div id="host" style="height:100vh"></div><script>window.exports={};</script><script src="/panel.js"></script><script>
        const host=document.querySelector('#host');const shadow=host.attachShadow({mode:'open'});
        shadow.innerHTML='<style>'+${JSON.stringify(css)}+'</style><main>'+${JSON.stringify(template.match(/<dialog[\s\S]*?<\/dialog>/)[0])}+'</main>';
        window.calls=[];window.fixture=${JSON.stringify(report)};
        window.Editor={Selection:{select(){}}};
        window.panel=new exports.ImportReviewPanel(shadow.querySelector('main'),async(method,...args)=>{
            calls.push([method,...args]);
            if(method==='get-import-review-preview')return{after:${JSON.stringify(svg)},before:${JSON.stringify(svg)}};
            if(method==='get-import-review-source-preview')return{url:${JSON.stringify(svg)},note:'Figma 原图'};
            if(method==='apply-import-review'){fixture.confirmed=true;fixture.assets[0].state='deleted';fixture.assets[0].canRemove=false;return fixture;}
        },()=>{});panel.open(fixture);window.q=(s)=>shadow.querySelector(s);
        </script></body></html>`;
    const server = createServer((req, res) => {
        res.setHeader('Content-Type', req.url === '/panel.js' ? 'application/javascript' : 'text/html; charset=utf-8');
        res.end(req.url === '/panel.js' ? code : html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const childProcess = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', `--user-data-dir=${join(temp, 'browser-profile')}`, 'about:blank'], { windowsHide: true });
    let socket;
    try {
        const websocketUrl = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 15000);
            let output = '';
            childProcess.stderr.on('data', (data) => { output += data.toString(); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match) { clearTimeout(timer); resolve(match[1]); } });
            childProcess.on('error', reject);
        });
        socket = new WebSocket(websocketUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let sequence = 0;
        const pending = new Map();
        socket.onmessage = (event) => { const value = JSON.parse(event.data); if (value.id && pending.has(value.id)) {
            const pair = pending.get(value.id); pending.delete(value.id); value.error ? pair.reject(new Error(value.error.message)) : pair.resolve(value.result); } };
        const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
            const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId }));
        });
        const target = await send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const cmd = (method, params) => send(method, params, sessionId);
        await cmd('Runtime.enable');
        await cmd('Page.enable');
        await cmd('Emulation.setDeviceMetricsOverride', { width: 920, height: 850, deviceScaleFactor: 1, mobile: false });
        await cmd('Page.navigate', { url: `http://127.0.0.1:${port}` });
        const evaluate = async (expression) => {
            const result = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
            return result.result.value;
        };
        for (let i = 0; i < 30; i++) {
            if (await evaluate('Boolean(window.panel)')) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(await evaluate('q("dialog").open'), true);
        assert.equal(await evaluate('q(".review-resource-row.reused input").disabled'), true);
        await evaluate('q(".review-resource-row.new input").click()');
        assert.equal(await evaluate('calls.some(c=>c[0]==="apply-import-review")'), false);
        assert.equal(await evaluate('q(".review-footer").textContent.includes("待删除 1 项")'), true);
        await evaluate('q(".review-close").click();panel.open(fixture)');
        assert.equal(await evaluate('q(".review-resource-row.new input").checked'), true);
        await evaluate('q(".review-resource-detail > button").click()');
        await new Promise((resolve) => setTimeout(resolve, 150));
        const shot = await cmd('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(temp, 'resources.png'), Buffer.from(shot.data, 'base64'));
        await evaluate('q(".review-tabs").children[1].click();q(".review-tree-row.added button").click()');
        assert.equal(await evaluate('q(".review-node-detail").textContent.includes("插件挂载/管理")'), true);
        const nodesShot = await cmd('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(temp, 'nodes.png'), Buffer.from(nodesShot.data, 'base64'));
        await evaluate('q(".review-tabs").children[2].click()');
        assert.equal(await evaluate('q(".review-content").textContent.includes("Figma 原始节点")'), true);
        await evaluate('q(".review-tabs").children[0].click()');
        await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 780, deviceScaleFactor: 1, mobile: false });
        assert.equal(await evaluate('q("dialog").scrollWidth <= q("dialog").clientWidth'), true);
        const narrowShot = await cmd('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(temp, 'narrow.png'), Buffer.from(narrowShot.data, 'base64'));
        await evaluate('q(".review-resource-row.new input").click();q(".review-footer .primary").click()');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(await evaluate('calls.filter(c=>c[0]==="apply-import-review").map(c=>c[2])'), [['new']]);
        assert.equal(await evaluate('q(".review-footer .primary").disabled'), true);
        console.log(`Panel browser checks passed (confirmation, discard, references, node details, source tree, 420px layout). Screenshots: ${temp}`);
        await send('Browser.close').catch(() => {});
    } finally {
        socket?.close(); childProcess.kill(); server.close();
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
