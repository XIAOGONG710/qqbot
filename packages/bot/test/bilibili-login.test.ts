import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { credentialPath, loadCredential, saveCredential, type BiliCredential, type BiliRequest, type BiliResponse } from '../src/bilibili-account.ts';
import { checkLogin, LOGIN_TIMEOUT_MS, loginQrPath, runLogin } from '../src/bilibili-login.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-bililogin-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const json = (body: unknown, setCookies: string[] = []): BiliResponse => ({ ok: true, status: 200, text: async () => JSON.stringify(body), setCookies });
const NAV = { code: 0, data: { isLogin: true, uname: '繁星小窝', mid: 4242, wbi_img: { img_url: 'https://x/a1.png', sub_url: 'https://x/b2.png' } } };
const COOKIES = ['SESSDATA=secret-sess%2C1; Path=/', 'bili_jct=secret-jct; Path=/', 'DedeUserID=4242; Path=/', 'buvid3=bv3; Path=/'];

/** 假时钟：sleep 直接把时间拨过去 */
function harness(polls: ('waiting' | 'scanned' | 'expired' | 'ok' | 'weird')[], extra: Partial<Record<string, () => BiliResponse>> = {}) {
    const clock = { t: 1_800_000_000_000 };
    const out: string[] = [];
    const shown: { svgPath: string; terminal: string }[] = [];
    const requests: string[] = [];
    const queue = [...polls];
    const dataDir = tmp();
    const request: BiliRequest = async url => {
        requests.push(url);
        for (const [part, handler] of Object.entries(extra)) if (url.includes(part) && handler) return handler();
        if (url.includes('qrcode/generate')) return json({ code: 0, data: { url: 'https://passport.bilibili.com/h5-app/passport/auth/scan?qrcode_key=k1', qrcode_key: 'k1' } });
        if (url.includes('qrcode/poll')) {
            const next = queue.shift() ?? 'waiting';
            if (next === 'ok') return json({ code: 0, data: { code: 0, refresh_token: 'r' } }, COOKIES);
            return json({ code: 0, data: { code: next === 'waiting' ? 86101 : next === 'scanned' ? 86090 : next === 'expired' ? 86038 : 12345 }, message: '奇怪' });
        }
        if (url.includes('web-interface/nav')) return json(NAV);
        throw new Error(`没有准备：${url}`);
    };
    const deps = {
        request, dataDir, now: () => clock.t, out: (line: string) => out.push(line),
        showQr: (qr: { svgPath: string; terminal: string }) => { shown.push(qr); },
        sleep: async (ms: number) => { clock.t += ms; },
    };
    return { deps, out, shown, requests, clock, dataDir };
}

describe('B 站扫码登录（命令行，ADR 0089）', () => {
    test('扫码、确认、成功：凭证存进 secrets/，问一次 B 站确认账号；二维码图片在期间存在、结束后删掉；输出里没有凭证内容', async () => {
        const h = harness(['waiting', 'scanned', 'scanned', 'ok']);
        let svgSeen = false;
        const deps = { ...h.deps, showQr: (qr: { svgPath: string; terminal: string }) => { h.shown.push(qr); svgSeen = existsSync(qr.svgPath) && readFileSync(qr.svgPath, 'utf8').startsWith('<svg'); } };
        const result = await runLogin(deps);
        assert.deepEqual(result, { ok: true, name: '繁星小窝', mid: 4242 });
        assert.equal(svgSeen, true, '展示二维码的时候图片已经写好');
        assert.equal(h.shown[0]!.svgPath, loginQrPath(h.dataDir));
        assert.ok(h.shown[0]!.terminal.length > 100);
        assert.equal(existsSync(loginQrPath(h.dataDir)), false, '结束后二维码图片删掉');
        const saved = loadCredential(credentialPath(h.dataDir))!;
        assert.equal(saved.sessdata, 'secret-sess%2C1');
        assert.equal(saved.biliJct, 'secret-jct');
        assert.equal(saved.dedeUserId, '4242');
        assert.equal(h.out.filter(l => l.includes('已扫码')).length, 1, '扫码提示只说一次');
        assert.ok(h.out.some(l => l.includes('登录成功：「繁星小窝」（uid 4242）')));
        assert.ok(!h.out.join('\n').includes('secret-'), '输出里没有凭证内容');
    });

    test('二维码过期：说清楚让重新运行，不存凭证；3 分钟没人扫：超时；轮询一直看不懂：放弃', async () => {
        const expired = harness(['waiting', 'expired']);
        const r1 = await runLogin(expired.deps);
        assert.equal(r1.ok === false && r1.reason, 'expired');
        assert.equal(loadCredential(credentialPath(expired.dataDir)), undefined);
        assert.equal(existsSync(loginQrPath(expired.dataDir)), false);

        const idle = harness([]);
        const r2 = await runLogin(idle.deps);
        assert.equal(r2.ok === false && r2.reason, 'timeout');
        assert.ok(idle.clock.t - 1_800_000_000_000 >= LOGIN_TIMEOUT_MS);

        const weird = harness(['weird', 'weird', 'weird', 'weird', 'weird', 'weird']);
        const r3 = await runLogin(weird.deps);
        assert.equal(r3.ok === false && r3.reason, 'failed');
        assert.match(r3.ok === false ? r3.message : '', /12345/);
    });

    test('取二维码就失败（风控、断网）：返回失败，不留下半成品', async () => {
        const h = harness([], { 'qrcode/generate': () => json({ code: -412, message: '被拦截' }) });
        const result = await runLogin(h.deps);
        assert.equal(result.ok === false && result.reason, 'failed');
        assert.match(result.ok === false ? result.message : '', /-412/);
        assert.deepEqual(h.shown, []);
    });

    test('登录成功但确认账号时出错：凭证照存，如实说，提示之后 --check', async () => {
        const h = harness(['ok'], { 'web-interface/nav': () => ({ ok: false, status: 412, text: async () => '' }) });
        const result = await runLogin(h.deps);
        assert.deepEqual(result, { ok: true, name: '', mid: 0 });
        assert.ok(loadCredential(credentialPath(h.dataDir)));
        assert.ok(h.out.some(l => l.includes('--check')));
    });
});

describe('B 站登录检查（--check）', () => {
    const credential: BiliCredential = { sessdata: 's', biliJct: 'j', dedeUserId: '4242', buvid3: 'b', savedAt: '2026-10-20T00:00:00.000Z' };
    test('没有凭证 / 有效 / 失效 / 问不了（不说失效）', async () => {
        const dataDir = tmp();
        const now = () => 1_800_000_000_000;
        const ok: BiliRequest = async () => json(NAV);
        assert.equal((await checkLogin({ request: ok, dataDir, now })).ok, false);
        assert.equal((await checkLogin({ request: ok, dataDir, now }) as { reason: string }).reason, 'missing');
        saveCredential(credentialPath(dataDir), credential);
        assert.deepEqual(await checkLogin({ request: ok, dataDir, now }), { ok: true, name: '繁星小窝', mid: 4242 });
        const loggedOut: BiliRequest = async () => json({ code: 0, data: { isLogin: false } });
        assert.equal((await checkLogin({ request: loggedOut, dataDir, now }) as { reason: string }).reason, 'invalid');
        const down: BiliRequest = async () => { throw new Error('断网'); };
        const failed = await checkLogin({ request: down, dataDir, now }) as { reason: string; message: string };
        assert.equal(failed.reason, 'failed');
        assert.match(failed.message, /不代表凭证失效/);
    });
});
