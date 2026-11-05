import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HindsightClient, HINDSIGHT_INVENTORY_MAX_ITEMS } from '../src/memory/hindsight.ts';

const bank = 'synthetic-inventory-bank', secret = 'SYNTHETIC_PRIVATE_INVENTORY';
const time = '2026-11-05T12:00:00.123456+00:00';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const row = (n: number, fact_type = 'observation') => ({ id: uuid(n), fact_type, state: 'valid', document_id: fact_type === 'observation' ? null : 'ep-1',
    tags: [], source_memory_ids: fact_type === 'observation' ? [uuid(9999)] : [], updated_at: time,
    consolidated_at: fact_type === 'observation' ? null : time, consolidation_failed_at: null as string | null,
    text: secret, context: secret, metadata: { raw: secret }, attachments: [{ url: secret }] });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
async function fake(fetcher: (url: URL, init: RequestInit) => Response | Promise<Response>, work: (client: HindsightClient) => Promise<void>, budget = 1000) {
    const original = globalThis.fetch; globalThis.fetch = async (input, init) => fetcher(new URL(String(input)), init ?? {});
    try { await work(new HindsightClient('http://synthetic.invalid/SYNTHETIC_PRIVATE_PATH', budget)); }
    finally { globalThis.fetch = original; }
}

test('observation完整无过滤清单覆盖101条及孤儿源，只返回固定metadata不带原文', async () => {
    const pages: number[] = [];
    await fake((url, init) => {
        assert.equal(init.method, 'GET'); assert.ok(url.pathname.endsWith('/memories/list'));
        assert.deepEqual([...url.searchParams.keys()].sort(), ['limit', 'offset', 'state', 'type']);
        assert.equal(url.searchParams.get('type'), 'observation'); assert.equal(url.searchParams.get('state'), 'valid');
        const offset = Number(url.searchParams.get('offset')); pages.push(offset);
        return json({ items: Array.from({ length: Math.min(100, 101 - offset) }, (_, n) => row(offset + n)), total: 101, limit: 100, offset });
    }, async client => {
        const results = await client.repairObservationInventory(bank);
        assert.equal(results.length, 101); assert.equal(results[100]!.id, uuid(100));
        assert.deepEqual(results[0]!.source_memory_ids, [uuid(9999)]);
        assert.equal(results[0]!.document_id, null); assert.doesNotMatch(JSON.stringify(results), /SYNTHETIC_PRIVATE/);
        assert.equal('history_cleared' in results, false);
    });
    assert.deepEqual(pages, [0, 100]);
});

test('source清单分别枚举world和experience并保留每项consolidation时标，不用stats零替代逐行证据', async () => {
    const types: string[] = [];
    await fake(url => {
        const type = url.searchParams.get('type')!; types.push(type);
        const item = row(type === 'world' ? 1 : 2, type);
        if (type === 'experience') item.consolidation_failed_at = time;
        return json({ items: [item], total: 1, limit: 100, offset: 0 });
    }, async client => {
        const results = await client.repairSourceConsolidationInventory(bank);
        assert.equal(results.length, 2); assert.equal(results[0]!.consolidated_at, time); assert.equal(results[1]!.consolidation_failed_at, time);
        assert.doesNotMatch(JSON.stringify(results), /SYNTHETIC_PRIVATE/);
    });
    assert.deepEqual(types, ['world', 'experience']);
});

const safe = (error: unknown) => { assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE/); return true; };
const page = (items: unknown[], total = items.length, offset = 0) => ({ items, total, offset, limit: 100 });

test('完整字段拒缺省/错type/state/坏UUID及日期，不借source仍存在条件过滤掉孤儿', async () => {
    const good = row(1);
    for (const value of [{ ...good, id: secret }, { ...good, fact_type: 'world' }, { ...good, state: 'invalidated' },
        { ...good, document_id: undefined }, { ...good, tags: undefined }, { ...good, tags: [1] },
        { ...good, source_memory_ids: undefined }, { ...good, source_memory_ids: [secret] },
        { ...good, updated_at: undefined }, { ...good, updated_at: '2026-02-30T00:00:00Z' },
        { ...good, consolidated_at: undefined }, { ...good, consolidation_failed_at: undefined }])
        await fake(() => json(page([value])), client => assert.rejects(client.repairObservationInventory(bank), safe));
    await fake(() => json(page([{ ...good, document_id: null, source_memory_ids: [], updated_at: null, consolidated_at: null, consolidation_failed_at: null }])),
        async client => assert.equal((await client.repairObservationInventory(bank)).length, 1));
    await fake(() => json({ message: secret }, 404), client => assert.rejects(client.repairObservationInventory(bank), safe));
});

test('分页遇total漂移/UUID重复含大小写/错误offset/limit或短页时不返回部分证明', async () => {
    for (const broken of ['total', 'duplicate', 'case', 'offset', 'limit', 'short'] as const) await fake(url => {
        const offset = Number(url.searchParams.get('offset'));
        if (!offset) return json(page(Array.from({ length: 100 }, (_, n) => row(n)), 101));
        const last = row(broken === 'duplicate' || broken === 'case' ? 10 : 100);
        if (broken === 'case') last.id = last.id.toUpperCase();
        return json({ ...page(broken === 'short' ? [] : [last], broken === 'total' ? 102 : 101, broken === 'offset' ? 0 : 100),
            ...(broken === 'limit' ? { limit: 99 } : {}) });
    }, client => assert.rejects(client.repairObservationInventory(bank), safe));
    await fake(url => json(page([row(1, url.searchParams.get('type')!) ])), client => assert.rejects(client.repairSourceConsolidationInventory(bank), safe));
});

test('空live inventory只证明本次live清单为空，不制造history清除或未知DELETE结算字段', async () => {
    await fake((url, init) => { assert.equal(init.method, 'GET'); assert.equal(url.searchParams.get('type'), 'observation'); return json(page([])); }, async client => {
        const rows = await client.repairObservationInventory(bank); assert.deepEqual(rows, []);
        assert.equal('history_cleared' in rows, false); assert.equal('delete_settled' in rows, false); assert.equal('snapshot' in rows, false);
    });
});

test('数量/累计UTF8 metadata限额整项拒证不截断，source两类型共用字节预算', async () => {
    let requests = 0;
    await fake(() => { requests++; return json(page(Array.from({ length: 100 }, (_, n) => row(n)), HINDSIGHT_INVENTORY_MAX_ITEMS + 1)); },
        client => assert.rejects(client.repairObservationInventory(bank), /限额/));
    assert.equal(requests, 1);
    requests = 0;
    const bigTag = '界'.repeat(1_500_000); // each valid HTTP page is below 8MiB; their metadata union is not.
    await fake(url => { requests++; return json(page([{ ...row(requests, url.searchParams.get('type')!), tags: [bigTag] }])); },
        client => assert.rejects(client.repairSourceConsolidationInventory(bank), /限额/));
    assert.equal(requests, 2);
});

test('source两类型共享总deadline；永久挂响应流取消且错误不回显正文/路径', async () => {
    let requests = 0, aborted = false;
    await fake((_url, init) => {
        requests++;
        if (requests === 1) { const until = performance.now() + 20; while (performance.now() < until) { /* consume shared budget deterministically */ } return json(page([])); }
        init.signal?.addEventListener('abort', () => aborted = true); return new Promise<Response>(() => {});
    }, async client => {
        await assert.rejects(client.repairSourceConsolidationInventory(bank), error => {
            safe(error); const timeout = /（(\d+) ms）/.exec(String(error)); assert.ok(timeout); assert.ok(Number(timeout[1]) <= 90); return true;
        });
    }, 100);
    assert.equal(requests, 2); assert.equal(aborted, true);
    let cancelled = false;
    await fake(() => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel() { cancelled = true; } })),
        client => assert.rejects(client.repairObservationInventory(bank), safe), 20);
    assert.equal(cancelled, true);
});
