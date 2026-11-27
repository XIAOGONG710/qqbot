import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { checkRequest, ensureToken, permissionMode, readToken, residentDir, TOKEN_FILE, TOKEN_HEADER } from '../src/platform/resident-guard.ts';
import { runWorkTask } from '../src/platform/work-bridge.ts';
import { focusCheckpoint } from '../../../dsh-plugins/dsh-linmengyao-memory/focus-checkpoints.mjs';

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

    test('常驻回 401 / 403：抛错并说怎么查，不会改走临时 headless（那样会绕过队列和「她离开电脑」）', async () => {
        process.env.HER_DIR = tmp();
        for (const status of [401, 403]) {
            globalThis.fetch = (async () => new Response('{"ok":false}', { status })) as never;
            await assert.rejects(runWorkTask('整理桌面'), new RegExp(`常驻的她拒绝了这次请求（HTTP ${status}）.*RESIDENT_TOKEN`));
        }
    });

    test('回执损坏或连接中途断开不改走临时执行', async () => {
        process.env.HER_DIR = tmp();
        globalThis.fetch = (async () => new Response('broken receipt')) as never;
        await assert.rejects(runWorkTask('查合成报错'), /工作回执未确认/);
        globalThis.fetch = (async () => { throw new TypeError('terminated'); }) as never;
        await assert.rejects(runWorkTask('查合成报错'), /工作回执未收到/);
    });
});

describe('隔离常驻进程的守卫和工作回执', () => {
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

    test('守卫正常工作，已落地但丢失的回执在重启后仍可核对，崩溃的执行不重跑', async () => {
        const dir = tmp();
        const port = await freePort();
        const script = resolve(import.meta.dirname, '../../../scripts/her-resident.mjs');
        // QQ 那边写的 NOW.md（生成时间 + 睡没睡）；常驻只读它
        const freshNow = `<!-- generated-at: ${new Date().toISOString()} -->\n<!-- asleep: no -->\n\n在宿舍看书\n`;
        writeFileSync(join(dir, 'NOW.md'), freshNow);
        const fakeBin = join(dir, 'synthetic.mjs');
        const calls = join(dir, 'calls');
        writeFileSync(fakeBin, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, 'run\\n');\nconsole.log('合成结果');\nif (process.argv.at(-1).includes('模拟中断')) process.exitCode = 1;`);
        const start = () => spawn(process.execPath, [script], {
            env: { ...process.env, HER_PORT: String(port), HER_DIR: dir, HER_SOUL_DIR: dir, QQBOT_SOUL_DIR: dir, HER_CWD: dir, DSH_BIN: fakeBin, QQBOT_LLM_API_KEY: '', QQBOT_DECISION_AUDIT: '1' },
            stdio: 'ignore', windowsHide: true,
        });
        let child = start();
        const ready = async () => {
            let up = false;
            for (let i = 0; i < 80 && !up; i++) {
                try { up = (await call(port, { method: 'GET', path: '/health' })).status === 200; } catch { await new Promise(done => setTimeout(done, 100)); }
            }
            assert.ok(up, '常驻没起来');
        };
        try {
            await ready();
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
            assert.deepEqual(JSON.parse(life.body), { ok: true, now: freshNow.trim() }, '只转述新鲜的 NOW.md，不再带 LIFE 状态');
            // NOW.md 过期了：now 是 null，不拿旧的冒充现在
            writeFileSync(join(dir, 'NOW.md'), `<!-- generated-at: ${new Date(Date.now() - 31 * 60_000).toISOString()} -->\n<!-- asleep: no -->\n\n在宿舍看书\n`);
            assert.deepEqual(JSON.parse((await call(port, { method: 'GET', path: '/life', headers: { [TOKEN_HEADER]: token } })).body), { ok: true, now: null });
            // 老的 Koishi 还会调 /note：回 200，什么也不做（不写 LIFE.json，不动 NOW.md）
            const nowBefore = readFileSync(join(dir, 'NOW.md'), 'utf8');
            const note = await call(port, { method: 'POST', path: '/note', headers: { ...json, [TOKEN_HEADER]: token }, body: '{"text":"你好烦","from":"baobao","negative":true}' });
            assert.equal(note.status, 200);
            assert.deepEqual(JSON.parse(note.body), { ok: true, retired: true });
            assert.equal((await call(port, { method: 'POST', path: '/note', headers: { ...json, [TOKEN_HEADER]: token }, body: 'not json' })).status, 200, '坏 JSON 也不在乎，反正不读');
            assert.equal(existsSync(join(dir, 'LIFE.json')), false, '不再有第二套生活写 LIFE.json');
            assert.equal(readFileSync(join(dir, 'NOW.md'), 'utf8'), nowBefore, 'NOW.md 只归 QQ 写');
            assert.equal((await call(port, { method: 'GET', path: '/health' })).status, 200);
            assert.match(readFileSync(join(dir, 'resident.log'), 'utf8'), /rejected HTTP 401/);
            const file = join(dir, 'focus-checkpoints.json');
            const submit = (checkpoint: { taskId: string; operationId: string; claimId: string }, task: string) => call(port, {
                method: 'POST', path: '/task', headers: { ...json, [TOKEN_HEADER]: token }, body: JSON.stringify({ task, checkpoint }),
            });
            const claim = (key: string) => {
                const operationId = key.repeat(24), taskId = `qq-${operationId}`, claimId = `start-${operationId}`;
                assert.equal(focusCheckpoint(file, { taskId, action: 'start', operationId: claimId, next: '核对合成日志' }).acquired, true);
                return { taskId, operationId, claimId };
            };
            const confirmed = claim('a');
            await submit(confirmed, '查合成日志'); // Discard the HTTP reply and reconstruct from storage.
            const interrupted = claim('b');
            assert.equal(focusCheckpoint(file, { action: 'finish', taskId: interrupted.taskId, operationId: 'desktop-finish' }).status, 'active');
            assert.equal(JSON.parse((await submit(interrupted, '模拟中断')).body).ok, false, '有输出但非正常退出，不能用作完成回执');
            const closed = new Promise(resolveExit => child.once('exit', resolveExit));
            child.kill();
            await closed;
            child = start();
            await ready();
            assert.equal(focusCheckpoint(file, { action: 'read', taskId: confirmed.taskId }).status, 'finished');
            assert.equal(JSON.parse((await submit(confirmed, '查合成日志')).body).ok, false);
            assert.equal(focusCheckpoint(file, { action: 'read', taskId: interrupted.taskId }).status, 'active');
            assert.equal(JSON.parse((await submit(interrupted, '模拟中断')).body).ok, false);
            assert.equal(focusCheckpoint(file, { action: 'cancel', taskId: interrupted.taskId, operationId: 'cancel' }).status, 'cancelled');
            const taskId = 'dsh-native-checkpoint', operationId = 'c'.repeat(24), claimId = `resume-${operationId}`;
            focusCheckpoint(file, { taskId, action: 'start', operationId: 'desktop-inspect', next: '查合成日志' });
            focusCheckpoint(file, { taskId, action: 'wait', operationId: 'desktop-wait', next: '核对合成配置' });
            assert.equal(focusCheckpoint(file, { taskId, action: 'resume', operationId: claimId }).acquired, true);
            const next = { taskId, operationId, claimId };
            assert.equal(JSON.parse((await submit(next, '检查下一项 PRIVATE-RESIDENT 123456789')).body).checkpoint, next.operationId);
            assert.equal(readFileSync(calls, 'utf8'), 'run\nrun\nrun\n');
            assert.doesNotMatch(readFileSync(join(dir, 'resident.log'), 'utf8'), /PRIVATE-RESIDENT|123456789|合成结果/);
        } finally {
            child.kill();
        }
    });
});
