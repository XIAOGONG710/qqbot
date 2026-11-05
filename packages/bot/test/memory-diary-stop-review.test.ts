import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diaryWriter } from '../src/life/diary.ts';
import type { Schedule } from '../src/life/schedule.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';
import { fileOps } from '../src/memory/json-file.ts';

const schedule = (): Schedule => ({ sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: 'one' }, periods: { one: { start: '08:00', end: '10:00' } },
 semester: { start: '2026-09-01', weeks: 20 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, pe: {}, water: {} }, courses: [],
 free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '合成地点' });
const now = new Date('2026-11-05T12:00:00+08:00');
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < end, '合成等待超时'); await new Promise(r => setTimeout(r, 2)); } }
async function promptly(promise: Promise<unknown> | undefined) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cancel did not settle')), 200); })]); } finally { clearTimeout(timer); } }
function fixture(patch: { generate?: () => Promise<string>; retainDiary?: () => Promise<boolean>; retainSummary?: () => Promise<boolean>; readDiary?: () => Promise<string | undefined>; schedule?: Schedule } = {}) {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-stop-')); const calls = { generate: 0, diary: 0, summary: 0, read: 0 };
 const memory = { retainDiary: async () => { calls.diary++; return patch.retainDiary?.() ?? true; }, retainSummary: async () => { calls.summary++; return patch.retainSummary?.() ?? true; },
  readDiary: async () => { calls.read++; return patch.readDiary?.(); } } as unknown as LongTermMemory;
 const writer = diaryWriter({ sources: { charName: '合成角色', schedule: patch.schedule ?? schedule(), moods: [], books: [] }, contacts: [], history: { load: () => [] }, memory, dir, log() {},
  generate: async () => { calls.generate++; return patch.generate?.() ?? '合成日记正文'; } });
 return { dir, path: join(dir, 'diary.json'), calls, writer };
}
function stop(writer: ReturnType<typeof diaryWriter>) { return (writer as { stop?: () => Promise<void> | undefined }).stop?.(); }

test('idle停止同步收束，停止后catchUp不读材料、不生成、不写状态', async () => {
 const f = fixture(); try { assert.equal(typeof (f.writer as { stop?: unknown }).stop, 'function'); assert.equal(stop(f.writer), undefined); assert.equal(stop(f.writer), undefined); await f.writer.catchUp(now); assert.deepEqual(f.calls, { generate: 0, diary: 0, summary: 0, read: 0 }); assert.equal(existsSync(f.path), false); }
 finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('在途生成取消立即结束drain，迟到正文不进入retain或本地状态', async () => {
 const held = gate<string>(); const f = fixture({ generate: () => held.promise }); const task = f.writer.catchUp(now);
 try { await until(() => f.calls.generate === 1); const drain = stop(f.writer); assert.ok(drain instanceof Promise); assert.equal(stop(f.writer), drain); await promptly(drain); await task;
  held.resolve('迟到合成正文'); await new Promise(r => setImmediate(r)); assert.equal(f.calls.diary, 0); assert.equal(existsSync(f.path), false); }
 finally { held.resolve('cleanup'); await task; rmSync(f.dir, { recursive: true, force: true }); }
});

test('已派发日记retain等待ACK并保存written/texts，停止后不再生成下一篇', async () => {
 const held = gate<boolean>(); const f = fixture({ retainDiary: () => held.promise }); const task = f.writer.catchUp(now);
 try { await until(() => f.calls.diary === 1); const drain = stop(f.writer); let settled = false; void drain?.then(() => { settled = true; }); await new Promise(r => setImmediate(r)); assert.equal(settled, false);
  held.resolve(true); await drain; await task; const state = JSON.parse(readFileSync(f.path, 'utf8')); assert.deepEqual(Object.keys(state.written), ['2026-11-02']); assert.equal(state.texts['2026-11-02'], '合成日记正文'); assert.equal(f.calls.generate, 1); assert.equal(f.calls.summary, 0); }
 finally { held.resolve(false); await task; rmSync(f.dir, { recursive: true, force: true }); }
});

test('读取旧日记可取消，晚返回不缓存原文或启动周记生成', async () => {
 const held = gate<string | undefined>(); const f = fixture({ readDiary: () => held.promise });
 const state = { written: { '2026-11-02': 1, '2026-11-03': 1, '2026-11-04': 1, '2026-10-20': 1 }, texts: {}, weeks: {}, phases: {} }; const before = JSON.stringify(state); writeFileSync(f.path, before); const task = f.writer.catchUp(now);
 try { await until(() => f.calls.read === 1); await promptly(stop(f.writer)); await task; held.resolve('迟到历史日记'); await new Promise(r => setImmediate(r)); assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(f.calls.generate, 0); assert.equal(f.calls.summary, 0); }
 finally { held.resolve(undefined); await task; rmSync(f.dir, { recursive: true, force: true }); }
});

test('retain已ACK但本地写失败时drain明确失败，保留旧状态且不生成下一篇', async () => {
 const held = gate<boolean>(); const f = fixture({ retainDiary: () => held.promise }); const original = fileOps.writeFileSync;
 const before = JSON.stringify({ written: {}, texts: {}, weeks: {}, phases: {} }); writeFileSync(f.path, before);
 const task = f.writer.catchUp(now); void task.catch(() => {});
 try { await until(() => f.calls.diary === 1); const drain = stop(f.writer); assert.ok(drain instanceof Promise);
  fileOps.writeFileSync = () => { throw new Error('synthetic disk failure'); }; held.resolve(true);
  await assert.rejects(drain, /synthetic disk failure/); assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(f.calls.generate, 1); assert.equal(f.calls.diary, 1);
 } finally { held.resolve(false); await task.catch(() => {}); fileOps.writeFileSync = original; rmSync(f.dir, { recursive: true, force: true }); }
});

for (const phase of [false, true]) test(`${phase ? '阶段总结' : '周记'}retain ACK保存完成记录后结束drain，不再生成后续总结`, async () => {
 const held = gate<boolean>(); const s = schedule(); if (phase) s.holidays = [{ name: '合成假期', start: '2026-10-23', end: '2026-10-24' }];
 const f = fixture({ schedule: s, retainSummary: () => held.promise });
 const oldDate = phase ? '2026-10-23' : '2026-10-20';
 const state = { written: { '2026-11-02': 1, '2026-11-03': 1, '2026-11-04': 1, [oldDate]: 1 }, texts: { [oldDate]: '合成旧日记' }, weeks: phase ? { '2026-10-19': 1, '2026-10-26': 1 } : {}, phases: {} }; writeFileSync(f.path, JSON.stringify(state)); const task = f.writer.catchUp(now);
 try { await until(() => f.calls.summary === 1); const drain = stop(f.writer); held.resolve(true); await drain; await task;
  const saved = JSON.parse(readFileSync(f.path, 'utf8')); assert.ok(saved[phase ? 'phases' : 'weeks'][phase ? '合成假期:2026-10-24' : '2026-10-19'] > 0); assert.equal(f.calls.generate, 1); assert.equal(f.calls.summary, 1); }
 finally { held.resolve(false); await task; rmSync(f.dir, { recursive: true, force: true }); }
});
