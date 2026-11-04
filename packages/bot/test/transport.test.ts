import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { parseTransportResponse, transportFetcher, useRealTransport } from '../src/world/transport.ts';
import { describeWorld, summarizeWorld, worldAt } from '../src/world/world.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const at = (iso: string) => new Date(`${iso}+08:00`);

describe('现实交通 / 公共服务事实（ADR 0232）', () => {
    afterEach(() => useRealTransport(undefined));

    test('只接受有限的结构化状态，并把中文状态归一化', () => {
        assert.deepEqual(parseTransportResponse({ items: [
            { location: '地铁 2 号线', status: '晚点', updatedAt: '2026-11-03T08:00:00+08:00', detail: '预计 10 分钟' },
            { status: '关闭', updatedAt: '2026-11-03T08:01:00+08:00' },
        ] }, 'jinan', 'test'), [
            { location: '地铁 2 号线', status: 'delayed', observedAt: '2026-11-03T00:00:00.000Z', source: 'test', real: true, detail: '预计 10 分钟' },
            { location: 'jinan', status: 'closed', observedAt: '2026-11-03T00:01:00.000Z', source: 'test', real: true },
        ]);
        assert.throws(() => parseTransportResponse({ items: [{ status: '正常', updatedAt: 'not-a-date' }] }, 'jinan', 'test'), /有效/);
    });

    test('成功缓存、单地点失败保留旧值、过期后不返回', async () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-transport-'));
        let now = at('2026-11-03T09:00:00').getTime();
        let fail = false;
        const logs: string[] = [];
        const fetcher = transportFetcher({
            dir: root, log: line => logs.push(line), locations: [{ id: 'jinan', name: '济南' }, { id: 'qingdao', name: '青岛' }],
            endpoint: location => `https://example.test/${location.id}`, source: 'test', now: () => now, cacheMaxAgeMs: 60_000,
            fetchJson: async url => {
                if (fail && url.endsWith('/qingdao')) throw new Error('timeout');
                return { data: [{ location: url.endsWith('/jinan') ? '济南' : '青岛', status: '正常', updatedAt: '2026-11-03T09:00:00+08:00' }] };
            },
        });
        try {
            await fetcher.refresh();
            assert.equal(fetcher.day('jinan', at('2026-11-03T09:00:00'))?.status, 'normal');
            fail = true;
            now += 30_000;
            await fetcher.refresh();
            assert.equal(fetcher.day('jinan', at('2026-11-03T09:00:00'))?.status, 'normal');
            assert.ok(logs.some(line => line.includes('青岛') && line.includes('timeout')));
            now += 61_000;
            assert.equal(fetcher.day('jinan', at('2026-11-03T09:00:00')), undefined);
            assert.equal(fetcher.day('qingdao', at('2026-11-03T09:00:00')), undefined, '另一个地点成功不能延长失败地点的旧观测');
            assert.equal(fetcher.status().locations.jinan!.stale, true);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('共享端点返回多个地点时按稳定 id 或显示名匹配，不把最后一条状态写给所有地点', async () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-transport-shared-'));
        const now = at('2026-11-03T09:00:00').getTime();
        let requests = 0;
        const fetcher = transportFetcher({
            dir: root, log: () => {}, locations: [{ id: 'jinan', name: '济南' }, { id: 'qingdao', name: '青岛' }],
            endpoint: 'https://example.test/all', source: 'test', now: () => now,
            fetchJson: async () => {
                requests += 1;
                return { data: [
                    { location: '济南', status: '延误', updatedAt: '2026-11-03T09:00:00+08:00' },
                    { location: 'qingdao', status: '关闭', updatedAt: '2026-11-03T09:00:00+08:00' },
                ] };
            },
        });
        try {
            await fetcher.refresh();
            assert.equal(requests, 1, '共享端点一轮只请求一次，避免重复耗用供应商额度');
            assert.equal(fetcher.day('jinan')?.status, 'delayed');
            assert.equal(fetcher.day('qingdao')?.status, 'closed');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('共享端点服务多个地点时拒绝没有地点标识的单条响应', async () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-transport-ambiguous-'));
        const now = at('2026-11-03T09:00:00').getTime();
        const logs: string[] = [];
        const fetcher = transportFetcher({
            dir: root, log: line => logs.push(line), locations: [{ id: 'jinan', name: '济南' }, { id: 'qingdao', name: '青岛' }],
            endpoint: 'https://example.test/all', source: 'test', now: () => now,
            fetchJson: async () => ({ data: [{ status: '正常', updatedAt: '2026-11-03T09:00:00+08:00' }] }),
        });
        try {
            await fetcher.refresh();
            assert.equal(fetcher.day('jinan'), undefined);
            assert.equal(fetcher.day('qingdao'), undefined);
            assert.match(fetcher.status().locations.jinan!.error ?? '', /没有当前地点/);
            assert.match(fetcher.status().locations.qingdao!.error ?? '', /没有当前地点/);
            assert.equal(logs.filter(line => line.includes('没有当前地点')).length, 2);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('供应商异常在日志和状态中隐藏凭据并限制长度', async () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-transport-error-'));
        const logs: string[] = [];
        const secret = 'supplier-secret-value';
        const fetcher = transportFetcher({
            dir: root, log: line => logs.push(line), locations: [{ id: 'jinan', name: '济南' }],
            endpoint: 'https://example.test/current', source: 'test',
            fetchJson: async () => { throw new Error(`HTTP 401 https://alice:password@example.test/feed?api_key=${secret}&ok=1 Authorization: Bearer bearer-value Cookie: sid=cookie-value ${'x'.repeat(300)}`); },
        });
        try {
            await fetcher.refresh();
            const error = fetcher.status().locations.jinan!.error ?? '';
            assert.match(error, /HTTP 401/);
            assert.match(error, /<redacted>/);
            assert.ok(error.length <= 160);
            assert.doesNotMatch(error, /supplier-secret-value|password@example|bearer-value|cookie-value/);
            assert.doesNotMatch(logs.join('\n'), /supplier-secret-value|password@example|bearer-value|cookie-value/);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('默认请求拒绝跟随供应商重定向，不能绕过已确认端点', async () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-transport-redirect-'));
        const now = at('2026-11-03T09:00:00').getTime();
        let redirect: RequestInit['redirect'];
        const fetcher = transportFetcher({
            dir: root, log: () => {}, locations: [{ id: 'jinan' }],
            endpoint: 'https://example.test/status', source: 'test', now: () => now,
            request: async (_url, init) => {
                redirect = init.redirect;
                return new Response(JSON.stringify({ data: [{ status: '正常', updatedAt: '2026-11-03T09:00:00+08:00' }] }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            },
        });
        try {
            await fetcher.refresh();
            assert.equal(redirect, 'error');
            assert.equal(fetcher.day('jinan')?.status, 'normal');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('可显式投影进世界，但不把供应商详情原样送进提示词', () => {
        const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
        useRealTransport({ day: location => ({ location, status: 'delayed', observedAt: '2026-10-20T05:00:00.000Z', source: 'test', real: true, detail: '供应商原文不应进入提示词' }) });
        const now = worldAt(card.herWorld!, card.schedule!, at('2026-10-20T14:00:00'))!;
        assert.equal(now.transport?.status, 'delayed');
        assert.match(describeWorld(now, at('2026-10-20T14:00:00'))!, /交通：延误/);
        assert.doesNotMatch(describeWorld(now, at('2026-10-20T14:00:00'))!, /供应商原文/);
        assert.match(summarizeWorld(now), /交通 延误/);
    });

    test('供应商抛错时世界仍照常生成，不把故障冒充交通状态', () => {
        const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
        useRealTransport({ day: () => { throw new Error('provider down'); } });
        const now = worldAt(card.herWorld!, card.schedule!, at('2026-10-20T14:00:00'))!;
        assert.equal(now.transport, undefined);
        assert.ok(now.weather);
    });

    test('缓存严格校验并绑定当前供应商，旧来源或损坏事实都不复用', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-transport-cache-'));
        const dir = join(root, 'transport');
        mkdirSync(dir);
        const cache = join(dir, 'transport.json');
        writeFileSync(cache, JSON.stringify({
            fetchedAt: '2026-11-03T01:00:00.000Z',
            facts: { jinan: { location: '济南', status: 'normal', observedAt: '2026-11-03T01:00:00.000Z', source: 'old-provider', real: true } },
        }));
        const options = {
            dir, log: () => {}, locations: [{ id: 'jinan' }], endpoint: 'https://example.test', source: 'new-provider',
            now: () => at('2026-11-03T09:00:00').getTime(), fetchJson: async () => ({}),
        };
        try {
            assert.equal(transportFetcher(options).day('jinan'), undefined, '更换供应商后不能短暂复用旧来源事实');
            writeFileSync(cache, JSON.stringify({
                fetchedAt: '2026-11-03T01:00:00.000Z',
                facts: { jinan: { location: '济南', status: 'normal', observedAt: 'not-a-time', source: 'new-provider', real: true } },
            }));
            const logs: string[] = [];
            const broken = transportFetcher({ ...options, log: message => logs.push(message) });
            assert.equal(broken.day('jinan'), undefined);
            assert.equal(existsSync(cache), false);
            assert.ok(readdirSync(dir).some(name => name.startsWith('transport.json.corrupt-')));
            assert.ok(logs.some(message => message.includes('交通缓存') && message.includes('挪到')));
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('明显来自未来的抓取时间或观测时间不会进入世界，并在状态页标为过期', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-transport-future-'));
        const dir = join(root, 'transport');
        mkdirSync(dir);
        const cache = join(dir, 'transport.json');
        const options = {
            dir, log: () => {}, locations: [{ id: 'jinan' }], endpoint: 'https://example.test', source: 'test',
            now: () => at('2026-11-03T09:00:00').getTime(), fetchJson: async () => ({}), cacheMaxAgeMs: 60_000,
        };
        try {
            writeFileSync(cache, JSON.stringify({
                fetchedAt: '2026-11-03T03:00:00.000Z',
                facts: { jinan: { location: '济南', status: 'normal', observedAt: '2026-11-03T03:00:00.000Z', source: 'test', real: true } },
            }));
            const futureFetch = transportFetcher(options);
            assert.equal(futureFetch.day('jinan'), undefined);
            assert.equal(futureFetch.status().stale, true);
            assert.equal(futureFetch.status().locations.jinan!.stale, true);

            writeFileSync(cache, JSON.stringify({
                fetchedAt: '2026-11-03T01:00:00.000Z',
                facts: { jinan: { location: '济南', status: 'normal', observedAt: '2026-11-03T03:00:00.000Z', source: 'test', real: true } },
            }));
            const futureObservation = transportFetcher(options);
            assert.equal(futureObservation.day('jinan'), undefined);
            assert.equal(futureObservation.status().locations.jinan!.stale, true);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
