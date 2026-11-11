import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { friendsFeedUrl, htmlToText, parseFriendsFeed, parseJsLiteral, postTextFromHtml, readFriendsFeed } from '../src/social/qzone-feeds3.ts';

const SELF = 200000002;
const BOYFRIEND = 100000001;

/** Qzone 把 html 放进单引号字符串时的转义方式：< → \x3C，" → \x22，/ → \/，' → \x27 */
const esc = (html: string): string => html.replace(/</g, '\\x3C').replace(/"/g, '\\x22').replace(/\//g, '\\/').replace(/'/g, '\\x27');

function shuoshuoHtml(uin: number, text: string): string {
    return `\t\t <li class="f-single f-s-s" id="fct_${uin}_311_0_1_0_1"><div class="f-single-head f-aside"><div class="user-pto"><a href="http://user.qzone.qq.com/${uin}"><img src="https://qlogo1.store.qq.com/qzone/${uin}/${uin}/50"></a></div></div>`
        + `<div class="f-single-content f-wrap"><div class="f-item f-s-i"><div class="f-info">${text}</div><div class="qz_summary wupfeed" id="hex_${uin}"><i class="none" name="feed_data" data-uin="${uin}"></i></div></div></div></li>`;
}

function item(fields: { appid: string; opuin: string; nickname?: string; key: string; abstime: number; html: string }): string {
    return `{ver:'1',appid:'${fields.appid}',typeid:'0',key:'${fields.key}',flag:'0',title:'',summary:'',abstime:'${fields.abstime}',feedstime:'昨天 15:52',`
        + `opuin:'${fields.opuin}',uin:'${fields.opuin}',ouin:'',nickname:'${fields.nickname ?? ''}',emoji:[],sameuser:{},uper_isfriend:[],html:'${esc(fields.html)}',commentcnt:''}`;
}

function feed(items: string[], code = 0): string {
    return `_preloadCallback({\n\t"code":${code},\n\t"subcode":0,\n\t"message":"",\n\t"default":0,\n\t"data":\n{main:{attach:'',hasMoreFeeds:true,error:''},data:[${items.join(',')},undefined]}}\n);`;
}

const friendPost = item({ appid: '311', opuin: String(BOYFRIEND), nickname: '宝宝', key: 'k-friend', abstime: 1792828345, html: shuoshuoHtml(BOYFRIEND, '今天&nbsp;下课早，去吃了碗面 <img src="a.png" alt="[开心]"> &amp; 回宿舍') });
const ownPost = item({ appid: '311', opuin: String(SELF), nickname: '她', key: 'k-self', abstime: 1792763079, html: shuoshuoHtml(SELF, '她自己发的') });
const adItem = item({ appid: '6600', opuin: '0', key: 'k-ad', abstime: 1792911557, html: '<li class="f-single f-single-biz" data-complete_adinfo="%7B%22"><div class="f-info">广告文案文案文案</div></li>' });
const noText = item({ appid: '311', opuin: String(BOYFRIEND), nickname: '宝宝', key: 'k-pic', abstime: 1792700000, html: shuoshuoHtml(BOYFRIEND, '') });

describe('JS 字面量解析器（ADR 0145）', () => {
    test('键名不带引号、单引号字符串、\\x \\u 转义、尾逗号、undefined、嵌套', () => {
        const value = parseJsLiteral(`{a:1, "b":'x\\x3Cy\\u4e2d\\/z\\'', c:[1,-2.5,true,false,null,undefined,],d:{e:{}},}`) as Record<string, unknown>;
        assert.equal(value.a, 1);
        assert.equal(value.b, "x<y中/z'");
        assert.deepEqual(value.c, [1, -2.5, true, false, null, undefined]);
        assert.deepEqual(value.d, { e: {} });
    });

    test('不是字面量的东西一律抛：函数调用、标识符、多余的尾巴、没结束的字符串、嵌套太深', () => {
        assert.throws(() => parseJsLiteral('{a:alert(1)}'));
        assert.throws(() => parseJsLiteral('{a:foo}'));
        assert.throws(() => parseJsLiteral('{a:1} x'));
        assert.throws(() => parseJsLiteral("{a:'abc}"));
        assert.throws(() => parseJsLiteral('['.repeat(60) + ']'.repeat(60)));
        assert.throws(() => parseJsLiteral("{a:'\\xZZ'}"));
    });

    test('__proto__ 只是一项自有数据，不能把网络字段变成解析结果的原型', () => {
        const value = parseJsLiteral(`{__proto__:{code:0,data:{data:['伪造']}}, safe:1}`) as Record<string, unknown>;
        assert.equal(Object.getPrototypeOf(value), Object.prototype);
        assert.equal(Object.hasOwn(value, '__proto__'), true);
        assert.equal(Object.hasOwn(value, 'code'), false);
        assert.equal(value.code, undefined);
        assert.equal(value.safe, 1);
    });
});

describe('好友动态流（ADR 0145）', () => {
    test('正文：f-info 里的字，表情图留 alt，标签去掉，实体还原，空白压成一个', () => {
        const html = shuoshuoHtml(BOYFRIEND, '一  二<br>三 <img src="x" alt="[笑]"> &lt;四&gt;');
        assert.equal(postTextFromHtml(html), '一 二 三 [笑] <四>');
        assert.equal(postTextFromHtml('<div class="other">没有 f-info</div>'), '');
        assert.equal(htmlToText('<b>a</b>&nbsp;&nbsp;b'), 'a b');
    });

    test('正文里嵌着 div 时按开合取完整的那个', () => {
        const html = '<div class="f-info"><div>前半</div>后半</div><div class="after">不要</div>';
        assert.equal(postTextFromHtml(html), '前半 后半');
    });

    test('解析：收宝宝的说说，不收广告、没正文的、她自己的', () => {
        const posts = parseFriendsFeed(feed([ownPost, friendPost, adItem, noText]), { selfUin: SELF })!;
        assert.equal(posts.length, 1);
        assert.equal(posts[0]!.uin, BOYFRIEND);
        assert.equal(posts[0]!.name, '宝宝');
        assert.equal(posts[0]!.id, 'k-friend');
        assert.equal(posts[0]!.text, '今天 下课早，去吃了碗面 [开心] & 回宿舍');
        assert.equal(posts[0]!.at, 1792828345 * 1000);
    });

    test('没给 selfUin 时她自己的也收；整页里一条好友的都没有返回 []（读到了，只是没有）', () => {
        assert.equal(parseFriendsFeed(feed([ownPost, adItem]))!.length, 1);
        assert.deepEqual(parseFriendsFeed(feed([ownPost, adItem]), { selfUin: SELF }), []);
    });

    test('读不出结构一律 undefined：code 非 0、不是 JSONP、字面量坏了、没有 data.data', () => {
        assert.equal(parseFriendsFeed(feed([friendPost], -3000)), undefined);
        assert.equal(parseFriendsFeed('<html>登录</html>'), undefined);
        assert.equal(parseFriendsFeed('_preloadCallback({code:0,data:{data:[{a:alert(1)}]}});'), undefined);
        assert.equal(parseFriendsFeed('_preloadCallback({code:0,data:{main:{}}});'), undefined);
    });

    test('请求地址：带 uin、g_tk、jsonp 回调', () => {
        const url = friendsFeedUrl({ cookie: 'p_skey=abc', gtk: 12345, uin: SELF });
        assert.match(url, /feeds3_html_more\?/);
        assert.match(url, new RegExp(`uin=${SELF}`));
        assert.match(url, /g_tk=12345/);
        assert.match(url, /callback=_preloadCallback/);
    });

    test('读一页：正常返回；非 200 / 网络错误 / 结构变了都是 undefined；请求带 cookie', async () => {
        const session = { cookie: 'uin=o200000002; p_skey=abc', gtk: 1, uin: SELF };
        let seen = '';
        const ok = await readFriendsFeed({ session, fetch: async (_url, init) => { seen = init.headers.cookie ?? ''; return { ok: true, status: 200, text: async () => feed([ownPost, friendPost, adItem]) }; } });
        assert.equal(ok?.length, 1);
        assert.match(seen, /p_skey=abc/);
        assert.equal(await readFriendsFeed({ session, fetch: async () => ({ ok: false, status: 403, text: async () => '' }) }), undefined);
        assert.equal(await readFriendsFeed({ session, fetch: async () => { throw new Error('ENOTFOUND'); } }), undefined);
        assert.equal(await readFriendsFeed({ session, fetch: async () => ({ ok: true, status: 200, text: async () => 'oops' }) }), undefined);
    });
});
