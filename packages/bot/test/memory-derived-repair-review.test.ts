import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DerivedState } from '../src/memory/derived-state.ts';
import { DerivedRepair, type RepairApi } from '../src/memory/derived-repair.ts';
import { repairCompareTimestamps, repairModelIdentityHash, repairSourceManifestHash, type RepairCandidate } from '../src/memory/derived-repair-protocol.ts';
import { isSafeRepairModel, repairModelConfigHash, type RepairModelEvidence, type RepairRefreshOutcome } from '../src/memory/hindsight.ts';
import { fileOps } from '../src/memory/json-file.ts';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-derived-worker-')); rmSync(dir, { recursive: true, force: true }); } });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const WATERMARK = '2026-11-05T12:00:00.000Z', REFRESHED = '2026-11-05T13:00:00.000Z';
const PRIVATE_BODY = 'SYNTHETIC_RAW_MODEL_BODY_NOT_FOR_SHARED_JSON';
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(done => { release = done; }); return { promise, release }; }
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) assert.fail('synthetic timeout'); await new Promise(done => setImmediate(done)); } }
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-derived-worker-')); roots.push(dir);
    const owner = { qq: 10001, tier: 'boyfriend' }, bank = `synthetic-${hash(`qqbot:${owner.qq}-${owner.tier}`).slice(0, 16)}`, store = new DerivedState(dir);
    store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'synthetic-recall' });
    const sourceManifest = [{ documentId: 'ep-1', episodeDigest: hash('synthetic episode'), contentHash: hash('synthetic source'), count: 2 }];
    let model: RepairModelEvidence = { id: 'relationship', bank_id: bank, name: '关系概况', source_query: '合成安全关系查询', tags: ['qq-private'], content: PRIVATE_BODY,
        trigger: { refresh_after_consolidation: true, min_refresh_interval_seconds: 1800 }, safe_configuration: false, configuration_hash: '', is_stale: false, last_memory_seen_at: WATERMARK, last_refreshed_at: WATERMARK };
    model.configuration_hash = repairModelConfigHash(model);
    const initial = store.snapshot(bank);
    const candidate: RepairCandidate = { bankId: bank, owner, generation: initial.generation, eventSetHash: initial.eventSetHash, sourceManifest, sourceManifestHash: repairSourceManifestHash(sourceManifest),
        progressHash: hash('synthetic confirmed retain progress'), modelIdentityHash: repairModelIdentityHash(model), expectedAutomatic: true, expectedCadence: 1800 };
    const calls: string[] = []; let status: 'pending' | 'completed' = 'pending', outcome: RepairRefreshOutcome = 'content_written', operation = randomUUID();
    const documents = [{ id: 'ep-1', bank_id: bank, content_hash: sourceManifest[0]!.contentHash, tags: ['qq-private'] }];
    let unsafeJobs = false;
    function configured(automatic: boolean, cadence = 1800) {
        model.trigger = { mode: 'full', exclude_mental_models: true, fact_types: ['world', 'experience'], include_chunks: false, refresh_after_consolidation: automatic,
            refresh_cron: null, min_refresh_interval_seconds: cadence, tags_match: 'all_strict', tag_groups: [
                { tags: ['qq-private'], match: 'all_strict', resolve: 'exact' }, { not: { tags: ['diary', 'week', 'phase'], match: 'any_strict', resolve: 'exact' } },
            ] };
        model.configuration_hash = repairModelConfigHash(model); model.safe_configuration = isSafeRepairModel(model); return structuredClone(model);
    }
    const api: RepairApi = {
        repairStats: async () => { calls.push('stats'); return { pending_consolidation: 0, failed_consolidation: 0, last_memory_write_at: WATERMARK }; },
        repairActiveOperations: async () => { calls.push('jobs'); return unsafeJobs ? [{ operation_id: randomUUID(), task_type: 'refresh_mental_model', status: 'cancelled', mental_model_id: 'relationship' }] : []; },
        repairDocuments: async () => { calls.push('documents'); return structuredClone(documents); },
        repairModels: async () => { calls.push('models'); return [{ id: 'relationship', bank_id: bank, name: model.name, tags: ['qq-private'], last_memory_seen_at: model.last_memory_seen_at, last_refreshed_at: model.last_refreshed_at }]; },
        repairModel: async () => { calls.push('model'); return structuredClone(model); },
        repairConfigureModel: async () => { calls.push('configure'); return configured(false); },
        repairClearModel: async () => { calls.push('clear'); model.content = ''; return structuredClone(model); },
        repairRefreshModel: async () => { if (calls.includes('refresh')) operation = randomUUID(); calls.push('refresh'); return operation; },
        repairRefreshOperation: async () => { calls.push('operation'); if (status === 'completed') { model.content = '合成已重建关系'; model.last_refreshed_at = REFRESHED; } return { operation_id: operation, operation_type: 'refresh_mental_model', mental_model_id: 'relationship', status, outcome: status === 'completed' ? outcome : null }; },
        repairRestoreAutomatic: async (_bank, _id, cadence, automatic = true) => { calls.push('restore'); return configured(automatic, cadence); },
    };
    const current = () => { const live = store.snapshot(bank); return live.generation === candidate.generation && live.eventSetHash === candidate.eventSetHash; };
    const worker = () => new DerivedRepair({ api, store });
    return { dir, bank, owner, store, candidate, api, calls, documents, current, worker, configured, get operation() { return operation; },
        completed: (value: RepairRefreshOutcome = 'content_written') => { status = 'completed'; outcome = value; },
        unsafeJobs: () => { unsafeJobs = true; }, model: () => model };
}
async function superseded(f: ReturnType<typeof fixture>) {
    await f.worker().step(f.candidate, f.current);
    const lease = f.store.snapshot(f.bank).repair!.lease;
    f.store.mark(f.bank, { ...f.owner, documents: ['ep-1'], eventKey: `superseded:${randomUUID()}` });
    const live = f.store.snapshot(f.bank); f.candidate.generation = live.generation; f.candidate.eventSetHash = live.eventSetHash;
    return lease;
}

test('真实store持久分步：pending不解封，重启核对完成并恢复原auto，收据不含原始模型', async () => {
    const f = fixture(), first = f.worker(); assert.equal(await first.step(f.candidate, f.current), 'waiting');
    assert.equal(f.store.snapshot(f.bank).repair?.phase, 'refresh-pending'); assert.equal(f.store.snapshot(f.bank).dirty, true); assert.equal(first.stop(), undefined);
    f.completed(); const restarted = new DerivedRepair({ api: f.api, store: new DerivedState(f.dir) });
    assert.equal(await restarted.step(f.candidate, f.current), 'repaired'); assert.equal(f.store.snapshot(f.bank).dirty, false);
    for (const name of ['configure', 'clear', 'refresh', 'restore']) assert.equal(f.calls.filter(call => call === name).length, 1, name);
    assert.equal(f.model().trigger.refresh_after_consolidation, true); assert.equal(isSafeRepairModel(f.model(), true), true);
    assert.ok(!readFileSync(join(f.dir, 'derived.json'), 'utf8').includes(PRIVATE_BODY));
});

test('completed保留旧内容不是重建成功，未知或取消旧job不算quiescent', async () => {
    const f = fixture(); await f.worker().step(f.candidate, f.current); f.completed('content_preserved_no_new_facts');
    assert.equal(await f.worker().step(f.candidate, f.current), 'blocked'); assert.equal(f.store.snapshot(f.bank).dirty, true); assert.ok(!f.calls.includes('restore'));
    const g = fixture(); g.unsafeJobs(); assert.equal(await g.worker().step(g.candidate, g.current), 'waiting'); assert.ok(!g.calls.includes('configure'));
});

test('refresh丢ACK无UUID保留durable uncertain，重启不盲重发', async () => {
    const f = fixture(); f.api.repairRefreshModel = async () => { f.calls.push('refresh'); throw new Error('SECRET_PROVIDER_BODY'); };
    assert.equal(await f.worker().step(f.candidate, f.current), 'unavailable'); assert.equal(f.store.snapshot(f.bank).repair?.phase, 'refresh-dispatched');
    assert.equal(await f.worker().step(f.candidate, f.current), 'blocked'); assert.equal(f.calls.filter(name => name === 'refresh').length, 1);
    assert.ok(!readFileSync(join(f.dir, 'derived.json'), 'utf8').includes('SECRET_PROVIDER_BODY'));
});

test('stop只等待已派clear ACK和检查点，恢复续跑不重清，纯读不持drain', async () => {
    const f = fixture(), held = gate<RepairModelEvidence>(); f.api.repairClearModel = async () => { f.calls.push('clear'); f.model().content = ''; return held.promise; };
    const worker = f.worker(), job = worker.step(f.candidate, f.current); await until(() => f.calls.includes('clear'));
    const drain = worker.stop(); assert.ok(drain instanceof Promise); assert.equal(worker.stop(), drain); held.release(structuredClone(f.model())); await drain; await job;
    assert.equal(f.store.snapshot(f.bank).repair?.phase, 'cleared'); assert.ok(!f.calls.includes('refresh'));
    await f.worker().step(f.candidate, f.current); assert.equal(f.calls.filter(name => name === 'clear').length, 1);
    const g = fixture(), read = gate<Awaited<ReturnType<RepairApi['repairStats']>>>(); g.api.repairStats = () => read.promise;
    const pure = g.worker(), reading = pure.step(g.candidate, g.current); assert.equal(pure.stop(), undefined); assert.equal(await reading, 'stopped');
    read.release({ pending_consolidation: 0, failed_consolidation: 0, last_memory_write_at: WATERMARK });
});

test('新dirty撤销旧lease但保已派refresh UUID检查点，不能恢复或解封新观察', async () => {
    const f = fixture(), held = gate<string>(); f.api.repairRefreshModel = async () => { f.calls.push('refresh'); return held.promise; };
    const worker = f.worker(), job = worker.step(f.candidate, f.current); await until(() => f.calls.includes('refresh'));
    const repairId = f.store.snapshot(f.bank).repair!.lease.repairId;
    f.store.mark(f.bank, { ...f.owner, documents: ['ep-1'], eventKey: 'synthetic-new-recall' }); held.release(f.operation); await job;
    const disk = JSON.parse(readFileSync(join(f.dir, 'derived.json'), 'utf8'));
    assert.equal(disk.banks[f.bank].journals[repairId].evidence.refreshOperationId, f.operation);
    assert.equal(f.store.snapshot(f.bank).dirty, true); assert.ok(!f.calls.includes('restore'));
});

test('完整目录不匹配、公共bank及未知全owner证据不会开始破坏性修复', async () => {
    const f = fixture(); f.documents.push({ id: 'diary:2026-11-05', bank_id: f.bank, content_hash: hash('unknown'), tags: ['qq-private', 'diary'] });
    assert.equal(await f.worker().step(f.candidate, f.current), 'waiting'); assert.ok(!f.calls.includes('configure'));
    assert.equal(await f.worker().step({ ...f.candidate, bankId: 'synthetic-common' }, () => true), 'blocked');
    const g = fixture(); g.store.mark(g.bank, { ...g.owner, eventKey: 'unknown-owner-docs' }); const live = g.store.snapshot(g.bank);
    assert.equal(await g.worker().step({ ...g.candidate, generation: live.generation, eventSetHash: live.eventSetHash }, () => true), 'blocked'); assert.equal(g.calls.length, 0);
});

test('restore丢ACK只读回确认，不重复PATCH；最终水位变化保持dirty', async () => {
    const f = fixture(); await f.worker().step(f.candidate, f.current); f.completed();
    f.api.repairRestoreAutomatic = async () => { f.calls.push('restore'); f.configured(true); throw new Error('lost ack'); };
    assert.equal(await f.worker().step(f.candidate, f.current), 'unavailable'); assert.equal(f.store.snapshot(f.bank).repair?.phase, 'restore-dispatched');
    assert.equal(await f.worker().step(f.candidate, f.current), 'repaired'); assert.equal(f.calls.filter(name => name === 'restore').length, 1);
    const g = fixture(); await g.worker().step(g.candidate, g.current); g.completed();
    g.api.repairStats = async () => ({ pending_consolidation: 0, failed_consolidation: 0, last_memory_write_at: REFRESHED });
    assert.equal(await g.worker().step(g.candidate, g.current), 'blocked'); assert.equal(g.store.snapshot(g.bank).dirty, true);
});

test('提交UUID检查点EIO不能把已发refresh变成可重发，恢复只保持屏障', async () => {
    const f = fixture(), rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    f.api.repairRefreshModel = async () => {
        f.calls.push('refresh'); fileOps.writeDelaysMs = [0]; fileOps.renameSync = (from, to) => {
            if (String(to) === join(f.dir, 'derived.json')) throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' }); return rename(from, to);
        }; return f.operation;
    };
    try { assert.equal(await f.worker().step(f.candidate, f.current), 'unavailable'); }
    finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
    assert.equal(await f.worker().step(f.candidate, f.current), 'blocked'); assert.equal(f.calls.filter(name => name === 'refresh').length, 1); assert.equal(f.store.snapshot(f.bank).dirty, true);
});

test('微秒水位精确比较；safe raw scope seen早于全局observations水位可以正常重建', async () => {
    assert.equal(repairCompareTimestamps('2026-11-05T12:00:00.123400Z', '2026-11-05T12:00:00.123456Z'), -1);
    assert.equal(repairCompareTimestamps('2026-11-05T21:00:00.123456+09:00', '2026-11-05T12:00:00.123456000Z'), 0);
    const f = fixture(); f.api.repairStats = async () => ({ pending_consolidation: 0, failed_consolidation: 0, last_memory_write_at: '2026-11-05T12:00:00.123456Z' });
    f.model().last_memory_seen_at = '2026-11-05T12:00:00.123400Z';
    await f.worker().step(f.candidate, f.current); f.completed(); assert.equal(await f.worker().step(f.candidate, f.current), 'repaired');
    const g = fixture(); await g.worker().step(g.candidate, g.current); g.completed(); g.model().is_stale = true;
    assert.equal(await g.worker().step(g.candidate, g.current), 'blocked'); assert.equal(g.store.snapshot(g.bank).dirty, true);
});

test('已存verified不是未来服务端证据：commit前失败重启后仍要fresh核对微秒水位', async () => {
    const f = fixture(); await f.worker().step(f.candidate, f.current); f.completed();
    const commit = f.store.commitVerifiedRepair.bind(f.store); f.store.commitVerifiedRepair = () => { throw new Error('synthetic commit EIO'); };
    assert.equal(await f.worker().step(f.candidate, f.current), 'unavailable'); assert.equal(f.store.snapshot(f.bank).repair?.phase, 'verified');
    f.store.commitVerifiedRepair = commit;
    f.api.repairStats = async () => ({ pending_consolidation: 0, failed_consolidation: 0, last_memory_write_at: '2026-11-05T12:00:00.000001Z' });
    assert.equal(await f.worker().step(f.candidate, f.current), 'blocked'); assert.equal(f.store.snapshot(f.bank).dirty, true);
});

test('新generation不能绕过旧refresh无UUID的不确定派发证据', async () => {
    const f = fixture(); let refreshes = 0;
    f.candidate.expectedAutomatic = false; f.model().trigger.refresh_after_consolidation = false; f.model().configuration_hash = repairModelConfigHash(f.model());
    f.api.repairRefreshModel = async () => { refreshes++; if (refreshes === 1) throw new Error('synthetic lost ACK'); return f.operation; };
    assert.equal(await f.worker().step(f.candidate, f.current), 'unavailable');
    assert.equal(f.store.snapshot(f.bank).repair?.phase, 'refresh-dispatched');
    f.store.mark(f.bank, { ...f.owner, documents: ['ep-1'], eventKey: 'new-generation-after-lost-ack' });
    const latest = f.store.snapshot(f.bank); f.candidate.generation = latest.generation; f.candidate.eventSetHash = latest.eventSetHash;
    f.completed();
    const result = await f.worker().step(f.candidate, f.current);
    assert.notEqual(result, 'repaired'); assert.equal(refreshes, 1, '不能通过新lease盲重发可能仍会晚到的旧HTTP请求');
    assert.equal(f.store.snapshot(f.bank).dirty, true);
});

test('旧generation已知UUID完成后只结旧事实，新lease独立重新清空刷新并恢复原自动设置', async () => {
    const f = fixture(); await f.worker().step(f.candidate, f.current); assert.equal(f.store.snapshot(f.bank).repair?.phase, 'refresh-pending');
    const oldRepair = f.store.snapshot(f.bank).repair!, oldOperation = f.operation;
    f.store.mark(f.bank, { ...f.owner, documents: ['ep-1'], eventKey: 'new-generation-after-known-operation' });
    const live = f.store.snapshot(f.bank); f.candidate.generation = live.generation; f.candidate.eventSetHash = live.eventSetHash;
    f.completed();
    assert.equal(await f.worker().step(f.candidate, f.current), 'repaired');
    assert.equal(f.store.snapshot(f.bank).dirty, false);
    assert.equal(f.calls.filter(call => call === 'clear').length, 2);
    assert.equal(f.calls.filter(call => call === 'refresh').length, 2);
    assert.equal(f.calls.filter(call => call === 'restore').length, 1, '不能先执行旧lease的restore');
    assert.equal(f.model().trigger.refresh_after_consolidation, true);
    const old = JSON.parse(readFileSync(join(f.dir, 'derived.json'), 'utf8')).banks[f.bank].journals[oldRepair.lease.repairId];
    assert.equal(old.phase, 'refresh-pending'); assert.equal(old.settlement.operationId, oldOperation); assert.notEqual(f.operation, oldOperation);
});

test('settlement仅结旧任务：新污染和generation保留，开始新配置时stop仍只确认新ACK', async () => {
    const f = fixture(), old = await superseded(f); f.completed();
    const held = gate<RepairModelEvidence>(); f.api.repairConfigureModel = async () => { f.calls.push('new-configure'); return held.promise; };
    const worker = f.worker(), job = worker.step(f.candidate, f.current); await until(() => f.calls.includes('new-configure'));
    const live = f.store.snapshot(f.bank), previous = f.store.repairJournals(f.bank).find(journal => journal.lease.repairId === old.repairId)!;
    assert.equal(live.generation, f.candidate.generation); assert.equal(live.dirty, true); assert.ok(previous.settlement); assert.equal(previous.phase, 'refresh-pending');
    assert.equal(f.calls.filter(call => call === 'clear').length, 1); assert.ok(!f.calls.includes('restore'));
    const drain = worker.stop(); assert.ok(drain instanceof Promise); held.release(f.configured(false)); await drain; await job;
    assert.equal(f.store.snapshot(f.bank).dirty, true); assert.equal(f.store.snapshot(f.bank).repair?.phase, 'paused'); assert.ok(!f.calls.includes('restore'));
});

test('旧UUID仅pending/processing/failed/cancelled/notfound/preserved或绑定不符都不settle', async () => {
    const cases: Awaited<ReturnType<RepairApi['repairRefreshOperation']>>[] = [
        ...(['pending', 'processing', 'failed', 'cancelled', 'not_found'] as const).map(status => ({ operation_id: '', operation_type: 'refresh_mental_model' as const, mental_model_id: 'relationship', status, outcome: null })),
        { operation_id: '', operation_type: 'refresh_mental_model', mental_model_id: 'relationship', status: 'completed', outcome: 'content_preserved_no_new_facts' },
        { operation_id: '', operation_type: null, mental_model_id: 'relationship', status: 'completed', outcome: 'content_written' },
        { operation_id: '', operation_type: 'refresh_mental_model', mental_model_id: 'foreign-model', status: 'completed', outcome: 'content_written' },
    ];
    for (const response of cases) {
        const f = fixture(); await superseded(f);
        f.api.repairRefreshOperation = async () => ({ ...response, operation_id: f.operation });
        assert.notEqual(await f.worker().step(f.candidate, f.current), 'repaired');
        assert.equal(f.store.snapshot(f.bank).dirty, true); assert.equal(f.store.repairJournals(f.bank).filter(journal => journal.settlement).length, 0);
        assert.equal(f.calls.filter(call => call === 'refresh').length, 1); assert.ok(!f.calls.includes('restore'));
    }
});

test('旧job completed仍需fresh consolidation/四态任务静止和原safe paused配置证据', async () => {
    for (const reason of ['pending-consolidation', 'failed-consolidation', 'cancelled-job', 'changed-config'] as const) {
        const f = fixture(); await superseded(f); f.completed();
        if (reason === 'cancelled-job') f.unsafeJobs();
        else if (reason === 'changed-config') f.configured(false, 3600);
        else f.api.repairStats = async () => ({ pending_consolidation: reason === 'pending-consolidation' ? 1 : 0, failed_consolidation: reason === 'failed-consolidation' ? 1 : 0, last_memory_write_at: WATERMARK });
        assert.notEqual(await f.worker().step(f.candidate, f.current), 'repaired');
        assert.equal(f.store.repairJournals(f.bank).filter(journal => journal.settlement).length, 0); assert.equal(f.calls.filter(call => call === 'refresh').length, 1);
    }
});

test('仲裁纯GET期间stop立即收束，晚completed不能写settlement或派发新配置', async () => {
    const f = fixture(), old = await superseded(f), held = gate<Awaited<ReturnType<RepairApi['repairRefreshOperation']>>>();
    f.api.repairRefreshOperation = async () => { f.calls.push('held-settlement'); return held.promise; };
    const worker = f.worker(), job = worker.step(f.candidate, f.current); await until(() => f.calls.includes('held-settlement'));
    assert.equal(worker.stop(), undefined); assert.equal(await job, 'stopped');
    held.release({ operation_id: f.operation, operation_type: 'refresh_mental_model', mental_model_id: 'relationship', status: 'completed', outcome: 'content_written' });
    await new Promise(done => setImmediate(done));
    assert.equal(f.store.repairJournals(f.bank).find(journal => journal.lease.repairId === old.repairId)!.settlement, undefined);
    assert.equal(f.calls.filter(call => call === 'configure').length, 1);
});

test('仲裁GET held时再次新dirty令旧观察失效，新generation不被晚证据结算', async () => {
    const f = fixture(), old = await superseded(f), held = gate<Awaited<ReturnType<RepairApi['repairRefreshOperation']>>>();
    f.api.repairRefreshOperation = async () => { f.calls.push('held-settlement'); return held.promise; };
    const job = f.worker().step(f.candidate, f.current); await until(() => f.calls.includes('held-settlement'));
    f.store.mark(f.bank, { ...f.owner, documents: ['ep-1'], eventKey: 'third-dirty-during-settlement' });
    const generation = f.store.snapshot(f.bank).generation;
    held.release({ operation_id: f.operation, operation_type: 'refresh_mental_model', mental_model_id: 'relationship', status: 'completed', outcome: 'content_written' });
    assert.equal(await job, 'stale'); assert.equal(f.store.snapshot(f.bank).generation, generation);
    assert.equal(f.store.repairJournals(f.bank).find(journal => journal.lease.repairId === old.repairId)!.settlement, undefined);
    assert.equal(f.calls.filter(call => call === 'configure').length, 1);
});

test('settlement发布前/发布后EIO都不重派旧刷新，重启依据完整JSON继续新repair', async () => {
    for (const published of [false, true]) {
        const f = fixture(), old = await superseded(f); f.completed();
        const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
        let first = true;
        try {
            fileOps.writeDelaysMs = [0]; fileOps.renameSync = (from, to) => {
                if (first && String(to) === join(f.dir, 'derived.json')) {
                    first = false; if (published) rename(from, to); throw Object.assign(new Error('SYNTHETIC_SECRET_EIO'), { code: 'EIO' });
                }
                return rename(from, to);
            };
            const result = await f.worker().step(f.candidate, f.current);
            assert.equal(result, published ? 'repaired' : 'unavailable');
        } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
        const restarted = new DerivedRepair({ api: f.api, store: new DerivedState(f.dir) });
        const result = await restarted.step(f.candidate, f.current); assert.ok(result === 'repaired' || result === 'clean');
        assert.equal(f.calls.filter(call => call === 'refresh').length, 2);
        const previous = f.store.repairJournals(f.bank).find(journal => journal.lease.repairId === old.repairId)!;
        assert.ok(previous.settlement); assert.equal(previous.phase, 'refresh-pending');
    }
});

test('新refresh复用旧UUID不能拿旧completed证据解封，保未知意图且不重POST', async () => {
    const f = fixture(); await superseded(f); const oldOperation = f.operation; f.completed();
    const original = f.api.repairRefreshOperation; let reads = 0;
    f.api.repairRefreshOperation = async (bank, id) => {
        if (++reads === 1) return original(bank, id); // Only the old completed job actually wrote content.
        return { operation_id: oldOperation, operation_type: 'refresh_mental_model', mental_model_id: 'relationship', status: 'completed', outcome: 'content_written' };
    };
    f.api.repairRefreshModel = async () => { f.calls.push('refresh'); return oldOperation; };
    assert.notEqual(await f.worker().step(f.candidate, f.current), 'repaired');
    assert.equal(f.store.snapshot(f.bank).dirty, true); assert.equal(f.store.snapshot(f.bank).repair?.phase, 'refresh-dispatched');
    assert.notEqual(await f.worker().step(f.candidate, f.current), 'repaired');
    assert.equal(f.calls.filter(call => call === 'refresh').length, 2, '第二次POST已派发结果未知，不能补发第三次');
    assert.equal(f.calls.filter(call => call === 'restore').length, 0);
});
