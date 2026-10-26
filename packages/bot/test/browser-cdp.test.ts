import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { CdpError, createCdpConnection, findBrowserExe, launchArgs, launchBrowser, openPage, parseActivePort, type CdpTransport } from '../src/browser-cdp.ts';

/** 假的浏览器：按方法名回话，可以主动推事件 */
function fakeBrowser(handlers: Record<string, (params: any) => unknown> = {}) {
    const sent: Array<{ id: number; method: string; params?: any; sessionId?: string }> = [];
    let onMessage: (text: string) => void = () => undefined;
    let onClose: () => void = () => undefined;
    const reply = (value: unknown) => onMessage(JSON.stringify(value));
    const transport: CdpTransport = {
        send(text) {
            const message = JSON.parse(text) as { id: number; method: string; params?: any; sessionId?: string };
            sent.push(message);
            const handler = handlers[message.method];
            queueMicrotask(() => {
                if (!handler) return reply({ id: message.id, result: {} });
                try { reply({ id: message.id, result: handler(message.params) }); } catch (error) { reply({ id: message.id, error: { code: -32000, message: (error as Error).message } }); }
            });
        },
        close() { onClose(); },
        onMessage(listener) { onMessage = listener; },
        onClose(listener) { onClose = listener; },
    };
    return { transport, sent, event: (method: string, params: unknown, sessionId?: string) => reply({ method, params, ...(sessionId ? { sessionId } : {}) }), drop: () => onClose() };
}

const pageHandlers = {
    'Target.createTarget': () => ({ targetId: 'T1' }),
    'Target.attachToTarget': () => ({ sessionId: 'S1' }),
};

describe('浏览器开发者协议连接（ADR 0166）', () => {
    test('命令按编号对上回话；错误回话变成 CdpError；事件送给监听者，取消后不再收到', async () => {
        const fake = fakeBrowser({ 'Runtime.evaluate': () => ({ result: { value: 3 } }), 'Page.bad': () => { throw new Error('不行'); } });
        const connection = createCdpConnection(fake.transport);
        assert.deepEqual(await connection.send('Runtime.evaluate', { expression: '1+2' }), { result: { value: 3 } });
        await assert.rejects(connection.send('Page.bad'), (error: unknown) => error instanceof CdpError && error.message === '不行' && error.code === -32000);
        const seen: unknown[] = [];
        const off = connection.on('Network.x', params => seen.push(params));
        fake.event('Network.x', { n: 1 });
        off();
        fake.event('Network.x', { n: 2 });
        assert.deepEqual(seen, [{ n: 1 }]);
    });

    test('命令超时会报错；连接断了，等着的命令全部失败，之后再发也失败', async () => {
        const silent: CdpTransport = { send() { /* 不回话 */ }, close() { /* 无 */ }, onMessage() { /* 无 */ }, onClose() { /* 无 */ } };
        await assert.rejects(createCdpConnection(silent, { commandTimeoutMs: 20 }).send('Page.enable'), /Page\.enable 超时/);
        // 单条命令自己的超时（读响应体用短的，不拖住整次浏览）
        await assert.rejects(createCdpConnection(silent, { commandTimeoutMs: 60_000 }).send('Network.getResponseBody', {}, undefined, 15), /Network\.getResponseBody 超时（15 ms）/);
        const fake = fakeBrowser({ 'Never.replies': () => new Promise(() => undefined) });
        const connection = createCdpConnection(fake.transport);
        const waiting = connection.send('Slow');
        fake.drop();
        await assert.rejects(waiting);
        await assert.rejects(connection.send('Page.enable'), /已经关了/);
        assert.equal(connection.closed, true);
    });
});

describe('页面：读网页自己发出去的请求收到的内容', () => {
    test('打开页面会开 Page / Network，导航等 load；evaluate 返回值、脚本报错抛 CdpError', async () => {
        const fake = fakeBrowser({
            ...pageHandlers,
            'Page.navigate': () => { setTimeout(() => fake.event('Page.loadEventFired', {}, 'S1'), 5); return { frameId: 'F' }; },
            'Runtime.evaluate': params => (params.expression === 'boom' ? { exceptionDetails: { text: '出错', exception: { description: 'ReferenceError: x' } } } : { result: { value: 42 } }),
        });
        const page = await openPage(createCdpConnection(fake.transport));
        assert.deepEqual(fake.sent.map(m => m.method).slice(0, 5), ['Target.createTarget', 'Target.attachToTarget', 'Page.enable', 'Network.enable', 'Emulation.setDeviceMetricsOverride']);
        await page.goto('https://example.com/x', { timeoutMs: 1000 });
        assert.equal(await page.evaluate('6*7'), 42);
        await assert.rejects(page.evaluate('boom'), /ReferenceError: x/);
        await page.wheel(500);
        const wheel = fake.sent.find(m => m.method === 'Input.dispatchMouseEvent');
        assert.equal(wheel?.params.type, 'mouseWheel');
        assert.equal(wheel?.sessionId, 'S1');
    });

    test('等响应：读完才算；按 URL 筛；since 之前的不算；别的会话的不算；读响应体（含 base64）', async () => {
        const bodies: Record<string, { body: string; base64Encoded: boolean }> = {
            r1: { body: '{"a":1}', base64Encoded: false },
            r2: { body: Buffer.from('{"b":"中文"}').toString('base64'), base64Encoded: true },
        };
        const fake = fakeBrowser({ ...pageHandlers, 'Network.getResponseBody': params => bodies[params.requestId] });
        const page = await openPage(createCdpConnection(fake.transport));
        const start = page.mark();
        fake.event('Network.responseReceived', { requestId: 'r1', response: { url: 'https://site/api/feed?x=1', status: 200, mimeType: 'application/json' } }, 'S1');
        // 还没读完：等不到
        assert.equal(await page.waitForResponse(/api\/feed/, { timeoutMs: 30 }), undefined);
        fake.event('Network.loadingFinished', { requestId: 'r1' }, 'S1');
        const first = await page.waitForResponse(/api\/feed/, { timeoutMs: 100 });
        assert.equal(first?.status, 200);
        assert.equal(await first?.body(), '{"a":1}');
        // since 之后才算新的
        assert.equal(await page.waitForResponse(/api\/feed/, { since: page.mark(), timeoutMs: 30 }), undefined);
        // 别的会话（别的标签页）的响应不混进来
        fake.event('Network.responseReceived', { requestId: 'other', response: { url: 'https://site/api/feed?y=1', status: 200, mimeType: 'application/json' } }, 'S9');
        fake.event('Network.loadingFinished', { requestId: 'other' }, 'S9');
        assert.equal(page.responses(/api\/feed/, start).length, 1);
        // 之后到的：等的人会被叫醒
        const waiting = page.waitForResponse(/api\/search/, { since: page.mark(), timeoutMs: 500 });
        fake.event('Network.responseReceived', { requestId: 'r2', response: { url: 'https://site/api/search', status: 200, mimeType: 'application/json' } }, 'S1');
        fake.event('Network.loadingFinished', { requestId: 'r2' }, 'S1');
        assert.equal(await (await waiting)?.body(), '{"b":"中文"}');
        // 失败的请求不算读完
        fake.event('Network.responseReceived', { requestId: 'r3', response: { url: 'https://site/api/bad', status: 0, mimeType: '' } }, 'S1');
        fake.event('Network.loadingFailed', { requestId: 'r3' }, 'S1');
        assert.equal(page.responses(/api\/bad/).length, 0);
    });

    test('导航失败（网络错误页）抛错，并说是哪个站', async () => {
        const fake = fakeBrowser({ ...pageHandlers, 'Page.navigate': () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }) });
        const page = await openPage(createCdpConnection(fake.transport));
        await assert.rejects(page.goto('https://www.douyin.com/'), /打不开 www\.douyin\.com：net::ERR_NAME_NOT_RESOLVED/);
    });
});

describe('启动浏览器（ADR 0166）', () => {
    test('启动参数：专用目录、调试端口自动选、默认不加载图片、放到屏幕外；要看见窗口 / 要图片时各自打开', () => {
        const base = launchArgs({ profileDir: 'D:\\p' });
        assert.ok(base.includes('--user-data-dir=D:\\p') && base.includes('--remote-debugging-port=0'));
        assert.ok(base.includes('--blink-settings=imagesEnabled=false') && base.some(a => a.startsWith('--window-position=-')));
        const visible = launchArgs({ profileDir: 'D:\\p', visible: true, images: true });
        assert.ok(!visible.includes('--blink-settings=imagesEnabled=false') && !visible.some(a => a.startsWith('--window-position')));
    });

    test('不带任何伪装参数：无头、改 UA、关自动化标记、反检测都不碰（ADR 0166 的底线，测试锁住）', () => {
        for (const options of [{ profileDir: 'x' }, { profileDir: 'x', visible: true }, { profileDir: 'x', images: true, offscreen: false }]) {
            for (const arg of launchArgs(options)) {
                assert.doesNotMatch(arg, /headless|user-agent|AutomationControlled|disable-blink-features|enable-automation|stealth|disable-web-security/i, arg);
            }
        }
    });

    test('launchBrowser：等到端口文件、连上、开页面；关的时候先让浏览器自己退出', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-cdp-'));
        try {
            const child = Object.assign(new EventEmitter(), { pid: 4321 });
            let spawned: { exe: string; args: string[] } | undefined;
            const fake = fakeBrowser({ ...pageHandlers, 'Browser.close': () => { queueMicrotask(() => child.emit('exit', 0)); return {}; } });
            const urls: string[] = [];
            const browser = await launchBrowser({
                exe: 'C:\\edge.exe', profileDir: join(dir, 'profile'),
                spawnProcess: ((exe: string, args: string[]) => { spawned = { exe, args }; writeFileSync(join(dir, 'profile', 'DevToolsActivePort'), '9333\n/devtools/browser/guid-1\n'); return child; }) as never,
                connect: async url => { urls.push(url); return fake.transport; },
            });
            assert.equal(spawned?.exe, 'C:\\edge.exe');
            assert.deepEqual(urls, ['ws://127.0.0.1:9333/devtools/browser/guid-1']);
            assert.equal(browser.pid, 4321);
            await browser.newPage();
            await browser.close();
            assert.ok(fake.sent.some(m => m.method === 'Browser.close'));
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('浏览器一启动就退出：抛错，不一直等', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-cdp-'));
        try {
            const child = Object.assign(new EventEmitter(), { pid: 1 });
            const started = launchBrowser({ exe: 'x', profileDir: join(dir, 'p'), spawnProcess: (() => { queueMicrotask(() => child.emit('exit', 1)); return child; }) as never, connect: async () => fakeBrowser().transport });
            await assert.rejects(started, /马上退出/);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('启动浏览器的小工具', () => {
    test('DevToolsActivePort：第一行端口，第二行路径；不对就 undefined', () => {
        assert.deepEqual(parseActivePort('9222\n/devtools/browser/abc-123\n'), { port: 9222, path: '/devtools/browser/abc-123' });
        assert.deepEqual(parseActivePort('9222\r\n/devtools/browser/abc'), { port: 9222, path: '/devtools/browser/abc' });
        assert.equal(parseActivePort(''), undefined);
        assert.equal(parseActivePort('abc\n/devtools/browser/x'), undefined);
        assert.equal(parseActivePort('9222\n/etc/passwd'), undefined);
    });

    test('找浏览器：环境变量优先，其次 Edge，再 Chrome；都没有返回 undefined', () => {
        const only = (...paths: string[]) => (path: string) => paths.includes(path);
        const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
        const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        assert.equal(findBrowserExe({ QQBOT_BROWSER_EXE: 'D:\\b.exe' }, only('D:\\b.exe', edge)), 'D:\\b.exe');
        assert.equal(findBrowserExe({}, only(edge, chrome)), edge);
        assert.equal(findBrowserExe({}, only(chrome)), chrome);
        assert.equal(findBrowserExe({}, only()), undefined);
        // 环境变量指的文件不存在就不用它
        assert.equal(findBrowserExe({ QQBOT_BROWSER_EXE: 'D:\\gone.exe' }, only(edge)), edge);
    });
});
