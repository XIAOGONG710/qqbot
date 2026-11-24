// 线上开着、开关这一层没测过的（docs/reports/2026-11-24-switch-audit.md「测试覆盖」）：hisReactions（ADR 0212，主动分享前看他的反应）。
// 计划器拿到 reactions 之后怎么用由 his-reactions.test.ts 管（直接建 createProactivePlanner）；这里只管配置那一层：
// 主动消息的计划器宿主（proactive/planner-host.ts，App 用的那一个）按档位给不给计划器 reactions（开关合并：hisReactions 并进 proactive，主动开着就给）。
// 合成角色的卡上的主动设定，试运行（dryRun）跑一天：两天前她说作业的事，他回「别老说作业了」——
// 开着时她自己挑话题主动开口（share / quiet）的那几次，说明里多一行「你看到的他的反应」；关着、或不是男朋友档，都没有。

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import type { AppConfig, Contact } from '../src/platform/config.ts';
import { loadTierCard, type TierCard } from '../src/platform/contact.ts';
import { plannerHost, type PlannerHostDeps } from '../src/proactive/planner-host.ts';
import type { ProactiveRecord } from '../src/proactive/proactive.ts';
import type { Responder, InitiateOutcome, InitiateRequest } from '../src/social/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { syntheticCardPattern, useSyntheticTerms } from './fixtures/card.ts';
import { baselineConfig } from './baseline/harness.ts';

useSyntheticTerms();

const HOUR = 3_600_000;
const START = Date.parse('2026-11-18T07:00:00+08:00');
const iso = (ms: number) => new Date(ms).toISOString();
const SEEN = '你看到的他的反应';

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 跑一天，收她每次主动开口时交给回复器的请求 */
async function run(contact: Contact) {
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-live-switches-proactive-'));
    dirs.push(dataDir);
    // 两天前下午她主动说了作业的事，他回「别老说作业了」，她接一句；前一天晚上他说去忙了、她回了好（没有没回的）
    const shared = START - 2 * 24 * HOUR + 8 * HOUR;
    const history: StoredMessage[] = [
        { time: iso(shared), role: 'assistant', content: '高数作业终于写完了', messageId: 1000 },
        { time: iso(shared + 5 * 60_000), role: 'user', content: '别老说作业了' },
        { time: iso(shared + 30 * 60_000), role: 'assistant', content: '哦' },
        { time: iso(START - 10 * HOUR), role: 'user', content: '我先去忙了' },
        { time: iso(START - 10 * HOUR + 60_000), role: 'assistant', content: '好，晚点聊' },
    ];
    const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const records: ProactiveRecord[] = [{ id: `${day(shared)}:share`, occasion: 'share', plannedAt: iso(shared), at: iso(shared), result: 'sent', messageIds: [1000] }];
    mkdirSync(join(dataDir, 'proactive'));
    writeFileSync(join(dataDir, 'proactive', `${contact.qq}-${contact.tier}.json`), JSON.stringify({ version: 1, records, followUps: [], extracted: {} }));

    const clock = new VirtualClock(new Date(START));
    const requests: InitiateRequest[] = [];
    const lines: string[] = [];
    let replyDue = false;
    const responder = {
        initiate: async (request: InitiateRequest): Promise<InitiateOutcome> => {
            requests.push(request);
            request.commit(['嗯嗯']);
            replyDue = true;
            return { result: 'dryRun', parts: ['嗯嗯'] };
        },
    } as unknown as Responder;
    const config: AppConfig = baselineConfig(dataDir, [contact], { proactive: 'dryRun', moody: false });
    const cards = new Map<string, TierCard>();
    const cardFor = (tier: string) => cards.get(tier) ?? cards.set(tier, loadTierCard(syntheticCardPattern, tier)).get(tier)!;
    // 宿主要的东西里，和这件事无关的都不给（没有世界账、天气、照片、记忆……，同这些开关关着时）
    const deps = {
        config, log: (line: string) => lines.push(line), exec: { llm: async () => '[]', now: clock.now }, clockNow: () => new Date(clock.now()), cardFor,
        proactiveContacts: [contact], deviceOwner: undefined, responders: new Map([[contact.qq, responder]]),
        history: { load: () => history }, photos: undefined, worldCard: undefined, ledgerWorld: undefined, sharedWorld: undefined,
        needsAnchor: undefined, agencyShadow: undefined, weather: undefined, web: undefined, herGuessesNow: undefined, promises: undefined, dormancy: undefined,
        crisisState: { pausedAt: () => false }, bedtimes: () => [], watchedEntries: () => [],
        pipeline: { now: clock.now, waitUntil: clock.waitUntil },
    } as unknown as PlannerHostDeps;
    const host = plannerHost(deps);
    host.start();
    const planner = host.planners.get(contact.qq);
    assert.ok(planner, '建了计划器');
    stops.push(() => planner.stop());
    // 一个个到点往前拨，拨到第二天凌晨
    for (let i = 0, idle = 0; i < 400 && idle < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        const next = clock.nextTimer();
        // 计划器还在算下一次（没登记等待）：多等几下
        if (next === undefined) { idle++; continue; }
        idle = 0;
        if (next > START + 20 * HOUR) break;
        clock.advanceTo(next);
        // 她主动说了之后，他过一分钟回个「嗯」、她接一句（聊天记录变了，同 App 一样戳一下计划器）：
        // 不然「主动过一次还没收到回复」会挡住这一天剩下的
        await new Promise(resolve => setTimeout(resolve, 10));
        if (replyDue) {
            replyDue = false;
            history.push({ time: iso(clock.now() + 60_000), role: 'user', content: '嗯' }, { time: iso(clock.now() + 120_000), role: 'assistant', content: '好' });
            clock.advanceTo(clock.now() + 180_000);
            planner.poke();
        }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    return { requests, lines };
}

const boyfriend: Contact = { qq: 10001, name: '阿明', tier: 'boyfriend' };
/** 她自己挑话题开口的那几次（share / quiet） */
const ownTopic = (request: InitiateRequest) => /^(冷场|随口说件自己的事)（/.test(request.label);

describe('hisReactions（ADR 0212，跟着 proactive）：主动分享前看他的反应', () => {
    test('主动开着：她自己挑话题开口那次，说明里有「他直接说过不想听你说课和作业」', async () => {
        const r = await run(boyfriend);
        const seen = r.requests.filter(request => request.note.includes(SEEN));
        assert.ok(seen.length >= 1, [...r.requests.map(request => `${request.label}：${request.note}`), ...r.lines].join('\n'));
        assert.match(seen[0]!.note, /直接说过不想听你说课和作业/);
    });

    test('主动开着但不是男朋友档：没有（只男朋友档）', async () => {
        const r = await run({ qq: 10003, name: '小林', tier: 'bestie' });
        assert.ok(r.requests.some(ownTopic), '这一天她有自己挑话题开口的（冷场 / 随口说件事）');
        assert.ok(r.requests.every(request => !request.note.includes(SEEN)));
    });
});
