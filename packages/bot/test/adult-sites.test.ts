import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adultSiteUrls, adultSiteVisitDue } from '../src/proactive/adult-sites.ts';

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
