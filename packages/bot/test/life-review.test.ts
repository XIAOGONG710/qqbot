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
import { judgeAction, type ActionContext } from '../src/life/actions.ts';
import { bodyAt } from '../src/life/body.ts';
import { wakeOn } from '../src/life/schedule.ts';
import { Tastes } from '../src/life/tastes.ts';
import { Acquaintances, acquaintancesAccount, classifyKind } from '../src/life/acquaintances.ts';
import type { BiliAccount, ReplyItem } from '../src/bilibili/bilibili-account.ts';

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

test('提前约定改地点和正文保留 ID 并采用新内容；未变化时不重复记录', async () => {
    const dir = fixture(); const logs: string[] = [];
    const chat: StoredMessage[] = [
        { role: 'user', content: '今晚六点一起吃饭', time: '2026-11-05T11:50:00+08:00' },
        { role: 'assistant', content: '好呀，六点东门见面', time: '2026-11-05T11:51:00+08:00' },
    ];
    let calls = 0;
    const service = keeper(dir, logs, async () => JSON.stringify({ add: [{ what: ++calls === 1 ? '东门吃饭' : '西门吃饭', date: '2026-11-05',
        meet: { time: '18:00', where: calls === 1 ? '东门' : '西门' } }] }), chat);
    await service.sync();
    const old = (JSON.parse(readFileSync(statePath(dir), 'utf8')) as PromiseState).promises[0]!;
    chat.push({ role: 'user', content: '改成六点西门见面，吃一个小时', time: '2026-11-05T11:55:00+08:00' });
    await service.sync();
    const changed = (JSON.parse(readFileSync(statePath(dir), 'utf8')) as PromiseState).promises;
    assert.equal(changed.length, 1);
    assert.equal(changed[0]!.id, old.id);
    assert.equal(changed[0]!.what, '西门吃饭');
    assert.deepEqual(changed[0]!.meet, { time: '18:00', where: '西门', minutes: 90 });
    const logged = logs.length;
    chat.push({ role: 'assistant', content: '好，六点一起吃饭', time: '2026-11-05T11:56:00+08:00' });
    await service.sync();
    assert.equal(calls, 3);
    assert.equal(logs.length, logged);
});

test('所有行动拒绝非法显式时长，固定时段也必须有限且正向', () => {
    const start = new Date('2026-11-05T12:00:00+08:00'); const end = new Date('2026-11-05T12:30:00+08:00');
    const context = { schedule, world: { routine: { meals: [{ kind: 'lunch', start, end, where: 'canteen' }] } } } as ActionContext;
    for (const durationMinutes of [-10, 0, NaN, Infinity, -Infinity, 0.01]) {
        for (const kind of ['eat', 'sleep', 'attend_class', 'meet', 'rest'] as const) {
            const verdict = judgeAction({ id: 'bad', kind, startedAt: start, durationMinutes }, context);
            assert.equal(verdict.ok, false, `${kind}: ${durationMinutes}`);
            if (!verdict.ok) assert.equal(verdict.reason, 'invalid_time');
        }
    }
    const good = judgeAction({ id: 'meal', kind: 'eat', startedAt: start, durationMinutes: 10 }, context);
    assert.equal(good.ok, true);
    if (good.ok) assert.equal(good.actualMinutes, 10);
    const defaultMeal = judgeAction({ id: 'default', kind: 'eat', startedAt: start }, context);
    assert.equal(defaultMeal.ok, true);
    if (defaultMeal.ok) assert.equal(defaultMeal.actualMinutes, 30);
    for (const invalidEnd of [start, new Date(start.getTime() - 1), new Date(NaN)]) {
        const verdict = judgeAction({ id: 'meet', kind: 'meet', startedAt: start }, { schedule,
            appointments: [{ id: 'meet', start, end: invalidEnd, subject: '见面', target: 'user', meal: false }] });
        assert.equal(verdict.ok, false);
        if (!verdict.ok) assert.equal(verdict.reason, 'invalid_time');
    }
});

test('早课困倦不受起床抖动影响，描述采用真实起床时间；无早课不误判', { skip: 'DSH 线的决定（ADR 0219，她说「别给我按课表编个『早八所以很累』出来」）：起床有浮动以后不再按课表推早上的困，早上的困只从真实的昨晚来；这条按 main 的修法写的测试和它相反，合并时保留 DSH 线的行为' }, () => {
    const early: Schedule = { ...schedule, wake: { ...schedule.wake, jitter: { from: '2026-09-01', spreadMin: 10, weekendMin: 0 } },
        courses: [1, 2, 3, 4, 5].map(day => ({ day, slot: 'one', weeks: '1-20', kind: 'hard', name: '高等数学' })) };
    const signs = new Set<number>();
    for (let offset = 0; offset < 28; offset++) {
        const date = new Date(2026, 10, 2 + offset, 10);
        if (date.getDay() === 0 || date.getDay() === 6) { assert.equal(bodyAt({}, early, date).sleepy, undefined); continue; }
        const woke = wakeOn(early, date);
        const baseline = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 7, 40);
        signs.add(Math.sign(woke.getTime() - baseline.getTime()));
        const sleepy = bodyAt({}, early, date).sleepy;
        assert.equal(sleepy?.when, 'morning');
        if (sleepy?.when === 'morning') assert.equal(sleepy.woke, woke.toTimeString().slice(0, 5));
        assert.equal(bodyAt({}, early, new Date(woke.getTime() - 1)).sleepy, undefined);
    }
    assert.ok(signs.has(-1) && signs.has(1));
});

test('偏好反思忽略非法提案并继续处理有效项，保存结果且维持每日上限', async () => {
    const dir = fixture(); let calls = 0;
    const valid = (name: string) => ({ name, why: '多次真实体验', stance: 'like', refs: ['e0', 'e1'] });
    const service = new Tastes({ dataDir: dir, now: () => now,
        experiences: () => Array.from({ length: 6 }, (_, i) => ({ ref: `e${i}`, at: now.toISOString(), kind: '休闲', text: '玩游戏' })),
        ask: async () => { calls++; return JSON.stringify([null, [], '错误', false, valid('独立游戏'), valid('摄影'), valid('阅读')]); } });
    assert.equal(await service.reflect(), 2);
    assert.deepEqual(service.list().map(t => t.name), ['独立游戏', '摄影']);
    assert.equal(await service.reflect(), 0);
    assert.equal(calls, 1);
});

test('同一平台回复重放不制造再次相遇；重启和摘录淘汰后仍去重，不同回复保留', async () => {
    const dir = fixture(); let people = new Acquaintances({ dataDir: dir, now: () => now });
    const reply: ReplyItem = { id: 'reply-1', root: 'root', parent: 'parent', aid: 1, title: '', uid: 7, name: '合成昵称', text: '你好', mine: '', at: now.getTime() };
    let replies = [reply];
    const account = () => acquaintancesAccount({ fetchReplies: async () => replies } as BiliAccount, people);
    await account().fetchReplies();
    await account().fetchReplies();
    assert.equal(people.list()[0]!.encounters.length, 1);
    assert.equal(people.promptLine(), undefined);
    // 同一秒、同一内容的另一个平台事件仍是真正的第二次互动。
    replies = [{ ...reply, id: 'reply-2' }];
    await account().fetchReplies();
    assert.equal(people.list()[0]!.encounters.length, 2);
    assert.ok(people.promptLine());
    for (let i = 3; i <= 12; i++) {
        replies = [{ ...reply, id: `reply-${i}`, at: now.getTime() + i }];
        await account().fetchReplies();
    }
    people = new Acquaintances({ dataDir: dir, now: () => now });
    const before = people.list()[0]!.encounters;
    replies = [reply];
    await account().fetchReplies();
    assert.deepEqual(people.list()[0]!.encounters, before);
});

test('无平台事件 ID 的相同观察可去重；截断摘录相同但完整内容不同不能误去重', () => {
    const people = new Acquaintances({ dataDir: fixture(), now: () => now });
    const observation = { platform: 'test', uid: '1', name: '测试', where: '评论区', what: '长'.repeat(40) + '甲', at: now };
    people.observe(observation); people.observe(observation);
    assert.equal(people.list()[0]!.encounters.length, 1);
    people.observe({ ...observation, what: '长'.repeat(40) + '乙' });
    assert.equal(people.list()[0]!.encounters.length, 2);
});

test('讨论 AI 产品或社区不推断身份，明确自称及人工更正仍生效', () => {
    for (const text of ['我最近在用ChatGPT写代码', '推荐Claude吗', '我是摄影师，最近用豆包', '大肥鱼这条视频不错', '我不是AI', '我是在用ChatGPT']) {
        assert.equal(classifyKind(text), 'unknown', text);
    }
    for (const text of ['我是 AI 伙伴', '我是一个人工智能助手', '作为一个 AI，我想学习', '我是ChatGPT']) assert.equal(classifyKind(text), 'ai', text);
    const people = new Acquaintances({ dataDir: fixture(), now: () => now });
    const observation = { platform: 'test', uid: '1', name: '测试', where: '评论区', what: '我是AI伙伴' };
    people.observe(observation);
    people.observe({ ...observation, what: '身份由作者确认', kind: 'human' });
    assert.equal(people.list()[0]!.kind, 'human');
});
