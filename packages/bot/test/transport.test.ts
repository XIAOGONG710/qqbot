import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
            assert.equal(fetcher.status().locations.jinan!.stale, true);
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
});
