import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HindsightClient } from '../src/memory/hindsight.ts';

const bank = 'synthetic-observation-bank', op = '11111111-1111-4111-8111-111111111111';
const time = '2026-11-05T12:00:00.123456+00:00', privateMarker = 'SYNTHETIC_PRIVATE_RESPONSE';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const safe = (error: unknown) => { assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE/); return true; };
async function fake(runFetch: (url: URL, init: RequestInit) => Response | Promise<Response>, work: (client: HindsightClient) => Promise<void>, budget = 1000) {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => runFetch(new URL(String(input)), init ?? {});
    try { await work(new HindsightClient('http://synthetic.invalid/SYNTHETIC_PRIVATE_PATH', budget)); }
    finally { globalThis.fetch = original; }
}
const stats = () => ({ bank_id: bank, total_nodes: 5, total_documents: 1, nodes_by_fact_type: { world: 2, experience: 1, observation: 2 },
    total_observations: 2, pending_consolidation: 1, failed_consolidation: 0, last_memory_write_at: time, last_consolidated_at: time });
const status = () => ({ operation_id: op, operation_type: 'consolidation', task_type: 'consolidation', id: op, status: 'completed',
    created_at: time, updated_at: time, completed_at: time, next_retry_at: null, retry_count: 0, mental_model_id: null, details: null });

test('独立观察fresh stats读取完整计数及微秒时标，不把缺失/矛盾证据当零', async () => {
    await fake(url => { assert.equal(url.searchParams.get('refresh'), 'true'); return json(stats()); }, async client => {
        const got = await client.repairObservationStats(bank);
        assert.equal(got.total_observations, 2); assert.equal(got.last_consolidated_at, time); assert.equal(got.last_memory_write_at, time);
        assert.deepEqual(got.nodes_by_fact_type, { world: 2, experience: 1, observation: 2 });
    });
});

test('consolidation单任务状态不套用retain父children要求，不冒充全链完成', async () => {
    await fake(() => json(status()), async client => {
        const got = await client.repairConsolidationStatus(bank, op);
        assert.equal(got.status, 'completed'); assert.equal(got.operation_type, 'consolidation'); assert.equal('chain_completed' in got, false);
        assert.equal(got.completed_at, time);
    });
});

test('观察计数/时标/银行畸形或缺字段均安全拒绝，合法空库明确零计数可读', async () => {
    const good = stats();
    for (const body of [null, [], { ...good, bank_id: privateMarker }, { ...good, total_observations: 3 },
        { ...good, total_nodes: 6 }, { ...good, total_documents: -1 }, { ...good, total_documents: Number.MAX_SAFE_INTEGER + 1 },
        { ...good, pending_consolidation: 0.5 }, { ...good, pending_consolidation: 4 }, { ...good, failed_consolidation: -1 },
        { ...good, nodes_by_fact_type: { world: '2', experience: 1, observation: 2 } }, { ...good, last_memory_write_at: undefined },
        { ...good, last_consolidated_at: undefined }, { ...good, last_consolidated_at: '2026-02-30T00:00:00Z' }])
        await fake(() => json(body), client => assert.rejects(client.repairObservationStats(bank), safe));
    await fake(() => json({ bank_id: bank, total_nodes: 0, total_documents: 0, total_observations: 0, nodes_by_fact_type: {},
        pending_consolidation: 0, failed_consolidation: 0, last_memory_write_at: null, last_consolidated_at: null }), async client => {
        const got = await client.repairObservationStats(bank); assert.equal(got.total_nodes, 0); assert.equal(got.last_memory_write_at, null);
    });
    await fake(() => json({ message: privateMarker }, 503), client => assert.rejects(client.repairObservationStats(bank), safe));
    await fake(() => json({ message: privateMarker }, 404), client => assert.rejects(client.repairObservationStats(bank), safe));
});

test('consolidation状态拒错UUID/任务类型/父子伪装/坏终态日期，保留failed cancelled及退避事实', async () => {
    const good = status();
    for (const body of [null, { ...good, operation_id: privateMarker }, { ...good, id: '22222222-2222-4222-8222-222222222222' },
        { ...good, operation_type: 'retain' }, { ...good, task_type: 'refresh_mental_model' }, { ...good, status: 'SYNTHETIC_PRIVATE_INVALID' },
        { ...good, child_operations: [{ operation_id: op, status: 'processing' }] }, { ...good, details: { outcome: privateMarker } },
        { ...good, mental_model_id: 'relationship' }, { ...good, completed_at: null }, { ...good, updated_at: '2026-02-30T00:00:00Z' },
        { ...good, retry_count: -1 }, { ...good, retry_count: undefined }, { ...good, next_retry_at: privateMarker }])
        await fake(() => json(body), client => assert.rejects(client.repairConsolidationStatus(bank, op), safe));
    for (const state of ['pending', 'processing', 'failed', 'cancelled'] as const)
        await fake(() => json({ ...good, status: state, completed_at: state === 'pending' || state === 'processing' ? null : time,
            next_retry_at: time, retry_count: 2, error_message: privateMarker }), async client => {
            const got = await client.repairConsolidationStatus(bank, op); assert.equal(got.status, state); assert.equal(got.next_retry_at, time);
            assert.equal('error_message' in got, false); assert.equal('result_metadata' in got, false);
        });
    await fake(() => json({ operation_id: op, status: 'not_found', operation_type: null, task_type: null }), async client => {
        assert.equal((await client.repairConsolidationStatus(bank, op)).status, 'not_found');
    });
    await fake(() => json({ message: privateMarker }, 404), async client => assert.equal((await client.repairConsolidationStatus(bank, op)).status, 'not_found'));
});

test('首轮completed后仍全分页发现第101个consolidation后继及failed cancelled任务', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    await fake(url => {
        if (url.pathname.endsWith(`/operations/${op}`)) return json(status());
        assert.equal(url.searchParams.get('exclude_parents'), 'false'); assert.equal(url.searchParams.get('type'), null);
        const state = url.searchParams.get('status')!, offset = Number(url.searchParams.get('offset'));
        const total = state === 'pending' ? 101 : state === 'processing' ? 0 : 1;
        const operations = Array.from({ length: Math.min(100, total - offset) }, (_, n) => ({ operation_id: id((state === 'failed' ? 1000 : state === 'cancelled' ? 2000 : 0) + offset + n),
            task_type: offset === 100 ? 'consolidation' : 'retain', status: state, mental_model_id: null }));
        return json({ bank_id: bank, total, offset, limit: 100, operations });
    }, async client => {
        assert.equal((await client.repairConsolidationStatus(bank, op)).status, 'completed');
        const active = await client.repairActiveOperations(bank);
        assert.equal(active.length, 103); assert.ok(active.some(row => row.task_type === 'consolidation'));
        assert.ok(active.some(row => row.status === 'failed')); assert.ok(active.some(row => row.status === 'cancelled'));
    });
});

test('观察读取永久挂fetch或挂响应流会按截止返回，错误不含源正文/路径', async () => {
    let aborted = false;
    await fake((_url, init) => { init.signal?.addEventListener('abort', () => aborted = true); return new Promise<Response>(() => {}); },
        client => assert.rejects(client.repairObservationStats(bank), safe), 20);
    assert.equal(aborted, true);
    let cancelled = false;
    await fake(() => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel: () => { cancelled = true; } })),
        client => assert.rejects(client.repairConsolidationStatus(bank, op), safe), 20);
    assert.equal(cancelled, true);
});
