import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HindsightClient, type MemoryItem, type RetentionStatus } from '../src/memory/hindsight.ts';

const uuid = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const bank = 'SYNTHETIC_PRIVATE_BANK';
const secret = 'SYNTHETIC_PRIVATE_RESPONSE';
const item: MemoryItem = { document_id: 'synthetic-episode', content: 'synthetic replacement', timestamp: '2026-11-05T12:00:00Z', context: 'synthetic', tags: [], metadata: {} };
const receipt = () => ({ success: true, bank_id: bank, items_count: 1, async: true, operation_id: uuid, operation_ids: null, usage: null });
const status = (value: RetentionStatus = 'not_found') => ({ operation_id: uuid, status: value,
    operation_type: value === 'not_found' ? null : 'batch_retain',
    child_operations: value === 'completed' ? [{ operation_id: other, status: 'completed', sub_batch_index: 1, items_count: 1, error_message: null }] : null });
const listing = () => ({ bank_id: bank, total: 0, limit: 1, offset: 0, operations: [] });
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code });
type Fetcher = (url: URL, init: RequestInit) => Promise<Response> | Response;
async function fake<T>(fetcher: Fetcher, work: (client: HindsightClient) => Promise<T>, timeout = 1000) {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => fetcher(new URL(String(input)), init ?? {});
    try { return await work(new HindsightClient('http://synthetic.invalid/SYNTHETIC_PRIVATE_PATH', timeout)); }
    finally { globalThis.fetch = original; }
}
function submit(client: HindsightClient) {
    assert.equal(typeof client.submitRetain, 'function'); return client.submitRetain(bank, item, uuid);
}
function safe(error: unknown): boolean {
    assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE_(?:RESPONSE|PATH|BANK)/); return true;
}

test('retain提交完整协议：原UUID查询、六类旧backlog检查、单item receipt及POST正文', async () => {
    const queries: string[] = []; let posts = 0;
    await fake((url, init) => {
        if (init.method === 'POST') {
            posts++; assert.deepEqual(JSON.parse(String(init.body)), { items: [item], async: true, operation_id: uuid });
            return json(receipt());
        }
        if (url.pathname.endsWith('/' + uuid)) return json(status());
        assert.equal(url.searchParams.get('limit'), '1'); assert.equal(url.searchParams.get('offset'), '0');
        assert.equal(url.searchParams.get('exclude_parents'), 'false');
        queries.push(url.searchParams.get('status') + ':' + url.searchParams.get('type')); return json(listing());
    }, submit);
    assert.equal(posts, 1);
    assert.deepEqual(queries.sort(), ['pending', 'processing'].flatMap(s => ['retain', 'batch_retain', 'file_convert_retain'].map(t => `${s}:${t}`)).sort());
});

test('已存在同UUID各状态不重复POST，也不因旧backlog阻止确认原receipt', async () => {
    for (const state of ['pending', 'processing', 'completed', 'failed', 'cancelled'] as const) {
        let calls = 0;
        await fake((url, init) => { calls++; assert.equal(init.method, 'GET'); assert.ok(url.pathname.endsWith('/' + uuid)); return json(status(state)); }, submit);
        assert.equal(calls, 1);
    }
});

test('旧A退避pending或processing阻挡新B：六种任务组合均拒绝，total而非首行决定', async () => {
    for (const state of ['pending', 'processing']) for (const type of ['retain', 'batch_retain', 'file_convert_retain']) {
        let posts = 0;
        await fake((url, init) => {
            if (init.method === 'POST') { posts++; return json(receipt()); }
            if (url.pathname.endsWith('/' + uuid)) return json(status());
            // 服务端退避行也是pending；以total为准，不依赖只取一页的正文或created_at位置。
            const blocked = url.searchParams.get('status') === state && url.searchParams.get('type') === type;
            return json({ ...listing(), total: blocked ? 101 : 0, operations: blocked ? [{ id: other, operation_id: other,
                task_type: type, operation_type: type, status: state, next_retry_at: '2099-01-01T00:00:00Z' }] : [] });
        }, async client => { await assert.rejects(submit(client), safe); });
        assert.equal(posts, 0);
    }
});

test('不存在的bank列表404可视作无旧任务，之后仍能首次提交', async () => {
    let posts = 0;
    await fake((url, init) => {
        if (init.method === 'POST') { posts++; return json(receipt()); }
        if (url.pathname.endsWith('/' + uuid)) return json(status());
        return json({ detail: secret }, 404);
    }, submit);
    assert.equal(posts, 1);
});

test('retentionStatus严格身份和状态；completed必须有非空且全部completed的children', async () => {
    const invalid = [null, [], {}, { ...status(), operation_id: other }, { ...status(), status: 'surprise' },
        { ...status('completed'), child_operations: null }, { ...status('completed'), child_operations: [] },
        { ...status('completed'), child_operations: [{ status: 'processing' }] },
        { ...status('completed'), child_operations: [{ status: 'completed' }, { status: 'cancelled' }] }];
    for (const value of invalid) await fake(() => json(value), async client => {
        assert.equal(typeof client.retentionStatus, 'function'); await assert.rejects(client.retentionStatus(bank, uuid), safe);
    });
    for (const state of ['not_found', 'pending', 'processing', 'completed', 'failed', 'cancelled'] as const)
        await fake(() => json(status(state)), async client => assert.equal(await client.retentionStatus(bank, uuid), state));
});

test('提交receipt五字段和可选operation_ids不可信，畸形时安全失败不冒认成功', async () => {
    const invalid = [null, [], {}, { ...receipt(), success: false }, { ...receipt(), bank_id: secret },
        { ...receipt(), async: false }, { ...receipt(), items_count: 2 }, { ...receipt(), operation_id: other },
        { ...receipt(), operation_ids: [other] }, { ...receipt(), operation_ids: [uuid, other] },
        { ...receipt(), operation_ids: secret }];
    for (const value of invalid) await fake((url, init) => init.method === 'POST' ? json(value)
        : json(url.pathname.endsWith('/' + uuid) ? status() : listing()), async client => assert.rejects(submit(client), safe));
    await fake((url, init) => init.method === 'POST' ? json({ ...receipt(), operation_ids: [uuid] })
        : json(url.pathname.endsWith('/' + uuid) ? status() : listing()), submit);
});

test('旧任务查询畸形或真实服务错误不能当作空bank，私密正文与路径不进入错误', async () => {
    for (const response of [() => json({ ...listing(), total: -1 }), () => json({ ...listing(), total: 0.5 }),
        () => json({ detail: secret }, 500), () => new Response('{"' + secret), () => { throw new Error(secret); }]) {
        let posts = 0;
        await fake((url, init) => {
            if (init.method === 'POST') { posts++; return json(receipt()); }
            return url.pathname.endsWith('/' + uuid) ? json(status()) : response();
        }, async client => assert.rejects(submit(client), safe));
        assert.equal(posts, 0);
    }
});

test('整个submit共享一个deadline，不为每个GET重置预算后继续POST', async () => {
    let posts = 0;
    await fake(async (url, init) => {
        if (init.method === 'POST') { posts++; return json(receipt()); }
        await new Promise(resolve => setTimeout(resolve, 20));
        return json(url.pathname.endsWith('/' + uuid) ? status() : listing());
    }, async client => assert.rejects(submit(client), safe), 70);
    assert.equal(posts, 0);
});

test('忽略abort且永不返回的fetch也在submit deadline结束，不继续POST', async () => {
    let calls = 0;
    await fake(() => { calls++; return new Promise<Response>(() => {}); }, async client => {
        const result = await Promise.race([submit(client).then(() => 'unexpected', error => { safe(error); return 'timeout'; }),
            new Promise<string>(resolve => { const timer = setTimeout(() => resolve('hung'), 1000); timer.unref(); })]);
        assert.equal(result, 'timeout');
    }, 30);
    assert.equal(calls, 1);
});
