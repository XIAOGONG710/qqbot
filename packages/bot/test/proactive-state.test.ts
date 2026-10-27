import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileOps } from '../src/memory/json-file.ts';
import { createProactivePlanner, type Planner, type PlannerDeps } from '../src/proactive/proactive-planner.ts';
import { emptyProactiveState, readProactiveState, validProactiveState } from '../src/proactive/proactive-state.ts';
import { TRANSIENT_GRACE_MS } from '../src/memory/transient-io.ts';
import { checkStates } from '../src/ops/state-check.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const dirs: string[] = [];
const planners: Planner[] = [];
afterEach(() => {
    planners.splice(0).forEach(p => p.stop());
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-proactive-state-')); dirs.push(dir); return dir; };
const at = '2026-10-14T09:00:00+08:00';
const record = { id: '2026-10-14:morning', occasion: 'morning', plannedAt: at, at, result: 'sent', messageIds: [1] };
const followUp = { id: 'f-1', what: '面试', date: '2026-10-15', time: '14:00', episode: 'ep-0', missed: 1 };
const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));

function deps(dir: string, patch: Partial<PlannerDeps> = {}): PlannerDeps {
    return { dir, contact: { qq: 10001, name: '阿明', tier: 'boyfriend' }, schedule: card.schedule!,
        settings: { occasions: [], dailyMax: 2, unansweredMax: 1 }, dates: [], mode: 'on', names: { char: card.name, user: '阿明' },
        now: () => Date.parse(at), history: { load: () => [] }, responder: { initiate: async () => assert.fail('不应发消息') },
        log: () => {}, waitUntil: (_at, signal) => new Promise(done => signal.addEventListener('abort', () => done(), { once: true })), ...patch };
}

test('旧主动文件保留已发送记录并补可选旧字段；迁移只在内存，已有空对象不算新状态', () => {
    const dir = fixture(); const path = join(dir, 'state.json');
    assert.deepEqual(readProactiveState(path), emptyProactiveState());
    const original = JSON.stringify({ records: [record] }); writeFileSync(path, original);
    assert.deepEqual(readProactiveState(path), { version: 1, records: [record], followUps: [], extracted: {} });
    assert.equal(readFileSync(path, 'utf8'), original);
    writeFileSync(path, '{}'); assert.throws(() => readProactiveState(path), /暂停主动消息/);
});

test('未知版本、字段缺失、重复记录或跟进 id 以及语义坏字段均失败关闭，原文件不重建', () => {
    const dir = fixture(); const path = join(dir, 'state.json'); const base = emptyProactiveState();
    for (const value of [null, [], { version: 2 }, { ...base, records: null }, { version: 1, records: [] },
        { ...base, records: [record, record] }, { ...base, records: [{ ...record, occasion: 'quiet' }] },
        { ...base, records: [{ ...record, at: '2026-02-30T09:00:00Z' }] },
        { ...base, records: [{ ...record, result: 'maybe' }] }, { ...base, records: [{ ...record, messageIds: ['1'] }] },
        { ...base, followUps: [followUp, followUp] }, { ...base, followUps: [{ ...followUp, date: '2026-02-30' }] },
        { ...base, followUps: [{ ...followUp, time: '25:00' }] }, { ...base, followUps: [{ ...followUp, missed: 2 }] },
        { ...base, extracted: { 'ep-0': false } }, { ...base, extracted: { 'ep-0': 3 } }, { ...base, extracted: { bad: true } }]) {
        const original = JSON.stringify(value); writeFileSync(path, original);
        assert.throws(() => readProactiveState(path), /原文件未重建/);
        assert.equal(readFileSync(path, 'utf8'), original);
        assert.deepEqual(readdirSync(dir), ['state.json']);
    }
});

test('重试必须是未发送且未耗尽的失败，时间合法；不能用矛盾标记重复发送', () => {
    const base = { ...record, result: 'failed', messageIds: undefined, tries: 1, retryAt: '2026-10-14T09:15:00+08:00' };
    assert.equal(validProactiveState({ ...emptyProactiveState(), records: [base] }), true);
    for (const patch of [{ result: 'sent' }, { tries: 3 }, { tries: 0 }, { messageIds: [1] }, { retryAt: at }, { retryAt: 'bad' }]) {
        assert.equal(validProactiveState({ ...emptyProactiveState(), records: [{ ...base, ...patch }] }), false);
    }
    assert.equal(validProactiveState({ ...emptyProactiveState(), records: [{ ...record, result: 'failed', tries: 3 }] }), true, '失败且有部分发送时保留事实，但不能安排自动重试');
});

test('坏状态只暂停这一位的计划器：不读聊天、不调用模型/发送/定时器，日志不回显正文', async () => {
    const dir = fixture(); const path = join(dir, '10001-boyfriend.json'); const original = 'PRIVATE_BAD_STATE not json';
    writeFileSync(path, original);
    const logs: string[] = [];
    const planner = createProactivePlanner(deps(dir, { log: line => logs.push(line),
        history: { load: () => assert.fail('不应读聊天') }, extract: async () => assert.fail('不应抽取'),
        waitUntil: async () => assert.fail('不应启动计时器') }));
    planners.push(planner);
    await planner.running; planner.poke(); await planner.syncFollowUps();
    assert.match(planner.status().paused!, /状态读取或校验失败/);
    assert.equal(planner.status().next, undefined);
    assert.ok(logs.every(line => !line.includes('PRIVATE_BAD_STATE')));
    assert.equal(readFileSync(path, 'utf8'), original);
});

test('可信旧状态下次正常写入存成 v1，抽取完成进度持久化', async () => {
    const dir = fixture(); const path = join(dir, '10001-boyfriend.json');
    writeFileSync(path, JSON.stringify({ records: [] }));
    let calls = 0;
    const planner = createProactivePlanner(deps(dir, {
        history: { load: () => [{ time: '2026-10-13T10:00:00+08:00', role: 'user', content: '明天下午面试' }] },
        extract: async () => { calls++; return '{"add":[],"resolved":[]}'; },
    })); planners.push(planner);
    await planner.syncFollowUps();
    assert.equal(calls, 1);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
    assert.ok(Object.values(readProactiveState(path).extracted).includes(true));
    await planner.syncFollowUps(); assert.equal(calls, 1);
});

test('写盘持续失败（目标路径是目录）：超过宽限期暂停计划器及后续抽取，不产生未处理拒绝', async () => {
    const dir = fixture(); const path = join(dir, '10001-boyfriend.json');
    const delays = fileOps.writeDelaysMs;
    fileOps.writeDelaysMs = [0]; // 不真等重试间隔
    let calls = 0; let clock = Date.parse(at);
    const planner = createProactivePlanner(deps(dir, {
        now: () => clock,
        history: { load: () => [{ time: '2026-10-13T10:00:00+08:00', role: 'user', content: '明天下午面试' }] },
        extract: async () => { calls++; return '{"add":[],"resolved":[]}'; },
    })); planners.push(planner);
    mkdirSync(path);
    try {
        await planner.syncFollowUps();
        // 目标是个目录：Windows 上报 EPERM（和杀毒软件短暂占文件同一个码），先当暂时的撑着；持续超过宽限期才暂停（其他系统的 EISDIR 会更早暂停，同样通过）
        clock += TRANSIENT_GRACE_MS + 1000;
        planner.poke(); await planner.running;
    } finally {
        fileOps.writeDelaysMs = delays;
    }
    assert.match(planner.status().paused!, /状态处理失败/);
    planner.poke(); await planner.syncFollowUps(); assert.equal(calls, 1);
    assert.deepEqual(readdirSync(path), []);
});

test('离线检查调用同一主动 schema，合法 JSON 中的坏发送记录也不通过', () => {
    const dir = fixture(); mkdirSync(join(dir, 'proactive'));
    const path = join(dir, 'proactive', '10001-boyfriend.json');
    const original = JSON.stringify({ records: [{ ...record, at: 'bad' }] }); writeFileSync(path, original);
    assert.equal(checkStates(dir).find(c => c.name === 'proactive/10001-boyfriend.json')!.ok, false);
    assert.equal(readFileSync(path, 'utf8'), original);
});
