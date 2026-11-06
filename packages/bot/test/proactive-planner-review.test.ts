import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProactivePlanner, type Planner, type PlannerDeps } from '../src/proactive/proactive-planner.ts';
import { fileOps } from '../src/memory/json-file.ts';
import type { Schedule } from '../src/life/schedule.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
const makePlanner: typeof createProactivePlanner = process.env.SYNTHETIC_PLANNER_MODULE ? (await import(process.env.SYNTHETIC_PLANNER_MODULE)).createProactivePlanner : createProactivePlanner;
const schedule: Schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '09:00', earlySlot: 'one' }, periods: { one: { start: '08:30', end: '09:15' } }, semester: { start: '2026-09-01', weeks: 20 }, holidays: [], makeups: [], courses: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, free: { morning: ['合成活动'], afternoon: ['合成活动'], evening: ['合成活动'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
const at = new Date(2026, 10, 5, 15).getTime();
const dirs: string[] = []; const planners: Planner[] = []; const restores: (() => void)[] = [];
afterEach(async () => { for (const restore of restores.splice(0).reverse()) restore(); for (const planner of planners.splice(0)) { planner.stop(); await planner.running; } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(patch: Partial<PlannerDeps> = {}, initial?: object) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-planner-review-')); dirs.push(dir); const path = join(dir, '10001-boyfriend.json');
    if (initial) writeFileSync(path, JSON.stringify(initial));
    const logs: string[] = []; let sent = 0;
    const deps: PlannerDeps = { dir, contact: { qq: 10001, tier: 'boyfriend', name: '合成人' }, schedule, settings: { occasions: [], dailyMax: 3, unansweredMax: 1 }, dates: [], mode: 'on', now: () => at, log: line => logs.push(line), history: { load: () => [] }, names: { char: '合成角色', user: '合成人' }, waitUntil: (_time, signal) => new Promise(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve(); }), responder: { initiate: async request => { try { request.commit(['合成消息']); } catch { return { result: 'failed', reason: 'synthetic commit failure' }; } sent++; return { result: 'sent', parts: ['合成消息'], messageIds: [sent] }; } }, ...patch };
    const planner = makePlanner(deps); planners.push(planner);
    return { dir, path, planner, logs, sent: () => sent, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}
function failWrites(path: string, after = false) {
    const original = fileOps.renameSync; const delays = fileOps.writeDelaysMs; fileOps.writeDelaysMs = [0];
    fileOps.renameSync = ((from, to) => { if (String(to) === path) { if (after) original(from, to); throw Object.assign(new Error('PRIVATE_IO'), { code: 'EIO' }); } return original(from, to); }) as typeof original;
    const restore = () => { fileOps.renameSync = original; fileOps.writeDelaysMs = delays; }; restores.push(restore); return restore;
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { release, promise }; }
async function settles(promise: Promise<unknown>) { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise.then(() => true, () => false), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 200); })]); } finally { clearTimeout(timer); } }

test('发送前去重状态暂时写不进不能实际发送；恢复后保留不重放事实', async () => {
    const f = fixture(); const restore = failWrites(f.path); await f.planner.fireNow();
    assert.equal(f.sent(), 0); assert.equal(existsSync(f.path), false); restore(); f.planner.poke();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sent(), 0); assert.equal(f.read().records[0].result, 'skipped');
});
test('JSON已经发布后报错读回确认，不把去重提交误判失败或重复发送', async () => {
    const f = fixture(); failWrites(f.path, true); await f.planner.fireNow();
    assert.equal(f.sent(), 1); assert.equal(f.read().records.length, 1); assert.equal(f.read().records[0].result, 'sent');
    assert.ok(f.logs.every(line => !line.includes('PRIVATE_IO')));
});
test('相同时钟连续手动主动各有独立记录，未知状态扩展写回保留', async () => {
    const f = fixture({}, { version: 1, records: [], followUps: [], extracted: {}, extension: { keep: true } });
    await f.planner.fireNow(); await f.planner.fireNow();
    assert.equal(f.sent(), 2); assert.equal(f.read().records.length, 2); assert.deepEqual(f.read().extension, { keep: true });
});
test('停止让在途手动生成立即收束，迟到commit不能再写或重新标成故障暂停', async () => {
    const held = gate(); let entered = false;
    const f = fixture({ responder: { initiate: async request => { entered = true; await held.promise; try { request.commit(['合成晚消息']); } catch { return { result: 'failed', reason: 'synthetic stopped' }; } return { result: 'sent', parts: ['合成晚消息'], messageIds: [1] }; } } });
    const pending = f.planner.fireNow(); assert.equal(entered, true); f.planner.stop();
    try { assert.equal(await settles(pending), true); } finally { held.release(); await pending; }
    assert.equal(existsSync(f.path), false); assert.ok(f.logs.every(line => !line.includes('状态处理失败')));
});
test('停止收束不合作抽取，迟到拒绝不改计数/落盘或输出服务正文', async () => {
    const held = gate();
    const f = fixture({ history: { load: () => [{ role: 'user', content: '合成过去聊天', time: new Date(at - 2 * 3_600_000).toISOString() }] }, extract: async () => { await held.promise; throw new Error('PRIVATE_LATE_MODEL'); } });
    const pending = f.planner.syncFollowUps(); f.planner.stop();
    try { assert.equal(await settles(pending), true); } finally { held.release(); await pending; }
    assert.equal(existsSync(f.path), false); assert.ok(f.logs.every(line => !line.includes('PRIVATE_LATE_MODEL') && !line.includes('状态处理失败')));
});
test('抽取供应商错误原文不进日志，普通失败仍按既定次数保存', async () => {
    const f = fixture({ history: { load: () => [{ role: 'user', content: '合成过去聊天', time: new Date(at - 2 * 3_600_000).toISOString() }] }, extract: async () => { throw new Error('PRIVATE_MODEL_BLOB'); } });
    await f.planner.syncFollowUps(); assert.ok(f.logs.every(line => !line.includes('PRIVATE_MODEL_BLOB'))); assert.equal(Object.values(f.read().extracted)[0], 1);
});
test('未来历史不能把尚未确认结束的行程提前忘掉', async () => {
    const item = { id: 'synthetic-trip', what: '合成高铁到达', date: '2026-11-04', time: 'morning', episode: `ep-${at - 2 * 86400000}` };
    const f = fixture({ history: { load: () => [{ role: 'user', content: '未来才回来', time: new Date(at + 86400000).toISOString() }] } }, { version: 1, records: [], followUps: [item], extracted: {} });
    assert.equal(f.read().followUps.length, 1); assert.equal(f.planner.status().paused, undefined);
});
test('启动瞬时读取失败会重读真实旧状态，不能永久暂停或清空既有去重', async () => {
    const original = fileOps.readFileSync; const delays = fileOps.readDelaysMs; fileOps.readDelaysMs = [0]; let fail = true;
    fileOps.readFileSync = ((...args: Parameters<typeof original>) => { if (String(args[0]).endsWith('10001-boyfriend.json') && fail) throw Object.assign(new Error('PRIVATE_READ_IO'), { code: 'EIO' }); return (original as Function)(...args); }) as typeof original;
    restores.push(() => { fileOps.readFileSync = original; fileOps.readDelaysMs = delays; });
    const f = fixture({}, { version: 1, records: [{ id: '2026-11-05:share:old', occasion: 'share', at: new Date(at - 3600000).toISOString(), plannedAt: new Date(at - 3600000).toISOString(), result: 'sent' }], followUps: [], extracted: {} });
    assert.equal(f.sent(), 0); fail = false; f.planner.poke(); await new Promise(resolve => setImmediate(resolve));
    assert.match(f.planner.status().paused ?? '', /上一条主动消息他还没回/); assert.equal(f.planner.status().today, 1); assert.equal(f.read().records.length, 1);
});

test('commit之后即使错误误标unreachable也不能创建可重放的重试', async () => {
    const f = fixture({ responder: { initiate: async request => { request.commit(['合成消息']); return { result: 'failed', unreachable: true, reason: 'synthetic failure after commit' }; } } });
    await f.planner.fireNow(); assert.equal(f.read().records[0].retryAt, undefined);
});

test('手动请求没有可重建定时候选时，失败返回安全原因而不是承诺不会执行的重试', async () => {
    const f = fixture({ responder: { initiate: async () => ({ result: 'failed', unreachable: true, reason: 'PRIVATE_MODEL_REASON' }) } });
    assert.match((await f.planner.fireNow()) ?? '', /失败|没连上/); assert.equal(f.read().records[0].retryAt, undefined);
    assert.ok(f.logs.every(line => !line.includes('PRIVATE_MODEL_REASON')));
});

for (const fail of [false, true]) test(`跟进消费与发送预留同次提交，${fail ? '写失败不消费' : '提交后崩溃也不留下跨日重问入口'}`, async () => {
    const clock = new VirtualClock(new Date(2026, 10, 5, 17, 50)); const held = gate(); let committed = false;
    const item = { id: 'f-synthetic', what: '合成面试', date: '2026-11-05', time: 'afternoon', episode: `ep-${at - 86400000}` };
    const f = fixture({ now: clock.now, waitUntil: clock.waitUntil, settings: { occasions: ['follow_up'], dailyMax: 3, unansweredMax: 1 }, responder: { initiate: async request => { try { request.commit(['合成面试结果怎么样']); } catch { committed = true; return { result: 'failed', reason: 'synthetic commit blocked' }; } committed = true; await held.promise; return { result: 'sent', parts: ['合成面试结果怎么样'], messageIds: [1] }; } } }, { version: 1, records: [], followUps: [item], extracted: {} });
    const restore = fail ? failWrites(f.path) : () => {};
    try {
        for (let i = 0; i < 12 && !committed; i++) { const next = clock.nextTimer(); assert.ok(next !== undefined); clock.advanceTo(next); await new Promise(resolve => setImmediate(resolve)); }
        assert.equal(committed, true);
        assert.equal(f.read().followUps.length, fail ? 1 : 0);
        if (!fail) assert.equal(f.read().records[0].result, 'sent');
        f.planner.stop();
    } finally { restore(); f.planner.stop(); held.release(); await f.planner.running; }
});

test('未来念头不进入当前内心prompt或重复比较，也不提前占今日次数', async () => {
    for (const count of [1, 12]) {
        const clock = new VirtualClock(new Date(at)); const notes: string[] = [];
        const thoughts = Array.from({ length: count }, (_, i) => ({ id: `th-${at + 3600000 + i}`, at: new Date(at + 3600000 + i).toISOString(), text: 'FUTURE_UNIQUE合成事件', goes: 'keep' }));
        const f = fixture({ now: clock.now, waitUntil: clock.waitUntil, inner: true, responder: { initiate: async request => { notes.push(request.note); return { result: 'thought', text: '合成相机这件事情还要慢慢准备\n自己想想' }; } } }, { version: 1, records: [], followUps: [], extracted: {}, inner: { thoughts } });
        try { await new Promise(resolve => setImmediate(resolve)); assert.equal(notes.length, 1); assert.doesNotMatch(notes[0]!, /FUTURE_UNIQUE/); }
        finally { f.planner.stop(); await f.planner.running; }
    }
});

test('持续读取失败过宽限期失败关闭，恢复IO后仍需重新创建，保留磁盘去重事实', async () => {
    const original = fileOps.readFileSync; const delays = fileOps.readDelaysMs; fileOps.readDelaysMs = [0]; let current = at;
    fileOps.readFileSync = ((...args: Parameters<typeof original>) => { if (String(args[0]).endsWith('10001-boyfriend.json')) throw Object.assign(new Error('PRIVATE_PERSISTENT_READ'), { code: 'EIO' }); return (original as Function)(...args); }) as typeof original;
    const restore = () => { fileOps.readFileSync = original; fileOps.readDelaysMs = delays; }; restores.push(restore);
    const initial = { version: 1, records: [], followUps: [], extracted: {}, extension: 'keep' };
    const f = fixture({ now: () => current }, initial);
    current += 6 * 60_000; f.planner.poke(); await f.planner.running;
    assert.match(f.planner.status().paused ?? '', /已暂停/); restore(); f.planner.poke();
    assert.match((await f.planner.fireNow()) ?? '', /停/); assert.equal(f.sent(), 0); assert.deepEqual(f.read(), initial);
    assert.ok(f.logs.every(line => !line.includes('PRIVATE_PERSISTENT_READ')));
});

test('候选重试成功保留未知条目扩展，同时清除旧失败重试字段', async () => {
    const current = new Date(2026, 10, 5, 18, 20).getTime();
    const clock = new VirtualClock(new Date(current));
    const item = { id: 'f-synthetic', what: '合成面试', date: '2026-11-05', time: 'afternoon', episode: `ep-${at - 86400000}` };
    const record = { id: '2026-11-05:follow_up', occasion: 'follow_up', plannedAt: new Date(current - 20 * 60000).toISOString(), at: new Date(current - 19 * 60000).toISOString(), result: 'failed', tries: 1, retryAt: new Date(current - 4 * 60000).toISOString(), extension: { keep: true } };
    const f = fixture({ now: clock.now, waitUntil: clock.waitUntil, settings: { occasions: ['follow_up'], dailyMax: 3, unansweredMax: 1 } }, { version: 1, records: [record], followUps: [item], extracted: {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sent(), 1); const saved = f.read().records[0]; assert.deepEqual(saved.extension, { keep: true });
    assert.equal(saved.result, 'sent'); assert.equal(saved.retryAt, undefined); assert.equal(saved.tries, undefined);
});
