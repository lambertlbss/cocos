'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function loadDiagnostics(lines, broken = false, levels = []) {
    const write = (level) => (line) => {
        if (broken) throw new Error('console unavailable');
        lines.push(line);
        levels.push(level);
    };
    const context = { exports: {}, Date, console: {
        log: write('log'), warn: write('warn'), error: write('error'),
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/diagnostics.js'), 'utf8'), context);
    return context.exports;
}

function loadClient(replies) {
    const lines = [];
    const requests = [];
    const intervals = new Set();
    let now = 0;
    const diagnostics = loadDiagnostics(lines);
    const fakeHttps = { request(options, callback) {
        requests.push(options);
        const reply = replies.shift();
        assert.ok(reply, 'unexpected extra request');
        const req = new EventEmitter();
        let timeout;
        req.setTimeout = (_ms, cb) => { timeout = cb; return req; };
        req.destroy = (error) => { req.emit('error', error); req.emit('close'); return req; };
        req.end = () => queueMicrotask(() => {
            if (reply.timeout) { timeout(); return; }
            const response = new EventEmitter();
            response.statusCode = reply.status;
            response.headers = reply.headers ?? {};
            response.complete = !reply.aborted;
            response.resume = () => {};
            callback(response);
            if (reply.onResponse) {
                reply.onResponse(response, req);
                return;
            }
            if (reply.aborted) {
                response.emit('aborted');
                response.emit('close');
                req.emit('close');
                return;
            }
            response.emit('data', Buffer.from(reply.body ?? '{}'));
            response.emit('end');
            response.emit('close');
            req.emit('close');
        });
        return req;
    } };
    const context = {
        exports: {}, Buffer, URLSearchParams,
        Date: { now: () => now },
        setInterval(callback, delay) {
            assert.equal(delay, 5000);
            const timer = { callback, unref() {} };
            intervals.add(timer);
            return timer;
        },
        clearInterval(timer) { intervals.delete(timer); },
        setTimeout: (callback) => { queueMicrotask(callback); return 1; },
        clearTimeout() {},
        require(id) {
            if (id === 'https') return fakeHttps;
            if (id === '../diagnostics') return diagnostics;
            return require(id);
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/figma/client.js'), 'utf8'), context);
    return {
        Client: context.exports.FigmaClient, lines, requests, intervals,
        tick(ms = 5000) {
            now += ms;
            for (const timer of intervals) timer.callback();
        },
    };
}

test('diagnostics preserve results and error identity while redacting credentials and signed URLs', async () => {
    const lines = [];
    const { diagnosticTask } = loadDiagnostics(lines);
    const result = {};
    assert.equal(await diagnosticTask('资源查询', { target: 'db://assets/test.png' }, async () => result), result);
    const error = new Error('https://cdn.example/image?signature=SECRET figd_PRIVATE');
    await assert.rejects(diagnosticTask('下载', undefined, async () => { throw error; }), (actual) => actual === error);
    const text = lines.join('\n');
    assert.match(text, /开始/);
    assert.match(text, /完成/);
    assert.match(text, /失败/);
    assert.match(text, /\+\d+ms/);
    assert.match(text, /db:\/\/assets\/test.png/);
    assert.doesNotMatch(text, /SECRET|PRIVATE|cdn\.example/);
});

test('unavailable console cannot break the operation', async () => {
    const { diagnosticTask } = loadDiagnostics([], true);
    assert.equal(await diagnosticTask('test', {}, async () => 42), 42);
});

test('diagnostics use error for failures, warn for retry/timeout/HTTP errors, and log for normal progress', () => {
    const levels = [];
    const { diagnosticStart } = loadDiagnostics([], false, levels);
    const trace = diagnosticStart('下载');
    trace.event('接收进度', { receivedBytes: 12 });
    trace.event('等待重试');
    trace.event('连接无数据超时');
    trace.event('响应中断');
    trace.event('响应提前关闭');
    trace.event('尝试失败');
    trace.event('收到响应头', { status: 429 });
    trace.done({ status: 500 });
    trace.fail(new Error('下载失败'));
    trace.event('失败：重定向次数过多');
    trace.done({ status: 200 });
    assert.deepEqual(levels, [
        'log', 'log', 'warn', 'warn', 'warn', 'warn', 'warn',
        'warn', 'warn', 'error', 'error', 'log',
    ]);
});

test('Figma export logs batch names, HTTP 429 and retry without changing batch size', async () => {
    const { Client, lines, requests } = loadClient([
        { status: 429, headers: { 'retry-after': '2' } },
        { status: 200, body: '{"images":{"1:0":"https://cdn.example/?signature=SECRET"}}' },
        { status: 200, body: '{"images":{}}' },
    ]);
    const ids = Array.from({ length: 101 }, (_, i) => `1:${i}`);
    const result = await new Client('DO_NOT_LOG_TOKEN').getImageUrls('file', ids, 'png', 1, true, { '1:0': '银币' });
    assert.match(result['1:0'], /SECRET/);
    assert.equal(requests.length, 3);
    assert.equal(new URL(`https://api.figma.com${requests[0].path}`).searchParams.get('ids').split(',').length, 100);
    assert.equal(new URL(`https://api.figma.com${requests[2].path}`).searchParams.get('ids'), '1:100');
    assert.equal(requests[0].headers['X-Figma-Token'], 'DO_NOT_LOG_TOKEN');
    const text = lines.join('\n');
    assert.match(text, /银币/);
    assert.match(text, /收到响应头.*429/);
    assert.match(text, /等待重试/);
    assert.match(text, /"batch":2/);
    assert.doesNotMatch(text, /DO_NOT_LOG_TOKEN|SECRET/);
});

test('download logs node identity and existing timeout retries, but not signed URLs', async () => {
    const { Client, lines, requests } = loadClient([
        { timeout: true }, { timeout: true }, { timeout: true },
    ]);
    await assert.rejects(new Client('TOKEN').download('https://cdn.example/image?signature=SECRET', '背景 (1:2)'), /请求超时/);
    assert.equal(requests.length, 3);
    const text = lines.join('\n');
    assert.match(text, /图片下载 背景 \(1:2\)/);
    assert.match(text, /连接无数据超时/);
    assert.match(text, /失败/);
    assert.doesNotMatch(text, /signature|SECRET|TOKEN/);
});

test('premature response closure is observable without changing the pending-request behavior', async () => {
    const { Client, lines } = loadClient([{ status: 200, aborted: true }]);
    let settled = false;
    new Client('TOKEN').getNode('file', '1:2').then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.match(lines.join('\n'), /响应中断/);
    assert.match(lines.join('\n'), /响应提前关闭/);
});

test('body heartbeat distinguishes zero bytes, partial transfer, and all bytes before end; timer stops on end', async () => {
    let response;
    const probe = loadClient([{
        status: 200,
        headers: { 'content-length': '10', 'content-type': 'image/png' },
        onResponse(value) { response = value; },
    }]);
    const task = new probe.Client('TOKEN').download('https://cdn.example/?signature=SECRET', '背景');
    await new Promise((resolve) => setImmediate(resolve));
    probe.tick();
    assert.match(probe.lines.at(-1), /接收进度.*"receivedBytes":0,"totalBytes":10,"percent":0,"noDataForMs":5000/);
    response.emit('data', Buffer.from('1234'));
    probe.tick();
    assert.match(probe.lines.at(-1), /接收进度.*"receivedBytes":4,"totalBytes":10,"percent":40,"noDataForMs":5000/);
    response.emit('data', Buffer.from('567890'));
    assert.match(probe.lines.at(-1), /已收到声明大小，等待响应结束.*"receivedBytes":10/);
    response.emit('end');
    assert.equal((await task).toString(), '1234567890');
    assert.equal(probe.intervals.size, 0);
    const count = probe.lines.length;
    probe.tick();
    assert.equal(probe.lines.length, count);
    assert.match(probe.lines.join('\n'), /"contentType":"image\/png"/);
    assert.doesNotMatch(probe.lines.join('\n'), /SECRET|TOKEN/);
});

test('unknown size stays null; premature close logs received bytes and removes heartbeat', async () => {
    let response;
    const probe = loadClient([{
        status: 200, headers: { 'content-length': 'invalid' },
        onResponse(value) { response = value; },
    }]);
    new probe.Client('TOKEN').download('https://cdn.example/image');
    await new Promise((resolve) => setImmediate(resolve));
    response.emit('data', Buffer.from('123'));
    probe.tick();
    assert.match(probe.lines.at(-1), /"receivedBytes":3,"totalBytes":null,"percent":null/);
    response.complete = false;
    response.emit('aborted');
    response.emit('close');
    assert.equal(probe.intervals.size, 0);
    assert.match(probe.lines.at(-1), /响应提前关闭.*"receivedBytes":3/);
});
