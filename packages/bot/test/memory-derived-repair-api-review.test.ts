import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { HindsightClient, isSafeRepairModel, repairDocumentContentHash, repairModelConfigHash } from '../src/memory/hindsight.ts';

const bank = 'synthetic-private', id = 'relationship', uuid = '11111111-1111-4111-8111-111111111111';
const stamp = '2026-11-05T12:00:00.123456+00:00', secret = 'SYNTHETIC_PRIVATE_RESPONSE';
const groups = [{ tags: ['qq-private'], match: 'all_strict', resolve: 'exact' }, { not: { tags: ['diary', 'week', 'phase'], match: 'any_strict', resolve: 'exact' } }];
const model = () => ({ id, bank_id: bank, name: '关系概况', source_query: '仅依据合成聊天整理关系', content: '合成安全正文', tags: ['qq-private'],
    trigger: { mode: 'full', exclude_mental_models: true, fact_types: ['world', 'experience'], include_chunks: false, tag_groups: groups, tags_match: 'all_strict',
        refresh_after_consolidation: false, refresh_cron: null, min_refresh_interval_seconds: 1800 }, last_memory_seen_at: stamp, last_refreshed_at: stamp, is_stale: false });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const safe = (error: unknown) => { assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE/); return true; };
async function fake<T>(fetcher: (url: URL, init: RequestInit) => Response | Promise<Response>, work: (client: HindsightClient) => Promise<T>, budget = 1000) {
    const original = globalThis.fetch; globalThis.fetch = async (input, init) => fetcher(new URL(String(input)), init ?? {});
    try { return await work(new HindsightClient('http://synthetic.invalid/SYNTHETIC_PRIVATE_PATH', budget)); }
    finally { globalThis.fetch = original; }
}
const operationId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const page = (items: unknown[], offset = 0, total = items.length) => ({ items, total, limit: 100, offset });

test('document hash对照官方sanitize：保留emoji/tab/LF/CR、去控制字符及孤立surrogate，不做trim/NFC', () => {
    const raw = ' A\x00\x08\t\n\r\x0b\x0c\x0e\x1f\x7f😀\ud800B\udc00 ';
    assert.equal(repairDocumentContentHash(raw), createHash('sha256').update(' A\t\n\r😀B ', 'utf8').digest('hex'));
    assert.notEqual(repairDocumentContentHash('e\u0301'), repairDocumentContentHash('é'));
    assert.notEqual(repairDocumentContentHash(' x '), repairDocumentContentHash('x'));
});

test('fresh stats强制refresh=true并保留微秒水位，坏计数/日期/bank与错误正文安全拒绝', async () => {
    const valid = { bank_id: bank, pending_consolidation: 0, failed_consolidation: 2, last_memory_write_at: stamp };
    await fake(url => { assert.equal(url.searchParams.get('refresh'), 'true'); return json(valid); }, async client => assert.deepEqual(await client.repairStats(bank), {
        pending_consolidation: 0, failed_consolidation: 2, last_memory_write_at: stamp }));
    for (const value of [null, [], { ...valid, bank_id: secret }, { ...valid, failed_consolidation: -1 },
        { ...valid, pending_consolidation: 0.5 }, { ...valid, last_memory_write_at: '2026-02-30T00:00:00Z' }])
        await fake(() => json(value), client => assert.rejects(client.repairStats(bank), safe));
    await fake(() => json({ message: secret }, 500), client => assert.rejects(client.repairStats(bank), safe));
});

test('活动证据遍历全部类型四状态及第101行，不把failed/cancelled当idle或截首100', async () => {
    const queried: string[] = [];
    await fake(url => {
        assert.equal(url.searchParams.get('type'), null); assert.equal(url.searchParams.get('exclude_parents'), 'false');
        const status = url.searchParams.get('status')!, offset = Number(url.searchParams.get('offset')); queried.push(status);
        const total = status === 'pending' ? 101 : status === 'failed' || status === 'cancelled' ? 1 : 0;
        const rows = Array.from({ length: Math.min(100, total - offset) }, (_, index) => ({
            operation_id: operationId((status === 'failed' ? 1000 : status === 'cancelled' ? 2000 : 0) + offset + index),
            task_type: offset === 100 ? 'file_convert_retain' : 'refresh_mental_model', status,
            mental_model_id: id,
        }));
        return json({ bank_id: bank, operations: rows, total, limit: 100, offset });
    }, async client => {
        const result = await client.repairActiveOperations(bank); assert.equal(result.length, 103);
        assert.ok(result.some(row => row.task_type === 'file_convert_retain')); assert.ok(result.some(row => row.status === 'failed')); assert.ok(result.some(row => row.status === 'cancelled'));
    });
    assert.deepEqual(queried, ['pending', 'pending', 'processing', 'failed', 'cancelled']);
});

test('模型与文档清单完整分页，未知模型/非ep文档不会在第101行被漏掉', async () => {
    await fake(url => {
        const offset = Number(url.searchParams.get('offset')), docs = url.pathname.endsWith('/documents');
        if (!docs) assert.equal(url.searchParams.get('detail'), 'metadata');
        const items = Array.from({ length: Math.min(100, 101 - offset) }, (_, n) => docs
            ? { id: offset + n === 100 ? 'diary:2026-11-01' : `ep-${offset + n}`, bank_id: bank, content_hash: 'a'.repeat(64), tags: ['qq-private'] }
            : { ...model(), id: offset + n === 100 ? 'unknown-model' : `model-${offset + n}`, content: secret });
        return json(page(items, offset, 101));
    }, async client => {
        const models = await client.repairModels(bank), docs = await client.repairDocuments(bank);
        assert.equal(models.length, 101); assert.equal(docs.length, 101);
        assert.equal(models.at(-1)!.id, 'unknown-model'); assert.equal(docs.at(-1)!.id, 'diary:2026-11-01');
        assert.equal('content' in models[0]!, false, 'metadata清单不带供应商意外附加正文');
    });
});

test('分页证据遇total漂移/重复ID/错误offset/不前进时失败，绝不返回部分清单', async () => {
    for (const mode of ['total', 'duplicate', 'offset', 'empty']) await fake(url => {
        const offset = Number(url.searchParams.get('offset'));
        const items = offset === 0 ? Array.from({ length: 100 }, (_, n) => ({ ...model(), id: `model-${n}` })) : [{ ...model(), id: mode === 'duplicate' ? 'model-0' : 'last' }];
        return json(page(mode === 'empty' ? [] : items, mode === 'offset' ? offset + 1 : offset, mode === 'total' && offset > 0 ? 102 : 101));
    }, client => assert.rejects(client.repairModels(bank), safe));
});

test('完整模型证据绑定id/bank/config hash，坏schema和无效瞬时不能成为完成证明', async () => {
    await fake(() => json(model()), async client => {
        const evidence = await client.repairModel(bank, id);
        assert.equal(evidence.safe_configuration, true); assert.equal(isSafeRepairModel(evidence), true);
        assert.equal(evidence.configuration_hash, repairModelConfigHash(evidence)); assert.equal(evidence.last_memory_seen_at, stamp);
        assert.notEqual(repairModelConfigHash({ ...evidence, source_query: 'changed' }), evidence.configuration_hash);
    });
    for (const value of [{ ...model(), id: 'wrong' }, { ...model(), bank_id: secret }, { ...model(), trigger: [] },
        { ...model(), source_query: {} }, { ...model(), tags: [false] }, { ...model(), content: {} }, { ...model(), last_refreshed_at: 'bad' },
        { ...model(), is_stale: undefined }, { ...model(), is_stale: null }, { ...model(), is_stale: 'false' }])
        await fake(() => json(value), client => assert.rejects(client.repairModel(bank, id), safe));
});

test('scope freshness明确保留true/false及微秒，不能把同毫秒旧水位自动当成不陈旧', async () => {
    const earlier = '2026-11-05T12:00:00.123400+00:00';
    assert.equal(Date.parse(earlier), Date.parse(stamp), '夹具必须证明毫秒比较丢掉差异');
    for (const is_stale of [true, false]) await fake(() => json({ ...model(), last_memory_seen_at: earlier, is_stale }), async client => {
        const evidence = await client.repairModel(bank, id);
        assert.equal(evidence.last_memory_seen_at, earlier); assert.equal(evidence.is_stale, is_stale);
    });
});

test('configure只PATCH安全hard filters与autooff；restore保留safe配置并恢复原true/false及cadence', async () => {
    let calls = 0;
    await fake((_url, init) => {
        calls++; assert.equal(init.method, 'PATCH'); const body = JSON.parse(String(init.body));
        assert.equal(body.content, undefined); assert.equal(body.trigger.mode, 'full'); assert.equal(body.trigger.exclude_mental_models, true);
        assert.deepEqual(body.trigger.fact_types, ['world', 'experience']); assert.equal(body.trigger.include_chunks, false); assert.deepEqual(body.trigger.tag_groups, groups);
        return json({ ...model(), trigger: { ...model().trigger, ...body.trigger } });
    }, async client => {
        assert.ok(isSafeRepairModel(await client.repairConfigureModel(bank, id)));
        for (const automatic of [false, true]) { const evidence = await client.repairRestoreAutomatic(bank, id, 900, automatic);
            assert.ok(isSafeRepairModel(evidence, automatic)); assert.equal(evidence.trigger.min_refresh_interval_seconds, 900); }
    });
    assert.equal(calls, 3);
    await fake(() => json({ ...model(), trigger: { ...model().trigger, exclude_mental_models: false } }), client => assert.rejects(client.repairConfigureModel(bank, id), safe));
});

test('clear要求实际空content和安全暂停配置，receipt非空/unsafe不能冒认清理成功', async () => {
    await fake((url, init) => { assert.ok(url.pathname.endsWith('/clear')); assert.equal(init.method, 'POST'); assert.equal(init.body, undefined); return json({ ...model(), content: '' }); },
        async client => assert.equal((await client.repairClearModel(bank, id)).content, ''));
    for (const value of [model(), { ...model(), content: null }, { ...model(), content: '', trigger: { ...model().trigger, mode: 'delta' } }])
        await fake(() => json(value), client => assert.rejects(client.repairClearModel(bank, id), safe));
});

test('refresh不虚构clientUUID，严格queued receipt且未知ACK只抛错不重发', async () => {
    let calls = 0;
    await fake((url, init) => { calls++; assert.ok(url.pathname.endsWith('/refresh')); assert.equal(init.body, undefined); return json({ operation_id: uuid, status: 'queued' }); },
        async client => assert.equal(await client.repairRefreshModel(bank, id), uuid));
    assert.equal(calls, 1);
    for (const value of [{ operation_id: uuid, status: 'completed' }, { operation_id: secret, status: 'queued' }, {}])
        await fake(() => json(value), client => assert.rejects(client.repairRefreshModel(bank, id), safe));
    calls = 0;
    await fake(() => { calls++; throw new Error(secret); }, client => assert.rejects(client.repairRefreshModel(bank, id), safe));
    assert.equal(calls, 1);
});

test('通用refresh operation无需retain children；支持typed outcome但preserved/cancelled/unknown不冒认重建完成', async () => {
    const status = (s: string, outcome: string | null = null) => ({ operation_id: uuid, status: s, operation_type: 'refresh_mental_model', mental_model_id: id,
        details: outcome ? { operation_type: 'refresh_mental_model', outcome, failure_reason: null } : null, error_message: secret });
    for (const outcome of ['content_written', 'content_unchanged', 'content_preserved_no_new_facts']) await fake(() => json(status('completed', outcome)), async client => {
        const result = await client.repairRefreshOperation(bank, uuid); assert.equal(result.outcome, outcome); assert.equal(result.mental_model_id, id);
        assert.equal('error_message' in result, false);
    });
    for (const state of ['pending', 'processing', 'failed', 'cancelled']) await fake(() => json(status(state)), async client => assert.equal((await client.repairRefreshOperation(bank, uuid)).status, state));
    await fake(() => json({ operation_id: uuid, status: 'not_found', operation_type: null }), async client => assert.equal((await client.repairRefreshOperation(bank, uuid)).status, 'not_found'));
    for (const value of [{ ...status('completed', 'content_written'), operation_id: operationId(2) }, status('completed'), status('completed', 'surprise'),
        { ...status('completed', 'content_written'), operation_type: 'retain' }, { ...status('completed', 'content_written'), mental_model_id: null }])
        await fake(() => json(value), client => assert.rejects(client.repairRefreshOperation(bank, uuid), safe));
});

test('跨分页共享同一deadline，忽略abort永挂fetch也限时结束且不继续读取', async () => {
    let calls = 0;
    await fake(async url => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return json({ bank_id: bank, total: 0, limit: 100, offset: Number(url.searchParams.get('offset')), operations: [] }); },
        client => assert.rejects(client.repairActiveOperations(bank), safe), 55);
    assert.ok(calls < 4);
    await fake(() => new Promise<Response>(() => {}), client => assert.rejects(client.repairModel(bank, id), safe), 20);
});
