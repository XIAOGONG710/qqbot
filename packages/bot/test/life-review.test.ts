import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { diaryWriter } from '../src/life/diary.ts';
import { parsePromises, promiseKeeper } from '../src/life/promises.ts';
import { emptyPromiseState, type PromiseState } from '../src/life/promise-state.ts';
import type { Schedule } from '../src/life/schedule.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { SENSITIVE_OFF, SENSITIVE_ON, useSensitiveSwitch } from '../src/platform/sensitive.ts';

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-life-review-')); dirs.push(dir); return dir; };
afterEach(() => {
    useSensitiveSwitch(SENSITIVE_OFF);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const now = new Date('2026-11-05T12:00:00+08:00');
const schedule: Schedule = {
    sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' } },
    semester: { start: '2026-09-07', weeks: 20 }, holidays: [], makeups: [],
    kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍',
};
const history: StoredMessage[] = [
    { role: 'user', content: '今晚六点东门见', time: '2026-11-05T10:00:00+08:00' },
    { role: 'assistant', content: '好呀，六点见', time: '2026-11-05T10:01:00+08:00' },
];
const episode = `ep-${Date.parse(history[0]!.time)}`;
const statePath = (dir: string) => join(dir, '1-boyfriend.json');
const keeper = (dir: string, logs: string[], extract: () => Promise<string>, chat = history) => promiseKeeper({
    contacts: [{ qq: 1, name: '测试用户', tier: 'boyfriend' }], history: { load: () => chat },
    names: () => ({ user: '测试用户', char: '测试角色' }), schedule, dir, now: () => now.getTime(),
    log: line => logs.push(line), extract,
});

for (const mode of ['expired', 'resolved'] as const) for (const sensitive of [false, true]) {
    test(`挂起事项${mode}日志遵守敏感开关 ${sensitive}`, async () => {
        useSensitiveSwitch(sensitive ? SENSITIVE_ON : SENSITIVE_OFF);
        const dir = fixture(); const logs: string[] = []; const secret = '合成隐私内容标记';
        const state = emptyPromiseState();
        state.loops.push({ id: 'u-test', kind: 'unsettled', what: secret, said: mode === 'expired' ? '2026-10-25' : '2026-11-04', episode: 'ep-1' });
        writeFileSync(statePath(dir), JSON.stringify(state));
        await keeper(dir, logs, async () => '{"add":[],"resolved":["u-test"]}', mode === 'expired' ? [] : history).sync();
        const line = logs.find(line => line.includes(mode === 'expired' ? '过了几天' : '了结'));
        assert.ok(line);
        assert.equal(line.includes(secret), sensitive);
        assert.deepEqual((JSON.parse(readFileSync(statePath(dir), 'utf8')) as PromiseState).loops, []);
    });
}

test('抽取失败不把模型正文写进错误信息', () => {
    for (const text of ['合成机密正文', '{"add":[合成机密正文]}']) {
        assert.throws(() => parsePromises(text), error => error instanceof Error && !error.message.includes('合成机密正文'));
    }
});

test('抽取拒绝错误对象与错误数组类型，同时兼容部分字段的旧结果', () => {
    for (const text of ['{}', '{"error":"failed"}', '{"add":[],"resolved":null}', '{"world":{}}', '[{"add":[]}]', '```json\n[{"add":[]}]\n```']) {
        assert.throws(() => parsePromises(text), text);
    }
    assert.deepEqual(parsePromises('{"add":[]}').add, []);
    assert.deepEqual(parsePromises('{"world":[]}').world, []);
    assert.deepEqual(parsePromises('{"add":[],"resolved":[]}').resolved, []);
});

test('错误抽取不清除提前约定、不标记成功；下轮有效结果能重试', async () => {
    const dir = fixture(); const state = emptyPromiseState();
    state.promises.push({ id: 'p-early', what: '东门见面', date: '2026-11-05', said: '2026-11-05', episode,
        meet: { time: '18:00', where: '东门', minutes: 90 }, early: true });
    writeFileSync(statePath(dir), JSON.stringify(state));
    let attempts = 0;
    const service = keeper(dir, [], async () => ++attempts === 1 ? '{"error":"failed"}' : '{"add":[{"what":"西门见面","date":"2026-11-05","meet":{"time":"18:00","where":"西门"}}],"resolved":[]}');
    await service.sync();
    const failed = JSON.parse(readFileSync(statePath(dir), 'utf8')) as PromiseState;
    assert.equal(failed.extracted[episode], 1);
    assert.deepEqual(failed.promises, state.promises);
    await service.sync();
    const recovered = JSON.parse(readFileSync(statePath(dir), 'utf8')) as PromiseState;
    assert.equal(attempts, 2);
    assert.equal(recovered.extracted[episode], true);
    assert.equal(recovered.promises[0]!.meet!.where, '西门');
});

for (const missing of [undefined, '', '   ']) for (const partial of [false, true]) {
    test(`已写日记暂缺原文 ${String(missing)} partial=${partial} 不结算周记或阶段总结，恢复后重试`, async () => {
        const dir = fixture(); const summaries: string[] = []; let recovered = false;
        const written = Object.fromEntries(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'].map(date => [date, 10]));
        const texts = Object.fromEntries(['2026-11-02', '2026-11-03', '2026-11-04'].map(date => [date, `${date} 原文`]));
        if (partial) { written['2026-10-31'] = 10; texts['2026-10-31'] = '另一篇日记'; }
        writeFileSync(join(dir, 'diary.json'), JSON.stringify({ written, texts, weeks: {}, phases: {} }));
        const memory = {
            readDiary: async () => recovered ? '找回的原文' : missing,
            retainDiary: async () => true,
            retainSummary: async (id: string) => { summaries.push(id); return true; },
        } as unknown as LongTermMemory;
        const service = diaryWriter({ sources: { charName: '测试角色', schedule: { ...schedule, holidays: [{ start: '2026-10-31', end: '2026-11-01', name: '测试假期' }] }, moods: [], books: [] },
            contacts: [], history: { load: () => [] }, dir, memory, log: () => {}, generate: async () => '总结' });
        await service.catchUp(now);
        const failed = JSON.parse(readFileSync(join(dir, 'diary.json'), 'utf8'));
        assert.equal(failed.weeks['2026-10-26'], undefined);
        assert.equal(failed.phases['测试假期:2026-11-01'], undefined);
        assert.deepEqual(summaries, []);
        recovered = true;
        await service.catchUp(now);
        assert.deepEqual(summaries, ['week:2026-10-26', 'phase:测试假期:2026-11-01']);
        await service.catchUp(now);
        assert.equal(summaries.length, 2);
    });
}

test('周记已完成时，阶段总结也会等待缺失日记并在恢复后重试', async () => {
    const dir = fixture(); const summaries: string[] = []; let recovered = false;
    writeFileSync(join(dir, 'diary.json'), JSON.stringify({
        written: { '2026-11-02': 10, '2026-11-03': 10, '2026-11-04': 10 },
        texts: { '2026-11-02': ' ', '2026-11-03': '另一篇原文', '2026-11-04': '原文' },
        weeks: { '2026-10-19': 0, '2026-10-26': 0 }, phases: {},
    }));
    const memory = { readDiary: async () => recovered ? '找回的原文' : undefined,
        retainSummary: async (id: string) => { summaries.push(id); return true; }, retainDiary: async () => true } as unknown as LongTermMemory;
    const service = diaryWriter({ sources: { charName: '测试角色', schedule: { ...schedule, holidays: [{ start: '2026-11-02', end: '2026-11-03', name: '测试假期' }] }, moods: [], books: [] },
        contacts: [], history: { load: () => [] }, dir, memory, log: () => {}, generate: async () => '总结' });
    await service.catchUp(now);
    assert.deepEqual(summaries, []);
    assert.equal(JSON.parse(readFileSync(join(dir, 'diary.json'), 'utf8')).phases['测试假期:2026-11-03'], undefined);
    recovered = true;
    await service.catchUp(now);
    assert.deepEqual(summaries, ['phase:测试假期:2026-11-03']);
});
