import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LongTermMemory } from '../src/memory/long-term.ts';
import type { HindsightApi, RecallResult } from '../src/memory/hindsight.ts';
import { diaryWriter } from '../src/life/diary.ts';
import type { Schedule } from '../src/life/schedule.ts';

const now = new Date('2026-11-09T12:00:00+08:00'), marker = 'SYNTHETIC_WRITTEN_SOURCE_PRIVATE';
const A = { qq: 10001, name: '合成甲', tier: 'boyfriend' as const }, B = { qq: 10002, name: '合成乙', tier: 'classmate' as const };
const query = [{ role: 'user' as const, content: '合成查询' }];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-written-source-guard-'));
    let documents = 0, entities = 0, result: RecallResult[] = [];
    const logs: string[] = [];
    const api: HindsightApi = { putBank: async () => {}, retain: async () => {}, recall: async () => result,
        getMentalModel: async (_bank, id) => ({ id, content: 'SYNTHETIC_PRIVATE_SAFE_MODEL' }), createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '',
        getDocument: async () => { documents++; return { original_text: `title\n${marker}` }; }, listEntities: async () => { entities++; return [marker]; } };
    const memory = new LongTermMemory({ api, dir, bankPrefix: 'synthetic', common: true, recallTimeoutMs: 100, now: () => now.getTime(), log: line => logs.push(line) });
    // An old runtime lacking the new integration still executes the actual read,
    // so the pre-fix failure is leaked provider content, not a missing-method error.
    const register = (check: () => boolean) => (memory as LongTermMemory & { setWrittenSourceVerifier?: (check: () => boolean) => void }).setWrittenSourceVerifier?.(check);
    const clean = async () => { await memory.stop(); assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-written-source-guard-')); rmSync(dir, { recursive: true, force: true }); };
    return { dir, api, memory, register, clean, logs, documents: () => documents, entities: () => entities, results: (rows: RecallResult[]) => { result = rows; } };
}

test('公共读取前同步核验written来源；禁止模型/日记仍保其他私人bank与精确QQ原始事实', async () => {
    const f = fixture(); let valid = true; f.register(() => valid);
    try {
        await f.memory.sync(B, { user: B.name, char: '合成角色' }, [{ role: 'user', content: 'SYNTHETIC_SAFE', time: '2026-11-08T12:00:00+08:00' }]);
        assert.equal(await f.memory.readDiary('2026-11-08'), marker); valid = false;
        const count = f.documents(); assert.equal(await f.memory.readDiary('2026-11-08'), undefined); assert.equal(f.documents(), count);
        assert.deepEqual(await f.memory.commonEntities(), []); assert.equal(f.entities(), 0);
        f.memory.relationship(B); await tick(); assert.ok(f.memory.relationship(B)?.includes('SAFE_MODEL'));
        const owner = f.memory.bankId(B).split('-').at(-1)!;
        f.results([{ id: 'diary', text: marker, type: 'world', document_id: 'diary:2026-11-08' },
            { id: 'safe', text: 'SYNTHETIC_SAFE_QQ_FACT', type: 'experience', document_id: `${owner}:ep-1` }]);
        const value = await f.memory.recallCommon(A, query, now, [A, B]); assert.match(value!, /SAFE_QQ_FACT/); assert.doesNotMatch(value!, /WRITTEN_SOURCE_PRIVATE/);
    } finally { await f.clean(); }
});

test('真实writer完成后since变化，不等待catchUp或新summary即可在读口形成持久屏障', async () => {
    const f = fixture(); let since: string | undefined;
    const schedule: Schedule = { sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:30' } },
        semester: { start: '2026-09-01', weeks: 20 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
        free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成学校' };
    const writer = diaryWriter({ dir: f.dir, memory: f.memory, sources: { charName: '合成角色', schedule, moods: [], books: [] }, contacts: [A],
        history: { load: () => [{ role: 'user', content: marker, time: '2026-11-06T12:00:00+08:00', messageId: 1 }] }, sourceSince: () => since, generate: async () => marker, log() {} });
    f.register(() => writer.verifySources(now));
    try { await writer.catchUp(now); assert.equal(await f.memory.readDiary('2026-11-06'), marker);
        since = '2026-11-07T00:00:00+08:00'; assert.equal(await f.memory.readDiary('2026-11-06'), undefined); assert.equal(f.memory.derivedAvailable(), false);
        const restarted = new LongTermMemory({ api: f.api, dir: f.dir, bankPrefix: 'synthetic', common: true, recallTimeoutMs: 100, log() {} });
        try { assert.equal(await restarted.readDiary('2026-11-06'), undefined); } finally { await restarted.stop(); }
    } finally { await writer.stop(); await f.clean(); }
});

test('来源核验异常或递归不能回退旧正文，不回显错误私密内容', async () => {
    const f = fixture();
    try { f.register(() => { throw new Error(marker); }); assert.equal(await f.memory.readDiary('2026-11-08'), undefined); assert.equal(f.documents(), 0);
        f.register(() => f.memory.derivedAvailable()); assert.equal(f.memory.derivedAvailable(), false); assert.ok(f.logs.every(line => !line.includes(marker)));
    } finally { await f.clean(); }
});

test('实体请求await后来源变无效，旧结果不能提交或返回', async () => {
    const f = fixture(); let valid = true, entered = false, release!: (value: string[]) => void;
    const held = new Promise<string[]>(done => { release = done; }); f.api.listEntities = async () => { entered = true; return held; }; f.register(() => valid);
    try { const task = f.memory.commonEntities(); while (!entered) await tick(); valid = false; release([marker]); assert.deepEqual(await task, []); }
    finally { release([]); await f.clean(); }
});

test('格式化回调才改变来源时，最终出口重核不返回先前日记正文', async () => {
    const f = fixture(); let valid = true, formatted = false; f.register(() => valid);
    try { await f.memory.sync(B, { user: B.name, char: '合成角色' }, [{ role: 'user', content: 'SYNTHETIC_SAFE', time: '2026-11-08T12:00:00+08:00' }]);
        f.results([{ id: 'diary', text: marker, type: 'world', document_id: 'diary:2026-11-08', mentioned_at: '2026-11-08T12:00:00+08:00' }]);
        const value = await f.memory.recallCommon(A, query, now, [A, B], undefined, { onFade: () => { formatted = true; valid = false; } });
        assert.equal(formatted, true); assert.equal(value, undefined);
    } finally { await f.clean(); }
});
