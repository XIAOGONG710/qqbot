import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adultSiteUrls, adultSiteVisitDue, readAdultSite } from '../src/proactive/adult-sites.ts';

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
const resolve = async () => ['93.184.216.34'];

test('在配置的站点目录里只跟一篇站内作品，忽略广告和作品链接上的查询参数', async () => {
    const cases = [
        ['https://www.literotica.com/stories', '/new/stories', '/s/synthetic-story'],
        ['https://storiesonline.net/', '/', '/s/123/synthetic-story'],
        ['https://www.lushstories.com/stories', '/stories', '/stories/love-stories/synthetic-story'],
    ] as const;
    for (const [entry, directory, story] of cases) {
        const requests: string[] = [];
        const done = await readAdultSite(new URL(entry), {
            resolve,
            fetch: async input => {
                const url = new URL(String(input));
                requests.push(url.pathname + url.search);
                return url.pathname === directory
                    ? html(`<p>这里是一段用来验证目录解析的合成页面正文</p><a href="https://ads.example${story}">广告</a>
                            <template><a href="${story}-template">模板</a></template>
                            <a href="${story}?tracking=1">作品一</a><a href="${story}-second">作品二</a>`)
                    : html('<p>这里是一段用于验证已读到作品正文的合成文字。</p>');
            },
        });
        assert.equal(done, true);
        assert.deepEqual(requests, [directory, story]);
    }
});

test('作品要求登录或跳向其他页面时不算读到正文', async () => {
    const entry = new URL('https://storiesonline.net/s/123/synthetic-story');
    assert.equal(await readAdultSite(entry, {
        resolve,
        fetch: async () => html('<p>To read the complete story you need to be logged in.</p>'),
    }), false);

    const requests: string[] = [];
    assert.equal(await readAdultSite(entry, {
        resolve,
        fetch: async input => {
            requests.push(String(input));
            return new Response(null, { status: 302, headers: { location: '/login' } });
        },
    }), false);
    assert.deepEqual(requests, [entry.href]);
});

test('成人网站只接受明确配置的无凭据 HTTPS 地址', () => {
    assert.deepEqual(adultSiteUrls(undefined), []);
    assert.deepEqual(adultSiteUrls(['https://example.com', 'https://example.com/']), ['https://example.com/']);
    for (const url of ['http://example.com/', 'https://user:pass@example.com/', 'https://example.com/?q=term']) {
        assert.throws(() => adultSiteUrls([url]));
    }
});

test('只在满意度足够低且距离上次尝试满一天时触发', () => {
    const now = Date.parse('2026-11-18T16:00:00Z');
    assert.equal(adultSiteVisitDue(undefined, undefined, now), false);
    assert.equal(adultSiteVisitDue(45, undefined, now), false);
    assert.equal(adultSiteVisitDue(44, undefined, now), true);
    assert.equal(adultSiteVisitDue(44, '2026-11-17T16:01:00Z', now), false);
    assert.equal(adultSiteVisitDue(44, '2026-11-17T16:00:00Z', now), true);
});
