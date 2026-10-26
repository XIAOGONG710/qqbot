import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { Browser } from '../src/browser-cdp.ts';
import { BreakerOpen, createBreaker } from '../src/platform-breaker.ts';
import { findQrLink, linkShape, LOGIN_BUTTON_JS, runSocialLogin } from '../src/social-login.ts';
import { openSocialSession, SessionRefused } from '../src/social-session.ts';
import { DOUYIN_CARDS_JS } from '../src/social-douyin.ts';
import { XHS_FEED_JS } from '../src/social-xhs.ts';
import { fakePage, fastPacing, type FakePage } from './fake-page.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-login-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// 响应结构来自 2026-10-26 不登录读到的真实二维码接口（只看键名和值的种类）；值是编的
const XHS_QR = { code: 0, success: true, msg: '成功', data: { code: '123456', url: 'https://www.xiaohongshu.com/mobile/login?qrId=abc&source=web', multi_flag: 0, qr_id: '123456789012345678' } };
const DOUYIN_QR = { data: { qrcode: 'base64…', token: 't', qrcode_index_url: 'https://api.amemv.com/ucenter_web/app/aweme/scan_login/index/douyin_scan_code_login/cn/app/index.html?scene=x&source=y' }, message: 'success' };

/** 一个假会话：登录状态可以在 n 次轮询之后翻成已登录 */
function loginSession(platform: 'xhs' | 'douyin', options: { flipAfter?: number; qrBodies?: Array<unknown | Error>; qrOnClick?: boolean; noButton?: boolean } = {}) {
    let polls = 0;
    const loggedIn = () => options.flipAfter !== undefined && polls++ >= options.flipAfter;
    const bodies = (options.qrBodies ?? [platform === 'xhs' ? XHS_QR : DOUYIN_QR]);
    let served = 0;
    const qrUrl = platform === 'xhs' ? 'https://edith.xiaohongshu.com/api/sns/web/v1/login/qrcode/create' : 'https://www.douyin.com/passport/web/get_qrcode/?x=1';
    const pushQr = (page: FakePage) => { for (let i = 0; i < bodies.length; i++) page.events.push({ url: `${qrUrl}${qrUrl.includes('?') ? '&' : '?'}n=${i}`, status: 200 }); };
    const page = fakePage({
        evaluate: expression => {
            if (expression === XHS_FEED_JS) return { loggedIn: loggedIn(), feeds: [] };
            if (expression === DOUYIN_CARDS_JS) return [];
            if (expression === LOGIN_BUTTON_JS) return options.noButton ? null : { x: 1200, y: 40 };
            return null;
        },
        // 小红书：打开首页就自己要二维码；抖音：点了「登录」才要
        onGoto: (_url, p) => { if (platform === 'xhs') pushQr(p); },
        cookies: [],
        bodies: [{ match: /qrcode|get_qrcode/, body: async () => { const next = bodies[served++ % bodies.length]; if (next instanceof Error) throw next; return JSON.stringify(next); } }],
    });
    const realCookies = page.cookieNames;
    page.cookieNames = async urls => (platform === 'douyin' && loggedIn() ? ['ttwid', 'sessionid'] : realCookies(urls));
    const click = page.click;
    page.click = async (x, y) => { await click(x, y); pushQr(page); };
    return { page, dataDir: tmp() };
}

// 用真的读者建会话（读者读 status）
async function realSession(platform: 'xhs' | 'douyin', options: Parameters<typeof loginSession>[1] = {}) {
    const fake = loginSession(platform, options);
    const launched: Array<Record<string, unknown>> = [];
    const browser: Browser = { pid: 1, newPage: async () => fake.page, close: async () => undefined };
    const session = await openSocialSession({ platform, dataDir: fake.dataDir, log: () => undefined, pacing: fastPacing, freeBytes: () => 4e9, exe: 'C:\\edge.exe', images: true, launch: (async (o: Record<string, unknown>) => { launched.push(o); return browser; }) as never });
    return { ...fake, session, launched };
}

describe('找二维码里的链接', () => {
    test('找键名带 qr / url / link 的 http 链接，嵌套也找；没有就 undefined', () => {
        assert.equal(findQrLink(XHS_QR), 'https://www.xiaohongshu.com/mobile/login?qrId=abc&source=web');
        assert.equal(findQrLink(DOUYIN_QR), DOUYIN_QR.data.qrcode_index_url);
        assert.equal(findQrLink({ data: { qrcode: 'base64…' } }), undefined);
        assert.equal(findQrLink({ a: { b: { c: { d: { e: { url: 'https://x/y' } } } } } }), undefined, '太深不找');
        assert.equal(findQrLink(null), undefined);
        assert.equal(findQrLink({ url: 'javascript:alert(1)' }), undefined);
    });

    test('链接的形状只说主机、路径和参数名，不带参数值', () => {
        const link = 'https://www.xiaohongshu.com/mobile/login?qrId=SECRET123&source=web';
        const shape = linkShape(link);
        assert.equal(shape, `www.xiaohongshu.com/mobile/login?qrId&source（共 ${link.length} 字符）`);
        assert.ok(!shape.includes('SECRET123'));
        assert.match(linkShape('not a url'), /不是链接/);
    });
});

describe('扫码登录（ADR 0166）', () => {
    test('小红书：访客 → 取二维码 → 画出来 → 手机确认后页面状态变已登录 → 成功', async () => {
        const { session, dataDir } = await realSession('xhs', { flipAfter: 3 });
        const lines: string[] = [];
        const result = await runSocialLogin(session, { out: line => lines.push(line), pacing: fastPacing, dataDir, waitMs: 60_000 });
        assert.equal(result.ok, true, result.message);
        assert.match(lines[0]!, /她的小红书专号.*别用你自己的主号/);
        assert.ok(lines[1]!.includes('█') || lines[1]!.includes('▀') || lines[1]!.includes('▄'), '画了二维码');
        assert.match(lines[2]!, /二维码内容的形状：www\.xiaohongshu\.com\/mobile\/login\?qrId&source/);
        assert.ok(!lines.join('\n').includes('qrId=abc'), '参数值不进输出');
    });

    test('小红书：页面发了两次二维码请求，第一次的响应体被浏览器丢了，用第二次的', async () => {
        const { session, dataDir } = await realSession('xhs', { flipAfter: 0, qrBodies: [new Error('No resource with given identifier found'), XHS_QR] });
        const result = await runSocialLogin(session, { out: () => undefined, pacing: fastPacing, dataDir, waitMs: 10_000 });
        assert.equal(result.ok, true, result.message);
    });

    test('抖音：先点「登录」才有二维码；确认后出现登录 cookie 才算成功（只看名字）', async () => {
        const { session, dataDir, page } = await realSession('douyin', { flipAfter: 2 });
        const lines: string[] = [];
        const result = await runSocialLogin(session, { out: line => lines.push(line), pacing: fastPacing, dataDir, waitMs: 60_000 });
        assert.equal(result.ok, true, result.message);
        assert.deepEqual(page.clicks, [{ x: 1200, y: 40 }]);
        assert.match(lines[2]!, /api\.amemv\.com\/ucenter_web\/app\/aweme\/scan_login/);
    });

    test('已经登录了：不取二维码，直接说已登录', async () => {
        const { session, dataDir, page } = await realSession('xhs', { flipAfter: 0 });
        const result = await runSocialLogin(session, { out: () => undefined, pacing: fastPacing, dataDir });
        assert.equal(result.ok, true);
        assert.match(result.message, /已经登录了/);
        assert.equal(page.clicks.length, 0);
    });

    test('一直没扫：超时失败，说二维码过期；--qr-only 画完就返回', async () => {
        const never = await realSession('xhs');
        const timedOut = await runSocialLogin(never.session, { out: () => undefined, pacing: fastPacing, dataDir: never.dataDir, waitMs: 6_000 });
        assert.equal(timedOut.ok, false);
        assert.match(timedOut.message, /6 秒内没有扫码确认.*过期/);
        const only = await realSession('douyin');
        const result = await runSocialLogin(only.session, { out: () => undefined, pacing: fastPacing, dataDir: only.dataDir, qrOnly: true });
        assert.deepEqual(result, { ok: false, message: '只取二维码（--qr-only），没有等扫码' });
    });

    test('取不到二维码链接：存页面截图给人看，说清楚怎么办；找不到登录按钮也说清楚', async () => {
        const noLink = await realSession('xhs', { qrBodies: [{ code: 0, data: { qrcode: 'base64…' } }] });
        const result = await runSocialLogin(noLink.session, { out: () => undefined, pacing: fastPacing, dataDir: noLink.dataDir });
        assert.equal(result.ok, false);
        assert.match(result.message, /没取到小红书的登录二维码链接；页面截图存在 /);
        assert.ok(existsSync(join(noLink.dataDir, 'platforms', 'xhs', 'login-screen.jpg')));
        const noButton = await realSession('douyin', { noButton: true });
        assert.match((await runSocialLogin(noButton.session, { out: () => undefined, pacing: fastPacing, dataDir: noButton.dataDir })).message, /没找到「登录」按钮/);
    });
});

describe('开会话', () => {
    const fakeLaunch = (calls: Array<Record<string, unknown>>) => (async (o: Record<string, unknown>) => { calls.push(o); return { pid: 7, newPage: async () => fakePage({ evaluate: () => null }), close: async () => undefined } satisfies Browser; }) as never;

    test('熔断中：不开浏览器；内存不够：不开；找不到浏览器：不开', async () => {
        const dataDir = tmp();
        const calls: Array<Record<string, unknown>> = [];
        createBreaker({ dataDir, platform: 'douyin' }).trip('HTTP 429', 429);
        await assert.rejects(openSocialSession({ platform: 'douyin', dataDir, log: () => undefined, launch: fakeLaunch(calls), freeBytes: () => 4e9, exe: 'x' }), BreakerOpen);
        await assert.rejects(openSocialSession({ platform: 'xhs', dataDir, log: () => undefined, launch: fakeLaunch(calls), freeBytes: () => 500 * 1024 * 1024, exe: 'x' }), (e: unknown) => e instanceof SessionRefused && e.reason === 'memory');
        await assert.rejects(openSocialSession({ platform: 'xhs', dataDir, log: () => undefined, launch: fakeLaunch(calls), freeBytes: () => 4e9, exe: undefined }), (e: unknown) => e instanceof SessionRefused && e.reason === 'noBrowser');
        assert.equal(calls.length, 0);
    });

    test('开会话：专用目录、默认屏幕外不要图片；登录时要看见 / 要图片；关了只关一次', async () => {
        const dataDir = tmp();
        const calls: Array<Record<string, unknown>> = [];
        const normal = await openSocialSession({ platform: 'xhs', dataDir, log: () => undefined, launch: fakeLaunch(calls), freeBytes: () => 4e9, exe: 'C:\\e.exe' });
        assert.equal(calls[0]!.profileDir, join(dataDir, 'secrets', 'browser', 'xhs'));
        assert.deepEqual({ offscreen: calls[0]!.offscreen, visible: calls[0]!.visible, images: calls[0]!.images }, { offscreen: true, visible: false, images: false });
        await normal.close();
        await normal.close();
        await openSocialSession({ platform: 'douyin', dataDir, log: () => undefined, launch: fakeLaunch(calls), freeBytes: () => 4e9, exe: 'C:\\e.exe', visible: true, images: true });
        assert.deepEqual({ offscreen: calls[1]!.offscreen, visible: calls[1]!.visible, images: calls[1]!.images }, { offscreen: false, visible: true, images: true });
        assert.equal(calls[1]!.profileDir, join(dataDir, 'secrets', 'browser', 'douyin'));
    });
});
