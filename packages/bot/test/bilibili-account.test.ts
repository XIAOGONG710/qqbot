import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    BiliApiError, cookieHeader, credentialPath, loadCredential, openAccount, parseClock, pickCookies, qrGenerate, qrPoll, saveCredential, subtitleExcerpt,
    wbiKeysFrom, wbiMixinKey, wbiSign, type BiliCredential, type BiliRequest, type BiliResponse,
} from '../src/bilibili-account.ts';
import { qrMatrix, qrSvg, qrTerminal } from '../src/qr.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-biliacct-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const json = (body: unknown, setCookies: string[] = []): BiliResponse => ({ ok: true, status: 200, text: async () => JSON.stringify(body), setCookies });
const credential: BiliCredential = { sessdata: 'sess%2Cdata', biliJct: 'jct123', dedeUserId: '4242', buvid3: 'buvid-3', savedAt: '2026-10-20T00:00:00.000Z' };
const NAV = { code: 0, data: { isLogin: true, uname: '繁星小窝', mid: 4242, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } };

/** 按网址里的片段回话；记下每次请求 */
function server(routes: Record<string, (url: string, init: Parameters<BiliRequest>[1]) => BiliResponse | Promise<BiliResponse>>) {
    const calls: { url: string; init: Parameters<BiliRequest>[1] }[] = [];
    const request: BiliRequest = async (url, init) => {
        calls.push({ url, init });
        for (const [part, handler] of Object.entries(routes)) if (url.includes(part)) return handler(url, init);
        throw new Error(`没有准备这个请求：${url}`);
    };
    return { request, calls };
}

describe('B 站账号层：WBI 签名（搜索、播放器信息要带）', () => {
    test('和 B 站文档里的示例一模一样：混合密钥与 w_rid', () => {
        const keys = { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' };
        assert.equal(wbiMixinKey(keys), 'ea1db124af3c7062474693fa704f4ff8');
        assert.equal(wbiSign({ foo: '114', bar: '514', zab: 1919810 }, keys, 1702204169), 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
    });
    test('参数值里的 !\'()* 先去掉；钥匙取图片文件名，取不到返回 undefined', () => {
        const keys = { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' };
        assert.ok(wbiSign({ q: "a!b'c(d)e*f" }, keys, 1).startsWith('q=abcdef&wts=1&w_rid='));
        assert.deepEqual(wbiKeysFrom(NAV.data), keys);
        assert.equal(wbiKeysFrom({}), undefined);
        assert.equal(wbiKeysFrom({ wbi_img: { img_url: '', sub_url: 'x.png' } }), undefined);
    });
});

describe('B 站账号层：扫码登录', () => {
    test('第一步要二维码：链接和 key；返回里缺了就报错', async () => {
        const ok = server({ 'qrcode/generate': () => json({ code: 0, data: { url: 'https://passport.bilibili.com/h5-app/passport/auth/scan?qrcode_key=k1', qrcode_key: 'k1' } }) });
        assert.deepEqual(await qrGenerate(ok.request), { url: 'https://passport.bilibili.com/h5-app/passport/auth/scan?qrcode_key=k1', key: 'k1' });
        const bad = server({ 'qrcode/generate': () => json({ code: 0, data: {} }) });
        await assert.rejects(qrGenerate(bad.request), /没有 url/);
        const refused = server({ 'qrcode/generate': () => json({ code: -412, message: '被拦截' }) });
        await assert.rejects(qrGenerate(refused.request), (error: unknown) => error instanceof BiliApiError && error.code === -412);
    });

    test('轮询：没扫 / 扫了没确认 / 过期；轮询不跟随重定向（凭证在响应头里）', async () => {
        const codes = [86101, 86090, 86038];
        const s = server({ 'qrcode/poll': () => json({ code: 0, data: { code: codes.shift() } }) });
        assert.deepEqual(await qrPoll(s.request, 'k1'), { state: 'waiting' });
        assert.deepEqual(await qrPoll(s.request, 'k1'), { state: 'scanned' });
        assert.deepEqual(await qrPoll(s.request, 'k1'), { state: 'expired' });
        assert.equal(s.calls[0]!.init.noRedirect, true);
        assert.match(s.calls[0]!.url, /qrcode_key=k1/);
    });

    test('轮询成功：凭证从 Set-Cookie 里取（不是 data.url），没有 buvid3 就补一张访客的', async () => {
        const s = server({
            'qrcode/poll': () => json({ code: 0, data: { code: 0, url: 'https://passport.biligame.com/x', refresh_token: 'refresh-1' } }, ['SESSDATA=abc%2Cdef; Path=/; HttpOnly', 'bili_jct=jct9; Path=/', 'DedeUserID=777; Path=/', 'DedeUserID__ckMd5=zzz; Path=/']),
            'finger/spi': () => json({ code: 0, data: { b_3: 'guest-3', b_4: 'guest-4' } }),
        });
        const result = await qrPoll(s.request, 'k1', () => Date.parse('2026-10-20T12:00:00Z'));
        assert.deepEqual(result, { state: 'ok', credential: { sessdata: 'abc%2Cdef', biliJct: 'jct9', dedeUserId: '777', buvid3: 'guest-3', buvid4: 'guest-4', refreshToken: 'refresh-1', savedAt: '2026-10-20T12:00:00.000Z' } });
    });

    test('成功了但响应头里没有凭证：说明白，不装作登录成功；访客 Cookie 取不到也不拖垮登录', async () => {
        const none = server({ 'qrcode/poll': () => json({ code: 0, data: { code: 0 } }, ['other=1']) });
        const result = await qrPoll(none.request, 'k1');
        assert.equal(result.state, 'unknown');
        assert.match((result as { message: string }).message, /SESSDATA/);
        const noGuest = server({
            'qrcode/poll': () => json({ code: 0, data: { code: 0 } }, ['SESSDATA=a', 'bili_jct=b', 'DedeUserID=1']),
            'finger/spi': () => { throw new Error('断网'); },
        });
        const ok = await qrPoll(noGuest.request, 'k1');
        assert.equal(ok.state, 'ok');
        assert.equal((ok as { credential: BiliCredential }).credential.buvid3, '');
    });

    test('从 Set-Cookie 里只取要的几个；Cookie 头保持 B 站给的样子（不解码）', () => {
        assert.deepEqual(pickCookies(['SESSDATA=abc%2Cdef; Path=/', 'bili_jct=xyz', 'other=1', 'noequals', 'DedeUserID=123; Path=/']), { SESSDATA: 'abc%2Cdef', bili_jct: 'xyz', DedeUserID: '123' });
        assert.equal(cookieHeader(credential), 'SESSDATA=sess%2Cdata; bili_jct=jct123; DedeUserID=4242; buvid3=buvid-3');
        assert.ok(cookieHeader({ ...credential, buvid4: 'b4' }).endsWith('; buvid4=b4'));
    });
});

describe('B 站账号层：凭证文件', () => {
    test('存了能读回来；文件不存在是 undefined；内容不对就报错而不是当成没登录', () => {
        const path = credentialPath(tmp());
        assert.equal(loadCredential(path), undefined);
        saveCredential(path, credential);
        assert.deepEqual(loadCredential(path), credential);
        assert.match(path, /secrets[\\/]bilibili\.json$/);
        writeFileSync(path, JSON.stringify({ sessdata: '', biliJct: 'x' }));
        assert.throws(() => loadCredential(path), /无效/);
    });
});

describe('B 站账号层：打开账号（nav）', () => {
    test('没登录（isLogin 为假）返回 undefined；登录了返回昵称和 uid，请求带 Cookie', async () => {
        const out = server({ 'web-interface/nav': () => json({ code: 0, data: { isLogin: false } }) });
        assert.equal(await openAccount(out.request, credential), undefined);
        const inn = server({ 'web-interface/nav': () => json(NAV) });
        const account = await openAccount(inn.request, credential);
        assert.equal(account?.name, '繁星小窝');
        assert.equal(account?.mid, 4242);
        assert.equal(inn.calls[0]!.init.headers.Cookie, cookieHeader(credential));
    });

    test('nav 请求失败（风控、断网）会抛：调用方当作「这次起不来」', async () => {
        const s = server({ 'web-interface/nav': () => json({ code: -352, message: '风控校验失败' }) });
        await assert.rejects(openAccount(s.request, credential), /-352/);
    });
});

describe('B 站账号层：搜索', () => {
    const result = [
        { bvid: 'BV1Jonu6mEwN', aid: 11, title: '<em class="keyword">三花猫</em>在&quot;门口&quot;等我', description: '一只猫 &amp; 一个人', author: '猫奴', typename: '喵星人', play: 12000, like: 300, duration: '3:45' },
        { bvid: '坏的', aid: 12, title: 'x', typename: '日常' },
        { bvid: 'BV1abcdefghi', aid: 13, title: '', typename: '日常' },
        { bvid: 'BV1zzzzzzzzz', aid: 14, title: '长视频', author: 'a', typename: '日常', play: 1, duration: '1:02:03' },
    ];

    test('带 WBI 签名查：关键词、排序；结果去掉高亮标签和转义，时长换成秒，坏条目跳过', async () => {
        const s = server({ 'web-interface/nav': () => json(NAV), 'wbi/search/type': () => json({ code: 0, data: { result } }) });
        const account = (await openAccount(s.request, credential, { now: () => 1_702_204_169_000 }))!;
        const videos = await account.search('三花猫', 'click');
        const url = s.calls.at(-1)!.url;
        assert.match(url, /wbi\/search\/type\?/);
        assert.match(url, /keyword=%E4%B8%89%E8%8A%B1%E7%8C%AB/);
        assert.match(url, /order=click/);
        assert.match(url, /wts=1702204169&w_rid=[0-9a-f]{32}$/);
        assert.deepEqual(videos.map(v => v.bvid), ['BV1Jonu6mEwN', 'BV1zzzzzzzzz']);
        assert.deepEqual(videos[0], {
            bvid: 'BV1Jonu6mEwN', aid: 11, title: '三花猫在"门口"等我', desc: '一只猫 & 一个人', owner: '猫奴', category: '喵星人', views: 12000, likes: 300, duration: 225,
            link: 'https://www.bilibili.com/video/BV1Jonu6mEwN',
        });
        assert.equal(videos[1]!.duration, 3723);
    });

    test('钥匙超过 6 小时再取一次 nav', async () => {
        const clock = { t: 1_702_204_169_000 };
        const s = server({ 'web-interface/nav': () => json(NAV), 'wbi/search/type': () => json({ code: 0, data: { result: [] } }) });
        const account = (await openAccount(s.request, credential, { now: () => clock.t }))!;
        await account.search('猫');
        assert.equal(s.calls.filter(c => c.url.includes('/nav')).length, 1);
        clock.t += 7 * 3_600_000;
        await account.search('猫');
        assert.equal(s.calls.filter(c => c.url.includes('/nav')).length, 2);
    });

    test('parseClock：分秒、时分秒、数字、乱写', () => {
        assert.deepEqual(['3:45', '1:02:03', 125, 'x', ''].map(parseClock), [225, 3723, 125, 0, 0]);
    });
});

describe('B 站账号层：字幕', () => {
    const playerWith = (subtitles: unknown[], extra: Record<string, unknown> = {}) => json({ code: 0, data: { subtitle: { subtitles }, ...extra } });
    const subtitleFile = (lines: string[]) => json({ body: lines.map((content, i) => ({ from: i, to: i + 1, content })) });

    test('cid 已知：问播放器信息，优先中文轨，下载字幕文件（//开头补 https），返回每句', async () => {
        const s = server({
            'web-interface/nav': () => json(NAV),
            'player/wbi/v2': () => playerWith([{ lan: 'en', subtitle_url: '//aisubtitle.hdslb.com/en.json' }, { lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/zh.json' }]),
            'aisubtitle.hdslb.com/zh.json': () => subtitleFile(['大家好', '今天讲讲猫']),
        });
        const account = (await openAccount(s.request, credential, { now: () => 1_702_204_169_000 }))!;
        const result = await account.subtitle({ bvid: 'BV1Jonu6mEwN', cid: 999 });
        assert.deepEqual(result, { status: 'ok', lan: 'ai-zh', lines: ['大家好', '今天讲讲猫'] });
        assert.ok(s.calls.some(c => /player\/wbi\/v2\?.*cid=999.*w_rid=/.test(c.url)));
        assert.ok(!s.calls.some(c => c.url.includes('web-interface/view')), 'cid 已知就不用再问 view');
        const download = s.calls.find(c => c.url.includes('hdslb.com/zh.json'))!;
        assert.equal(download.url.startsWith('https://'), true);
        assert.equal(download.init.headers.Cookie, undefined, '字幕文件不带 Cookie');
    });

    test('没有 cid（搜索结果）：先问 view 要 cid', async () => {
        const s = server({
            'web-interface/nav': () => json(NAV),
            'web-interface/view': () => json({ code: 0, data: { cid: 555 } }),
            'player/wbi/v2': () => playerWith([]),
        });
        const account = (await openAccount(s.request, credential))!;
        assert.deepEqual(await account.subtitle({ bvid: 'BV1Jonu6mEwN' }), { status: 'none' });
        assert.ok(s.calls.some(c => /player\/wbi\/v2\?.*cid=555/.test(c.url)));
    });

    test('没有字幕轨是 none；登录了还说要登录是 needLogin（Cookie 失效）；有轨但文件是空的也是 none', async () => {
        const base = { 'web-interface/nav': () => json(NAV) };
        const none = await openAccount(server({ ...base, 'player/wbi/v2': () => playerWith([]) }).request, credential);
        assert.deepEqual(await none!.subtitle({ bvid: 'BV1Jonu6mEwN', cid: 1 }), { status: 'none' });
        const need = await openAccount(server({ ...base, 'player/wbi/v2': () => playerWith([], { need_login_subtitle: true }) }).request, credential);
        assert.deepEqual(await need!.subtitle({ bvid: 'BV1Jonu6mEwN', cid: 1 }), { status: 'needLogin' });
        const empty = await openAccount(server({ ...base, 'player/wbi/v2': () => playerWith([{ lan: 'zh', subtitle_url: '//x.hdslb.com/a.json' }]), 'x.hdslb.com': () => subtitleFile([]) }).request, credential);
        assert.deepEqual(await empty!.subtitle({ bvid: 'BV1Jonu6mEwN', cid: 1 }), { status: 'none' });
    });

    test('字幕文件下载失败会抛（调用方只记一次日志、这次只靠标题和热评）', async () => {
        const s = server({
            'web-interface/nav': () => json(NAV),
            'player/wbi/v2': () => playerWith([{ lan: 'zh', subtitle_url: '//x.hdslb.com/a.json' }]),
            'x.hdslb.com': () => ({ ok: false, status: 404, text: async () => '' }),
        });
        const account = (await openAccount(s.request, credential))!;
        await assert.rejects(account.subtitle({ bvid: 'BV1Jonu6mEwN', cid: 1 }), /404/);
    });

    test('摘录：重复行合并、网址和 @ 去掉；不长就整段，太长取开头、中间、结尾各一截', () => {
        assert.equal(subtitleExcerpt(['你好', '你好', '大家好 https://x.com/a @某人', '今天讲个故事'], 100), '你好，大家好，今天讲个故事');
        const long = subtitleExcerpt(Array.from({ length: 200 }, (_, i) => `第${i}句话内容内容内容`), 120);
        assert.ok(long.length <= 120 + 12, String(long.length));
        assert.ok(long.startsWith('第0句话') && long.endsWith('第199句话内容内容内容'));
        assert.equal(long.split('……').length, 3);
    });
});

describe('B 站账号层：评论与复核', () => {
    const open = async (routes: Parameters<typeof server>[0] = {}) => {
        const s = server({ 'web-interface/nav': () => json(NAV), ...routes });
        return { ...s, account: (await openAccount(s.request, credential))! };
    };

    test('发评论：表单带 type/oid/message/plat/csrf；@ 他时消息最前面写 @昵称，并交上昵称对应的 uid（真提及）；Referer 是视频页', async () => {
        const s = await open({ 'reply/add': () => json({ code: 0, data: { rpid: 123456789, rpid_str: '123456789' } }) });
        const result = await s.account.postComment({ aid: 11, bvid: 'BV1Jonu6mEwN', text: '这个猫也太会了', at: { name: '小明', uid: 98765 } });
        assert.deepEqual(result, { rpid: '123456789' });
        const call = s.calls.at(-1)!;
        assert.equal(call.init.method, 'POST');
        assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
        assert.equal(call.init.headers.Referer, 'https://www.bilibili.com/video/BV1Jonu6mEwN');
        assert.equal(call.init.headers.Cookie, cookieHeader(credential));
        const form = new URLSearchParams(call.init.body);
        assert.equal(form.get('type'), '1');
        assert.equal(form.get('oid'), '11');
        assert.equal(form.get('plat'), '1');
        assert.equal(form.get('csrf'), 'jct123');
        assert.equal(form.get('message'), '@小明 这个猫也太会了');
        assert.deepEqual(JSON.parse(form.get('at_name_to_mid')!), { 小明: 98765 });
    });

    test('不 @ 谁就不带 at_name_to_mid；返回里没有 rpid 要报错（复核靠它，不能编一个）；接口错误码带出来', async () => {
        const s = await open({ 'reply/add': () => json({ code: 0, data: {} }) });
        await assert.rejects(s.account.postComment({ aid: 1, bvid: 'BV1Jonu6mEwN', text: 'x' }), /没有 rpid/);
        assert.equal(new URLSearchParams(s.calls.at(-1)!.init.body).has('at_name_to_mid'), false);
        for (const [code, message] of [[12015, '需要验证码'], [-101, '账号未登录'], [12051, '重复评论']] as const) {
            const f = await open({ 'reply/add': () => json({ code, message }) });
            await assert.rejects(f.account.postComment({ aid: 1, bvid: 'BV1Jonu6mEwN', text: 'x' }), (error: unknown) => error instanceof BiliApiError && error.code === code && error.message.includes(message));
        }
    });

    test('复核：在公开的「最新」第一页里找得到才算可见；找不到不说没发出去', async () => {
        const replies = [{ rpid: 5, rpid_str: '5' }, { rpid: 777, rpid_str: '777' }];
        const s = await open({ 'reply/main': () => json({ code: 0, data: { replies } }) });
        assert.equal(await s.account.commentVisible({ aid: 11, rpid: '777' }), true);
        assert.equal(await s.account.commentVisible({ aid: 11, rpid: '888' }), false);
        assert.match(s.calls.at(-1)!.url, /reply\/main\?type=1&oid=11&mode=2&next=0&ps=20/);
        const empty = await open({ 'reply/main': () => json({ code: 0, data: {} }) });
        assert.equal(await empty.account.commentVisible({ aid: 11, rpid: '777' }), false);
    });
});

describe('二维码（登录时给用户扫）', () => {
    const url = 'https://passport.bilibili.com/h5-app/passport/auth/scan?navhide=1&qrcode_key=0123456789abcdef0123456789abcdef&from=main-fe-header';
    test('三个角上有定位块（7×7 的框、5×5 的空、3×3 的实心）', () => {
        const m = qrMatrix(url);
        const finder = (x0: number, y0: number) => Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (_, j) => m[y0 + i]![x0 + j] === (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4))).every(Boolean)).every(Boolean);
        assert.ok(finder(0, 0) && finder(m.length - 7, 0) && finder(0, m.length - 7));
        assert.ok(m.length >= 21 && m.length <= 69, String(m.length));
    });
    test('SVG 带白边、只有黑白两色；终端版每行等宽', () => {
        const svg = qrSvg(url);
        const size = qrMatrix(url).length + 8;
        assert.match(svg, new RegExp(`viewBox="0 0 ${size} ${size}"`));
        assert.deepEqual([...new Set(svg.match(/#[0-9a-f]{6}/g))].sort(), ['#000000', '#ffffff']);
        const lines = qrTerminal(url).split('\n');
        assert.equal(new Set(lines.map(l => [...l].length)).size, 1);
        assert.equal(lines.length, Math.ceil((qrMatrix(url).length + 4) / 2), '两行模块并成一行，四周各补 2 个浅色模块');
    });
});
