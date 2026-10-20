import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { credentialPath, saveCredential, type BiliCredential, type BiliRequest, type BiliResponse } from '../src/bilibili-account.ts';
import { createAccountSource, OPEN_RETRY_MS } from '../src/bilibili-account-source.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-biliSource-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const json = (body: unknown): BiliResponse => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const nav = (name: string, isLogin = true) => json({ code: 0, data: { isLogin, uname: name, mid: 4242, wbi_img: { img_url: 'https://x/a1.png', sub_url: 'https://x/b2.png' } } });
const credential = (sess: string): BiliCredential => ({ sessdata: sess, biliJct: 'jct-secret', dedeUserId: '4242', buvid3: 'b', savedAt: '2026-10-20T00:00:00.000Z' });

/** 写凭证并把修改时间设成确定的值：测试里两次写入的时间一定不同 */
let version = 0;
const writeCredential = (dataDir: string, sess: string) => {
    const path = credentialPath(dataDir);
    saveCredential(path, credential(sess));
    const when = new Date(1_800_000_000_000 + ++version * 10_000);
    utimesSync(path, when, when);
};

function harness(respond: (cookie: string) => BiliResponse | Promise<BiliResponse>) {
    const dataDir = tmp();
    const clock = { t: 1_800_000_000_000 };
    const logs: string[] = [];
    const cookies: string[] = [];
    const request: BiliRequest = async (_url, init) => { cookies.push(init.headers.Cookie ?? ''); return respond(init.headers.Cookie ?? ''); };
    const source = createAccountSource({ dataDir, request, now: () => clock.t, log: message => logs.push(message) });
    return { dataDir, clock, logs, cookies, source };
}

describe('她的 B 站号的来源：凭证文件换了就自动换上（ADR 0089）', () => {
    test('先没有凭证文件：只记一次日志、不请求 B 站；之后扫码存了凭证，不用重启就打开', async () => {
        const h = harness(() => nav('繁星小窝'));
        assert.equal(await h.source(), undefined);
        assert.equal(await h.source(), undefined);
        assert.equal(h.logs.filter(l => l.includes('没有凭证文件')).length, 1);
        assert.equal(h.cookies.length, 0);

        writeCredential(h.dataDir, 'sess-1');
        const account = await h.source();
        assert.equal(account?.name, '繁星小窝');
        assert.ok(h.logs.some(l => l.includes('已登录「繁星小窝」')));
        assert.equal(await h.source(), account, '打开之后拿同一个，不重复请求 B 站');
        assert.equal(h.cookies.length, 1);
    });

    test('凭证失效（B 站说没登录）：记一次日志，之后不再问；重新扫码（文件变了）才再打开', async () => {
        const h = harness(cookie => (cookie.includes('sess-new') ? nav('新登录的号') : nav('', false)));
        writeCredential(h.dataDir, 'sess-old');
        assert.equal(await h.source(), undefined);
        assert.equal(await h.source(), undefined);
        assert.equal(await h.source(), undefined);
        assert.equal(h.logs.filter(l => l.includes('凭证已经失效')).length, 1);
        assert.equal(h.cookies.length, 1, '失效之后不反复问 B 站');

        writeCredential(h.dataDir, 'sess-new');
        const account = await h.source();
        assert.equal(account?.name, '新登录的号');
        assert.equal(h.cookies.length, 2);
        assert.ok(h.cookies[1]!.includes('sess-new'));
    });

    test('已经打开了，凭证文件又换了（重新扫码）：重新打开，用新凭证', async () => {
        const h = harness(cookie => nav(cookie.includes('sess-b') ? '换了的号' : '原来的号'));
        writeCredential(h.dataDir, 'sess-a');
        assert.equal((await h.source())?.name, '原来的号');
        writeCredential(h.dataDir, 'sess-b');
        assert.equal((await h.source())?.name, '换了的号');
        assert.ok(h.logs.some(l => l.includes('凭证文件换了，重新打开')));
        assert.equal(h.cookies.length, 2);
    });

    test('打不开（断网 / 风控）：只记一次日志，30 分钟后才再试，再试成功就用上', async () => {
        let down = true;
        const h = harness(() => { if (down) throw new Error('断网'); return nav('繁星小窝'); });
        writeCredential(h.dataDir, 'sess-1');
        assert.equal(await h.source(), undefined);
        assert.equal(await h.source(), undefined);
        assert.equal(h.cookies.length, 1, '30 分钟内不再试');
        h.clock.t += OPEN_RETRY_MS - 1;
        assert.equal(await h.source(), undefined);
        assert.equal(h.cookies.length, 1);
        h.clock.t += 2;
        assert.equal(await h.source(), undefined);
        assert.equal(h.cookies.length, 2, '到点再试一次');
        assert.equal(h.logs.filter(l => l.includes('打开失败')).length, 1, '失败只记一次');
        down = false;
        h.clock.t += OPEN_RETRY_MS + 1;
        assert.equal((await h.source())?.name, '繁星小窝');
    });

    test('凭证文件读不了（内容坏了）：记一次日志；修好（重新扫码）之后自动再试', async () => {
        const h = harness(() => nav('繁星小窝'));
        const path = credentialPath(h.dataDir);
        saveCredential(path, credential('placeholder'));
        writeFileSync(path, '{"sessdata": 1}');
        const broken = new Date(1_800_000_000_000 + 5_000);
        utimesSync(path, broken, broken);
        assert.equal(await h.source(), undefined);
        assert.equal(await h.source(), undefined);
        assert.equal(h.logs.filter(l => l.includes('凭证文件读不了')).length, 1);
        assert.equal(h.cookies.length, 0);

        writeCredential(h.dataDir, 'sess-ok');
        assert.equal((await h.source())?.name, '繁星小窝');
    });

    test('日志里没有凭证内容', async () => {
        const h = harness(() => nav('繁星小窝'));
        writeCredential(h.dataDir, 'sess-secret-value');
        await h.source();
        assert.ok(!h.logs.join('\n').includes('sess-secret-value'));
        assert.ok(!h.logs.join('\n').includes('jct-secret'));
    });
});
