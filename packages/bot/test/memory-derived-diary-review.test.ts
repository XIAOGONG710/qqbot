import assert from 'node:assert/strict';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { diaryWriter } from '../src/life/diary.ts';
import type { Schedule } from '../src/life/schedule.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';

const roots: string[] = [], marker = 'SYNTHETIC_WITHDRAWN_DIARY_SECRET';
const now = new Date('2026-11-09T12:00:00+08:00');
const schedule = (phase: boolean): Schedule => ({ sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: 'one' }, periods: { one: { start: '08:00', end: '10:00' } },
    semester: { start: '2026-09-01', weeks: 20 }, holidays: phase ? [{ name: '合成假期', start: '2026-11-03', end: '2026-11-03' }] : [], makeups: [],
    kinds: { hard: {}, machine: {}, pe: {}, water: {} }, courses: [], free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '合成地点' });
afterEach(() => { for (const dir of roots.splice(0)) { const target = resolve(dir); assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('qqbot-derived-diary-')); rmSync(target, { recursive: true, force: true }); } });
function gate<T>() { let release!: (value: T) => void; let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }); const pending = new Promise<T>(resolve => { release = resolve; });
    return { release, entered, work: () => { enter(); return pending; } }; }
function fixture(kind: 'week' | 'phase' | 'daily', patch: { generate?: () => Promise<string>; read?: () => Promise<string | undefined>; retain?: () => Promise<boolean> } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-derived-diary-')); roots.push(dir); const path = join(dir, 'diary.json');
    let available = true;
    const state = { written: { '2026-11-03': 1, '2026-11-06': 1, '2026-11-07': 1, '2026-11-08': 1 } as Record<string, number>,
        texts: patch.read ? {} : { '2026-11-03': marker, '2026-11-06': '合成旧日记', '2026-11-07': '合成旧日记', '2026-11-08': '合成旧日记' },
        weeks: { '2026-10-26': 0, ...(kind === 'week' ? {} : { '2026-11-02': 0 }) }, phases: {} };
    if (kind === 'daily') delete state.written['2026-11-06'];
    writeFileSync(path, JSON.stringify(state));
    const calls = { generate: 0, read: 0, diary: 0, summary: 0 }; const prompts: string[] = [];
    const memory = { derivedAvailable: () => available, readDiary: async () => { calls.read++; return patch.read?.(); },
        retainDiary: async () => { calls.diary++; return patch.retain?.() ?? true; }, retainSummary: async () => { calls.summary++; return patch.retain?.() ?? true; } } as unknown as LongTermMemory;
    const writer = diaryWriter({ sources: { charName: '合成角色', schedule: schedule(kind === 'phase'), moods: [], books: [] }, contacts: [],
        history: { load: () => [] }, memory, dir, log() {}, generate: async messages => { calls.generate++; prompts.push(JSON.stringify(messages)); return patch.generate?.() ?? '合成生成正文'; } });
    return { path, writer, memory, calls, prompts, dirty: () => { available = false; }, clean: () => { available = true; } };
}

for (const kind of ['week', 'phase'] as const) test(`${kind}本地旧texts不能绕过dirty守卫进入模型，也不能记为空总结`, async () => {
    const f = fixture(kind); const before = readFileSync(f.path, 'utf8');
    try { f.dirty(); await f.writer.catchUp(now);
        assert.deepEqual(f.calls, { generate: 0, read: 0, diary: 0, summary: 0 }); assert.equal(f.prompts.length, 0);
        assert.equal(readFileSync(f.path, 'utf8'), before);
        f.clean(); await f.writer.catchUp(now); assert.equal(f.calls.generate, 1); assert.equal(f.calls.summary, 1);
        assert.ok(f.prompts[0]!.includes(marker), 'clean兼容旧本地日记，不靠删除数据修复');
    } finally { await f.writer.stop(); }
});

for (const kind of ['daily', 'week', 'phase'] as const) test(`${kind}生成held期间变dirty，晚正文不retain或标完成`, async () => {
    const held = gate<string>(), f = fixture(kind, { generate: held.work }), before = readFileSync(f.path, 'utf8');
    const running = f.writer.catchUp(now);
    try { await held.entered; f.dirty(); held.release('SYNTHETIC_LATE_GENERATION'); await running;
        assert.equal(f.calls.diary + f.calls.summary, 0); assert.equal(readFileSync(f.path, 'utf8'), before);
    } finally { held.release('cleanup'); await running; await f.writer.stop(); }
});

for (const kind of ['week', 'phase'] as const) test(`${kind}旧日记read held期间变dirty，晚读取不缓存或传给generate`, async () => {
    const held = gate<string | undefined>(), f = fixture(kind, { read: held.work }), before = readFileSync(f.path, 'utf8');
    const running = f.writer.catchUp(now);
    try { await held.entered; f.dirty(); held.release(marker); await running;
        assert.equal(f.calls.generate, 0); assert.equal(f.calls.summary, 0); assert.equal(readFileSync(f.path, 'utf8'), before);
    } finally { held.release(undefined); await running; await f.writer.stop(); }
});

test('已经派发summary retain期间变dirty仍保存真实ACK进度，不回滚既有事实', async () => {
    const held = gate<boolean>(), f = fixture('week', { retain: held.work }); const running = f.writer.catchUp(now);
    try { await held.entered; f.dirty(); held.release(true); await running;
        assert.equal(f.calls.summary, 1); assert.ok(JSON.parse(readFileSync(f.path, 'utf8')).weeks['2026-11-02'] > 0);
    } finally { held.release(true); await running; await f.writer.stop(); }
});

test('守卫状态读取抛错时安全暂停，不把未知视作clean且保留旧日记', async () => {
    const f = fixture('week'), before = readFileSync(f.path, 'utf8');
    Object.defineProperty(f.memory, 'derivedAvailable', { value: () => { throw new Error('SYNTHETIC_PRIVATE_GUARD_IO'); } });
    try { await f.writer.catchUp(now); assert.equal(f.calls.generate, 0); assert.equal(readFileSync(f.path, 'utf8'), before); }
    finally { await f.writer.stop(); }
});
