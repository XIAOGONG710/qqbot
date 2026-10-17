import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { aboutHer, expired, extractionPrompt, firstAsk, mentions, parseExtraction, tripAlreadyOver, whenText, type FollowUp } from '../src/follow-ups.ts';
import type { StoredMessage } from '../src/history.ts';
import { ModelUnreachable } from '../src/llm.ts';
import { blockReason, candidatesOn, occasionNote, type ProactiveInput } from '../src/proactive.ts';
import { createProactivePlanner, type Planner } from '../src/proactive-planner.ts';
import type { InitiateRequest, ResponderStatus } from '../src/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { SENSITIVE_OFF, SENSITIVE_ON, useSensitiveSwitch } from '../src/sensitive.ts';

// 这个文件里的测试靠日志里的原文来断言模块的行为；日志默认不写原文的那条由 log-bodies.test.ts 管
useSensitiveSwitch(SENSITIVE_ON);

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
        assert.match(system!.content, /凌晨（0 点到 5 点）还没睡时说的「明天」/);
        assert.match(system!.content, /冲着林梦瑶的事/);
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

    function setup(start: Date, history: StoredMessage[], replies: (string | Error)[], settings = { occasions: ['follow_up' as const], dailyMax: 2, unansweredMax: 1 }, said = ['面试咋样了']) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-followups-'));
        dirs.push(dir);
        const clock = new VirtualClock(start);
        const logs: string[] = [];
        const prompts: string[] = [];
        const initiated: InitiateRequest[] = [];
        // 只开待跟进：别的时机试运行发出去之后「他没回」，会先停（早安里提一句由上面的候选测试管）
        const planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings, dates: [], mode: 'dryRun',
            history: { load: () => history },
            responder: { initiate: async request => { initiated.push(request); request.commit(said); return { result: 'dryRun', parts: said }; } },
            dir, log: m => logs.push(m), now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '林梦瑶' },
            extract: async messages => {
                prompts.push(messages.at(-1)!.content);
                const reply = replies.shift() ?? '{"add":[],"resolved":[]}';
                if (reply instanceof Error) throw reply;
                return reply;
            },
        });
        planners.push(planner);
        const state = () => JSON.parse(readFileSync(join(dir, '10001-boyfriend.json'), 'utf8'));
        return { clock, planner, logs, prompts, initiated, state };
    }
    const msg = (time: number, role: 'user' | 'assistant', content: string): StoredMessage => ({ time: new Date(time).toISOString(), role, content });
    const settled = () => new Promise(r => setTimeout(r, 30));

    test('断网时没连上模型不算失败次数，网络好了照样抽（10-08 上午断网 40 分钟丢过一段）', async () => {
        const history = [msg(t(10, 8, 21), 'user', '我明天下午两点有面试'), msg(t(10, 8, 21, 1), 'assistant', '加油')];
        const offline = new ModelUnreachable('模型接口请求失败（ENOTFOUND：getaddrinfo ENOTFOUND api.deepseek.com）');
        const { planner, logs, prompts, state } = setup(new Date(t(10, 8, 22)), history, [offline, offline, offline, offline, '{"add":[{"what":"字节的面试","date":"2026-10-09","time":"14:00"}],"resolved":[]}']);
        for (let i = 0; i < 5; i++) await planner.syncFollowUps();
        assert.equal(prompts.length, 5);
        assert.equal(logs.filter(l => l.includes('没连上模型，等网络好了再抽')).length, 4);
        assert.ok(!logs.some(l => l.includes('抽取失败')));
        assert.equal(state().followUps.length, 1);
    });

    test('危机相关的片段不抽成待跟进（ADR 0068 决策 8）：不调模型、记为抽过，不会第二天主动提起；平常的片段照抽', async () => {
        const history = [
            msg(t(10, 8, 21), 'user', '我不想活了'), msg(t(10, 8, 21, 1), 'assistant', '我在，你现在安全吗'), msg(t(10, 8, 21, 2), 'user', '明天下午两点还有面试'),
        ];
        const { planner, prompts, state } = setup(new Date(t(10, 8, 22)), history, ['{"add":[{"what":"面试","date":"2026-10-09","time":"14:00"}],"resolved":[]}']);
        await planner.syncFollowUps();
        assert.equal(prompts.length, 0, '危机片段不送去抽');
        assert.deepEqual(state().followUps, []);
        await planner.syncFollowUps();
        assert.equal(prompts.length, 0, '记成抽过了，下次也不抽');
    });

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

    test('敏感调试关着时：记下、问过就忘的日志只剩字数，没有原文（ADR 0070 第 8 项）', async () => {
        useSensitiveSwitch(SENSITIVE_OFF);
        try {
            const history = [msg(t(10, 8, 21), 'user', '我明天下午两点有面试'), msg(t(10, 8, 21, 1), 'assistant', '加油')];
            const { clock, planner, logs, initiated } = setup(new Date(t(10, 8, 22)), history, ['{"add":[{"what":"字节的面试","date":"2026-10-09","time":"14:00"}],"resolved":[]}']);
            await planner.syncFollowUps();
            assert.ok(logs.includes('待跟进：记下「（5 字）」（2026-10-09 14:00）'), logs.join(' | '));
            for (let i = 0; i < 6 && !initiated.some(r => r.label.startsWith('待跟进')); i++) {
                await settled();
                const next = clock.nextTimer();
                if (next === undefined) break;
                clock.advanceTo(next);
            }
            await settled();
            assert.ok(initiated.some(r => r.label.startsWith('待跟进')), '问过了');
            assert.ok(logs.some(l => l.startsWith('待跟进：试运行里问过了，忘掉「（5 字）」')), logs.join(' | '));
            assert.ok(!logs.some(l => l.includes('字节')), logs.join(' | '));
        } finally {
            useSensitiveSwitch(SENSITIVE_ON);
        }
    });

    test('条数留给了待跟进：下课到点时没排上，记录和日志写的是这个原因（不是「他没回」）', async () => {
        const history = [msg(t(10, 8, 21), 'user', '我明天下午两点有面试'), msg(t(10, 8, 21, 1), 'assistant', '加油')];
        const { clock, planner, logs, initiated, state } = setup(new Date(t(10, 9, 6)), history,
            ['{"add":[{"what":"面试","date":"2026-10-09","time":"14:00"}],"resolved":[]}'],
            { occasions: ['morning', 'after_class', 'follow_up'] as never, dailyMax: 2, unansweredMax: 10 });
        await planner.syncFollowUps();
        for (let i = 0; i < 8 && initiated.length < 2; i++) {
            await settled();
            const next = clock.nextTimer();
            if (next === undefined) break;
            clock.advanceTo(next);
        }
        await settled();
        assert.deepEqual(initiated.slice(0, 2).map(r => r.label.replace(/（.*$/, '')), ['早安', '待跟进的事']);
        const skipped = state().records.find((r: { occasion: string }) => r.occasion === 'after_class');
        assert.equal(skipped?.reason, '今天的条数留给了别的时机', logs.join('\n'));
    });

    test('行程过去了、他后来又来聊过：不用再问；有结果的事、他还没来过的照旧（10-09 线上「到济南」）', () => {
        const trip = { what: '到济南', date: '2026-10-07', time: '17:44' };
        assert.ok(tripAlreadyOver(trip, [{ time: '2026-10-08T20:14:00+08:00' }]), '8 号晚上聊过了');
        assert.ok(!tripAlreadyOver(trip, [{ time: '2026-10-07T18:00:00+08:00' }]), '到了才 16 分钟，还没算');
        assert.ok(!tripAlreadyOver(trip, []));
        assert.ok(tripAlreadyOver({ what: '坐高铁回青岛', date: '2026-10-07', time: 'afternoon' }, [{ time: '2026-10-08T09:00:00+08:00' }]));
        assert.ok(!tripAlreadyOver({ what: '字节的面试', date: '2026-10-07', time: '14:00' }, [{ time: '2026-10-08T09:00:00+08:00' }]), '面试有结果可问');
        assert.ok(!tripAlreadyOver({ what: '收到offer的消息', date: '2026-10-07', time: '14:00' }, [{ time: '2026-10-08T09:00:00+08:00' }]));
        assert.ok(!tripAlreadyOver({ what: '去图书馆前面集合，上一整个上午', date: '2026-10-09', time: '09:25' }, [{ time: '2026-10-09T13:10:00+08:00' }]));
    });

    test('冲着她的事不记；到时候她没问出口的留着下次再问，第二次还没问出口才忘（10-09 线上「回去陪林梦瑶」）', async () => {
        assert.ok(aboutHer('回去陪林梦瑶', '林梦瑶'));
        assert.ok(!aboutHer('字节的面试', '林梦瑶'));
        assert.ok(aboutHer('跟林梦瑶视频', '林梦瑶'));
        assert.ok(!aboutHer('去林梦瑶家找小皮鞋', '林梦瑶'), '她不在场的事照记（10-07 线上问过「找到了没」）');
        assert.ok(!mentions({ what: '回去陪林梦瑶' }, ['早呀', '还困着，今天下雨，懒得去图书馆了']));
        assert.ok(mentions({ what: '高数期中考试' }, ['考得咋样']));
        assert.ok(mentions({ what: 'CET4 成绩' }, ['cet4出了没']));
        assert.ok(!mentions({ what: '明天去医院复查' }, ['早，今天去哪']), '只对上「去」「今天」不算');
        assert.ok(mentions({ what: '去了' }, ['嗯']), '全是虚词的判断不了，算问到');

        const history = [msg(t(10, 8, 21), 'user', '我明天下午两点有面试，晚上回去陪林梦瑶'), msg(t(10, 8, 21, 1), 'assistant', '加油')];
        const { clock, planner, logs, initiated, state } = setup(new Date(t(10, 8, 22)), history,
            ['{"add":[{"what":"字节的面试","date":"2026-10-09","time":"14:00"},{"what":"回去陪林梦瑶","date":"2026-10-09","time":"evening"}],"resolved":[]}'],
            // 他一直没回也接着排（真的线上是他回了才排下一条）
            { occasions: ['follow_up' as const], dailyMax: 2, unansweredMax: 10 }, ['在吗', '今天好困']);
        await planner.syncFollowUps();
        assert.ok(logs.includes('待跟进：「回去陪林梦瑶」是冲着她的事，不记'), logs.join('\n'));
        assert.deepEqual(state().followUps.map((f: FollowUp) => f.what), ['字节的面试']);
        const askedTimes = async (n: number) => {
            for (let i = 0; i < 12; i++) {
                await settled();
                if (initiated.filter(r => r.label.startsWith('待跟进')).length >= n) break;
                const next = clock.nextTimer();
                if (next === undefined) break;
                clock.advanceTo(next);
            }
            await settled();
        };
        await askedTimes(1);
        assert.ok(logs.includes('待跟进：她没问出口「字节的面试」，留着下次再问'), logs.join('\n'));
        assert.equal(state().followUps[0]?.missed, 1, logs.join('\n'));
        // 第二天早安里再问一次，还是没问出口：忘了
        await askedTimes(2);
        assert.equal(initiated.filter(r => r.label.startsWith('待跟进')).length, 2);
        assert.ok(logs.some(l => l.startsWith('待跟进：又没问出口，忘掉「字节的面试」')), logs.join('\n'));
        assert.deepEqual(state().followUps, []);
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

describe('有没回的消息、回复器又闲着：到了主动的时机先再回一次', () => {
    const dirs: string[] = [];
    const planners: Planner[] = [];
    afterEach(() => {
        for (const p of planners.splice(0)) p.stop();
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    async function morning(phase: ResponderStatus['phase']) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-pending-'));
        dirs.push(dir);
        const clock = new VirtualClock(new Date(t(10, 9, 6)));
        const logs: string[] = [];
        let caughtUp = 0;
        // 昨晚的消息没回（断网时回复失败、放弃了）
        const history: StoredMessage[] = [{ time: new Date(t(10, 8, 23, 50)).toISOString(), role: 'user', content: '在吗' }];
        const planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings: { occasions: ['morning'], dailyMax: 2, unansweredMax: 1 }, dates: [], mode: 'on',
            history: { load: () => history },
            responder: {
                initiate: async () => ({ result: 'skipped', reason: '不该走到这里' }),
                catchUp: () => { caughtUp++; },
                status: () => ({ phase, failures: 2 }),
            },
            dir, log: m => logs.push(m), now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '林梦瑶' },
            extract: async () => '{"add":[],"resolved":[]}',
        });
        planners.push(planner);
        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 30));
            if (logs.some(l => l.includes('不发'))) break;
            const next = clock.nextTimer();
            if (next === undefined) break;
            clock.advanceTo(next);
        }
        await new Promise(r => setTimeout(r, 30));
        return { logs, caughtUp: () => caughtUp };
    }

    test('回复器闲着：记下不发，再回一次', async () => {
        const { logs, caughtUp } = await morning('idle');
        assert.ok(logs.some(l => /^主动：早安.*不发：有没回的消息，回复就好$/.test(l)), logs.join('\n'));
        assert.ok(logs.includes('主动：没回的消息还没回，先再回一次'));
        assert.equal(caughtUp(), 1, logs.join('\n'));
    });

    test('回复器还在等着再试、在等她看到：不插手', async () => {
        for (const phase of ['retry', 'waiting'] as const) {
            const { logs, caughtUp } = await morning(phase);
            assert.ok(logs.some(l => l.endsWith('不发：有没回的消息，回复就好')), logs.join('\n'));
            assert.equal(caughtUp(), 0);
        }
    });
});
