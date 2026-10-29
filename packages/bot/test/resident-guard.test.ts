import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { checkRequest, ensureToken, permissionMode, readToken, residentDir, TOKEN_FILE, TOKEN_HEADER } from '../src/platform/resident-guard.ts';
import { noteResident, runWorkTask } from '../src/platform/work-bridge.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-resident-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TOKEN = 'a'.repeat(64);
const PORT = 7777;
const request = (over: Partial<Parameters<typeof checkRequest>[0]> & { headers?: Record<string, string> } = {}) => ({
    method: 'POST', url: '/task', ...over, headers: { host: `127.0.0.1:${PORT}`, [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', ...(over.headers ?? {}) },
});

describe('常驻的她的本地接口守卫（ADR 0172）：整机权限给「他从 QQ 发来的任务」，不给本机别的进程和他浏览器里的网页', () => {
    test('正常请求：本机地址 + 令牌 + JSON 才放行', () => {
        assert.deepEqual(checkRequest(request(), { token: TOKEN, port: PORT }), { ok: true });
        assert.deepEqual(checkRequest(request({ headers: { host: `localhost:${PORT}` } }), { token: TOKEN, port: PORT }), { ok: true });
    });

    test('没有令牌 / 令牌不对 / 长度不同：401', () => {
        for (const headers of [{ [TOKEN_HEADER]: '' }, { [TOKEN_HEADER]: 'b'.repeat(64) }, { [TOKEN_HEADER]: TOKEN.slice(0, 10) }, { [TOKEN_HEADER]: `${TOKEN}x` }]) {
            assert.deepEqual(checkRequest(request({ headers }), { token: TOKEN, port: PORT }), { ok: false, status: 401, error: 'token required' }, JSON.stringify(headers));
        }
        // 根本没带这个头（和带了空串不是一回事）
        const { [TOKEN_HEADER]: _dropped, ...withoutToken } = request().headers;
        assert.equal((checkRequest({ method: 'POST', url: '/task', headers: withoutToken }, { token: TOKEN, port: PORT }) as { status: number }).status, 401);
    });

    test('浏览器跨站请求：带 Origin 的一律 403，就算令牌是对的（网页拿不到令牌，但「简单 POST」不触发预检，不能指望预检）', () => {
        assert.deepEqual(checkRequest(request({ headers: { origin: 'https://evil.example' } }), { token: TOKEN, port: PORT }), { ok: false, status: 403, error: 'cross-origin requests are not allowed' });
        assert.deepEqual(checkRequest(request({ headers: { origin: 'null' } }), { token: TOKEN, port: PORT }), { ok: false, status: 403, error: 'cross-origin requests are not allowed' });
    });

    test('DNS 重绑定：Host 不是本机地址 + 端口就 400（没有 Host 也是）', () => {
        for (const host of ['evil.example:7777', 'evil.example', '127.0.0.1', '127.0.0.1:8888', '127.0.0.1.evil.example:7777']) {
            assert.deepEqual(checkRequest(request({ headers: { host } }), { token: TOKEN, port: PORT }), { ok: false, status: 400, error: 'bad host' }, host);
        }
        const { host: _noHost, ...withoutHost } = request().headers;
        assert.equal((checkRequest({ method: 'POST', url: '/task', headers: withoutHost }, { token: TOKEN, port: PORT }) as { status: number }).status, 400);
    });

    test('POST 必须是 application/json（text/plain 的跨站请求能绕开预检）', () => {
        for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
            assert.deepEqual(checkRequest(request({ headers: { 'content-type': type } }), { token: TOKEN, port: PORT }), { ok: false, status: 415, error: 'application/json required' }, type);
        }
        assert.equal(checkRequest(request({ headers: { 'content-type': 'Application/JSON; charset=utf-8' } }), { token: TOKEN, port: PORT }).ok, true);
    });

    test('GET /health 不要令牌（探活用），但 Host / Origin 照样查；GET /life 要令牌', () => {
        const health = { method: 'GET', url: '/health', headers: { host: `127.0.0.1:${PORT}` } };
        assert.equal(checkRequest(health, { token: TOKEN, port: PORT }).ok, true);
        assert.equal((checkRequest({ ...health, headers: { ...health.headers, origin: 'https://evil.example' } }, { token: TOKEN, port: PORT }) as { status: number }).status, 403);
        assert.equal((checkRequest({ ...health, url: '/life' }, { token: TOKEN, port: PORT }) as { status: number }).status, 401);
    });

    test('令牌：第一次生成 64 位十六进制并存盘；再调用原样用；文件坏了（格式不对）读不到、会重新生成', () => {
        const dir = tmp();
        assert.equal(readToken(dir), undefined);
        const first = ensureToken(dir);
        assert.match(first, /^[0-9a-f]{64}$/);
        assert.equal(ensureToken(dir), first);
        assert.equal(readToken(dir), first);
        assert.equal(readFileSync(join(dir, TOKEN_FILE), 'utf8').trim(), first);
        writeFileSync(join(dir, TOKEN_FILE), 'not-a-token\n');
        assert.equal(readToken(dir), undefined);
        const second = ensureToken(dir);
        assert.match(second, /^[0-9a-f]{64}$/);
        assert.notEqual(second, first);
    });

    test('权限模式：默认整机权限（用户 10-29 给的），环境变量可以降档；常驻目录可以用环境变量改', () => {
        assert.equal(permissionMode({}), 'danger-full-access');
        assert.equal(permissionMode({ HER_PERMISSION_MODE: 'workspace-write' }), 'workspace-write');
        assert.equal(permissionMode({ HER_PERMISSION_MODE: '' }), 'danger-full-access');
        assert.equal(residentDir({ HER_DIR: 'D:/x' }), 'D:/x');
    });
});

describe('工作桥：带令牌去找常驻的她；被明确拒绝不能悄悄改走临时 headless', () => {
    const realFetch = globalThis.fetch;
    const realDir = process.env.HER_DIR;
    afterEach(() => { globalThis.fetch = realFetch; if (realDir === undefined) delete process.env.HER_DIR; else process.env.HER_DIR = realDir; });

    test('令牌文件在：请求头带上令牌，拿到回复就返回', async () => {
        const dir = tmp();
        process.env.HER_DIR = dir;
        const token = ensureToken(dir);
        const seen: Array<{ url: string; headers: Record<string, string> }> = [];
        globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => { seen.push({ url, headers: init.headers }); return new Response(JSON.stringify({ ok: true, reply: '做完了' }), { status: 200 }); }) as never;
        assert.equal(await runWorkTask('整理桌面', { context: '' }), '做完了');
        assert.equal(seen[0]!.url.endsWith('/task'), true);
        assert.equal(seen[0]!.headers[TOKEN_HEADER], token);
        assert.equal(seen[0]!.headers['Content-Type'], 'application/json');
    });

    test('互动记录（/note，生活引擎据此改心情 / 关系）也要带令牌，否则加了守卫之后会被 401 静默丢掉；常驻没起来不抛错', async () => {
        const dir = tmp();
        process.env.HER_DIR = dir;
        const token = ensureToken(dir);
        const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
        globalThis.fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => { seen.push({ url, ...init }); return new Response('{"ok":true}', { status: 200 }); }) as never;
        await noteResident({ text: '他又催我切工作', from: 'baobao', negative: true });
        assert.equal(seen[0]!.url, 'http://127.0.0.1:7777/note');
        assert.equal(seen[0]!.method, 'POST');
        assert.equal(seen[0]!.headers[TOKEN_HEADER], token);
        assert.equal(seen[0]!.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(seen[0]!.body), { text: '他又催我切工作', from: 'baobao', negative: true });
        globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as never;
        await assert.doesNotReject(noteResident({ text: 'x', from: 'baobao' }));
    });

    test('常驻回 401 / 403：抛错并说怎么查，不会改走临时 headless（那样会绕过队列和「她离开电脑」）', async () => {
        process.env.HER_DIR = tmp();
        for (const status of [401, 403]) {
            globalThis.fetch = (async () => new Response('{"ok":false}', { status })) as never;
            await assert.rejects(runWorkTask('整理桌面'), new RegExp(`常驻的她拒绝了这次请求（HTTP ${status}）.*RESIDENT_TOKEN`));
        }
    });
});

describe('真的把 scripts/her-resident.mjs 起起来：守卫接上了（不发任何合法的 /task，免得在装了 DSH 的机器上跑起真的智能体）', () => {
    const freePort = () => new Promise<number>((resolvePort, reject) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolvePort(port)); });
        server.on('error', reject);
    });
    const call = (port: number, options: { method: string; path: string; headers?: Record<string, string>; body?: string }) => new Promise<{ status: number; body: string }>((resolveCall, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: options.method, path: options.path, headers: options.headers }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolveCall({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end(options.body);
    });

    test('无令牌 401、错令牌 401、带 Origin 403、text/plain 415、伪造 Host 400；有令牌的 GET /life 200；GET /health 不要令牌', async () => {
        const dir = tmp();
        const port = await freePort();
        const script = resolve(import.meta.dirname, '../../../scripts/her-resident.mjs');
        const child = spawn(process.execPath, [script], {
            env: { ...process.env, HER_PORT: String(port), HER_DIR: dir, HER_SOUL_DIR: dir, HER_CWD: dir, DSH_PERMISSION_MODE: '', QQBOT_LLM_API_KEY: '' },
            stdio: 'ignore', windowsHide: true,
        });
        try {
            let up = false;
            for (let i = 0; i < 80 && !up; i++) {
                try { up = (await call(port, { method: 'GET', path: '/health' })).status === 200; } catch { await new Promise(done => setTimeout(done, 100)); }
            }
            assert.ok(up, '常驻没起来');
            const token = readToken(dir);
            assert.ok(token, '常驻第一次启动应该生成令牌文件');
            const json = { 'content-type': 'application/json' };
            assert.equal((await call(port, { method: 'POST', path: '/task', headers: json, body: '{"task":"自动测试请求：不要做任何事，只回复收到"}' })).status, 401);
            assert.equal((await call(port, { method: 'POST', path: '/task', headers: { ...json, [TOKEN_HEADER]: 'b'.repeat(64) }, body: '{"task":"自动测试请求：不要做任何事，只回复收到"}' })).status, 401);
            assert.equal((await call(port, { method: 'POST', path: '/task', headers: { ...json, [TOKEN_HEADER]: token, origin: 'https://evil.example' }, body: '{"task":"自动测试请求：不要做任何事，只回复收到"}' })).status, 403);
            assert.equal((await call(port, { method: 'POST', path: '/task', headers: { 'content-type': 'text/plain', [TOKEN_HEADER]: token }, body: '{"task":"自动测试请求：不要做任何事，只回复收到"}' })).status, 415);
            assert.equal((await call(port, { method: 'POST', path: '/note', headers: json, body: '{"text":"x"}' })).status, 401);
            assert.equal((await call(port, { method: 'GET', path: '/life', headers: { host: `evil.example:${port}`, [TOKEN_HEADER]: token } })).status, 400);
            assert.equal((await call(port, { method: 'GET', path: '/life' })).status, 401);
            const life = await call(port, { method: 'GET', path: '/life', headers: { [TOKEN_HEADER]: token } });
            assert.equal(life.status, 200);
            assert.equal((JSON.parse(life.body) as { ok: boolean }).ok, true);
            assert.equal((await call(port, { method: 'GET', path: '/health' })).status, 200);
            assert.match(readFileSync(join(dir, 'resident.log'), 'utf8'), /rejected POST \/task: token required/);
        } finally {
            child.kill();
        }
    });
});
