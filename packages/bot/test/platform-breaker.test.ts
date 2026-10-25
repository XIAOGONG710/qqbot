import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { BILIBILI_RISK, BreakerOpen, breakerPath, createBreaker, guardRequest, type GuardedResponse } from '../src/platform-breaker.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-breaker-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('平台账号的持久熔断器（ADR 0147）', () => {
    test('熔断后 check 抛 BreakerOpen；先熔断的原因不被后来的覆盖；写了日志', () => {
        const dataDir = tmp();
        const logs: string[] = [];
        const breaker = createBreaker({ dataDir, platform: 'bilibili', now: () => 1000, log: m => logs.push(m) });
        assert.doesNotThrow(() => breaker.check());
        assert.equal(breaker.state(), undefined);
        breaker.trip('HTTP 412', 412);
        breaker.trip('风控码 -352', -352);
        assert.throws(() => breaker.check(), (error: unknown) => error instanceof BreakerOpen && error.state.reason === 'HTTP 412');
        assert.deepEqual(breaker.state(), { platform: 'bilibili', trippedAt: 1000, reason: 'HTTP 412', code: 412 });
        assert.equal(logs.filter(l => l.includes('熔断：')).length, 1);
        assert.match(logs[0]!, /platform resume bilibili --acknowledge-account-risk/);
    });

    test('状态存盘：新实例（重启）和另一个进程都看得到；恢复后也立刻看得到', () => {
        const dataDir = tmp();
        createBreaker({ dataDir, platform: 'bilibili', now: () => 5 }).trip('HTTP 429', 429);
        const afterRestart = createBreaker({ dataDir, platform: 'bilibili' });
        assert.throws(() => afterRestart.check(), BreakerOpen);
        // 另一个进程（命令行）恢复
        createBreaker({ dataDir, platform: 'bilibili' }).resume();
        assert.doesNotThrow(() => afterRestart.check(), '运行中的实例每次都读盘，命令行恢复之后下一次请求就通了');
        assert.equal(afterRestart.state(), undefined);
    });

    test('各平台各管各的', () => {
        const dataDir = tmp();
        createBreaker({ dataDir, platform: 'bilibili' }).trip('x');
        assert.doesNotThrow(() => createBreaker({ dataDir, platform: 'weibo' }).check());
        assert.match(breakerPath(dataDir, 'bilibili'), /platforms[\\/]bilibili[\\/]breaker\.json$/);
    });
});

describe('guardRequest：给请求函数包一层', () => {
    const make = (responses: { status: number; body: string }[]) => {
        let calls = 0;
        const request = async (_url: string, _init: object): Promise<GuardedResponse & { extra: string }> => {
            const next = responses[Math.min(calls++, responses.length - 1)]!;
            let read = false;
            return { ok: next.status < 400, status: next.status, extra: 'cookies', text: async () => { if (read) throw new Error('body already read'); read = true; return next.body; } };
        };
        return { request, calls: () => calls };
    };

    test('正常响应原样放行：响应体能读、别的字段（setCookies 之类）还在、code 不是风控的不熔断（-101 是没登录）', async () => {
        const breaker = createBreaker({ dataDir: tmp(), platform: 'bilibili' });
        const { request, calls } = make([{ status: 200, body: '{"code":0,"data":{"ok":true}}' }, { status: 200, body: '{"code":-101,"message":"账号未登录"}' }, { status: 200, body: '<html>字幕或页面</html>' }]);
        const guarded = guardRequest(request, breaker, BILIBILI_RISK);
        const first = await guarded('https://x', {});
        assert.equal(await first.text(), '{"code":0,"data":{"ok":true}}');
        assert.equal(first.extra, 'cookies');
        assert.match(await (await guarded('https://x', {})).text(), /-101/);
        assert.match(await (await guarded('https://x', {})).text(), /字幕或页面/);
        assert.equal(calls(), 3);
        assert.equal(breaker.state(), undefined);
    });

    test('HTTP 412 / 风控码 -352：熔断并抛 BreakerOpen；之后的请求在发出之前就被拦下，不碰网络', async () => {
        for (const reply of [{ status: 412, body: '' }, { status: 200, body: '{"code":-352,"message":"风控校验失败"}' }, { status: 429, body: 'slow down' }, { status: 200, body: '{"code":-799}' }]) {
            const breaker = createBreaker({ dataDir: tmp(), platform: 'bilibili' });
            const { request, calls } = make([reply]);
            const guarded = guardRequest(request, breaker, BILIBILI_RISK);
            await assert.rejects(guarded('https://x', {}), BreakerOpen);
            assert.equal(calls(), 1);
            await assert.rejects(guarded('https://x', {}), BreakerOpen);
            assert.equal(calls(), 1, '熔断中没有再发请求');
            assert.ok(breaker.state());
        }
    });

    test('人恢复之后又能发请求', async () => {
        const dataDir = tmp();
        const breaker = createBreaker({ dataDir, platform: 'bilibili' });
        const { request, calls } = make([{ status: 412, body: '' }, { status: 200, body: '{"code":0}' }]);
        const guarded = guardRequest(request, breaker, BILIBILI_RISK);
        await assert.rejects(guarded('https://x', {}), BreakerOpen);
        createBreaker({ dataDir, platform: 'bilibili' }).resume();
        assert.equal(await (await guarded('https://x', {})).text(), '{"code":0}');
        assert.equal(calls(), 2);
    });
});
