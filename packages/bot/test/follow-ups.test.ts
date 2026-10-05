import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { expired, extractionPrompt, firstAsk, parseExtraction, whenText, type FollowUp } from '../src/follow-ups.ts';
import type { StoredMessage } from '../src/history.ts';
import { blockReason, candidatesOn, occasionNote, type ProactiveInput } from '../src/proactive.ts';
import { createProactivePlanner, type Planner } from '../src/proactive-planner.ts';
import type { InitiateRequest } from '../src/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const day = (month: number, d: number) => new Date(2026, month - 1, d);
const item = (patch: Partial<FollowUp> = {}): FollowUp => ({ id: 'f-1', what: '字节的面试', date: '2026-10-09', time: 'afternoon', episode: 'ep-1', ...patch });
const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
    qq: 10001, schedule, settings: boyfriend.proactive!, dates: [], history: [], records: [], mode: 'on', ...patch,
});
const hm = (time: number) => new Date(time).toTimeString().slice(0, 5);

describe('待跟进：抽取的输入输出', () => {
    test('提示词带上还没问的事和聊天记录', () => {
        const [system, user] = extractionPrompt('—— 2026年10月8日 星期四 ——\n阿明 (07:32): 我明天下午面试', [item()], { user: '阿明', char: '林梦瑶' });
        assert.match(system!.content, /阿明自己之后要经历/);
        assert.match(system!.content, /resolved/);
        assert.equal(user!.content, '还没问的事：\n- f-1：2026-10-09 下午 字节的面试\n\n聊天记录：\n—— 2026年10月8日 星期四 ——\n阿明 (07:32): 我明天下午面试');
    });

    test('解析：取第一个 JSON 对象；说不出哪天的丢掉；time 不认识的按下午；不是 JSON 抛错', () => {
        const parsed = parseExtraction('好的：\n```json\n{"add":[{"what":"面试","date":"2026-10-09","time":"14:00"},{"what":"考试","date":"下周","time":"morning"},{"what":"看牙","date":"2026-10-10","time":"傍晚"}],"resolved":["f-1",3]}\n```');
        assert.deepEqual(parsed, {
            add: [{ what: '面试', date: '2026-10-09', time: '14:00' }, { what: '看牙', date: '2026-10-10', time: 'afternoon' }],
            resolved: ['f-1'],
        });
        assert.deepEqual(parseExtraction('{"add":[],"resolved":[]}'), { add: [], resolved: [] });
        assert.throws(() => parseExtraction('没有'), /没有 JSON/);
    });

    test('什么时候问、什么时候过期、怎么说', () => {
        assert.equal(firstAsk(item({ time: 'morning' })), t(10, 9, 12));
        assert.equal(firstAsk(item()), t(10, 9, 18));
        assert.equal(firstAsk(item({ time: '14:00' })), t(10, 9, 16));
        assert.equal(firstAsk(item({ time: 'evening' })), undefined);
        assert.equal(expired(item(), day(10, 12)), false);
        assert.equal(expired(item(), day(10, 13)), true);
        assert.equal(whenText(item(), day(10, 9)), '今天下午');
        assert.equal(whenText(item(), day(10, 10)), '昨天下午');
        assert.equal(whenText(item({ time: '14:00' }), day(10, 11)), '10月9日14:00');
    });
});

describe('待跟进：候选', () => {
    const followUp = (list: FollowUp[], d: Date) => candidatesOn(d, input({ followUps: list })).find(c => c.occasion === 'follow_up');

    test('下午的事当天 18:00–18:30 问；之前的日子没有；早安里提一句「今天下午有面试」', () => {
        const due = followUp([item()], day(10, 9))!;
        assert.ok(due.at >= t(10, 9, 18) && due.at <= t(10, 9, 18, 30), hm(due.at));
        assert.equal(due.id, '2026-10-09:follow_up');
        assert.match(occasionNote(due, '阿明'), /问问阿明今天下午的字节的面试怎么样了/);
        assert.equal(followUp([item()], day(10, 8)), undefined);

        const morning = candidatesOn(day(10, 9), input({ followUps: [item()] })).find(c => c.occasion === 'morning')!;
        assert.deepEqual(morning.today, ['下午字节的面试']);
        assert.match(occasionNote(morning, '阿明'), /阿明今天下午字节的面试，可以说句加油/);
    });

    test('晚上的事、第一天没问到的：之后几天并进早安（这天没有单独的早安）；过了 3 天就没有了', () => {
        const evening = item({ time: 'evening' });
        assert.equal(followUp([evening], day(10, 9)), undefined);
        const next = candidatesOn(day(10, 10), input({ followUps: [evening] }));
        const merged = next.find(c => c.occasion === 'follow_up')!;
        assert.equal(merged.followUp!.atMorning, true);
        assert.equal(next.find(c => c.occasion === 'morning'), undefined);
        assert.match(occasionNote(merged, '阿明'), /^\[这次是你主动找阿明：你起床没多久，跟阿明说早安，顺便问问阿明昨天晚上的字节的面试怎么样了/);
        assert.ok(followUp([item()], day(10, 12)));
        assert.equal(followUp([item()], day(10, 13)), undefined);
    });

    test('一天只问一件，挑最早该问的；那件事删了（他说了结果）就不发', () => {
        const a = item({ id: 'f-a', what: '面试', time: 'afternoon' });
        const b = item({ id: 'f-b', what: '考试', time: 'morning' });
        const due = followUp([a, b], day(10, 9))!;
        assert.equal(due.followUp!.item.id, 'f-b');
        const history: StoredMessage[] = [{ time: new Date(t(10, 9, 8)).toISOString(), role: 'user', content: '早' }, { time: new Date(t(10, 9, 8, 1)).toISOString(), role: 'assistant', content: '早' }];
        assert.equal(blockReason(due, due.at, input({ history, followUps: [a] })), '那件事已经了结');
        assert.equal(blockReason(due, due.at, input({ history, followUps: [a, b] })), undefined);
    });
});

describe('待跟进：计划器里记下、问过就忘、他说了结果就忘、过期就忘', () => {
    const dirs: string[] = [];
    const planners: Planner[] = [];
    afterEach(() => {
        for (const p of planners.splice(0)) p.stop();
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    function setup(start: Date, history: StoredMessage[], replies: string[]) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-followups-'));
        dirs.push(dir);
        const clock = new VirtualClock(start);
        const logs: string[] = [];
        const prompts: string[] = [];
        const initiated: InitiateRequest[] = [];
        // 只开待跟进：别的时机试运行发出去之后「他没回」，会先停（早安里提一句由上面的候选测试管）
        const planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings: { occasions: ['follow_up'], dailyMax: 2, unansweredMax: 1 }, dates: [], mode: 'dryRun',
            history: { load: () => history },
            responder: { initiate: async request => { initiated.push(request); request.commit(['好']); return { result: 'dryRun', parts: ['好'] }; } },
            dir, log: m => logs.push(m), now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '林梦瑶' },
            extract: async messages => { prompts.push(messages.at(-1)!.content); return replies.shift() ?? '{"add":[],"resolved":[]}'; },
        });
        planners.push(planner);
        const state = () => JSON.parse(readFileSync(join(dir, '10001-boyfriend.json'), 'utf8'));
        return { clock, planner, logs, prompts, initiated, state };
    }
    const msg = (time: number, role: 'user' | 'assistant', content: string): StoredMessage => ({ time: new Date(time).toISOString(), role, content });
    const settled = () => new Promise(r => setTimeout(r, 30));

    test('片段结束后抽一次；到时候问（试运行），问过就忘', async () => {
        const history = [msg(t(10, 8, 21), 'user', '我明天下午两点有面试'), msg(t(10, 8, 21, 1), 'assistant', '加油')];
        const { clock, planner, logs, prompts, initiated, state } = setup(new Date(t(10, 8, 22)), history, ['{"add":[{"what":"字节的面试","date":"2026-10-09","time":"14:00"}],"resolved":[]}']);
        await planner.syncFollowUps();
        assert.equal(prompts.length, 1);
        assert.match(prompts[0]!, /阿明 \(21:00\): 我明天下午两点有面试/);
        assert.ok(logs.includes('待跟进：记下「字节的面试」（2026-10-09 14:00）'));
        assert.equal(state().followUps.length, 1);
        await planner.syncFollowUps();
        assert.equal(prompts.length, 1, '同一个片段不再抽');

        // 拨到 10-09 16:00 之后问面试
        for (let i = 0; i < 6 && !initiated.some(r => r.label.startsWith('待跟进')); i++) {
            await settled();
            const next = clock.nextTimer();
            if (next === undefined) break;
            clock.advanceTo(next);
        }
        await settled();
        const asked = initiated.find(r => r.label.startsWith('待跟进'))!;
        assert.ok(asked, initiated.map(r => r.label).join());
        assert.match(asked.note, /问问阿明今天14:00的字节的面试怎么样了/);
        assert.match(asked.topic, /^阿明今天14:00的字节的面试；/);
        assert.equal(initiated.length, 1);
        assert.deepEqual(state().followUps, []);
        assert.ok(logs.some(l => l.startsWith('待跟进：试运行里问过了，忘掉「字节的面试」')));
    });

    test('他自己先说了结果：下一段抽的时候了结，删掉；过了 3 天没问到的也删', async () => {
        const history = [
            msg(t(10, 8, 21), 'user', '我明天下午两点有面试'),
            msg(t(10, 9, 15), 'user', '面试过了！'),
        ];
        const { planner, logs, state } = setup(new Date(t(10, 9, 16)), history, [
            '{"add":[{"what":"字节的面试","date":"2026-10-09","time":"14:00"},{"what":"体检","date":"2026-10-01","time":"morning"}],"resolved":[]}',
            '{"add":[],"resolved":["f-' + t(10, 8, 21) + '-1"]}',
        ]);
        await planner.syncFollowUps();
        assert.ok(logs.includes('待跟进：他已经说了结果，忘掉「字节的面试」（2026-10-09 14:00）'), logs.join('\n'));
        assert.equal(logs.some(l => l.includes('体检')), false, '已经过期的不记');
        assert.deepEqual(state().followUps, []);
    });
});
