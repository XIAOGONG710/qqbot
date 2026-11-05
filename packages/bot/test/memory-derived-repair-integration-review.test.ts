import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LongTermMemory, RELATIONSHIP_MODEL } from '../src/memory/long-term.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { DerivedState } from '../src/memory/derived-state.ts';
import { localDate } from '../src/local-date.ts';
import { isSafeRepairModel, repairModelConfigHash, repairDocumentContentHash, type HindsightApi, type DerivedRepairApi, type RepairModelEvidence, type MemoryItem } from '../src/memory/hindsight.ts';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-repair-integration-')); rmSync(dir, { recursive: true, force: true }); } });
const contact = { qq: 10001, tier: 'classmate' }, names = { char: 'Synthetic Character', user: 'Synthetic User' };
const now = Date.parse('2026-11-05T12:30:00Z'), watermark = '2026-11-05T12:00:00.000001Z';
const old = 'SYNTHETIC_WITHDRAWN_MODEL', fresh = 'SYNTHETIC_REBUILT_MODEL';
const tick = () => new Promise<void>(done => setImmediate(done));
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check()) { assert.ok(Date.now() < end, 'synthetic timeout'); await tick(); } }
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-repair-integration-')); roots.push(dir);
    const history = new ChatHistory(dir), docs = new Map<string, MemoryItem>(), models = new Map<string, RepairModelEvidence>();
    const calls: string[] = []; let completed = false, retention: 'completed' | 'pending' | 'not_found' = 'completed';
    const api: HindsightApi & DerivedRepairApi = {
        putBank: async () => {}, retain: async () => {}, submitRetain: async (bank, item) => { calls.push('retain'); docs.set(`${bank}/${item.document_id}`, structuredClone(item)); }, retentionStatus: async () => retention,
        recall: async () => [],
        getMentalModel: async (bank, id) => models.get(`${bank}/${id}`),
        createMentalModel: async (bank, request) => { models.set(`${bank}/${request.id}`, { ...structuredClone(request), bank_id: bank, content: old, is_stale: false,
            safe_configuration: true, configuration_hash: '', last_memory_seen_at: watermark, last_refreshed_at: watermark }); },
        updateMentalModel: async (bank, id, request) => { Object.assign(models.get(`${bank}/${id}`)!, structuredClone(request)); }, refreshMentalModel: async () => '',
        repairStats: async () => ({ pending_consolidation: 0, failed_consolidation: 0, last_memory_write_at: watermark }), repairActiveOperations: async () => [],
        repairDocuments: async bank => [...docs.entries()].filter(([key]) => key.startsWith(`${bank}/`)).map(([, item]) => ({ id: item.document_id!, bank_id: bank, content_hash: repairDocumentContentHash(item.content), tags: item.tags! })),
        repairModels: async bank => [...models.values()].filter(model => model.bank_id === bank).map(model => ({ id: model.id, bank_id: bank, name: model.name, tags: model.tags, last_memory_seen_at: model.last_memory_seen_at, last_refreshed_at: model.last_refreshed_at })),
        repairModel: async (bank, id) => structuredClone(models.get(`${bank}/${id}`)!),
        repairConfigureModel: async (bank, id) => configure(bank, id, false),
        repairClearModel: async (bank, id) => { calls.push('clear'); const model = models.get(`${bank}/${id}`)!; model.content = ''; return structuredClone(model); },
        repairRefreshModel: async () => { calls.push('refresh'); return randomUUID(); },
        repairRefreshOperation: async (bank, id) => { if (completed) { const model = models.get(`${bank}/relationship`)!; model.content = fresh; model.last_refreshed_at = '2026-11-05T13:00:00Z'; }
            return { operation_id: id, operation_type: 'refresh_mental_model', mental_model_id: 'relationship', status: completed ? 'completed' : 'pending', outcome: completed ? 'content_written' : null }; },
        repairRestoreAutomatic: async (bank, id, cadence, enabled = true) => configure(bank, id, enabled, cadence),
    };
    function configure(bank: string, id: string, enabled: boolean, cadence = 1800) {
        const model = models.get(`${bank}/${id}`)!; model.trigger = { ...structuredClone(RELATIONSHIP_MODEL.trigger), refresh_after_consolidation: enabled, min_refresh_interval_seconds: cadence };
        model.safe_configuration = isSafeRepairModel(model); model.configuration_hash = repairModelConfigHash(model); return structuredClone(model);
    }
    const make = () => new LongTermMemory({ api, dir, common: true, bankPrefix: 'synthetic', recallTimeoutMs: 100, now: () => now, log() {} });
    const memory = make(), store = new DerivedState(dir);
    for (let i = 0; i < 30; i++) history.append(contact.qq, { role: 'user', time: new Date(now - 900_000 + i * 1000).toISOString(), content: i === 15 ? old : `synthetic ${i}`, messageId: i + 1 });
    const sync = (instance = memory) => instance.sync(contact, names, history.load(contact.qq));
    const recall = (id = 16, instance = memory) => { assert.equal(history.recall(contact.qq, id), true); instance.noteRecall(contact, history.load(contact.qq)); };
    return { dir, api, history, models, docs, calls, memory, store, sync, recall, make, complete: () => { completed = true; }, retention: (value: typeof retention) => { retention = value; } };
}

test('实际LongTerm自动修复私人关系，公共继续保护；重启与重复已处理撤回不再污染', async () => {
    const f = fixture(); let restart: LongTermMemory | undefined;
    try {
        await f.sync(); f.memory.relationship(contact); await tick(); await tick(); assert.ok(f.memory.relationship(contact)?.includes(old));
        f.recall(); await f.sync(); assert.equal(f.memory.relationship(contact), undefined);
        assert.equal(f.store.snapshot(f.memory.bankId(contact)).repair?.phase, 'refresh-pending');
        assert.equal(f.calls.filter(call => call === 'refresh').length, 1);
        await f.memory.stop(); restart = f.make(); f.complete(); await f.sync(restart);
        assert.equal(f.store.snapshot(restart.bankId(contact)).dirty, false); assert.equal(f.store.snapshot(restart.commonBankId()).dirty, true);
        restart.relationship(contact); await tick(); await tick(); assert.ok(restart.relationship(contact)?.includes(fresh)); assert.ok(!restart.relationship(contact)?.includes(old));
        const generation = f.store.snapshot(restart.bankId(contact)).generation;
        restart.noteRecall(contact, f.history.load(contact.qq)); await f.sync(restart);
        assert.equal(f.store.snapshot(restart.bankId(contact)).generation, generation); assert.equal(f.calls.filter(call => call === 'refresh').length, 1);
        assert.ok(!readFileSync(join(f.dir, 'derived.json'), 'utf8').includes(old));
    } finally { await f.memory.stop(); await restart?.stop(); }
});

test('修复期间普通追加不改冻结来源，成功后继续正常写入；新撤回必须更新来源', async () => {
    const f = fixture();
    try {
        await f.sync(); f.recall(); await f.sync(); const before = f.calls.filter(call => call === 'retain').length;
        for (let i = 0; i < 30; i++) f.history.append(contact.qq, { role: 'user', time: new Date(now - 850_000 + i * 1000).toISOString(), content: `tail ${i}`, messageId: 31 + i });
        await f.sync(); assert.equal(f.calls.filter(call => call === 'retain').length, before);
        f.complete(); await f.sync(); assert.equal(f.store.snapshot(f.memory.bankId(contact)).dirty, false);
        await f.sync(); assert.equal(f.calls.filter(call => call === 'retain').length, before + 2);
        f.recall(17); assert.equal(f.store.snapshot(f.memory.bankId(contact)).dirty, true); await f.sync();
        assert.equal(f.store.snapshot(f.memory.bankId(contact)).dirty, false); assert.equal(f.calls.filter(call => call === 'refresh').length, 2);
    } finally { await f.memory.stop(); }
});

test('pending前缀未变而普通追加，不制造派生污染；not_found只重交原不可变前缀', async () => {
    const f = fixture();
    try {
        f.retention('pending'); await f.sync(); assert.equal(f.calls.filter(call => call === 'retain').length, 1);
        f.history.append(contact.qq, { role: 'user', time: new Date(now - 850_000).toISOString(), content: 'normal appended tail', messageId: 31 });
        f.retention('not_found'); await f.sync();
        assert.equal(f.calls.filter(call => call === 'retain').length, 2); assert.equal(f.store.snapshot(f.memory.bankId(contact)).dirty, false);
        f.recall(); await f.sync(); assert.equal(f.store.snapshot(f.memory.bankId(contact)).dirty, true); assert.equal(f.calls.filter(call => call === 'retain').length, 2);
    } finally { await f.memory.stop(); }
});

test('来源未知或完整文档目录不匹配，真实同步不清除保护', async () => {
    const f = fixture();
    try {
        await f.sync(); f.memory.noteRecall(contact); f.complete(); await f.sync();
        assert.equal(f.store.snapshot(f.memory.bankId(contact)).dirty, true); assert.ok(!f.calls.includes('clear'));
    } finally { await f.memory.stop(); }
});

test('另一实例已缓存旧关系，修复改变读取世代后不能复活旧缓存', async () => {
    const f = fixture(); let reader: LongTermMemory | undefined;
    try {
        await f.sync(); reader = f.make(); reader.relationship(contact); await tick(); await tick(); assert.ok(reader.relationship(contact)?.includes(old));
        f.recall(); await f.sync(); f.complete(); await f.sync();
        assert.equal(reader.relationship(contact), undefined); await tick(); await tick();
        assert.ok(reader.relationship(contact)?.includes(fresh)); assert.ok(!reader.relationship(contact)?.includes(old));
    } finally { await f.memory.stop(); await reader?.stop(); }
});

test('已派clear晚ACK归属stop drain，停止后不再派refresh，重启从确认点续跑', async () => {
    const f = fixture(); let release!: () => void, entered = false; const held = new Promise<void>(done => { release = done; });
    const clear = f.api.repairClearModel;
    f.api.repairClearModel = async (...args) => { const ack = await clear(...args); entered = true; await held; return ack; };
    let restarted: LongTermMemory | undefined;
    try {
        await f.sync(); f.recall(); const job = f.sync(); while (!entered) await tick();
        const drain = f.memory.stop(); assert.ok(drain instanceof Promise); let settled = false; void drain.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
        release(); await drain; await job; assert.equal(f.calls.filter(call => call === 'refresh').length, 0);
        assert.equal(f.store.snapshot(f.memory.bankId(contact)).repair?.phase, 'cleared');
        restarted = f.make(); f.complete(); await f.sync(restarted);
        assert.equal(f.store.snapshot(restarted.bankId(contact)).dirty, false); assert.equal(f.calls.filter(call => call === 'clear').length, 1);
    } finally { release(); await f.memory.stop(); await restarted?.stop(); }
});

test('额外未知远端文档不能因本地清单只含QQ片段而被清模型解封', async () => {
    const f = fixture();
    try {
        await f.sync(); const bank = f.memory.bankId(contact);
        f.docs.set(`${bank}/foreign-document`, { content: 'synthetic unknown source', document_id: 'foreign-document', tags: ['qq-private'], timestamp: watermark, context: 'synthetic', metadata: {} });
        f.recall(); f.complete(); await f.sync(); assert.equal(f.store.snapshot(bank).dirty, true); assert.ok(!f.calls.includes('clear'));
    } finally { await f.memory.stop(); }
});

test('关系重建收据不等于所有旧观察已净化：恢复原始事实但继续排除旧派生观察', async () => {
    const f = fixture();
    try {
        await f.sync(); f.recall(); f.complete(); await f.sync(); assert.equal(f.store.snapshot(f.memory.bankId(contact)).dirty, false);
        const item = [...f.docs.entries()].find(([key]) => key.startsWith(`${f.memory.bankId(contact)}/`))![1];
        f.api.recall = async () => [
            { id: 'old-observation', text: old, type: 'observation', document_id: item.document_id },
            { id: 'safe-fact', text: 'SYNTHETIC_SAFE_RAW_FACT', type: 'world', document_id: item.document_id },
        ];
        const result = await f.memory.recall(contact, [], new Date(now), { query: 'synthetic', ignore: [] });
        assert.ok(result?.includes('SYNTHETIC_SAFE_RAW_FACT')); assert.ok(!result?.includes(old));
    } finally { await f.memory.stop(); }
});

test('真实同步新撤回遇旧UUID刷新：先保持屏障，完成旧任务后独立重建新来源', async () => {
    const f = fixture();
    try {
        await f.sync(); f.recall(); await f.sync();
        const first = f.store.snapshot(f.memory.bankId(contact)); assert.equal(first.repair?.phase, 'refresh-pending');
        f.recall(17); await f.sync();
        assert.equal(f.store.snapshot(f.memory.bankId(contact)).dirty, true);
        assert.equal(f.calls.filter(call => call === 'refresh').length, 1);
        f.complete(); await f.sync();
        const final = f.store.snapshot(f.memory.bankId(contact));
        assert.equal(final.dirty, false); assert.notEqual(final.generation, first.generation);
        assert.equal(f.calls.filter(call => call === 'refresh').length, 2);
        assert.equal(f.calls.filter(call => call === 'clear').length, 2);
        const state = JSON.parse(readFileSync(join(f.dir, 'derived.json'), 'utf8'));
        const oldJournal = state.banks[f.memory.bankId(contact)].journals[first.repair!.lease.repairId];
        assert.ok(oldJournal.settlement); assert.equal(oldJournal.phase, 'refresh-pending');
        assert.ok(!readFileSync(join(f.dir, 'derived.json'), 'utf8').includes(old));
        f.memory.relationship(contact); await tick(); await tick(); assert.ok(f.memory.relationship(contact)?.includes(fresh));
        assert.equal(f.store.snapshot(f.memory.commonBankId()).dirty, true);
    } finally { await f.memory.stop(); }
});

test('新污染和旧UUID均跨重启持久，旧任务完成后继续新世代修复', async () => {
    const f = fixture(); let restart: LongTermMemory | undefined;
    try {
        await f.sync(); f.recall(); await f.sync(); f.recall(17); await f.sync(); await f.memory.stop();
        restart = f.make(); f.complete(); await f.sync(restart);
        assert.equal(f.store.snapshot(restart.bankId(contact)).dirty, false);
        assert.equal(f.calls.filter(call => call === 'refresh').length, 2);
        assert.equal(f.store.snapshot(restart.commonBankId()).dirty, true);
    } finally { await f.memory.stop(); await restart?.stop(); }
});

test('仲裁读取await期间再撤回，不确认陈旧世代；下一轮核对最新来源后重建', async () => {
    const f = fixture(); let entered = false, release!: () => void; const held = new Promise<void>(done => { release = done; });
    const query = f.api.repairRefreshOperation;
    try {
        await f.sync(); f.recall(); await f.sync(); f.recall(17); await f.sync(); f.complete();
        const before = f.store.snapshot(f.memory.bankId(contact));
        f.api.repairRefreshOperation = async (...args) => { const result = await query(...args); entered = true; await held; return result; };
        const job = f.sync(); await until(() => entered); f.recall(18); release(); await job;
        const stale = f.store.snapshot(f.memory.bankId(contact)); assert.equal(stale.dirty, true); assert.notEqual(stale.generation, before.generation);
        assert.equal(f.calls.filter(call => call === 'refresh').length, 1);
        f.api.repairRefreshOperation = query; await f.sync(); assert.equal(f.store.snapshot(f.memory.bankId(contact)).dirty, false);
        assert.equal(f.calls.filter(call => call === 'refresh').length, 2);
    } finally { release(); await f.memory.stop(); }
});

test('旧任务仲裁纯读不阻停止，晚返回不能发布settlement；重启重新核验', async () => {
    const f = fixture(); let restart: LongTermMemory | undefined, entered = false, release!: () => void;
    const held = new Promise<void>(done => { release = done; }), query = f.api.repairRefreshOperation;
    try {
        await f.sync(); f.recall(); await f.sync(); f.recall(17); await f.sync(); f.complete();
        const oldId = f.store.snapshot(f.memory.bankId(contact)).repair!.lease.repairId;
        f.api.repairRefreshOperation = async (...args) => { const result = await query(...args); entered = true; await held; return result; };
        const job = f.sync(); await until(() => entered); let drained = false;
        await Promise.resolve(f.memory.stop()).then(() => { drained = true; }); assert.equal(drained, true); await job;
        const read = () => JSON.parse(readFileSync(join(f.dir, 'derived.json'), 'utf8')).banks[f.memory.bankId(contact)].journals[oldId];
        assert.equal(read().settlement, undefined); release(); await tick(); assert.equal(read().settlement, undefined);
        f.api.repairRefreshOperation = query; restart = f.make(); await f.sync(restart);
        assert.equal(f.store.snapshot(restart.bankId(contact)).dirty, false);
    } finally { release(); await f.memory.stop(); await restart?.stop(); }
});

test('供应商复用旧刷新UUID不能以旧completed冒充新重建，保未知派发且不盲重试', async () => {
    const f = fixture(), refresh = f.api.repairRefreshModel, query = f.api.repairRefreshOperation;
    let firstId: string | undefined, previous: Awaited<ReturnType<typeof query>> | undefined;
    f.api.repairRefreshModel = async (...args) => { const id = await refresh(...args); return firstId ??= id; };
    f.api.repairRefreshOperation = async (...args) => {
        if (f.calls.filter(call => call === 'refresh').length > 1) { assert.ok(previous); return structuredClone(previous); }
        const result = await query(...args); if (result.status === 'completed') previous = structuredClone(result); return result;
    };
    try {
        await f.sync(); f.recall(); await f.sync(); f.recall(17); await f.sync(); f.complete(); await f.sync();
        const live = f.store.snapshot(f.memory.bankId(contact));
        assert.equal(live.dirty, true); assert.equal(live.repair?.phase, 'refresh-dispatched');
        assert.equal(live.repair?.evidence.refreshOperationId, undefined); assert.equal(f.memory.relationship(contact), undefined);
        assert.equal(f.models.get(`${f.memory.bankId(contact)}/relationship`)!.content, '');
        await f.sync(); assert.equal(f.calls.filter(call => call === 'refresh').length, 2);
        assert.equal(f.store.snapshot(f.memory.bankId(contact)).dirty, true);
    } finally { await f.memory.stop(); }
});

test('供应商不实日历不滚入另一查询窗口，合法mentioned日期仍可回退展示', async () => {
    const f = fixture();
    try {
        await f.sync(); f.api.recall = async () => [{ id: 'bad-calendar', type: 'world', text: '【重要】SYNTHETIC_BAD_CALENDAR', document_id: 'diary:2026-02-01', occurred_start: '2026-02-30T12:00:00Z', mentioned_at: '2026-02-01T12:00:00Z' }];
        const person = { ...contact, name: '合成甲' }, query = [{ role: 'user' as const, content: '合成日期查询' }];
        const wrong = await f.memory.recallCommon(person, query, new Date('2026-03-02T13:00:00Z'), [person], { start: new Date('2026-03-02T00:00:00Z'), end: new Date('2026-03-03T00:00:00Z') });
        assert.ok(!wrong?.includes('SYNTHETIC_BAD_CALENDAR'));
        const right = await f.memory.recallCommon(person, query, new Date('2026-02-01T13:00:00Z'), [person], { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-02-02T00:00:00Z') });
        assert.ok(right?.includes('SYNTHETIC_BAD_CALENDAR')); assert.ok(!right?.includes('3月2日'));
    } finally { await f.memory.stop(); }
});

test('真实日记窗口按Apia缺日的civil身份，不滚到exclusive end的31日', async () => {
    const previous = process.env.TZ; process.env.TZ = 'Pacific/Apia'; const f = fixture();
    try {
        await f.sync(); f.api.recall = async () => [{ id: 'missing-civil', type: 'world', text: '【重要】SYNTHETIC_APIA_DIARY', document_id: 'diary:2011-12-30' }];
        const person = { ...contact, name: '合成甲' };
        const result = await f.memory.recallCommon(person, [{ role: 'user', content: '那几天呢' }], localDate(2011, 11, 31, 12), [person], { start: localDate(2011, 11, 29), end: localDate(2011, 11, 31) });
        assert.ok(result?.includes('SYNTHETIC_APIA_DIARY'));
    } finally { await f.memory.stop(); if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
