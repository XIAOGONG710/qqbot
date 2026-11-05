import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HindsightClient, type HindsightApi, type MemoryItem, type RetentionStatus } from '../src/memory/hindsight.ts';
import { LongTermMemory } from '../src/memory/long-term.ts';
import { WrittenRetainStore, WRITTEN_RETAIN_FILE, WRITTEN_RETAIN_MARKER } from '../src/memory/written-retain.ts';
import { DerivedState } from '../src/memory/derived-state.ts';
import { fileOps } from '../src/memory/json-file.ts';

const day = new Date('2026-11-04T12:00:00+08:00'), date = '2026-11-04', char = 'Synthetic Character';
const UUID = '11111111-1111-4111-8111-111111111111', SECOND = '22222222-2222-4222-8222-222222222222';
const secret = 'SYNTHETIC_PRIVATE_WRITTEN_BODY';
const json = (v: unknown) => new Response(JSON.stringify(v));
async function fixture(work: (f: { dir: string; create(): LongTermMemory; statuses: Map<string, RetentionStatus>; posts: { operation: string; item: MemoryItem }[]; logs: string[];
    holdPost(callback: () => Promise<void>): void; holdBacklog(callback: () => Promise<void>): void }) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-written-retain-')), original = globalThis.fetch;
    const statuses = new Map<string, RetentionStatus>(), posts: { operation: string; item: MemoryItem }[] = [], logs: string[] = [], memories: LongTermMemory[] = [];
    let held: (() => Promise<void>) | undefined;
    let heldBacklog: (() => Promise<void>) | undefined;
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input)), bank = url.pathname.split('/banks/')[1]?.split('/')[0];
        if (init?.method === 'PUT') return json({});
        if (url.pathname.endsWith('/memories/recall')) return json({ results: [
            { id: 'raw', text: 'SAFE_RAW_COMMON', type: 'world', document_id: '2222222222222222:ep-1', mentioned_at: day.toISOString() },
            { id: 'diary', text: 'BAD_DIARY_DERIVED', type: 'experience', document_id: `diary:${date}`, mentioned_at: day.toISOString() },
            { id: 'obs', text: 'BAD_OBSERVATION_DERIVED', type: 'observation', mentioned_at: day.toISOString() },
        ] });
        if (url.pathname.endsWith('/memories') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)), operation = body.operation_id;
            posts.push({ operation, item: body.items[0] }); statuses.set(operation, 'pending'); if (held) await held();
            return json({ success: true, async: true, bank_id: bank, items_count: 1, operation_id: operation });
        }
        if (url.pathname.endsWith('/operations')) { if (heldBacklog) await heldBacklog(); return json({ bank_id: bank, operations: [], total: 0 }); }
        const id = url.pathname.split('/operations/')[1];
        if (id) { const status = statuses.get(id) ?? 'not_found'; return json({ operation_id: id, status, operation_type: status === 'not_found' ? null : 'batch_retain',
            ...(status === 'completed' ? { child_operations: [{ operation_id: SECOND, status: 'completed' }] } : {}) }); }
        throw new Error('unexpected synthetic route');
    };
    const create = () => { const memory = new LongTermMemory({ dir, api: new HindsightClient('http://synthetic.invalid', 1000), bankPrefix: 'synthetic',
        recallTimeoutMs: 100, common: true, log: text => logs.push(text) }); memories.push(memory); return memory; };
    try { await work({ dir, create, statuses, posts, logs, holdPost(callback) { held = callback; }, holdBacklog(callback) { heldBacklog = callback; } }); }
    finally { for (const memory of memories) await memory.stop(); globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('真实SDK异步accepted不算日记完成，跨重启保留UUID与原文，completed才true', async () => fixture(async f => {
    const first = f.create(); assert.equal(await first.retainDiary(date, day, secret, char, { operationId: UUID }), false);
    assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.operation, UUID);
    const state = JSON.parse(readFileSync(join(f.dir, WRITTEN_RETAIN_FILE), 'utf8'));
    assert.equal(state.operations[UUID].phase, 'dispatched'); assert.ok(existsSync(join(f.dir, WRITTEN_RETAIN_MARKER)));
    await first.stop(); f.statuses.set(UUID, 'completed');
    const restarted = f.create(); assert.equal(await restarted.retainDiary(date, day, secret, char, { operationId: UUID }), true);
    assert.equal(f.posts.length, 1); assert.equal(JSON.parse(readFileSync(join(f.dir, WRITTEN_RETAIN_FILE), 'utf8')).operations[UUID].phase, 'completed');
}));

test('旧body pending不能让新body成功；旧completed后新正文另UUID单独等待完成', async () => fixture(async f => {
    const memory = f.create();
    assert.equal(await memory.retainDiary(date, day, 'old-body', char, { operationId: UUID }), false);
    assert.equal(await memory.retainDiary(date, day, 'new-body', char, { operationId: SECOND }), false); assert.equal(f.posts.length, 1);
    f.statuses.set(UUID, 'completed');
    assert.equal(await memory.retainDiary(date, day, 'new-body', char, { operationId: SECOND }), false);
    assert.equal(f.posts.length, 2); assert.equal(f.posts[1]!.operation, SECOND); assert.match(f.posts[1]!.item.content, /new-body$/);
    assert.equal(await memory.retainDiary(date, day, 'other-body', char, { operationId: SECOND }), false);
    f.statuses.set(SECOND, 'completed'); assert.equal(await memory.retainDiary(date, day, 'new-body', char, { operationId: SECOND }), true);
}));

test('failed cancelled和not_found变正文保屏障，同UUID原body not_found可幂等重投', async () => fixture(async f => {
    const memory = f.create(); await memory.retainSummary('week:2026-11-02', day, 'Title', 'old', char, 'week', { operationId: UUID });
    for (const status of ['failed', 'cancelled', 'not_found'] as const) {
        f.statuses.set(UUID, status);
        assert.equal(await memory.retainSummary('week:2026-11-02', day, 'Title', 'new', char, 'week', { operationId: SECOND }), false);
        assert.equal(f.posts.length, 1);
    }
    assert.equal(await memory.retainSummary('week:2026-11-02', day, 'Title', 'old', char, 'week', { operationId: UUID }), false);
    assert.equal(f.posts.length, 2); assert.equal(f.posts[1]!.operation, UUID);
}));

test('同文档并发串行只派一次，stop等已发HTTP ACK但不把pending当完成', async () => fixture(async f => {
    let release!: () => void; const held = new Promise<void>(resolve => release = resolve); f.holdPost(() => held);
    const memory = f.create(), first = memory.retainDiary(date, day, secret, char, { operationId: UUID });
    const second = memory.retainDiary(date, day, secret, char, { operationId: UUID });
    while (!f.posts.length) await tick(); const drain = memory.stop(); assert.ok(drain);
    release(); assert.deepEqual(await Promise.all([first, second]), [false, false]); await drain;
    assert.equal(f.posts.length, 1); assert.equal(JSON.parse(readFileSync(join(f.dir, WRITTEN_RETAIN_FILE), 'utf8')).operations[UUID].phase, 'dispatched');
    f.statuses.set(UUID, 'completed'); assert.equal(await f.create().retainDiary(date, day, secret, char, { operationId: UUID }), true);
}));

test('source blocker无QQ归属仍持久生效，dirty时query-only可结旧ACK但不能新派发', async () => fixture(async f => {
    const memory = f.create(); await memory.retainDiary(date, day, secret, char, { operationId: UUID });
    memory.noteWrittenSourceChanged(`diary:${date}`); assert.equal(memory.derivedAvailable(), false);
    f.statuses.set(UUID, 'completed');
    assert.equal(await memory.retainDiary(date, day, secret, char, { operationId: UUID, allowSubmit: false }), true);
    assert.equal(await memory.retainDiary(date, day, 'new', char, { operationId: SECOND }), false); assert.equal(f.posts.length, 1);
    assert.equal(f.create().derivedAvailable(), false);
    assert.equal(await f.create().readDiary(date), undefined);
    const recalled = await memory.recallCommon({ qq: 10001, tier: 'boyfriend', name: 'Synthetic User' }, [{ role: 'user', content: '合成查询' }], day, []);
    assert.ok(recalled?.includes('SAFE_RAW_COMMON')); assert.doesNotMatch(recalled!, /BAD_DIARY|BAD_OBSERVATION/);
    assert.equal(f.logs.some(line => line.includes(secret)), false);
}));

test('存在advanced pending时不能降级legacy接口重发；旧无pending fake保既有完成契约', async () => fixture(async f => {
    const first = f.create(); await first.retainDiary(date, day, secret, char, { operationId: UUID });
    let legacyWrites = 0;
    const legacy: HindsightApi = { putBank: async () => {}, retain: async () => { legacyWrites++; }, recall: async () => [], getMentalModel: async () => undefined,
        createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '' };
    const memory = new LongTermMemory({ dir: f.dir, api: legacy, bankPrefix: 'synthetic', recallTimeoutMs: 100, common: true, log() {} });
    try {
        assert.equal(await memory.retainDiary(date, day, secret, char), false); assert.equal(legacyWrites, 0);
        assert.equal(await memory.retainDiary('2026-11-03', day, 'legacy new document', char), true); assert.equal(legacyWrites, 1);
    } finally { await memory.stop(); }
}));

test('completed checkpoint发布前或发布后EIO均不重发RPC，恢复仍按原UUID确认', async () => {
    for (const afterPublish of [false, true]) await fixture(async f => {
        const memory = f.create(); await memory.retainDiary(date, day, secret, char, { operationId: UUID }); f.statuses.set(UUID, 'completed');
        const original = fileOps.renameSync, delays = fileOps.writeDelaysMs; fileOps.writeDelaysMs = [0];
        try {
            fileOps.renameSync = ((from, to) => {
                if (String(to).endsWith(WRITTEN_RETAIN_FILE)) {
                    const next = JSON.parse(readFileSync(from, 'utf8'));
                    if (next.operations[UUID]?.phase === 'completed') { if (afterPublish) original(from, to); throw Object.assign(new Error(secret), { code: 'EIO' }); }
                }
                return original(from, to);
            }) as typeof original;
            assert.equal(await memory.retainDiary(date, day, secret, char, { operationId: UUID }), afterPublish);
            fileOps.renameSync = original;
            assert.equal(await f.create().retainDiary(date, day, secret, char, { operationId: UUID }), true); assert.equal(f.posts.length, 1);
        } finally { fileOps.renameSync = original; fileOps.writeDelaysMs = delays; }
    });
});

test('standalone outbox只读不污染DerivedState初始化见证；坏JSON及marker丢JSON保原且无派发', async () => fixture(async f => {
    const store = new WrittenRetainStore(f.dir); assert.deepEqual(store.snapshot().operations, {});
    assert.equal(new DerivedState(f.dir).snapshot('synthetic-common').dirty, false);
    const memory = f.create(); await memory.retainDiary(date, day, secret, char, { operationId: UUID });
    const path = join(f.dir, WRITTEN_RETAIN_FILE), before = readFileSync(path, 'utf8');
    writeFileSync(path, '{"SYNTHETIC_PRIVATE_BROKEN"');
    assert.equal(await memory.retainDiary(date, day, secret, char, { operationId: UUID }), false); assert.equal(f.posts.length, 1);
    assert.equal(readFileSync(path, 'utf8'), '{"SYNTHETIC_PRIVATE_BROKEN"');
    writeFileSync(path, before); unlinkSync(path);
    assert.equal(await memory.retainDiary(date, day, secret, char, { operationId: UUID }), false); assert.equal(existsSync(path), false); assert.equal(f.posts.length, 1);
}));

test('outbox发布前IO失败不派发，source dirty观察IO失败后RAM仍挡读且恢复可flush', async () => fixture(async f => {
    const original = fileOps.renameSync, delays = fileOps.writeDelaysMs; fileOps.writeDelaysMs = [0];
    try {
        fileOps.renameSync = ((from, to) => { if (String(to).endsWith(WRITTEN_RETAIN_FILE)) throw Object.assign(new Error(secret), { code: 'EIO' }); return original(from, to); }) as typeof original;
        const memory = f.create(); assert.equal(await memory.retainDiary(date, day, secret, char, { operationId: UUID }), false); assert.equal(f.posts.length, 0);
        assert.throws(() => memory.noteWrittenSourceChanged(`diary:${date}`), e => e instanceof Error && !e.message.includes(secret));
        assert.equal(memory.derivedAvailable(), false);
        fileOps.renameSync = original; assert.equal(memory.derivedAvailable(), false);
        assert.deepEqual(new WrittenRetainStore(f.dir).blockedDocuments('synthetic-common'), [`diary:${date}`]);
    } finally { fileOps.renameSync = original; fileOps.writeDelaysMs = delays; }
}));

test('真实SDK内部backlog预查等待时源变，最后POST前fresh guard阻止旧body外发', async () => fixture(async f => {
    let release!: () => void, entered = false, valid = true;
    const held = new Promise<void>(resolve => release = resolve); f.holdBacklog(async () => { entered = true; await held; });
    const memory = f.create();
    const request = memory.retainDiary(date, day, secret, char, { operationId: UUID, canSubmit: () => {
        if (!valid) { memory.noteWrittenSourceChanged(`diary:${date}`); return false; } return true;
    } });
    try {
        while (!entered) await tick(); valid = false; release();
        assert.equal(await request, false); assert.equal(f.posts.length, 0); assert.equal(memory.derivedAvailable(), false);
        assert.equal(await memory.retainDiary(date, day, secret, char, { operationId: UUID, allowSubmit: false }), false);
        assert.equal(f.posts.length, 0);
    } finally { release(); await request; }
}));

test('source读取guard永久挂起可由stop取消，不阻drain或发出未派正文', async () => fixture(async f => {
    let entered = false; let sourceSignal: AbortSignal | undefined;
    const memory = f.create();
    const pending = memory.retainDiary(date, day, secret, char, { operationId: UUID, canSubmit: signal => { entered = true; sourceSignal = signal; return new Promise<boolean>(() => {}); } });
    while (!entered) await tick();
    const drain = memory.stop(); assert.ok(drain); await drain;
    assert.equal(await pending, false); assert.equal(f.posts.length, 0); assert.equal(sourceSignal?.aborted, true);
}));

test('SDK异步final guard沿用提交总deadline并abort，guard错误不回显私密正文', async () => fixture(async f => {
    const item: MemoryItem = { content: secret, context: 'synthetic', timestamp: day.toISOString(), document_id: `diary:${date}`, tags: ['diary'], metadata: {} };
    let aborted = false;
    await assert.rejects(new HindsightClient('http://synthetic.invalid', 25).submitRetain('synthetic-common', item, UUID, { canSubmit: signal => {
        signal.addEventListener('abort', () => aborted = true); return new Promise<boolean>(() => {});
    } }), /超时/);
    assert.equal(aborted, true); assert.equal(f.posts.length, 0);
    await assert.rejects(new HindsightClient('http://synthetic.invalid', 1000).submitRetain('synthetic-common', item, UUID, { canSubmit: () => { throw new Error(secret); } }),
        error => error instanceof Error && !error.message.includes(secret));
    assert.equal(f.posts.length, 0);
    // The writer's source read must receive the SDK budget cancellation through
    // LongTerm as well; cancelling only the outer SDK promise is insufficient.
    let checks = 0; let sourceSignal: AbortSignal | undefined;
    const memory = f.create();
    assert.equal(await memory.retainDiary(date, day, secret, char, { operationId: UUID, canSubmit: signal => {
        checks++; if (checks < 4) return true;
        sourceSignal = signal; return new Promise<boolean>(() => {});
    } }), false);
    assert.equal(sourceSignal?.aborted, true); assert.equal(f.posts.length, 0);
}));
