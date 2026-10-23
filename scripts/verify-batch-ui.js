'use strict';

// Run the shipped renderer and DOM in a real browser; only Creator/Figma IO is simulated.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdtemp } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

async function main() {
    const root = resolve(__dirname, '..');
    const playwrightPath = process.env.PLAYWRIGHT_PATH || 'C:/Users/lanbosheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
    const { chromium } = require(playwrightPath);
    const temp = await mkdtemp(join(tmpdir(), 'cocos-batch-ui-'));
    const [template, css, packageJSON] = await Promise.all([
        readFile(join(root, 'static/template/default/index.html'), 'utf8'),
        readFile(join(root, 'static/style/default/index.css'), 'utf8'),
        readFile(join(root, 'package.json'), 'utf8'),
    ]);
    const modules = {};
    for (const file of ['panels/default/index', 'panels/default/workflow', 'panels/default/model',
        'panels/default/import-review', 'import-actions', 'node-name', 'importer/fonts', 'importer/assets', 'figma/url', 'diagnostics']) {
        modules[`/dist/${file}.js`] = (await readFile(join(root, `dist/${file}.js`), 'utf8')).replace(/\/\/# sourceMappingURL=.*$/gm, '');
    }
    const html = `<!doctype html><html><body style="margin:0"><div id="host" style="height:100vh"></div><script>
        const template=${JSON.stringify(template)},css=${JSON.stringify(css)},sources=${JSON.stringify(modules)},pkg=${packageJSON};
        const shadow=document.querySelector('#host').attachShadow({mode:'open'});
        shadow.innerHTML='<style>'+css+'</style>'+template;
        window.q=(s)=>shadow.querySelector(s); window.calls=[];window.stopRequested=false;window.importCount=0;
        const preview='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#20272c"/><rect x="16" y="16" width="268" height="40" rx="8" fill="#d8ff52"/><text x="32" y="43" font-size="20" fill="#182000">Frame Preview</text><rect x="16" y="73" width="123" height="105" rx="8" fill="#385559"/><rect x="155" y="73" width="129" height="105" rx="8" fill="#385559"/></svg>');
        const fonts=[{name:'Inter',url:'db://assets/fonts/Inter.ttf',relativePath:'fonts/Inter.ttf'}];
        const makeNode=(id,name,type,children=[])=>({id,name,type,width:300,height:200,visible:true,action:'generate',kind:type==='TEXT'?'label':'node',patchCandidate:type==='RECTANGLE',children});
        const names=['Home_ui','Bag_ui','Shop_ui'];
        window.frames=names.map((name,i)=>{const rootId=(i+1)+':1';const sourceUrl='https://www.figma.com/design/example?node-id='+(i+1)+'-1';return{
            id:'frame-'+i,fileKey:'example',rootId,name,sourceUrl,enabled:true,sectionName:'Main Section',document:{fileKey:'example',fileName:'Game UI',sourceUrl,fonts:['Inter'],fontAssets:fonts,nodeOverrides:[],tree:[makeNode(rootId,name,'FRAME',[
                makeNode(rootId+':title','Title','TEXT'),makeNode(rootId+':background','Background','RECTANGLE'),makeNode(rootId+':button','Start_Button','FRAME')])]} };});
        const reports=new Map();const scene={rootUuid:'root',targetUuid:'target',mode:'prefab',nodes:[]};
        frames.forEach((frame,i)=>reports.set('review-'+i,{id:'review-'+i,createdAt:new Date().toISOString(),fileName:frame.name,targetUrl:'db://assets/ui/prefabs/'+frame.name+'.prefab',
            assets:[],before:scene,after:scene,sourceTree:[],changes:[],warnings:[],confirmed:false,readOnlyReason:i?'':'历史批量报告，只读查看'}));
        let queue=[],lastResult;
        const settings={sourceUrl:'https://www.figma.com/design/example?node-id=10-1',assetFolder:'ui/images',prefabFolder:'ui/prefabs',localResourceFolders:[],localResourceFolder:'',scale:1,updateExisting:true,refreshAssets:false,autoSave:false,fontMap:{}};
        const request=async(_name,message,...args)=>{calls.push([message,...args]);
            if(message==='get-state')return{version:pkg.version,vault:{hasToken:true,persistent:true,backend:'browser fixture'},settings,document:null,fontAssets:fonts};
            if(message==='get-batch-state')return{items:queue,lastResult};
            if(message==='get-import-review')return args[0]?reports.get(args[0]):null;
            if(message==='resolve-batch-source'){queue=frames;return{sourceType:'section',sourceUrl:settings.sourceUrl,items:frames,added:3,duplicates:0};}
            if(message==='activate-batch-item')return frames.find(f=>f.id===args[0]).document;
            if(message==='sync-batch-items'){queue=args[0].map(x=>({...frames.find(f=>f.id===x.id),enabled:x.enabled}));return{items:queue};}
            if(message==='save-node-overrides')return args[1];
            if(message==='get-preview')return{url:preview};
            if(message==='stop-import-batch'){stopRequested=true;return{accepted:true};}
            if(message==='import-batch'){
                importCount++;const input=args[0];
                if(importCount===1)return await new Promise(resolve=>{window.finishImport=()=>{lastResult={id:'batch-1',stopped:true,completed:2,total:3,items:frames.map((f,i)=>({id:f.id,name:f.name,sourceUrl:f.sourceUrl,status:['success','failed','pending'][i],created:i?0:4,
                    ...(i===0?{prefabUrl:'db://assets/ui/prefabs/'+f.name+'.prefab',reviewId:'review-'+i}:i===1?{error:'示例：网络请求失败，可重试'}:{})}))};resolve(lastResult);};});
                return{id:'batch-'+importCount,stopped:false,completed:input.items.length,total:input.items.length,items:input.items.map(item=>({...frames.find(f=>f.id===item.id),status:'success',created:4,reviewId:'review-'+frames.findIndex(f=>f.id===item.id)}))};
            }
        };
        window.Editor={Panel:{define:definition=>definition},Message:{request},Selection:{clear(){},select(){}}};
        const cache={};const normalize=p=>{const a=[];for(const x of p.split('/')){if(x==='..')a.pop();else if(x&&x!=='.')a.push(x);}return'/'+a.join('/');};
        function load(id){if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;
            const localRequire=name=>{if(name==='fs')return{readFileSync:path=>path.endsWith('.html')?template:css};
                if(name==='path')return{join:(...p)=>p.join('/')};if(name==='crypto'||name==='fs/promises')return{};
                if(name.endsWith('raster-format'))return{};if(name.endsWith('package.json'))return pkg;
                const next=normalize(id.slice(0,id.lastIndexOf('/'))+'/'+name)+'.js';if(!sources[next])throw new Error('Fixture module missing: '+next);return load(next);};
            new Function('require','module','exports','__dirname',sources[id])(localRequire,module,module.exports,id.slice(0,id.lastIndexOf('/')));return module.exports;}
        window.panel=load('/dist/panels/default/index.js');window.host={$:{app:q('#app')}};window.ready=panel.ready.call(host);
    </script></body></html>`;
    const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const errors = [];
    try {
        const page = await browser.newPage({ viewport: { width: 650, height: 860 } });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForLoadState('networkidle'); await page.evaluate(() => window.ready);
        await page.locator('#add-batch-source').click();
        await page.waitForFunction(() => q('#batch-source-list').children.length === 3 && q('#app').dataset.workflowBusy === 'false');
        const checkLayout = async (label) => {
            assert.equal(await page.evaluate(() => q('#app').scrollWidth <= q('#app').clientWidth), true, `${label}: app width`);
            assert.equal(await page.evaluate(() => q('.workflow-content').scrollWidth <= q('.workflow-content').clientWidth), true, `${label}: content width`);
            assert.equal(await page.evaluate(() => q('.action-bar').getBoundingClientRect().top >= q('.workflow-content').getBoundingClientRect().bottom - 1), true, `${label}: footer separation`);
        };
        for (const width of [650, 420]) {
            await page.setViewportSize({ width, height: 860 }); await checkLayout(`list ${width}`);
            await page.screenshot({ path: join(temp, `list-${width}.png`) });
        }
        await page.locator('[data-batch-configure="frame-0"]').click();
        await page.waitForFunction(() => q('#app').dataset.workflowStep === '2' && q('#app').dataset.workflowBusy === 'false');
        assert.equal(await page.locator('[data-batch-frame]').count(), 3);
        await page.locator('[data-node-id="1:1:title"]').click();
        await page.locator('[data-name-for="1:1:title"]').fill('Home_Title');
        await page.locator('[data-name-for="1:1:title"]').press('Tab');
        await page.locator('[data-action-for="1:1:title"]').selectOption('render');
        await page.locator('[data-batch-frame="frame-1"]').click();
        await page.waitForFunction(() => q('#batch-active-name').textContent.includes('Bag_ui') && q('#app').dataset.workflowBusy === 'false');
        await page.locator('[data-batch-frame="frame-0"]').click();
        await page.waitForFunction(() => q('[data-name-for="1:1:title"]')?.value === 'Home_Title' && q('#app').dataset.workflowBusy === 'false');
        assert.equal(await page.locator('[data-action-for="1:1:title"]').inputValue(), 'render');
        assert.equal(await page.locator('[data-kind-for="1:1:title"]').count(), 1);
        assert.equal(await page.locator('[data-patch-for="1:1:title"]').count(), 1);
        for (const width of [650, 420]) {
            await page.setViewportSize({ width, height: 860 }); await page.locator('#nodes-title').scrollIntoViewIfNeeded();
            await checkLayout(`nodes ${width}`); await page.screenshot({ path: join(temp, `nodes-${width}.png`) });
        }
        await page.locator('#workflow-next').click();
        assert.equal(await page.locator('[data-batch-name]').count(), 3);
        await page.locator('#import-button').click();
        await page.waitForFunction(() => Boolean(window.finishImport));
        await page.evaluate(() => panel.methods.onProgress({phase:'assets',value:.4,message:'准备图片资源',batch:{batchId:'batch-1',itemId:'frame-0',name:'Home_ui',index:1,total:3,completed:0,stopRequested:false,items:frames.map((f,i)=>({id:f.id,name:f.name,sourceUrl:f.sourceUrl,status:i?'pending':'running'}))}}));
        for (const width of [650, 420]) {
            await page.setViewportSize({ width, height: 860 }); await page.locator('#progress-region').scrollIntoViewIfNeeded();
            await checkLayout(`running ${width}`); await page.screenshot({ path: join(temp, `running-${width}.png`) });
        }
        await page.locator('#cancel-import').click();
        assert.equal(await page.evaluate(() => window.stopRequested), true);
        await page.evaluate(() => window.finishImport());
        await page.waitForFunction(() => q('#app').dataset.workflowStep === '4' && q('#app').dataset.workflowBusy === 'false');
        for (const width of [650, 420]) {
            await page.setViewportSize({ width, height: 860 }); await page.locator('#result-title').scrollIntoViewIfNeeded();
            await checkLayout(`results ${width}`); await page.screenshot({ path: join(temp, `results-${width}.png`) });
        }
        await page.locator('[data-batch-review="frame-0"]').click();
        await page.waitForFunction(() => q('#import-review-dialog').open);
        assert.match(await page.locator('.review-readonly').textContent(), /历史批量报告/);
        await page.locator('.review-close').click();
        await page.locator('#batch-resume-pending').click();
        await page.waitForFunction(() => q('#result-summary').textContent.includes('成功 2 项'));
        await page.locator('#batch-retry-failed').click();
        await page.waitForFunction(() => q('#result-summary').textContent.includes('成功 3 项'));
        assert.deepEqual(errors, []);
        console.log(`Compiled batch panel browser checks passed: Section list, Frame tabs, independent edits, full node controls, shared settings, stop/resume/retry, per-item reports, and 650/420px layout. Screenshots: ${temp}`);
    } finally { await browser.close(); server.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
