import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LongTermMemory } from '../src/memory/long-term.ts';
import { DerivedState } from '../src/memory/derived-state.ts';
import type { HindsightApi, MemoryItem } from '../src/memory/hindsight.ts';
import type { StoredMessage } from '../src/memory/history.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z'), WHO = { qq: 10001, tier: 'boyfriend' }, NAMES = { char: '合成角色', user: '合成甲' };
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-memory-future-')); rmSync(dir, { recursive: true, force: true }); } });
const row = (minute: number, content = `合成${minute}`, id = minute): StoredMessage => ({ role: 'user', content, time: new Date(NOW + minute * 60_000).toISOString(), messageId: id });
const past = (count: number) => Array.from({ length: count }, (_, i) => row(i - count));
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(done => { release = done; }); return { promise, release }; }
function fixture(patch: Partial<HindsightApi> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-future-')); roots.push(dir); let clock = NOW;
    const writes: { bank: string; item: MemoryItem }[] = [], deletes: string[] = [];
    const api: HindsightApi = { putBank: async () => {}, retain: async (bank, item) => { writes.push({ bank, item: structuredClone(item) }); }, deleteDocument: async (_bank, id) => { deletes.push(id); },
        recall: async () => [], getMentalModel: async () => undefined, createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '', ...patch };
    const memory = new LongTermMemory({ api, dir, bankPrefix: 'synthetic', common: true, recallTimeoutMs: 100, now: () => clock, log() {} });
    return { dir, memory, api, writes, deletes, clock: (value: number) => { clock = value; }, progress: () => JSON.parse(readFileSync(join(dir, '10001-boyfriend.json'), 'utf8')) };
}

test('29条已发生加未来1条不能提前双库retain，时钟追上后正常凑满同步', async () => {
    const f = fixture(), history = [...past(29), row(1, 'FUTURE_MARKER')];
    await f.memory.sync(WHO, NAMES, history); assert.equal(f.writes.length, 0);
    f.clock(NOW + 60_000); await f.memory.sync(WHO, NAMES, history);
    assert.equal(f.writes.length, 2); assert.ok(f.writes.every(write => write.item.content.includes('FUTURE_MARKER'))); await f.memory.stop();
});

test('未来crisis不提前delete既有公共片段，真正到时仍按既定危机规则清公共', async () => {
    const f = fixture(), history = past(30); await f.memory.sync(WHO, NAMES, history); assert.equal(f.writes.length, 2);
    const next = [...history, row(1, '我想自杀')]; await f.memory.sync(WHO, NAMES, next); assert.equal(f.deletes.length, 0);
    f.clock(NOW + 60_000); await f.memory.sync(WHO, NAMES, next); assert.equal(f.deletes.length, 1); await f.memory.stop();
});

test('一次sync固定事实时点，await期间时钟推进不能让未来尾部混进已派快照', async () => {
    const held = gate<void>(); const f = fixture({ putBank: async () => { await held.promise; } }); const history = [...past(30), row(1, 'FUTURE_DURING_AWAIT')];
    const job = f.memory.sync(WHO, NAMES, history); await new Promise(done => setImmediate(done)); f.clock(NOW + 60_000); held.release(); await job;
    assert.equal(f.writes.length, 2); assert.ok(f.writes.every(write => !write.item.content.includes('FUTURE_DURING_AWAIT'))); await f.memory.stop();
});

test('时钟回拨或旧已提交future count保事实且屏蔽派生，不把可见短数组误当真实删除', async () => {
    const f = fixture(), history = [...past(29), row(1, 'KNOWN_SUBMITTED_FACT')]; f.clock(NOW + 60_000); await f.memory.sync(WHO, NAMES, history);
    const original = f.progress(); f.clock(NOW); await f.memory.sync(WHO, NAMES, history);
    assert.equal(f.writes.length, 2); assert.equal(f.deletes.length, 0); assert.deepEqual(f.progress().retained, original.retained);
    assert.equal(new DerivedState(f.dir).snapshot(f.memory.bankId(WHO)).dirty, true);
    f.clock(NOW + 60_000); await f.memory.sync(WHO, NAMES, history); assert.equal(f.writes.length, 2); await f.memory.stop();
});

test('未来行夹在已发生行之间不吞后续过去事实，过去正文修订仍正常同步', async () => {
    const f = fixture(), history = past(30); history.splice(12, 0, row(1, 'INTERLEAVED_FUTURE'));
    await f.memory.sync(WHO, NAMES, history); assert.equal(f.writes.length, 2); assert.ok(f.writes.every(write => !write.item.content.includes('INTERLEAVED_FUTURE')));
    history[history.length - 1] = { ...history.at(-1)!, content: 'PAST_REVISED' };
    await f.memory.sync(WHO, NAMES, history); assert.equal(f.writes.length, 4); assert.ok(f.writes.slice(2).every(write => write.item.content.includes('PAST_REVISED'))); await f.memory.stop();
});

test('future位于首/中/尾和倒序时原始source分片身份不漂移，追上后覆盖同一文档', async () => {
    for (const position of [0, 13, 30]) {
        const f = fixture(), history = past(30).reverse(); history.splice(position, 0, row(1, 'FUTURE_POSITION'));
        await f.memory.sync(WHO, NAMES, history); assert.equal(f.writes.length, 2);
        const identities = f.writes.map(write => `${write.bank}:${write.item.document_id}`);
        f.clock(NOW + 46 * 60_000); await f.memory.sync(WHO, NAMES, history);
        assert.equal(f.writes.length, 4); assert.deepEqual(f.writes.slice(2).map(write => `${write.bank}:${write.item.document_id}`), identities);
        assert.ok(f.writes.slice(2).every(write => write.item.content.includes('FUTURE_POSITION'))); await f.memory.stop();
    }
});

test('回拨发生在派发前await时不再发future快照，追上后可恢复', async () => {
    const held = gate<void>(), f = fixture({ putBank: async () => { await held.promise; } }), history = [...past(29), row(1, 'ROLLBACK_BEFORE_DISPATCH')];
    f.clock(NOW + 60_000); const job = f.memory.sync(WHO, NAMES, history); await new Promise(done => setImmediate(done)); f.clock(NOW); held.release(); await job;
    assert.equal(f.writes.length, 0); f.clock(NOW + 60_000); await f.memory.sync(WHO, NAMES, history); assert.equal(f.writes.length, 2); await f.memory.stop();
});

test('immutable pending未来prefix notfound不重派，knownACK保count并保持屏障，追上可续公共', async () => {
    let status: 'pending' | 'not_found' | 'completed' = 'pending'; const submissions: MemoryItem[] = [];
    const f = fixture({ submitRetain: async (_bank, item) => { submissions.push(structuredClone(item)); }, retentionStatus: async () => status });
    const history = [...past(29), row(1, 'IMMUTABLE_FUTURE')]; f.clock(NOW + 60_000); await f.memory.sync(WHO, NAMES, history);
    const before = f.progress().pendingOwn; assert.equal(submissions.length, 1);
    f.clock(NOW); status = 'not_found'; await f.memory.sync(WHO, NAMES, history); assert.equal(submissions.length, 1); assert.deepEqual(f.progress().pendingOwn, before);
    status = 'completed'; await f.memory.sync(WHO, NAMES, history); assert.equal(Object.keys(f.progress().pendingOwn).length, 0);
    assert.equal(Object.values(f.progress().retained)[0], 30); assert.equal(new DerivedState(f.dir).snapshot(f.memory.bankId(WHO)).dirty, true);
    f.clock(NOW + 60_000); await f.memory.sync(WHO, NAMES, history); assert.equal(submissions.length, 2); assert.ok(submissions[1]!.content.includes('IMMUTABLE_FUTURE')); await f.memory.stop();
});

test('future追上插入pending前缀时，可按不可变源时间和摘要核对notfound重派原正文', async () => {
    let status: 'pending' | 'not_found' | 'completed' = 'pending'; const submissions: MemoryItem[] = [];
    const f = fixture({ submitRetain: async (_bank, item) => { submissions.push(structuredClone(item)); status = 'completed'; }, retentionStatus: async () => status });
    // Keep the first accepted operation pending despite the fake submission's local update.
    f.api.submitRetain = async (_bank, item) => { submissions.push(structuredClone(item)); };
    const history = [row(1, 'PENDING_INSERTED_FUTURE'), ...past(30)]; await f.memory.sync(WHO, NAMES, history); assert.equal(submissions.length, 1);
    const original = structuredClone(submissions[0]); status = 'not_found'; f.clock(NOW + 60_000);
    await f.memory.sync(WHO, NAMES, history); assert.equal(submissions.length, 2); assert.deepEqual(submissions[1], original); assert.ok(!submissions[1]!.content.includes('PENDING_INSERTED_FUTURE')); await f.memory.stop();
});

test('future撤回不提前污染；时钟追上保原sourceID和撤回屏障，零年及NaN时间安全', async () => {
    const f = fixture(), history = [...past(29), { ...row(1, '[撤回了一条消息]', 123), recalled: true as const }];
    f.memory.noteRecall(WHO, history); await f.memory.sync(WHO, NAMES, history);
    assert.equal(new DerivedState(f.dir).snapshot(f.memory.bankId(WHO)).dirty, false); assert.equal(f.writes.length, 0);
    f.clock(NOW + 60_000); f.memory.noteRecall(WHO, history); await f.memory.sync(WHO, NAMES, history);
    assert.equal(new DerivedState(f.dir).snapshot(f.memory.bankId(WHO)).dirty, true); assert.equal(f.writes.length, 2); await f.memory.stop();
    const low = fixture(); low.clock(Date.parse('0000-01-02T12:00:00Z'));
    await low.memory.sync(WHO, NAMES, [{ role: 'user', content: '合成零年过去', time: '0000-01-01T12:00:00Z' }]); assert.equal(low.writes.length, 2);
    const invalid = fixture(); invalid.clock(NaN); await invalid.memory.sync(WHO, NAMES, past(30)); assert.equal(invalid.writes.length, 0);
    await low.memory.stop(); await invalid.memory.stop();
});

test('stop保已派immutable意图，重启回拨不重发future，knownACK后仍保count与屏障', async () => {
    const held = gate<void>(); let status: 'not_found' | 'completed' = 'not_found', dispatched = 0;
    const f = fixture({ submitRetain: async () => { dispatched++; await held.promise; }, retentionStatus: async () => status });
    const history = [...past(29), row(1, 'PENDING_RESTART_FUTURE')]; f.clock(NOW + 60_000);
    const job = f.memory.sync(WHO, NAMES, history); while (!dispatched) await new Promise(done => setImmediate(done));
    const drain = f.memory.stop(); assert.ok(drain instanceof Promise); held.release(); await drain; await job;
    const pending = f.progress().pendingOwn; assert.equal(Object.values(pending).length, 1);
    const restarted = new LongTermMemory({ api: f.api, dir: f.dir, bankPrefix: 'synthetic', common: true, recallTimeoutMs: 100, now: () => NOW, log() {} });
    await restarted.sync(WHO, NAMES, history); assert.equal(dispatched, 1); assert.deepEqual(f.progress().pendingOwn, pending);
    status = 'completed'; await restarted.sync(WHO, NAMES, history); assert.equal(Object.keys(f.progress().pendingOwn).length, 0);
    assert.equal(Object.values(f.progress().retained)[0], 30); assert.equal(new DerivedState(f.dir).snapshot(restarted.bankId(WHO)).dirty, true); await restarted.stop();
});

test('重启保filtered前缀时间证据，隐藏future不会阻断已发生正文的真实修订', async () => {
    const f = fixture(), history = [row(1, 'HIDDEN_FUTURE'), ...past(30)]; await f.memory.sync(WHO, NAMES, history); await f.memory.stop();
    assert.equal(Object.values(f.progress().retainedSourceTimes)[0] instanceof Array, true);
    const restarted = new LongTermMemory({ api: f.api, dir: f.dir, bankPrefix: 'synthetic', common: true, recallTimeoutMs: 100, now: () => NOW, log() {} });
    history[history.length - 1] = { ...history.at(-1)!, content: 'REAL_PAST_EDIT_AFTER_RESTART' };
    await restarted.sync(WHO, NAMES, history); assert.equal(f.writes.length, 4); assert.ok(f.writes.slice(2).every(write => !write.item.content.includes('HIDDEN_FUTURE') && write.item.content.includes('REAL_PAST_EDIT_AFTER_RESTART'))); await restarted.stop();
});

test('未发生的远future不改变过去分片，追上后的不可证明重分片保留原文档并屏障', async () => {
    const f = fixture(), history = past(60); history.splice(30, 0, row(120, 'FUTURE_SOURCE_BOUNDARY'));
    await f.memory.sync(WHO, NAMES, history); assert.equal(f.writes.length, 2);
    const identities = new Set(f.writes.map(write => `${write.bank}:${write.item.document_id}`));
    assert.equal(Object.keys(f.progress().retained).length, 1);
    f.clock(NOW + 166 * 60_000); await f.memory.sync(WHO, NAMES, history);
    assert.equal(f.writes.length, 2, '不能把原60条截成前30条或另写后半片');
    assert.equal(new Set(f.writes.map(write => `${write.bank}:${write.item.document_id}`)).size, identities.size);
    assert.equal(Object.values(f.progress().retained)[0], 60); assert.equal(new DerivedState(f.dir).snapshot(f.memory.bankId(WHO)).dirty, true); await f.memory.stop();
});

test('已提交30过去事实后中插48h future不截为12条，后18条不丢且过去修订仍可同步', async () => {
    const f = fixture(), history = past(30); await f.memory.sync(WHO, NAMES, history); const document = f.writes[0]!.item.document_id;
    history.splice(12, 0, row(48 * 60, 'DISTANT_FUTURE')); await f.memory.sync(WHO, NAMES, history);
    assert.equal(f.writes.length, 2); assert.equal(Object.values(f.progress().retained)[0], 30);
    history[history.length - 1] = { ...history.at(-1)!, content: 'STILL_PAST_TAIL' };
    await f.memory.sync(WHO, NAMES, history); assert.equal(f.writes.length, 4);
    assert.ok(f.writes.slice(2).every(write => write.item.content.includes('STILL_PAST_TAIL') && !write.item.content.includes('DISTANT_FUTURE')));
    assert.equal(f.writes[2]!.item.document_id, document); await f.memory.stop();
});

test('旧无sourceTimes进度遇远future追上重分片也不能把已确认30条改写成12条', async () => {
    const f = fixture(), history = past(30); await f.memory.sync(WHO, NAMES, history);
    const old = f.progress(); delete old.retainedSourceTimes; delete old.commonSourceTimes;
    writeFileSync(join(f.dir, '10001-boyfriend.json'), JSON.stringify(old)); history.splice(12, 0, row(48 * 60, 'LEGACY_DISTANT_FUTURE'));
    await f.memory.sync(WHO, NAMES, history); assert.equal(f.writes.length, 2);
    f.clock(NOW + (48 * 60 + 46) * 60_000); await f.memory.sync(WHO, NAMES, history);
    assert.equal(f.writes.length, 2); assert.equal(Object.values(f.progress().retained)[0], 30);
    assert.equal(new DerivedState(f.dir).snapshot(f.memory.bankId(WHO)).dirty, true); await f.memory.stop();
});
