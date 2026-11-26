import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import { DEFAULTS, type AppConfig, type Contact } from '../src/platform/config.ts';
import type { TierCard } from '../src/platform/contact.ts';
import { plannerHost } from '../src/proactive/planner-host.ts';
import { blockReason, DESKTOP_WITH_REASON, OCCASIONS, type Candidate, type DesktopTurnText, type ProactiveInput, type ProactiveRecord } from '../src/proactive/proactive.ts';
import { createProactivePlanner, type Planner } from '../src/proactive/proactive-planner.ts';
import type { Responder } from '../src/social/responder.ts';
import type { InitiateRequest } from '../src/social/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { SYNTHETIC_CHAR_NAME, syntheticCardPath } from './fixtures/card.ts';

// ADR 0347 第 3 层 B 块（desktopDay，方案 §2.2-2）：他在电脑前陪着她 / 刚在电脑上聊过，QQ 这边的主动消息也知道

const boyfriend = loadCharacterCard(syntheticCardPath('boyfriend'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
let nextId = 1;
const user = (time: number, content = '在吗'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'user', content, messageId: nextId++ });
const her = (time: number, content = '嗯'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'assistant', content, messageId: nextId++ });
const legacySettings = { ...boyfriend.proactive!, occasions: boyfriend.proactive!.occasions.filter(o => o !== 'share'), dailyMax: 2 };
const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
    qq: 10001, schedule, settings: legacySettings, dates: boyfriend.dates, history: [], records: [], mode: 'on', ...patch,
});
const at = (occasion: string, time: number, extra: Partial<Candidate> = {}): Candidate => ({
    id: `x:${occasion}`, occasion: occasion as Candidate['occasion'], day: '2026-10-12', at: time, reason: '', ...extra,
});
const turn = (time: number, userText = '帮我看看这个表格', assistant = '好，我看一下'): DesktopTurnText => ({ at: time, user: userText, assistant });
/** 桌面三项都按这几轮回合给（像 desktop-now 那样） */
const desk = (turns: DesktopTurnText[], withNow = false): Partial<ProactiveInput> => ({
    desktopWith: () => withNow,
    lastDesktopAt: now => turns.filter(item => item.at <= now).at(-1)?.at,
    desktopTurns: () => turns,
});
// 昨晚聊过一来一回，今天 QQ 上还没说话
const yesterday = [user(t(10, 11, 22)), her(t(10, 11, 22, 1))];

describe('主动消息：桌面上的时间（desktopDay）', () => {
    test('他在电脑前：普通主动时机不插，睡前、重要日子和约好回来沿用专用规则', () => {
        const when = t(10, 12, 18);
        for (const occasion of OCCASIONS.filter(occasion => occasion !== 'dates' && occasion !== 'back' && occasion !== 'bedtime')) {
            assert.equal(blockReason(at(occasion, when), when, input({ history: yesterday, desktopWith: () => true })), DESKTOP_WITH_REASON, occasion);
            assert.notEqual(blockReason(at(occasion, when), when, input({ history: yesterday, desktopWith: () => false })), DESKTOP_WITH_REASON, occasion);
            assert.notEqual(blockReason(at(occasion, when), when, input({ history: yesterday })), DESKTOP_WITH_REASON, occasion);
        }
        assert.notEqual(blockReason(at('bedtime', t(10, 12, 23, 30)), t(10, 12, 23, 30), input({ history: yesterday, desktopWith: () => true })), DESKTOP_WITH_REASON);
        assert.equal(blockReason(at('dates', when), when, input({ history: yesterday, desktopWith: () => true })), undefined);
        assert.equal(blockReason(at('back', when, { id: `2026-10-12:back:${when - 60_000}` }), when,
            input({ history: yesterday, desktopWith: () => true })), undefined);
    });

    test('一小时内 / 正聊着 / 刚聊过：桌面最后一轮和 QQ 最后一句取较晚的', () => {
        const when = t(10, 12, 18);
        // QQ 上昨晚以后没说过话：冷场够 8 小时；桌面上 17:30 刚聊过 → 一小时内聊过
        assert.equal(blockReason(at('quiet', when), when, input({ history: yesterday })), undefined);
        assert.equal(blockReason(at('quiet', when), when, input({ history: yesterday, ...desk([turn(t(10, 12, 17, 30))]) })), '一小时内聊过');
        // 桌面上 14:00 聊过：过了一小时，但冷场不到 8 小时
        assert.equal(blockReason(at('quiet', when), when, input({ history: yesterday, ...desk([turn(t(10, 12, 14))]) })), '没到 8 小时');
        // 她那边的事：桌面上 17:58 刚说过话 → 正聊着
        const news = { id: 'camera', kind: 'camera' as const, day: '2026-10-12', at: t(10, 12, 16), what: '买到了相机' };
        assert.equal(blockReason(at('news', when, { id: '2026-10-12:news:camera', news }), when, input({ history: yesterday, news: [news], ...desk([turn(t(10, 12, 17, 58))]) })), '正聊着，聊天里说');
        // 下课：下课以后在电脑上聊过
        assert.equal(blockReason(at('after_class', when, { classEnd: t(10, 12, 16, 35) }), when, input({ history: yesterday, ...desk([turn(t(10, 12, 16, 50))]) })), '下课后已经聊过');
        // QQ 那一句更晚时听 QQ 的：QQ 17:30、桌面 14:00 → 一小时内
        assert.equal(blockReason(at('quiet', when), when, input({ history: [...yesterday, user(t(10, 12, 17, 30)), her(t(10, 12, 17, 31))], ...desk([turn(t(10, 12, 14))]) })), '一小时内聊过');
        // 桌面早于 QQ 最后一句时不改结果：QQ 10:00、桌面昨晚
        assert.equal(blockReason(at('quiet', when), when, input({ history: [...yesterday, user(t(10, 12, 9)), her(t(10, 12, 9, 1))], ...desk([turn(t(10, 11, 23))]) })), undefined);
        // 睡前 20 分钟：桌面 23:20 刚聊过
        assert.equal(blockReason(at('bedtime', t(10, 12, 23, 30)), t(10, 12, 23, 30), input({ history: [...yesterday, user(t(10, 12, 20)), her(t(10, 12, 20, 1))], ...desk([turn(t(10, 12, 23, 20))]) })), '20 分钟内聊过');
    });

    test('早安：他今天先在电脑上来过也算来过消息', () => {
        const when = t(10, 12, 9, 45);
        assert.equal(blockReason(at('morning', when), when, input({ history: yesterday })), undefined);
        assert.equal(blockReason(at('morning', when), when, input({ history: yesterday, ...desk([turn(t(10, 12, 7, 45))]) })), '他今天已经来过消息');
        // 昨晚在电脑上的不算今天
        assert.equal(blockReason(at('morning', when), when, input({ history: yesterday, ...desk([turn(t(10, 11, 23))]) })), undefined);
    });

    test('睡前：今天只在电脑上聊过也算聊过；桌面上谁说过晚安都算道过', () => {
        const when = t(10, 12, 23, 30);
        assert.equal(blockReason(at('bedtime', when), when, input({ history: yesterday })), '今天没聊过');
        assert.equal(blockReason(at('bedtime', when), when, input({ history: yesterday, ...desk([turn(t(10, 12, 15))]) })), undefined);
        assert.equal(blockReason(at('bedtime', when), when, input({ history: yesterday, ...desk([turn(t(10, 12, 15)), turn(t(10, 12, 22), '我先睡了', '好')]) })), '已经道过晚安');
        assert.equal(blockReason(at('bedtime', when), when, input({ history: yesterday, ...desk([turn(t(10, 12, 15)), turn(t(10, 12, 22), '弄完了', '那你早点睡')]) })), '已经道过晚安');
        // 傍晚以前的「睡了」不算今晚
        assert.equal(blockReason(at('bedtime', when), when, input({ history: yesterday, ...desk([turn(t(10, 12, 15), '昨天几点睡了', '一点多')]) })), undefined);
    });

    test('没给桌面三项：和原来逐字一样', () => {
        const cases: [Candidate, number, ProactiveInput][] = [
            [at('quiet', t(10, 12, 18)), t(10, 12, 18), input({ history: yesterday })],
            [at('morning', t(10, 12, 9, 45)), t(10, 12, 9, 45), input({ history: yesterday })],
            [at('bedtime', t(10, 12, 23, 30)), t(10, 12, 23, 30), input({ history: yesterday })],
            [at('after_class', t(10, 12, 18), { classEnd: t(10, 12, 16, 35) }), t(10, 12, 18), input({ history: [user(t(10, 12, 16, 40)), her(t(10, 12, 16, 41))] })],
        ];
        for (const [candidate, now, given] of cases) {
            assert.equal(blockReason(candidate, now, given), blockReason(candidate, now, { ...given, lastDesktopAt: () => undefined, desktopTurns: () => [], desktopWith: () => false }), candidate.occasion);
        }
    });
});

const settled = () => new Promise(r => setTimeout(r, 30));
async function runUntil(clock: VirtualClock, end: number) {
    for (let i = 0; i < 40 && clock.now() < end; i++) {
        await settled();
        const next = clock.nextTimer();
        if (next === undefined || next > end) break;
        clock.advanceTo(next);
    }
    await settled();
}

describe('计划器把桌面三项原样交给 blockReason', () => {
    const dirs: string[] = [];
    const planners: Planner[] = [];
    afterEach(() => {
        for (const p of planners.splice(0)) p.stop();
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    const camera = { id: 'camera', kind: 'camera' as const, day: '2026-10-11', at: t(10, 11, 16, 30), what: '在城南的二手相机店买到了一台胶片机' };

    function setup(extra: { desktopWith?: () => boolean } = {}, news = [camera]) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-desk-'));
        dirs.push(dir);
        const clock = new VirtualClock(new Date(t(10, 11, 16)));
        const tried: number[] = [];
        const history = [user(t(10, 11, 11), '我写代码去了'), her(t(10, 11, 11, 1), '去吧')];
        const planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings: { occasions: ['news'], dailyMax: 3, unansweredMax: 2 }, dates: [], mode: 'dryRun',
            history: { load: () => history },
            responder: {
                initiate: async (request: InitiateRequest) => {
                    tried.push(clock.now());
                    request.commit(['我买到相机啦']);
                    return { result: 'dryRun', parts: ['我买到相机啦'] };
                },
            },
            dir, log: () => {}, now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: SYNTHETIC_CHAR_NAME },
            news: () => news,
            ...extra,
        });
        planners.push(planner);
        const records = () => (JSON.parse(readFileSync(join(dir, '10001-boyfriend.json'), 'utf8')) as { records: ProactiveRecord[] }).records;
        return { clock, tried, records };
    }

    test('他在电脑前：到点不发，记下原因', async () => {
        const { clock, tried, records } = setup({ desktopWith: () => true });
        await runUntil(clock, t(10, 11, 18));
        assert.equal(tried.length, 0);
        const news = records().find(r => r.occasion === 'news');
        assert.equal(news?.result, 'skipped');
        assert.equal(news?.reason, DESKTOP_WITH_REASON);
    });

    test('不在电脑前（或没给）：照常', async () => {
        for (const extra of [{ desktopWith: () => false }, {}]) {
            const { clock, tried, records } = setup(extra);
            await runUntil(clock, t(10, 11, 18));
            assert.equal(tried.length, 1);
            assert.equal(records().find(r => r.occasion === 'news')?.result, 'dryRun');
        }
    });

    test('同一个计划器离开后恢复后续时机，先前因在场跳过的时机不重发', async () => {
        let present = true;
        const later = { ...camera, id: 'later', at: t(10, 11, 18, 30), what: '合成的第二件事' };
        const { clock, tried, records } = setup({ desktopWith: () => present }, [camera, later]);
        await runUntil(clock, t(10, 11, 18));
        assert.equal(tried.length, 0);
        present = false;
        await runUntil(clock, t(10, 11, 22));
        assert.equal(tried.length, 1);
        assert.deepEqual(records().filter(row => row.occasion === 'news').map(row => row.result), ['skipped', 'dryRun']);
    });
});

describe('planner-host：桌面三项只接给 deviceOwner 那一位男朋友档', () => {
    const dirs: string[] = [];
    const stops: (() => void)[] = [];
    afterEach(() => {
        for (const stop of stops.splice(0)) stop();
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    test('他（deviceOwner）的早安被挡成「正在电脑上陪他」，名单里另一位男朋友档不受影响；没给 desktop 时两位都照常', async () => {
        for (const withDesktop of [true, false]) {
            const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-desk-host-'));
            dirs.push(dataDir);
            // 10-12 早上 7:00 之前：两位的早安都还没到点
            const clock = new VirtualClock(new Date(t(10, 12, 6)));
            const owner: Contact = { qq: 10001, name: '阿明', tier: 'boyfriend' };
            const other: Contact = { qq: 10003, name: '小周', tier: 'boyfriend' };
            const tried: number[] = [];
            const responder = {
                initiate: async (request: InitiateRequest) => {
                    tried.push(clock.now());
                    request.commit(['早']);
                    return { result: 'dryRun', parts: ['早'] };
                },
            } as unknown as Responder;
            const config = { ...DEFAULTS, dataDir, proactive: 'dryRun' } as unknown as AppConfig;
            const host = plannerHost({
                config, log: () => {}, exec: { llm: async () => '', now: clock.now } as never, clockNow: () => new Date(clock.now()),
                cardFor: () => ({ character: { ...boyfriend, proactive: { occasions: ['morning'], dailyMax: 2, unansweredMax: 1 } } }) as unknown as TierCard,
                proactiveContacts: [owner, other], deviceOwner: owner, responders: new Map([[owner.qq, responder], [other.qq, responder]]),
                history: { load: () => [] } as never, worldCard: undefined, ledgerWorld: undefined, sharedWorld: undefined,
                needsAnchor: undefined, agencyShadow: undefined, weather: undefined, web: undefined, herGuessesNow: undefined, promises: undefined,
                dormancy: undefined, crisisState: { pausedAt: () => false }, bedtimes: () => [], watchedEntries: () => [],
                pipeline: { now: clock.now, waitUntil: clock.waitUntil },
                ...(withDesktop ? { desktop: { desktopWith: () => true, lastDesktopAt: () => undefined, desktopTurns: () => [] } } : {}),
            });
            host.start();
            stops.push(() => { for (const planner of host.planners.values()) planner.stop(); });
            await runUntil(clock, t(10, 12, 12));
            const read = (qq: number) => (JSON.parse(readFileSync(join(dataDir, 'proactive', `${qq}-boyfriend.json`), 'utf8')) as { records: ProactiveRecord[] }).records.find(r => r.occasion === 'morning');
            if (withDesktop) {
                assert.equal(read(owner.qq)?.reason, DESKTOP_WITH_REASON);
                assert.equal(read(other.qq)?.result, 'dryRun');
            } else {
                assert.equal(read(owner.qq)?.result, 'dryRun');
                assert.equal(read(other.qq)?.result, 'dryRun');
            }
        }
    });
});
