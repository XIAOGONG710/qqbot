import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cookieHeader, gTk, jsonpBody, parseUserFeed, readUserQzone, sessionFromCookies, userFeedUrl } from '../src/social/qzone-remote.ts';

const cookies = [
    { name: 'uin', value: 'o200000002', domain: 'qzone.qq.com' },
    { name: 'p_skey', value: 'abc', domain: 'qzone.qq.com' },
    { name: 'skey', value: 's', domain: 'qzone.qq.com' },
];

describe('看别人的空间（ADR 0143）', () => {
    test('cookie 头：要有 p_skey 或 skey；uin 的 o 前缀去掉', () => {
        const header = cookieHeader(cookies);
        assert.match(header ?? '', /uin=o200000002/);
        assert.match(header ?? '', /p_skey=abc/);
        assert.equal(cookieHeader([{ name: 'uin', value: 'o1' }]), undefined);
        const session = sessionFromCookies(cookies);
        assert.equal(session?.gtk, gTk('abc'));
        assert.equal(session?.uin, 200000002);
        assert.equal(sessionFromCookies([{ name: 'skey', value: 'x' }])?.gtk, gTk('x'), '没有 p_skey 时退回 skey');
    });

    test('NapCat get_cookies 的真实形状（cookies 是一整串，另给 bkn）也能取到登录态', () => {
        const real = { cookies: 'uin=o200000002; skey=@s; p_skey=abc', bkn: '123' };
        assert.match(cookieHeader(real) ?? '', /p_skey=abc/);
        const session = sessionFromCookies(real);
        assert.equal(session?.gtk, gTk('abc'));
        assert.equal(session?.uin, 200000002);
        assert.equal(sessionFromCookies('uin=o1; p_skey=abc')?.gtk, gTk('abc'), '裸字符串也认');
        assert.equal(sessionFromCookies({ cookies: 'uin=o1', bkn: '' }), undefined, '没有 p_skey / skey 就是没有登录态');
        assert.equal(sessionFromCookies({ cookies: '', bkn: '' }), undefined);
    });

    test('g_tk：djb2 取低 31 位（固定向量）', () => {
        assert.equal(gTk('abc'), 193485963);
        assert.equal(gTk('p_skey_example'), 2029982555);
        assert.equal(gTk(''), 5381);
    });

    test('请求地址带 hostuin、g_tk、jsonp', () => {
        const url = userFeedUrl({ hostUin: 10001, gtk: 42, num: 5 });
        assert.match(url, /uin=10001/);
        assert.match(url, /g_tk=42/);
        assert.match(url, /emotion_cgi_msglist_v6/);
        assert.match(url, /format=jsonp/);
    });

    test('JSONP 抠 JSON；Qzone 的错误码当读不到', () => {
        assert.deepEqual(jsonpBody('_preloadCallback({"a":1})'), { a: 1 });
        assert.deepEqual(jsonpBody('{"a":1}'), { a: 1 });
        assert.equal(jsonpBody('not json'), undefined);
        assert.equal(parseUserFeed({ code: -3000, message: '请先登录' }), undefined);
        assert.equal(parseUserFeed({}), undefined);
    });

    test('msglist 规范化：正文、图、时间、赞和评论、昵称', () => {
        const items = parseUserFeed({
            msglist: [
                { tid: 't1', content: '今天风好大', created_time: 1760000000, name: '小雨', uin: 10001, pic: [{ url: 'a.jpg' }], likeNum: 2, cmntnum: 1 },
                { tid: 't2', content: '' },
            ],
        });
        assert.equal(items?.length, 1);
        assert.deepEqual(items?.[0], { id: 't1', uin: 10001, name: '小雨', text: '今天风好大', images: 1, at: 1760000000000, likes: 2, comments: 1 });
    });

    test('读一个人：正常返回；非 200 / 网络错误返回 undefined', async () => {
        const session = sessionFromCookies(cookies)!;
        const ok = await readUserQzone({
            hostUin: 10001, session,
            fetch: async () => ({ ok: true, status: 200, text: async () => '_preloadCallback({"msglist":[{"tid":"x","content":"海边的晚霞"}]})' }),
        });
        assert.equal(ok?.[0]?.text, '海边的晚霞');
        const denied = await readUserQzone({ hostUin: 10001, session, fetch: async () => ({ ok: false, status: 403, text: async () => '' }) });
        assert.equal(denied, undefined);
        const broken = await readUserQzone({ hostUin: 10001, session, fetch: async () => { throw new Error('断网'); } });
        assert.equal(broken, undefined);
    });
});
