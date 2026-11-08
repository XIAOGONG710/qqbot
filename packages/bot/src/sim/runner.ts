// 跑一个场景（ADR 0005）：和 bot 同一条流水线（contact.ts），只换掉收发、时钟和数据目录。
// 对方的消息由场景给出，按虚拟时间记录；她发出的每一条、每次生成的提示词、调度日志都按步骤记下来，最后写成报告。

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { localDate } from '../local-date.ts';
import { join } from 'node:path';
import { watchedFacts } from '../language/watching.ts';
import type { BotConfig, Contact } from '../platform/config.ts';
import { createContactResponder, replySkip, type ContactPipelineOptions, type TierCard } from '../platform/contact.ts';
import { jokesTurnModule } from '../modules/jokes.ts';
import { idiomsTurnModule } from '../modules/idioms.ts';
import { interruptionsModule } from '../modules/interruptions.ts';
import { closenessModule } from '../modules/closeness.ts';
import { togetherModule } from '../modules/together.ts';
import { replyBasicsModule } from '../modules/reply-basics.ts';
import { asksModule } from '../modules/asks.ts';
import { readingModule } from '../modules/reading.ts';
import { registerModule } from '../modules/register.ts';
import { scenesModule } from '../modules/scenes.ts';
import { voiceModule } from '../modules/voice.ts';
import { intentModule } from '../modules/intent.ts';
import { memesModule } from '../modules/memes.ts';
import { watchedModule } from '../modules/watched.ts';
import { SENSITIVE_ON, useSensitiveSwitch } from '../platform/sensitive.ts';
import { withFestivalActivities, withFestivals } from '../world/festivals.ts';
import { photoAllowance, photoShelf } from '../vision/photos.ts';
import { togetherNow } from '../language/together.ts';
import { STICKER_ONLY_SHARE, stickerShelf } from '../social/stickers.ts';
import { MEET_MINUTES, promiseKeeper } from '../life/promises.ts';
import { writeJsonAtomic } from '../memory/json-file.ts';
import { ponderIfDue, thoughtsReader } from '../life/open-questions.ts';
import { substituteMacros } from '../st/macros.ts';
import { ChatHistory, type StoredMessage } from '../memory/history.ts';
import type { FactRecord } from '../language/fact-check.ts';
import { chatCompletion, forExtraction } from '../language/llm.ts';
import { createTurnWeigher, WEIGH_TIMEOUT_MS } from '../language/turn-weight.ts';
import type { Log } from '../platform/log.ts';
import type { HindsightApi } from '../memory/hindsight.ts';
import { LongTermMemory, RELATIONSHIP_MODEL } from '../memory/long-term.ts';
import type { OpenAIMessage, PromptResult } from '../language/prompt.ts';
import { inspectReply, summarizeIssues } from '../language/exit-check.ts';
import { describeSpeechIssue, inspectSpeech, speechContext, type SpeechContext } from '../language/speech-check.ts';
import { EPISODE_GAP_MS } from '../memory/episodes.ts';
import { herDay, newsKindsOf, withAsk, withBack, withCatPhoto, withCurious, withFoodShares, withInner, withInvite, withReach, withRoom, withSmallNews } from '../proactive/proactive.ts';
import type { Moment } from '../emotion/feelings.ts';
import { mergePursuits, type Pursuit } from '../life/pursuits.ts';
import { dmMessageId, dmNote, nudgeNote, videoNote, videoTopic } from '../bilibili/bilibili.ts';
import { createProactivePlanner, newsFrom, reschedulesFrom, type Planner } from '../proactive/proactive-planner.ts';
import { herDayLogger } from '../life/her-days.ts';
import { worldState, type World, CAMERA_FUND_TARGET } from '../world/world.ts';
import { DIARY_TEMPERATURE, diaryWriter } from '../life/diary.ts';
import { formatDate, stateAt, type Schedule } from '../life/schedule.ts';
import { actionQueue, settlingWorld } from '../world/action-queue.ts';
import { bodyAt } from '../life/body.ts';
import { dayFrom, useRealWeather, type HourWeather, type RealWeather } from '../world/weather.ts';
import type { LifeEvent } from '../world/life-events.ts';
import { lifeExecutor, type LifeSources } from '../world/life-selector.ts';
import { asleepSince, saidBedtimes } from '../life/bedtime.ts';
import { contextSummarizer, SUMMARY_HEADER, type TurnWindow } from '../language/context-window.ts';
import { estimateTokens } from '../language/tokens.ts';
import { auditLedgerCoverage, auditLifeStatus, type LedgerGap, type LifeStatusMismatch } from './life-audit.ts';
import { repeatedSentences } from './repeats.ts';
import { parseDuration, sayText, VirtualClock, type Checks, type LifeChecks, type ProactiveChecks, type Scenario, type SayStep } from './scenario.ts';

/** 模拟的联系人用的 QQ 号（虚构） */
export const SIM_QQ = 10001;
/** say 之后，她要等这么久（虚拟时间）之内才看到的，自动把时钟拨过去（冷场、上课）；更久的（睡觉）要 advance 或 wait */
export const AUTO_TIMER_MS = 60 * 60_000;
/** wait: reply 最多等多久 */
export const WAIT_REPLY_MS = 24 * 3_600_000;

/** 模拟器要用到的 Hindsight 接口（HindsightClient 都有） */
export interface SimHindsight extends HindsightApi {
    activeOperations(bankId: string): Promise<string[]>;
    operationStatus(bankId: string, operationId: string): Promise<string>;
    deleteBank(bankId: string): Promise<void>;
}

export interface RunOptions {
    /** 用在 bank 前缀里，只能是字母、数字、短横线 */
    runId: string;
    dataDir: string;
    card: TierCard;
    llm: BotConfig['llm'];
    prompt: BotConfig['prompt'];
    /** 不传就不用记忆（场景里 memory: true 也一样） */
    hindsight?: SimHindsight;
    recallTimeoutMs?: number;
    /** 等 Hindsight 后台任务的上限 */
    hindsightWaitMs?: number;
    /** 默认调模型接口；测试传假的 */
    generate?: (messages: OpenAIMessage[], log: Log) => Promise<string>;
    /** 跑完不删 bank，方便事后去 Hindsight 里看 */
    keepBank?: boolean;
    sleep?: (ms: number) => Promise<void>;
    /** 连发合并的等待，默认和 bot 一样（测试用短的） */
    settle?: { quietMs: number; maxMs: number };
    /** 出口检查里查说话的毛病（ADR 0014），run.ts 照 bot 的配置传；默认否 */
    speechCheck?: boolean;
    /** 她自己的日子（ADR 0015），run.ts 照 bot 的配置传；默认否 */
    herDays?: boolean;
    /** 他难过、亲密话、收尾时挑候选（ADR 0041），run.ts 照 bot 的配置或 --candidates 传；默认不挑 */
    candidates?: number;
    /** 形状控制（ADR 0091）：run.ts 的 --shape 对所有场景打开 */
    shape?: boolean;
    /** 带自己的小事（ADR 0094）：run.ts 的 --agenda 对所有场景打开，同时打开 shape */
    shapeAgenda?: boolean;
    /** 废话（ADR 0095）：run.ts 的 --filler 对所有场景打开，同时打开 shape */
    shapeFiller?: boolean;
    /** 情绪轮（ADR 0099）：run.ts 的 --feel 对所有场景打开，同时打开 shape */
    shapeFeel?: boolean;
    /** 分成几条（ADR 0096）：run.ts 的 --split 对所有场景打开，同时打开 shape */
    shapeSplit?: boolean;
    /** 被问直接问题时答完再接着说（ADR 0149）：run.ts 的 --ask 对所有场景打开，同时打开 shape */
    shapeAsk?: boolean;
    /** 被认真问想法时说长一点（ADR 0150）：run.ts 的 --long 对所有场景打开，同时打开 shape */
    shapeLong?: boolean;
    /** 认真问她时深思（ADR 0151）：run.ts 的 --deliberate；深思轮次用这份模型配置 */
    deliberateLlm?: BotConfig['llm'];
    /** 换掉深思轮次的那段提示词（run.ts 的 --deliberate-note <文件>）；不写就用线上的 DELIBERATE_NOTE */
    deliberateNote?: string;
    /** 语义路由（ADR 0202）：run.ts 的 --depth；要 deliberateLlm */
    depthRouting?: boolean;
    /** 事实检查多查一类：她替他说的事（ADR 0203）：run.ts 的 --fact-him；要事实检查开着 */
    factHim?: boolean;
    /** 「做题式」写法（ADR 0146 实验）：run.ts 的 --frame solve；线上没有 */
    replyFrame?: 'solve';
    /** 测试注入：设备控制的钩子（ADR 0148）；模拟器命令行不传 */
    devices?: ContactPipelineOptions['devices'];
    /** 逐条事实检查的档位（ADR 0137，run.ts 的 --fact）：覆盖场景自己写的；不传按场景 */
    factCheck?: 'off' | 'log' | 'fix';
    /** 日记里的世界（ADR 0026）：同学档的卡上的，run.ts 传 */
    diaryWorld?: World;
    /** 和 diaryWorld 同一档的作息（ADR 0034） */
    diaryWorldSchedule?: Schedule;
    /** 虚拟时钟底下的真实时间，默认 Date.now；测试传一个不动的，虚拟时间只靠 advance 走，两遍跑出来的时刻一样（ADR 0039） */
    realNow?: () => number;
    /** 原始聊天只放最近几轮、更早的整理成要点（ADR 0043 离线实验，run.ts 的 --context-turns）；不传是线上的最近 80 条 */
    contextTurns?: TurnWindow;
}

/** proactive：她主动发的（ADR 0011），是哪个时机（日志里的说法） */
export interface Bubble { time: number; text: string; proactive?: string; /** 引用回复（ADR 0136）：引用的是他的哪一句 */ quote?: string }
export interface Input { time: number; text: string; interrupt?: boolean }
export interface Generation {
    time: number; recall?: string; timeBlock?: string; relationship?: string; people?: string; common?: string; todayOthers?: string; past?: string; messages: number;
    /** 较早聊天的要点（ADR 0043 实验） */
    summary?: string;
    /** 提示词估算多少 token（tokens.ts，和截断用的同一个估法）：比较上下文放法的成本 */
    tokens?: number;
    /** 模型原文（清理之前） */
    raw?: string;
    /** 出口检查带说明重写的原文（ADR 0006） */
    rewrites?: string[];
}
/**
 * pipeline：管线自检（提示词里有没有那一行、召回了什么、日志、生成了几次），查的不是她说了什么。
 * 代码就位后多半恒真（DSH 复核 ADR 0036：42 项里 12 项时间块检查不可能失败），通过率分开算
 */
export interface CheckResult { ok: boolean; text: string; pipeline?: boolean }
export interface CheckCount { passed: number; failed: number }

export interface StepRecord {
    kind: 'case' | 'say' | 'life' | 'action' | 'advance' | 'video' | 'wait' | 'memory' | 'refresh' | 'check' | 'forget' | 'hindsight' | 'restart';
    /** 这一步开始时的虚拟时间 */
    time: number;
    /** 到这一步为止对方最后一条消息的虚拟时间（replyAfter / replyWithin 从这里算） */
    inputTime?: number;
    caseId?: string;
    note?: string;
    inputs: Input[];
    bubbles: Bubble[];
    generations: Generation[];
    logs: string[];
    checks: CheckResult[];
    relationship?: string;
    advance?: string;
    life?: string;
    action?: string;
    /** 逐条事实检查的记录（ADR 0137，场景里 factCheck 开着才有） */
    facts?: FactRecord[];
}

export interface RunResult {
    scenario: Scenario;
    runId: string;
    dataDir: string;
    bankId?: string;
    /** 原始聊天只放最近几轮 + 要点（ADR 0043 实验）；没有就是线上的最近 80 条 */
    contextTurns?: TurnWindow;
    steps: StepRecord[];
    /** 全部检查；reply 是查她说了什么、怎么回的，pipeline 是管线自检（CheckResult.pipeline） */
    checks: CheckCount & { reply: CheckCount; pipeline: CheckCount };
}

const RECALL_HEADER = '[你们以前聊过的事';
const TIME_HEADER = '[当前时间：';
const RELATIONSHIP_HEADER = '[你们关系的整体情况';
/** ADR 0016：提起名单里的人时的那一段（第一个人；带他的记忆）、公共记忆 */
const PEOPLE_HEADER = '[你认识的人：';
const COMMON_HEADER = '[你和名单里别的人聊天时';
const TODAY_OTHERS_HEADER = '[你今天和别人聊过的事';
const PAST_HEADER = '[你想起的从前';
/** responder.ts 的两句日志：清理后为空当场再生成一次、再空算回复失败 */
export const EMPTIED = /模型回复清理后为空/;

/** 场景的 realRain → 一份假的逐小时实况（写了的日子：下雨的钟头是小雨，其余阴天），走和线上一样的 dayFrom */
function fakeRealWeather(rain: Readonly<Record<string, number[]>>): RealWeather {
    const hours: Record<string, HourWeather> = {};
    for (const [date, wet] of Object.entries(rain)) {
        for (let h = 0; h < 24; h++) hours[`${date}T${String(h).padStart(2, '0')}`] = { t: h >= 12 && h <= 16 ? 19 : 15, p: 0, c: wet.includes(h) ? 61 : 3, o: 1 };
    }
    return { day: (_place, date, until) => dayFrom(hours, date, until) };
}

interface SimulationOwner { stop(): void | Promise<void>; readonly running?: Promise<unknown> }
function simulationOwners() {
    const live = new Set<SimulationOwner>();
    const closing = new Set<() => void>(), final = new Set<() => void>();
    return {
        keep<T extends SimulationOwner>(owner: T): T { live.add(owner); return owner; },
        beforeClose(callback: () => void): void { closing.add(callback); },
        onFinal(callback: () => void): void { final.add(callback); },
        finish(): void { for (const callback of final) callback(); final.clear(); },
        async close(only?: readonly SimulationOwner[]): Promise<void> {
            const pending: Promise<unknown>[] = [];
            for (const callback of closing) { try { callback(); } catch (error) { pending.push(Promise.reject(error)); } }
            // Stop every owner before waiting for any ACK. One held mutation
            // must not leave another owner free to dispatch new work.
            for (const owner of only ?? [...live]) {
                live.delete(owner);
                try {
                    const drain = owner.stop();
                    if (drain) pending.push(drain);
                    if (owner.running) pending.push(owner.running);
                } catch (error) { pending.push(Promise.reject(error)); }
            }
            const failures = (await Promise.allSettled(pending)).filter((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failures.length) throw new AggregateError(failures.map(result => result.reason), '模拟器后台任务停止收尾失败，保留数据等待核对');
        },
    };
}

export async function runScenario(scenario: Scenario, options: RunOptions): Promise<RunResult> {
    const owners = simulationOwners();
    try { return await runOwnedScenario(scenario, options, owners); }
    finally { try { await owners.close(); } finally { owners.finish(); } }
}

async function runOwnedScenario(scenario: Scenario, options: RunOptions, owners: ReturnType<typeof simulationOwners>): Promise<RunResult> {
    let injecting = 0, responderEpoch = 0;
    let summaryLifetime = new AbortController();
    const injectionTimers = new Set<ReturnType<typeof setTimeout>>();
    owners.beforeClose(() => {
        responderEpoch++; summaryLifetime.abort();
        for (const timer of injectionTimers) clearTimeout(timer);
        injectionTimers.clear(); injecting = 0;
    });
    // 模拟用的全是虚构对话，报告就是给人看细节的（主动消息原文、出口检查命中了什么）：日志照旧写原文。
    // 线上的默认是不写（ADR 0070 第 8 项，sensitive.ts）；这里不恢复，因为同一进程里可能并行跑好几个场景，而模拟器不会进线上进程。
    useSensitiveSwitch(SENSITIVE_ON);
    const { dataDir } = options;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    mkdirSync(join(dataDir, 'prompts'), { recursive: true });
    const clock = new VirtualClock(new Date(scenario.start), options.realNow);
    const simMoments: Moment[] = scenario.moments.map(moment => ({
        ...moment,
        kind: moment.kind as Moment['kind'],
        strength: moment.strength as Moment['strength'],
        at: /^-\d/.test(moment.at) ? new Date(Date.parse(scenario.start) - parseDuration(moment.at.slice(1))).toISOString() : moment.at,
    }));
    // 假的「真实天气」（ADR 0050）：场景写了 realRain 的日子按它算（世界和主动消息都认），跑完换回来
    const fakeWeather = scenario.realRain ? fakeRealWeather(scenario.realRain) : undefined;
    if (fakeWeather) { useRealWeather(fakeWeather); owners.onFinal(() => useRealWeather(undefined)); }
    const contact: Contact = { qq: SIM_QQ, name: scenario.user, tier: scenario.tier, persona: scenario.persona, knowsBot: scenario.knowsBot };
    const names = { user: contact.name, char: options.card.character.name };
    // 下面从数据目录建的几样（聊天记录、记忆、世界、答应的事、日记、回复器、主动消息）在 restart 步骤里丢掉重建（ADR 0039）
    let history = new ChatHistory(dataDir);
    // 名单里的其他人（ADR 0016）：QQ 号接着往后排，事先的聊天先记进聊天记录
    const others: Contact[] = scenario.others.map((other, i) => ({
        qq: SIM_QQ + 1 + i, name: other.name, tier: other.tier, ...(other.intro ? { intro: other.intro } : {}),
    }));
    scenario.others.forEach((other, i) => {
        for (const message of other.history) history.append(others[i]!.qq, message);
    });
    // 她和他事先的聊天（ADR 0018）
    for (const message of scenario.history) history.append(contact.qq, message);

    const steps: StepRecord[] = [];
    let current = newStep('case', clock.now());
    const log: Log = message => {
        current.logs.push(message.replace(/^\[\d+\] /, ''));
        appendFileSync(join(dataDir, 'sim.log'), `[${new Date(clock.now()).toLocaleString('zh-CN', { hour12: false })}] ${message}\n`);
    };
    // Provider callbacks receive a log bound to the owner that dispatched them,
    // not a closure that can address the next restart's report.
    const generationLog = (): Log => {
        const epoch = responderEpoch;
        return message => { if (epoch === responderEpoch) log(message); };
    };

    let hindsightDown = false;
    const hindsight = options.hindsight && switchable(options.hindsight, () => hindsightDown);
    const openMemory = () => (scenario.memory && hindsight
        ? owners.keep(new LongTermMemory({
            api: hindsight,
            dir: join(dataDir, 'memory'),
            bankPrefix: `sim-${options.runId}`,
            recallTimeoutMs: options.recallTimeoutMs ?? 5000,
            log,
            now: clock.now,
            common: true,
        }))
        : undefined);
    let memory = openMemory();
    const bankId = memory?.bankId(contact);
    /** 跑完要删的：他自己的、名单里其他人的、公共库 */
    const banks = memory ? [bankId!, ...others.map(other => memory!.bankId(other)), memory.commonBankId()] : [];
    const { character } = options.card;
    // 闺蜜的约（ADR 0061）：场景开着才有；开关在世界对象上，其余代码照旧读世界
    if (scenario.npcAsks && character.herWorld) character.herWorld.asks = true;
    // 公共节日（ADR 0076）：并进这一档的重要的日子；场景的开场时刻决定算哪几年
    character.dates = withFestivals(character.dates, new Date(clock.now()), scenario.festivals);
    withFestivalActivities(character.schedule, new Date(clock.now()), scenario.festivals);
    // W3：模拟器和线上共用同一状态层，抽取后的动作立即影响后续提示词和日记。
    const openWorld = () => {
        const ledger = options.herDays && scenario.schedule && character.schedule && character.herWorld
            ? worldState(character.herWorld, character.schedule, log, join(options.dataDir, 'world'), clock.now)
            : undefined;
        const queue = ledger ? actionQueue(join(options.dataDir, 'world', 'action-queue.json'), log) : undefined;
        // 没人聊天时她也过日子（ADR 0040）：执行器从场景开始那一刻排起，读的是不带结算的那一层世界
        const herWorld = character.herWorld;
        const executor = scenario.autonomous && ledger && queue && character.schedule && herWorld
            ? lifeExecutor({
                schedule: character.schedule, books: character.books, ...(herWorld.plans ? { plans: herWorld.plans } : {}),
                worldAt: time => ledger.at(herWorld, character.schedule!, time), events: () => ledger.events(),
                ...(scenario.projectChoice ? { projectChoice: true } : {}),
                ...(herWorld.body ? { bodyAt: (time: Date) => bodyAt(herWorld.body!, character.schedule!, time) } : {}),
                // 她跟谁说过「睡了」（ADR 0042）：和 app.ts 一样看名单里所有人的聊天记录（restart 之后 history 是新读的那一份）
                bedtimes: () => saidBedtimes([contact, ...others].map(person => history.load(person.qq)), character.schedule!, clock.now() - 86_400_000),
            }, queue, { since: new Date(scenario.start), log })
            : undefined;
        if (scenario.autonomous && !executor) throw new Error('autonomous 要开着作息、她自己的日子，卡上要有世界');
        // 开场先记进账的、他给的钱（和线上补记一样走事件账，ADR 0027 调整）；restart 时账已经有了就不重复记
        if (ledger && scenario.gifts?.length && !ledger.events().some(e => e.kind === 'receive_money')) {
            ledger.recordEvents(scenario.gifts.map((g, i) => ({
                id: `sim-gift:${i}`, kind: 'receive_money', startedAt: new Date(g.at).toISOString(), at: new Date(g.at).toISOString(),
                source: 'conversation' as const, result: 'succeeded' as const, amount: g.amount, contact: contact.qq, episode: 'sim-gift',
                ...(g.forCamera ? { target: CAMERA_FUND_TARGET } : {}),
            })));
        }
        // 读世界之前先结算到期的行动（ADR 0038 调整）：聊天、时间块、日记看到的都算上已经做完的
        const plan = executor ? (now: Date) => { executor.fill(now); } : undefined;
        return { ledger, queue, world: ledger && queue ? settlingWorld(ledger, queue, clock.now, plan) : undefined };
    };
    // restart 步骤里丢掉重建：行动队列也从 action-queue.json 读回来（ADR 0038 的重启恢复）
    let { ledger: ledgerWorld, queue: queuedActions, world: sharedWorld } = openWorld();
    // 她的日记（ADR 0017）：和 bot 一样，跨过她的一天就补写，存进公共库；场景关了作息就没有她的一天，不写
    // 她答应过的事（ADR 0018 决策 2）：和 bot 一样，开了记忆就抽（记忆同步时），到了日子在时间块里提醒，那天的打算写进日记
    // 场景开场就有的约（ADR 0066）：写进她答应的事的状态文件，不靠模型抽取；有它就开着答应的事，不要求开长期记忆
    if (scenario.promises?.length) {
        mkdirSync(join(dataDir, 'promises'), { recursive: true });
        writeJsonAtomic(join(dataDir, 'promises', `${contact.qq}-${contact.tier}.json`), {
            promises: scenario.promises.map((p, i) => ({
                id: `p-seed-${i + 1}`, what: p.what, date: p.date, said: p.said, episode: 'ep-0',
                meet: { time: p.time, ...(p.where ? { where: p.where } : {}), minutes: MEET_MINUTES },
            })),
            loops: [], extracted: {}, early: {},
        });
    }
    const openPromises = () => (memory || scenario.promises?.length
        ? owners.keep(promiseKeeper({
            contacts: [contact, ...others],
            history,
            names: person => ({ user: person.name, char: names.char }),
            ...(scenario.schedule && options.card.character.schedule ? { schedule: options.card.character.schedule } : {}),
            extract: messages => {
                const scoped = generationLog();
                return options.generate ? options.generate(messages, scoped) : chatCompletion(forExtraction(options.llm), messages, { log: scoped });
            },
            dir: join(dataDir, 'promises'),
            log,
            now: clock.now,
            ...(sharedWorld ? { onWorldActions: sharedWorld.record } : {}),
        }))
        : undefined);
    let promises = openPromises();
    const diaryCard = options.card.character;
    const openDiaries = () => (memory && scenario.schedule && diaryCard.schedule
        ? owners.keep(diaryWriter({
            sources: {
                charName: diaryCard.name,
                schedule: diaryCard.schedule,
                moods: options.herDays ? diaryCard.moods : [],
                books: options.herDays ? diaryCard.books : [],
                ...(options.herDays && options.diaryWorld ? { world: options.diaryWorld, ...(options.diaryWorldSchedule ? { worldSchedule: options.diaryWorldSchedule } : {}) } : {}),
                ...(sharedWorld ? { resolveWorld: sharedWorld.at } : {}),
                ...(scenario.mood !== undefined ? { mood: scenario.mood } : {}),
            },
            contacts: [contact, ...others],
            history,
            memory,
            ...(promises ? { plans: promises.plansOn } : {}),
            generate: messages => {
                const scoped = generationLog();
                return options.generate ? options.generate(messages, scoped) : chatCompletion({ ...options.llm, temperature: DIARY_TEMPERATURE }, messages, { log: scoped });
            },
            dir: join(dataDir, 'memory'),
            log,
        }))
        : undefined);
    let diaries = openDiaries();
    const bindWrittenSources = () => {
        const writer = diaries;
        memory?.setWrittenSourceVerifier(writer ? intents => writer.verifySources(new Date(clock.now()), intents) : null);
        memory?.derivedAvailable();
    };
    bindWrittenSources();

    let nextMessageId = 1;
    let armed: SayStep['interrupt'];
    let bubblesThisStep = 0;
    let generationCount = 0;
    let lastInputTime: number | undefined;

    const receive = (text: string, interrupt = false) => {
        const time = clock.now();
        lastInputTime = time;
        current.inputs.push({ time, text, ...(interrupt ? { interrupt } : {}) });
        responder.receive(text, nextMessageId++, new Date(time));
        planner?.poke();
    };
    /** 正在主动找他：这时发出的气泡标成主动的（时机的说法） */
    let initiating: string | undefined;
    const baseGenerate = (messages: OpenAIMessage[], log: Log, use?: BotConfig['llm']) => (options.generate
        ? options.generate(messages, log)
        : chatCompletion(use ?? options.llm, messages, { log }));

    if (scenario.mood !== undefined && !character.moods.some(mood => mood.name === scenario.mood)) {
        throw new Error(`场景的 mood「${scenario.mood}」不是卡上的心情（${character.moods.map(mood => mood.name).join('、') || '这一档没有心情'}）`);
    }
    // 最近几轮 + 要点（ADR 0043）：整理要点和抽答应的事一样用抽取的参数；重建回复器（forget、restart）时沿用同一个，整理过的不再整理
    const contextWindow = options.contextTurns
        ? {
            ...options.contextTurns,
            summarize: contextSummarizer({
                names,
                generate: messages => {
                    const signal = summaryLifetime.signal, scoped = generationLog();
                    return new Promise<string>((resolve, reject) => {
                        const abort = () => reject(new Error('模拟器上下文整理已停止'));
                        if (signal.aborted) { abort(); return; }
                        signal.addEventListener('abort', abort, { once: true });
                        Promise.resolve().then(() => {
                            if (signal.aborted) throw new Error('模拟器上下文整理已停止');
                            return options.generate ? options.generate(messages, scoped) : chatCompletion(forExtraction(options.llm), messages, { log: scoped });
                        })
                            .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
                    });
                },
                log,
            }),
        }
        : undefined;
    const ownSummary = () => { if (contextWindow) owners.keep({ stop: () => contextWindow.summarize.idle() }); };
    ownSummary();
    // 她自己的日子：和 bot 一样，她的每一天第一次生成时在 sim.log 里写一行当天的心情和进度
    const openHerDayLogger = () => (options.herDays && character.schedule
        ? herDayLogger(character.schedule, character.moods, character.books, log, scenario.mood)
        : undefined);
    let noteMoodAndBooks = openHerDayLogger();
    // 她的世界（ADR 0021）：每天一行摘要，state.json 写在这次的数据目录
    const noteHerDay = noteMoodAndBooks || sharedWorld ? (now: Date) => { noteMoodAndBooks?.(now); sharedWorld?.note(now); } : undefined;
    // 假的图片表情收藏（ADR 0063）：用真的 shelf（提示词清单、清理、历史描述都是线上同一份代码），文件是空的
    const stickers = scenario.stickers ? (() => {
        const dir = join(dataDir, 'stickers');
        mkdirSync(dir, { recursive: true });
        for (const entry of scenario.stickers!) writeFileSync(join(dir, `${entry.id}.png`), '');
        writeFileSync(join(dir, 'index.json'), JSON.stringify({
            version: 1, seen: [],
            entries: scenario.stickers!.map(entry => ({ id: entry.id, file: `${entry.id}.png`, description: entry.description, tags: entry.tags, source: { kind: 'qq-custom' }, createdAt: new Date(clock.now()).toISOString(), used: 0 })),
        }));
        return stickerShelf({ dir, describe: async () => '', decide: async () => ({ keep: false, description: '', tags: [] }), log });
    })() : undefined;
    // 假的照片货架（ADR 0109）：真的 shelf，文件是假图
    const photos = scenario.photos ? (() => {
        const src = join(dataDir, 'photo-src');
        mkdirSync(src, { recursive: true });
        const shelf = photoShelf({ dir: join(dataDir, 'photos'), log, now: () => new Date(clock.now()) });
        scenario.photos!.forEach((entry, i) => { const file = join(src, `p${i}.jpg`); writeFileSync(file, `fake-photo-${i}-${entry.caption}`); shelf.add(file, entry.kind, entry.caption, entry.dish); });
        return shelf;
    })() : undefined;
    const createResponder = () => {
        const epoch = responderEpoch;
        return owners.keep(createContactResponder({
        contact,
        card: options.card,
        llm: options.llm,
        prompt: options.prompt,
        schedule: scenario.schedule,
        moody: scenario.moody,
        ...(scenario.moodyChance !== undefined ? { moodyChance: scenario.moodyChance } : {}),
        speechCheck: options.speechCheck ?? false,
        herDays: options.herDays ?? false,
        ...(options.candidates ? { candidates: options.candidates } : {}),
        ...(scenario.mood !== undefined ? { mood: scenario.mood } : {}),
        ...(noteHerDay ? { onHerDay: noteHerDay } : {}),
        ...(contextWindow ? { contextWindow: { ...contextWindow, summarize: Object.assign(
            (older: Parameters<typeof contextWindow.summarize>[0]) => epoch === responderEpoch ? contextWindow.summarize(older) : { ready: false as const },
            { idle: () => contextWindow.summarize.idle() },
        ) } } : {}),
        history,
        memory,
        ...(promises ? { promises } : {}),
        ...(sharedWorld ? { worldState: sharedWorld } : {}),
        ...(scenario.projectChoice && scenario.autonomous ? { projectChoice: true } : {}),
        ...(scenario.lifeInPrompt && scenario.autonomous ? { lifeInPrompt: true } : {}),
        ...(scenario.grievance ? { grievance: true } : {}),
        ...(scenario.rhythm ? { rhythm: true } : {}),
        ...(scenario.shortReplies ? { shortReplies: true } : {}),
        ...(scenario.shape || options.shape || scenario.shapeAgenda || options.shapeAgenda || scenario.shapeFiller || options.shapeFiller || scenario.shapeFeel || options.shapeFeel || scenario.shapeSplit || options.shapeSplit || options.shapeAsk || options.shapeLong ? { shape: true } : {}),
        ...(scenario.shapeAgenda || options.shapeAgenda ? { shapeAgenda: true } : {}),
        ...(scenario.shapeFiller || options.shapeFiller ? { shapeFiller: true } : {}),
        ...(scenario.shapeFeel || options.shapeFeel ? { shapeFeel: true } : {}),
        // 她最近心里在想什么（ADR 0101）：计划器在后面才建，每次现取
        ...(scenario.innerLife ? { innerLine: () => planner?.innerLine() } : {}),
        // 心境（ADR 0102）：场景里的 moments 的 at 可以写 "-3h" 这样相对开场的偏移
        ...(scenario.herFeelings ? { herFeelings: true, moments: () => simMoments } : {}),
        ...(scenario.texture ? { texture: true } : {}),
        ...(scenario.quoteReply ? { quoteReply: true, ...(scenario.quoteShare !== undefined ? { quoteShare: scenario.quoteShare } : {}) } : {}),
        // 逐条事实检查（ADR 0137）：审稿的调用走场景自己的模型（假模型也行）；每次的记录进这一步，报告里看得到
        ...((options.factCheck ?? scenario.factCheck) !== 'off' ? {
            factCheck: options.factCheck ?? scenario.factCheck,
            ...(options.factHim ? { factAboutHim: true } : {}),
            factAudit: (messages: OpenAIMessage[]) => {
                if (epoch !== responderEpoch) return Promise.reject(new Error('模拟回复器已停止'));
                const scoped = generationLog();
                return options.generate ? options.generate(messages, scoped) : chatCompletion({ ...forExtraction(options.llm), temperature: 0 }, messages, { log: scoped });
            },
            onFactCheck: (record: FactRecord) => { if (epoch === responderEpoch) (current.facts ??= []).push(record); },
        } : {}),
        // 做判断的模块（ADR 0336），顺序同 App：意图阶梯总在最前；小梗（ADR 0114）直接给场景里写好的梗，不抽
        turnModules: [
            intentModule({
                ...(scenario.herNo ? { refuse: true } : {}), ...(scenario.afterNo ? { afterNo: true } : {}), ...(scenario.jealousy ? { jealous: true } : {}), ...(scenario.curious ? { curious: true } : {}),
                ...(scenario.everydayLife ? { everydayLife: true } : {}), ...(scenario.pursuits ? { pursuits: true } : {}),
            }),
            // 接话的基本规矩（DSH 10-30 / 10-31）：每一轮都放，同 App
            replyBasicsModule(),
            asksModule(message => { if (epoch === responderEpoch) log(message); }),
            readingModule(message => { if (epoch === responderEpoch) log(message); }),
            registerModule(message => { if (epoch === responderEpoch) log(message); }),
            scenesModule(message => { if (epoch === responderEpoch) log(message); }),
            voiceModule(message => { if (epoch === responderEpoch) log(message); }),
            ...(scenario.relationship ? [closenessModule(message => { if (epoch === responderEpoch) log(message); })] : []),
            ...(scenario.jokes?.length ? [jokesTurnModule(() => scenario.jokes!, message => { if (epoch === responderEpoch) log(message); })] : []),
            ...(scenario.idioms?.length ? [idiomsTurnModule(() => scenario.idioms!.map(item => ({ phrase: item.phrase, kind: item.kind ?? '口头禅', count: 9, days: 5 })), message => { if (epoch === responderEpoch) log(message); }, scenario.idiomShare)] : []),
            ...(scenario.together ? [togetherModule(message => { if (epoch === responderEpoch) log(message); })] : []),
            ...(scenario.interruptions ? [interruptionsModule(message => { if (epoch === responderEpoch) log(message); })] : []),
            // 网络热梗（ADR 0129）：直接给场景里写好的梗，当作今天刚在榜上，不学
            ...(scenario.memes?.length ? [memesModule(() => { const day = formatDate(new Date(clock.now())); return scenario.memes!.map(m => ({ term: m.term, meaning: m.meaning, example: '', confidence: 'mid' as const, firstSeen: day, lastSeen: day, seen: 1 })); }, message => { if (epoch === responderEpoch) log(message); })] : []),
            // 她看视频（ADR 0130）：直接给场景里写好的，当作今天刚看过，不去看
            ...(scenario.watched?.length ? [watchedModule(() => { const day = formatDate(new Date(clock.now())); return scenario.watched!.map((w, i) => ({ bvid: `BV1sim${i}`, title: w.title, owner: w.owner, tname: w.tname, excerpt: w.excerpt, hot: w.hot ?? [], day })); }, message => { if (epoch === responderEpoch) log(message); })] : []),
        ],
        ...(scenario.memoryFeelings && scenario.herFeelings ? { memoryFeelings: true } : {}),
        ...(scenario.shapeAll ? { shapeAll: true } : {}),
        // 她没想完的问题（ADR 0207）：想出来的在数据目录的 open-questions.json，每次现取
        ...(scenario.openQuestions && scenario.tier === 'boyfriend' ? { openQuestions: thoughtsReader(dataDir) } : {}),
        ...(scenario.lagTail ? { lagTail: true } : {}),
        ...(scenario.everydayLife ? { everydayLife: true } : {}),
        ...(scenario.shapeShares ? { shapeShares: scenario.shapeShares } : {}),
        ...(scenario.pursuits ? { pursuits: () => mergePursuits(scenario.pursuitsFile as Pursuit[]) } : {}),
        ...(scenario.shapeSplit || options.shapeSplit ? { shapeSplit: true } : {}),
        ...(options.shapeAsk ? { shapeAsk: true } : {}),
        ...(options.shapeLong ? { shapeLong: true } : {}),
        ...(options.deliberateLlm ? { deliberate: { llm: options.deliberateLlm, ...(options.deliberateNote ? { note: options.deliberateNote } : {}) } } : {}),
        ...(options.depthRouting && options.deliberateLlm ? {
            turnWeight: createTurnWeigher({
                ask: messages => (options.generate ? options.generate(messages, log) : chatCompletion({ ...options.llm, temperature: 0, maxTokens: 80, timeoutMs: WEIGH_TIMEOUT_MS, extraBody: { ...(Object.fromEntries(Object.entries(options.llm.extraBody ?? {}).filter(([key]) => key !== 'reasoning_effort'))), thinking: { type: 'disabled' } } }, messages, { log })),
                log: line => log(line),
            }),
        } : {}),
        ...(options.replyFrame ? { replyFrame: options.replyFrame } : {}),
        ...(options.devices ? { devices: options.devices } : {}),
        ...(stickers ? { stickers } : {}),
        ...(photos && scenario.tier === 'boyfriend' ? { photos } : {}),
        ...(scenario.stickerChance !== undefined ? { stickerChance: scenario.stickerChance } : {}),
        ...(scenario.stickerUncued !== undefined ? { stickerUncued: scenario.stickerUncued } : {}),
        ...(scenario.stickerOnlyChance !== undefined ? { stickerOnlyChance: scenario.stickerOnlyChance } : scenario.shapeFeel || options.shapeFeel ? { stickerOnlyChance: STICKER_ONLY_SHARE } : {}),
        contacts: [contact, ...others],
        log: message => { if (epoch === responderEpoch) log(message); },
        now: clock.now,
        settle: options.settle,
        retryAfterMs: [],
        waitUntil: clock.waitUntil,
        send: async (_userId, text, sendOptions) => {
            if (epoch !== responderEpoch) throw new Error('旧模拟回复器已停止，本次未发送');
            const quoted = sendOptions?.replyTo === undefined ? undefined : history.load(contact.qq).find(m => m.messageId === sendOptions.replyTo)?.content;
            current.bubbles.push({ time: clock.now(), text, ...(initiating ? { proactive: initiating } : {}), ...(quoted ? { quote: quoted } : {}) });
            bubblesThisStep++;
            if (armed?.afterBubbles !== undefined && bubblesThisStep >= armed.afterBubbles) {
                const it = armed;
                armed = undefined;
                // 等这一条记进聊天记录之后、下一条发出之前再插话（气泡间隔是 1 秒）
                injecting++;
                const timer = setTimeout(() => {
                    injectionTimers.delete(timer);
                    if (epoch !== responderEpoch) return;
                    injecting--; receive(it.say, true);
                }, 100);
                injectionTimers.add(timer);
            }
            return nextMessageId++;
        },
        generate: async (messages, log, use) => {
            const generation = current.generations.at(-1);
            const reply = baseGenerate(messages, log, use);
            if (armed?.during === 'generation') {
                const it = armed;
                armed = undefined;
                receive(it.say, true);
            }
            const raw = await reply;
            if (epoch !== responderEpoch) return raw;
            // 出口检查的重写不经过 onPrompt，算在同一次生成里
            if (generation) {
                if (generation.raw === undefined) generation.raw = raw;
                else (generation.rewrites ??= []).push(raw);
            }
            return raw;
        },
        onPrompt: prompt => {
            if (epoch !== responderEpoch) return;
            current.generations.push(dynamicParts(prompt, clock.now()));
            writeFileSync(join(dataDir, 'prompts', `${++generationCount}.json`), JSON.stringify(prompt, null, 2));
        },
        }));
    };
    let responder = createResponder();
    let forgotten = 0;

    // 主动消息（ADR 0011）：场景开着、卡上有主动设置和作息时，计划器跑在虚拟时钟上（真发，记录在 dataDir/proactive）
    // 场景可以先把还没上线的事件类开起来（ADR 0064）
    const proactiveBase = character.proactive && (scenario.newsKinds || scenario.extraOccasions)
        ? {
            ...character.proactive,
            ...(scenario.newsKinds ? { newsKinds: scenario.newsKinds } : {}),
            ...(scenario.extraOccasions ? { occasions: [...new Set([...character.proactive.occasions, ...scenario.extraOccasions])] } : {}),
        }
        : character.proactive;
    const withReached = proactiveBase && scenario.proactiveReach ? withReach(proactiveBase) : proactiveBase;
    const withInned = withReached && scenario.innerLife ? withInner(withReached) : withReached;
    const withInvitedOnly = withInned && scenario.proactiveInvite ? withInvite(withInned) : withInned;
    const withInvited = withInvitedOnly && scenario.proactiveAsk ? withAsk(withInvitedOnly) : withInvitedOnly;
    const withPhotoShare = withInvited && scenario.photoShares && scenario.photos ? withCatPhoto(withInvited) : withInvited;
    const withBacked = withPhotoShare && scenario.comeBack ? withBack(withPhotoShare) : withPhotoShare;
    const withRoomed = withBacked && scenario.proactiveRoom ? withRoom(withBacked) : withBacked;
    const withCurioused = withRoomed && scenario.curious ? withCurious(withRoomed) : withRoomed;
    const withSmalled = withCurioused && scenario.smallNews ? withSmallNews(withCurioused) : withCurioused;
    const proactiveSettings = withSmalled && scenario.foodPhotos && scenario.menu && scenario.photos ? withFoodShares(withSmalled) : withSmalled;
    const openPlanner = (): Planner | undefined => (scenario.proactive && scenario.schedule && proactiveSettings && character.schedule
        ? owners.keep(createProactivePlanner({
            contact,
            schedule: character.schedule,
            settings: proactiveSettings,
            ...(scenario.innerLife ? { inner: true } : {}),
            ...(scenario.innerLife && scenario.watched?.length ? { watchedFacts: () => { const d = new Date(clock.now()); const day = formatDate(d); return watchedFacts(scenario.watched!.map((w, i) => ({ bvid: `BV1sim${i}`, title: w.title, owner: w.owner, tname: w.tname, excerpt: w.excerpt, hot: w.hot ?? [], day })), d); } } : {}),
            ...(scenario.hisHours ? { hisHours: true } : {}),
            ...(scenario.together ? { together: (at: number) => Boolean(togetherNow(history.load(contact.qq), at)) } : {}),
            ...(photos && (scenario.photoShares || scenario.foodPhotos) ? { photoReady: (kind: 'cat' | 'food', at: number, dish?: string) => photos.has(kind, dish) && photoAllowance(history.load(contact.qq), at).allowed } : {}),
            dates: character.dates,
            mode: 'on',
            history,
            // 「forget」之后换了新的回复器：每次取当前的
            responder: {
                initiate: async request => {
                    const occasion = request.label.replace(/[[（].*$/, '');
                    if (scenario.proactiveOffline?.includes(occasion)) {
                        log(`主动找他（${request.label}）：场景里这个时机断网`);
                        return { result: 'failed', reason: '模型接口请求失败（场景：断网）', unreachable: true };
                    }
                    initiating = occasion;
                    try {
                        return await responder.initiate(request);
                    } finally {
                        initiating = undefined;
                    }
                },
                catchUp: () => responder.catchUp(),
                status: () => responder.status(),
            },
            dir: join(dataDir, 'proactive'),
            log,
            skip: replySkip(character, scenario.moody, scenario.moodyChance),
            asleep: now => Boolean(asleepSince(character.schedule!, saidBedtimes([contact, ...others].map(person => history.load(person.qq)), character.schedule!, now - 86_400_000), new Date(now))),
            // 下雨了主动找他（ADR 0050）：和 app.ts 一样只在有真实天气时给；这里是场景的 realRain
            ...(fakeWeather && sharedWorld && character.herWorld ? {
                weather: (now: number) => {
                    const seen = sharedWorld!.at(character.herWorld!, character.schedule!, new Date(now));
                    return seen ? { day: seen.day, ...(seen.weather ? { weather: seen.weather } : {}) } : undefined;
                },
            } : {}),
            // 她那边的事（ADR 0057）：和 app.ts 一样
            ...(sharedWorld && character.herWorld ? {
                news: newsFrom(now => sharedWorld!.at(character.herWorld!, character.schedule!, now), character.schedule!, {
                    kinds: newsKindsOf(proactiveSettings),
                    ...(character.herWorld.body ? { bodyAt: (time: Date) => bodyAt(character.herWorld!.body!, character.schedule!, time) } : {}),
                }),
            } : {}),
            // 约好之后她这边出了事、想改约（ADR 0066）：和 app.ts 一样；约要开了记忆才有
            ...(sharedWorld && character.herWorld && character.schedule ? {
                reschedule: reschedulesFrom({
                    qq: contact.qq,
                    appointments: (from, to) => promises?.appointmentsBetween(from, to) ?? [],
                    facts: {
                        schedule: character.schedule,
                        worldAt: time => sharedWorld!.at(character.herWorld!, character.schedule!, time),
                        appointments: (from, to) => promises?.appointmentsBetween(from, to) ?? [],
                        ...(character.herWorld.body ? { bodyAt: (time: Date) => bodyAt(character.herWorld!.body!, character.schedule!, time) } : {}),
                    },
                }),
            } : {}),
            now: clock.now,
            waitUntil: clock.waitUntil,
            names,
            extract: messages => {
                const scoped = generationLog();
                return options.generate ? options.generate(messages, scoped) : chatCompletion(forExtraction(options.llm), messages, { log: scoped });
            },
        }))
        : undefined);
    let planner = openPlanner();
    if (scenario.proactive && !planner) log('场景开了主动消息，但卡上没有主动设置或作息，不主动');

    const closeOwners = async () => {
        await owners.close();
        await contextWindow?.summarize.idle();
    };

    /** 等她把这一轮（含插话之后的回复）都发完，或者停在「到点才看到」的等待上 */
    async function settle(): Promise<void> {
        for (;;) {
            // 要点在后台整理（ADR 0043）：线上不等，模拟器每轮等它做完，结果可复现（切口刚挪的那一轮照旧放最近 80 条，下一轮起用要点）
            await contextWindow?.summarize.idle();
            await responder.whenQuiet();
            const before = history.load(contact.qq).length;
            await sleep(300);
            if (injecting === 0 && history.load(contact.qq).length === before) {
                await responder.whenQuiet();
                if (history.load(contact.qq).length === before) return;
            }
        }
    }

    /**
     * 把虚拟时钟一个个拨到她等着的时刻（不超过 limit），每拨一次等她这一轮做完；stop：这一步满足了就停（她回了、她主动发了）。
     * 开着主动消息时，途中聊天片段结束（安静 45 分钟）那一刻先停一下，抽待跟进的事（bot 里是每 5 分钟查一次）
     */
    async function runTimers(limit: number, stop?: () => boolean): Promise<void> {
        for (;;) {
            await settle();
            if (stop?.()) return;
            const next = clock.nextTimer();
            if (planner) {
                const last = history.load(contact.qq).at(-1);
                const closeAt = last ? Date.parse(last.time) + EPISODE_GAP_MS : undefined;
                if (closeAt !== undefined && closeAt > clock.now() && closeAt <= Math.min(next ?? Infinity, limit)) {
                    clock.advanceTo(closeAt);
                    await planner.syncFollowUps();
                    continue;
                }
            }
            if (next === undefined || next > limit) return;
            clock.advanceTo(next);
        }
    }

    /** 把这几个人结束了的片段写进记忆（各自的 bank 和公共库），补写日记，等 Hindsight 做完 */
    async function syncMemory(who: Contact[] = [contact]): Promise<void> {
        const mind = memory;
        if (!mind || !options.hindsight || !bankId || hindsightDown) return;
        for (const person of who) await mind.sync(person, { user: person.name, char: names.char }, history.load(person.qq));
        await diaries?.catchUp(new Date(clock.now()));
        await promises?.sync();
        const watched = [...who.map(person => mind.bankId(person)), mind.commonBankId()];
        const started = Date.now();
        const limit = options.hindsightWaitMs ?? 240_000;
        let quietPolls = 0;
        while (quietPolls < 2) {
            let busy = 0;
            let created = 0;
            for (const bank of watched) {
                try {
                    // 关系概况的自动刷新有 30 分钟（真实时间）的最短间隔，会一直排着，不等它；T23 用手动刷新
                    busy += (await options.hindsight.activeOperations(bank)).filter(t => t !== 'refresh_mental_model').length;
                    created++;
                } catch {
                    // bank 还没建（没有结束了的片段）
                }
            }
            if (created === 0) return;
            quietPolls = busy === 0 ? quietPolls + 1 : 0;
            if (Date.now() - started > limit) {
                log(`Hindsight 后台任务 ${Math.round(limit / 1000)} 秒还没做完，不再等`);
                return;
            }
            await sleep(1000);
        }
        log(`Hindsight 后台任务做完（${Math.round((Date.now() - started) / 1000)} 秒）`);
    }

    let lastSay: StepRecord | undefined;
    /** 上一个主动消息检查查到哪一步了 */
    let proactiveCheckedUpTo = 0;
    try {
        if (others.length) log(`名单里的其他人：${others.map(other => `${other.name}（${other.tier}${other.intro ? '，有介绍' : ''}）`).join('、')}`);
        // 起点：事先的聊天写进记忆，起点之前的几天补写日记（ADR 0017）
        await syncMemory([...(scenario.history.length ? [contact] : []), ...others]);
        for (const step of scenario.steps) {
            current = newStep(Object.keys(step)[0] as StepRecord['kind'], clock.now());
            steps.push(current);
            if ('case' in step) {
                current.caseId = step.case;
                current.note = step.note;
            } else if ('say' in step) {
                lastSay = current;
                bubblesThisStep = 0;
                armed = step.interrupt;
                const texts = (Array.isArray(step.say) ? step.say : [step.say]).map(sayText);
                for (const [i, text] of texts.entries()) {
                    if (i > 0) await sleep(step.gapMs ?? 800);
                    receive(text);
                }
                current.inputTime = lastInputTime;
                await runTimers(lastInputTime! + AUTO_TIMER_MS);
                if (armed) {
                    log(`插话没有触发（这一轮她只发了 ${bubblesThisStep} 条）`);
                    armed = undefined;
                }
            } else if ('life' in step) {
                if (!sharedWorld) throw new Error('life 步骤需要开启 herDays、schedule，并使用带世界的角色卡');
                const at = new Date(clock.now()).toISOString();
                sharedWorld.recordEvents([{
                    id: `sim:${options.runId}:${step.life.id}`,
                    kind: step.life.kind,
                    at,
                    source: 'simulation',
                    result: step.life.result ?? 'succeeded',
                    ...(step.life.subject ? { subject: step.life.subject } : {}),
                    ...(step.life.target ? { target: step.life.target } : {}),
                    ...(step.life.seen !== undefined ? { seen: step.life.seen } : {}),
                }]);
                const event = sharedWorld.events().find(item => item.id === `sim:${options.runId}:${step.life.id}`);
                current.life = `${step.life.kind}：${event?.result ?? 'rejected'}`;
            } else if ('action' in step) {
                if (!sharedWorld || !queuedActions || !character.schedule || !character.herWorld) {
                    throw new Error('action 步骤需要开启 herDays、schedule，并使用带世界的角色卡');
                }
                const startedAt = new Date(clock.now());
                const id = `sim:${options.runId}:action:${step.action.id}`;
                const verdict = queuedActions.schedule({
                    id, kind: step.action.kind, startedAt, source: 'simulation',
                    ...(step.action.subject ? { subject: step.action.subject } : {}),
                    ...(step.action.target ? { target: step.action.target } : {}),
                    ...(step.action.durationMinutes !== undefined ? { durationMinutes: step.action.durationMinutes } : {}),
                }, {
                    schedule: character.schedule,
                    world: sharedWorld.at(character.herWorld, character.schedule, startedAt),
                    books: character.books,
                    events: sharedWorld.events(),
                });
                if (!verdict.ok) {
                    sharedWorld.recordEvents([verdict.event]);
                    current.action = `${step.action.kind}：failed（${verdict.reason}）`;
                } else {
                    current.action = `${step.action.kind}：planned → ${new Date(verdict.event.at).toLocaleString('zh-CN', { hour12: false })}`;
                }
            } else if ('advance' in step) {
                current.advance = step.advance;
                const target = clock.now() + parseDuration(step.advance);
                await runTimers(target);
                clock.advanceTo(target);
                if (queuedActions && ledgerWorld) queuedActions.settleDue(new Date(clock.now()), ledgerWorld);
                current.time = clock.now();
                await syncMemory();
            } else if ('video' in step) {
                const v = step.video;
                const bvid = 'BV1sim0000000';
                const video = { bvid, aid: 0, title: v.title, desc: v.desc ?? '-', owner: v.owner, category: v.category, views: 0, likes: 0, duration: v.minutes * 60, link: `https://www.bilibili.com/video/${bvid}` };
                if (v.via === 'dm') {
                    // 私信（ADR 0089）：像线上一样先写（试运行，不进 QQ），把草稿记成一个气泡方便检查，再记进聊天记录；nudge 时在 QQ 上提醒一句
                    initiating = 'B 站私信（写）';
                    let drafted;
                    try {
                        drafted = await responder.initiate({ label: 'B 站私信（写）', note: dmNote(video, v.comments ?? [], scenario.user, v.excerpt), topic: videoTopic(scenario.user), maxBubbles: 1, dryRun: true, commit: () => undefined });
                    } finally {
                        initiating = undefined;
                    }
                    if (drafted.result === 'dryRun') {
                        const text = drafted.parts.join('\n');
                        current.bubbles.push({ time: clock.now(), text, proactive: 'B 站私信（写）' });
                        history.append(contact.qq, { time: new Date(clock.now()).toISOString(), role: 'assistant', content: `[B 站私信] ${text}（《${video.title}》）`, messageId: dmMessageId(clock.now()) });
                    } else {
                        log(`私信没写出来：${drafted.result}`);
                    }
                    if (v.nudge && drafted.result === 'dryRun') {
                        initiating = 'B 站私信（提醒）';
                        try {
                            await responder.initiate({ label: 'B 站私信（提醒）', note: nudgeNote(scenario.user), topic: videoTopic(scenario.user), maxBubbles: 1, dryRun: false, allowRepeat: true, commit: () => undefined });
                        } finally {
                            initiating = undefined;
                        }
                        await runTimers(clock.now() + WAIT_REPLY_MS, () => current.bubbles.some(b => b.proactive === 'B 站私信（提醒）'));
                    }
                } else {
                    initiating = 'B 站视频';
                    try {
                        await responder.initiate({ label: 'B 站视频', note: videoNote(video, v.comments ?? [], scenario.user, v.excerpt), topic: videoTopic(scenario.user), maxBubbles: 2, dryRun: false, commit: () => undefined });
                    } finally {
                        initiating = undefined;
                    }
                    await runTimers(clock.now() + WAIT_REPLY_MS, () => current.bubbles.some(b => b.proactive));
                }
            } else if ('wait' in step && step.wait === 'proactive') {
                await runTimers(clock.now() + WAIT_REPLY_MS, () => current.bubbles.some(b => b.proactive));
                if (!current.bubbles.some(b => b.proactive)) log('等了一天她也没主动找');
            } else if ('wait' in step) {
                lastSay = current;
                current.inputTime = lastInputTime;
                await runTimers(clock.now() + WAIT_REPLY_MS, () => current.bubbles.length > 0);
                if (current.bubbles.length === 0) log('等了一天也没回');
            } else if ('memory' in step) {
                await syncMemory();
            } else if ('refresh' in step) {
                if (options.hindsight && bankId && !hindsightDown) {
                    const operation = await options.hindsight.refreshMentalModel(bankId, RELATIONSHIP_MODEL.id);
                    const started = Date.now();
                    let status = '';
                    while (!['completed', 'failed', 'cancelled', 'not_found'].includes(status) && Date.now() - started < (options.hindsightWaitMs ?? 240_000)) {
                        await sleep(1000);
                        status = await options.hindsight.operationStatus(bankId, operation);
                    }
                    log(`关系概况刷新：${status || '没等到'}（${Math.round((Date.now() - started) / 1000)} 秒）`);
                    current.relationship = (await options.hindsight.getMentalModel(bankId, RELATIONSHIP_MODEL.id))?.content ?? '';
                } else {
                    log('没有记忆，跳过刷新关系概况');
                }
            } else if ('forget' in step) {
                await settle();
                await owners.close([responder]);
                await contextWindow?.summarize.idle();
                summaryLifetime = new AbortController();
                const chats = join(dataDir, 'chats');
                renameSync(join(chats, `${contact.qq}.jsonl`), join(chats, `${contact.qq}.forgotten-${++forgotten}.jsonl`));
                responder = createResponder();
                log('聊天记录挪走了，之后只能靠记忆');
            } else if ('restart' in step) {
                // bot 重启（ADR 0039）：照 app.ts 启动，从数据目录重新读起；之后和连上 NapCat 时一样，补写停了的那几天的日记、回没回的消息
                await settle();
                await closeOwners();
                summaryLifetime = new AbortController();
                ownSummary();
                history = new ChatHistory(dataDir);
                memory = openMemory();
                ({ ledger: ledgerWorld, queue: queuedActions, world: sharedWorld } = openWorld());
                promises = openPromises();
                diaries = openDiaries();
                bindWrittenSources();
                noteMoodAndBooks = openHerDayLogger();
                responder = createResponder();
                planner = openPlanner();
                log('重启：聊天记录、记忆、世界、行动队列、答应的事、日记、回复器、主动消息从数据目录重新读起');
                await diaries?.catchUp(new Date(clock.now()));
                responder.catchUp();
                await runTimers(clock.now() + AUTO_TIMER_MS);
            } else if ('ponder' in step) {
                // 她夜里把没想完的问题想一遍（ADR 0207）：和线上一样用 deliberateModel（模拟里有 --deliberate 就用它）；时间不在 22 点到凌晨 3 点、开关没开、没有可想的，都只记一行
                await settle();
                if (!scenario.openQuestions || scenario.tier !== 'boyfriend') {
                    log('没想完的问题：场景没开 openQuestions，略过');
                } else {
                    const result = await ponderIfDue({
                        dataDir,
                        now: clock.now,
                        generate: messages => (options.generate ? options.generate(messages, log) : chatCompletion({ ...(options.deliberateLlm ?? options.llm), temperature: 0.9 }, messages, { log })),
                        history: () => history.load(contact.qq),
                        persona: () => substituteMacros(options.card.character.description, { user: names.user, char: names.char }).slice(0, 700),
                        names,
                        others: () => others.map(other => other.name),
                        log,
                    });
                    log(result.ran ? `没想完的问题：这一步想了一次${result.error ? `，没想成（${result.error}）` : `（${result.applied?.lines.join('；') || '什么也没想出来'}）`}` : '没想完的问题：这一步没有要想的（时间不对 / 没有答不上来的问题）');
                }
            } else if ('hindsight' in step) {
                hindsightDown = step.hindsight === 'down';
                log(hindsightDown ? 'Hindsight 停了' : 'Hindsight 恢复');
            } else if ('check' in step) {
                const { proactive, life, ...rest } = step.check;
                const before = lastSay ? historyBefore(history.load(contact.qq), lastSay) : [];
                current.checks = Object.keys(rest).length === 0 ? []
                    : lastSay ? runChecks(rest, lastSay, options.card.character.banned, speechContext(before), before)
                        : [{ ok: false, text: '前面没有 say 步骤' }];
                if (life) {
                    const events = (sharedWorld?.events() ?? []).filter(event => event.id.startsWith('life:'));
                    let mismatches: LifeStatusMismatch[] | undefined;
                    let gaps: LedgerGap[] | undefined;
                    if (life.statusConsistent && ledgerWorld && character.schedule && character.herWorld) {
                        const schedule = character.schedule;
                        const herWorld = character.herWorld;
                        const sources: LifeSources = {
                            schedule,
                            books: character.books,
                            ...(herWorld.plans ? { plans: herWorld.plans } : {}),
                            worldAt: at => ledgerWorld!.at(herWorld, schedule, at),
                            events: () => ledgerWorld!.events(),
                            ...(scenario.projectChoice ? { projectChoice: true } : {}),
                            ...(herWorld.body ? { bodyAt: (at: Date) => bodyAt(herWorld.body!, schedule, at) } : {}),
                            bedtimes: () => saidBedtimes([contact, ...others].map(person => history.load(person.qq)), schedule, clock.now() - 86_400_000),
                        };
                        mismatches = auditLifeStatus(events, sources);
                        gaps = auditLedgerCoverage(events, sources);
                    }
                    current.checks.push(...lifeChecks(life, events, mismatches, gaps));
                }
                if (proactive) {
                    const since = steps.slice(proactiveCheckedUpTo, -1);
                    proactiveCheckedUpTo = steps.length;
                    current.checks.push(...proactiveChecks(proactive, since, options.card));
                }
            }
        }
    } finally {
        await closeOwners();
        if (fakeWeather) useRealWeather(undefined);
        if (memory && options.hindsight && !options.keepBank) {
            for (const bank of banks) {
                await options.hindsight.deleteBank(bank).catch(error => {
                    // 没建过的（没写过片段）是 404，不用记
                    if ((error as { status?: number }).status !== 404) log(`删除测试 bank 失败：${error instanceof Error ? error.message : String(error)}`);
                });
            }
        }
    }

    const all = steps.flatMap(s => s.checks);
    const count = (list: CheckResult[]): CheckCount => ({ passed: list.filter(c => c.ok).length, failed: list.filter(c => !c.ok).length });
    return {
        scenario,
        runId: options.runId,
        ...(options.contextTurns ? { contextTurns: options.contextTurns } : {}),
        dataDir,
        bankId,
        steps,
        checks: { ...count(all), reply: count(all.filter(c => !c.pipeline)), pipeline: count(all.filter(c => c.pipeline)) },
    };
}

/** 包一层：停了的时候每个请求都报错，和连不上一样 */
export function switchable(api: SimHindsight, down: () => boolean): SimHindsight {
    const guard = <T>(call: () => Promise<T>): Promise<T> =>
        (down() ? Promise.reject(new Error('fetch failed（模拟 Hindsight 停了）')) : call());
    const methods = new Map<PropertyKey, { source: unknown; call: (...args: unknown[]) => unknown }>();
    // Forward actual capabilities, including future SDK additions. A separate
    // proxy target also permits wrapping a frozen custom API without violating
    // non-configurable own-method invariants. Getter/private-field this is api.
    return new Proxy({} as SimHindsight, {
        get(_target, name) {
            const source: unknown = Reflect.get(api, name, api);
            if (typeof source !== 'function') return source;
            const cached = methods.get(name); if (cached?.source === source) return cached.call;
            const call = (...args: unknown[]) => {
                const invoke = () => Reflect.apply(source, api, args) as Promise<unknown>;
                // Cleanup must still remove synthetic banks after a down step.
                return name === 'deleteBank' ? invoke() : guard(invoke);
            };
            methods.set(name, { source, call }); return call;
        },
        has: (_target, name) => Reflect.has(api, name),
    });
}

function newStep(kind: StepRecord['kind'], time: number): StepRecord {
    return { kind, time, inputs: [], bubbles: [], generations: [], logs: [], checks: [] };
}

/** 提示词里每次都变的几块：召回、时间、关系概况（按开头的标记找，后处理合并了消息也找得到） */
export function dynamicParts(prompt: PromptResult, time: number): Generation {
    const text = prompt.messages.map(m => m.content ?? '').join('\n\n');
    const block = (header: string) => {
        const start = text.indexOf(header);
        if (start < 0) return undefined;
        const end = text.indexOf('\n\n', start);
        return text.slice(start, end < 0 ? undefined : end).trim();
    };
    return {
        time,
        recall: block(RECALL_HEADER),
        timeBlock: block(TIME_HEADER),
        relationship: block(RELATIONSHIP_HEADER),
        people: block(PEOPLE_HEADER),
        common: block(COMMON_HEADER),
        todayOthers: block(TODAY_OTHERS_HEADER),
        past: block(PAST_HEADER),
        summary: block(SUMMARY_HEADER),
        messages: prompt.messages.length,
        tokens: prompt.messages.reduce((n, m) => n + estimateTokens(m.content ?? ''), 0),
    };
}

/** 她自己过的日子（ADR 0040）：事件账里她的行动，各类够不够、有没有两件重叠。查的是她的生活，不是她说了什么，算管线自检 */
export function lifeChecks(checks: LifeChecks, events: readonly LifeEvent[], statusMismatches?: readonly LifeStatusMismatch[], ledgerGaps?: readonly LedgerGap[]): CheckResult[] {
    const results: CheckResult[] = [];
    for (const [kind, count] of Object.entries(checks.atLeast ?? {})) {
        const n = events.filter(event => event.kind === kind && event.result !== 'failed').length;
        results.push({ ok: n >= count!, text: `她过的日子里「${kind}」至少 ${count} 件（实际 ${n}）`, pipeline: true });
    }
    if (checks.noOverlap) {
        const done = events.filter(event => event.result !== 'failed').sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
        const clash = done.slice(1).find((event, i) => Date.parse(event.startedAt) < Date.parse(done[i]!.endedAt));
        results.push({ ok: !clash, text: `她过的日子一件接一件、不重叠${clash ? `（${clash.id} 和前一件撞了）` : `（${done.length} 件）`}`, pipeline: true });
    }
    if (checks.noFailed) {
        const failed = events.filter(event => event.result === 'failed');
        results.push({ ok: failed.length === 0, text: `事件账没有把排不上的候选记成经历${failed.length ? `（实际 ${failed.length} 件）` : ''}`, pipeline: true });
    }
    if (checks.nonRoutinePerDay) {
        const routine = new Set(['sleep', 'eat', 'attend_class']);
        const { days, min, max } = checks.nonRoutinePerDay;
        for (const day of days) {
            const dayEvents = events.filter(event => event.day === day && event.result !== 'failed' && !routine.has(event.kind));
            const kinds = [...new Set(dayEvents.map(event => event.kind))].map(kind => `${kind} ${dayEvents.filter(event => event.kind === kind).length}`).join('、');
            results.push({
                ok: dayEvents.length >= min && dayEvents.length <= max,
                text: `${day} 有 ${min}–${max} 件非例行动作（实际 ${dayEvents.length}${kinds ? `：${kinds}` : ''}）`,
                pipeline: true,
            });
        }
    }
    for (const [reason, count] of Object.entries(checks.interruptedAtLeast ?? {})) {
        const n = events.filter(event => event.result === 'interrupted' && event.reason === reason).length;
        results.push({ ok: n >= count!, text: `硬事件「${reason}」至少打断 ${count} 次（实际 ${n}）`, pipeline: true });
    }
    if (checks.npcInteractionsAtLeast !== undefined) {
        const socialKinds = new Set(['eat', 'attend_class', 'interact_npc']);
        const n = events.filter(event => event.result !== 'failed' && socialKinds.has(event.kind) && Boolean(event.target)).length;
        results.push({
            ok: n >= checks.npcInteractionsAtLeast,
            text: `NPC 独立互动至少 ${checks.npcInteractionsAtLeast} 次（实际 ${n}）`,
            pipeline: true,
        });
    }
    if (checks.projectProgressAtLeast) {
        const { target, minutes } = checks.projectProgressAtLeast;
        const actual = events.filter(event => event.kind === 'work_on_project' && event.target === target && event.result !== 'failed')
            .reduce((sum, event) => sum + Math.max(0, Math.round((Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 60_000)), 0);
        results.push({
            ok: actual >= minutes,
            text: `长期项目「${target}」至少推进 ${minutes} 分钟（实际 ${actual} 分钟）`,
            pipeline: true,
        });
    }
    if (checks.statusConsistent) {
        const mismatches = statusMismatches ?? [];
        const detail = mismatches.slice(0, 3).map(item => `${item.eventKind}→${item.expectedKind ?? '空'}@${item.at}`).join('、');
        results.push({
            ok: statusMismatches !== undefined && mismatches.length === 0,
            text: `事件账与同一时刻的对外状态一致${statusMismatches === undefined ? '（没有可用的状态审计源）' : mismatches.length ? `（${detail}）` : '（0 分叉）'}`,
            pipeline: true,
        });
        // 反方向（10-09 复核）：状态行说她在做的，账上那一刻要有行动
        const gaps = ledgerGaps ?? [];
        const holes = gaps.slice(0, 3).map(gap => `${gap.expectedKind}@${gap.from}–${gap.to}`).join('、');
        results.push({
            ok: ledgerGaps !== undefined && gaps.length === 0,
            text: `状态行说她在做的，账上都有${ledgerGaps === undefined ? '（没有可用的状态审计源）' : gaps.length ? `（账上缺 ${gaps.length} 段：${holes}）` : '（账上缺 0）'}`,
            pipeline: true,
        });
    }
    return results;
}

/** 主动消息的检查（ADR 0011）：这几步里她主动发的那几次。一次 = 同一个时机、隔不到 1 分钟的几条气泡 */
export function proactiveChecks(checks: ProactiveChecks, steps: StepRecord[], card: TierCard): CheckResult[] {
    const results: CheckResult[] = [];
    const sends: { time: number; last: number; label: string; texts: string[] }[] = [];
    for (const bubble of steps.flatMap(s => s.bubbles).filter(b => b.proactive)) {
        const prev = sends.at(-1);
        if (prev && prev.label === bubble.proactive && bubble.time - prev.last < 60_000) {
            prev.texts.push(bubble.text);
            prev.last = bubble.time;
        } else {
            sends.push({ time: bubble.time, last: bubble.time, label: bubble.proactive!, texts: [bubble.text] });
        }
    }
    const fmt = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const list = sends.map(s => `${fmt(s.time)} ${s.label}`).join('、') || '无';
    const schedule = card.character.schedule;
    if (checks.count) {
        const [min, max] = checks.count;
        results.push({ ok: sends.length >= min && sends.length <= max, text: `主动了 ${min}–${max} 次（实际 ${sends.length}：${list}）` });
    }
    if (checks.perDayMax !== undefined && schedule) {
        const perDay = new Map<string, number>();
        for (const s of sends.filter(s => s.label !== '重要的日子')) {
            const day = formatDate(herDay(schedule, new Date(s.time)));
            perDay.set(day, (perDay.get(day) ?? 0) + 1);
        }
        const most = Math.max(0, ...perDay.values());
        results.push({ ok: most <= checks.perDayMax, text: `她的每一天最多主动 ${checks.perDayMax} 次（实际最多 ${most}）` });
    }
    if (checks.allowedTimes && schedule) {
        const bad = sends.filter(s => {
            const kind = stateAt(schedule, new Date(s.time)).activity.kind;
            const day = herDay(schedule, new Date(s.time));
            const night = localDate(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 30).getTime();
            return kind === 'sleep' || kind === 'class' || (s.label !== '重要的日子' && s.time >= night);
        });
        results.push({ ok: bad.length === 0, text: `都不在睡觉、上课、夜里${bad.length ? `（${bad.map(s => `${fmt(s.time)} ${s.label}`).join('、')}）` : ''}` });
    }
    for (const occasion of checks.occasions ?? []) {
        results.push({ ok: sends.some(s => s.label === occasion), text: `主动的时机里有「${occasion}」` });
    }
    for (const occasion of checks.absent ?? []) {
        results.push({ ok: !sends.some(s => s.label === occasion), text: `主动的时机里没有「${occasion}」` });
    }
    const texts = sends.flatMap(s => s.texts).join('\n');
    if (checks.replyAny) {
        const hit = checks.replyAny.filter(w => texts.includes(w));
        results.push({ ok: hit.length > 0, text: `主动发的话里有「${checks.replyAny.join('」「')}」之一${hit.length ? `（${hit.join('、')}）` : ''}` });
    }
    for (const word of checks.replyNone ?? []) results.push({ ok: !texts.includes(word), text: `主动发的话里没有「${word}」` });
    if (checks.exitClean) {
        const issues = inspectReply(texts, card.character.banned);
        results.push({ ok: issues.length === 0, text: `主动发的话过得了出口检查${issues.length ? `（${summarizeIssues(issues)}）` : ''}` });
    }
    return results;
}

/** 这一步她发的话之前的聊天记录（speechClean 取其中最近几次，noRepeat 用全部；这一步她没发就是全部） */
export function historyBefore(history: readonly StoredMessage[], step: StepRecord): StoredMessage[] {
    const first = step.bubbles[0]?.text;
    let end = history.length;
    if (first !== undefined) {
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i]!.role === 'assistant' && history[i]!.content === first) {
                end = i;
                break;
            }
        }
    }
    return history.slice(0, end);
}

/** speech：speechClean 比的她最近几次回复、对方最近几条；earlier：这一步她发的话之前的全部聊天（noRepeat），都从 historyBefore 来 */
export function runChecks(
    checks: Checks, step: StepRecord, banned: readonly string[] = [], speech?: SpeechContext, earlier: readonly Pick<StoredMessage, 'role' | 'content'>[] = [],
): CheckResult[] {
    const results: CheckResult[] = [];
    const last = step.generations.at(-1);
    const recall = last?.recall ?? '';
    const replies = step.bubbles.map(b => b.text).join('\n');
    const has = (pattern: RegExp) => step.logs.some(l => pattern.test(l));
    for (const word of checks.recall ?? []) results.push({ ok: recall.includes(word), text: `召回里有「${word}」`, pipeline: true });
    for (const word of checks.recallNot ?? []) results.push({ ok: !recall.includes(word), text: `召回里没有「${word}」`, pipeline: true });
    for (const word of checks.people ?? []) results.push({ ok: (last?.people ?? '').includes(word), text: `「你认识的人」里有「${word}」`, pipeline: true });
    for (const word of checks.common ?? []) results.push({ ok: (last?.common ?? '').includes(word), text: `公共记忆里有「${word}」`, pipeline: true });
    for (const word of checks.todayOthers ?? []) results.push({ ok: (last?.todayOthers ?? '').includes(word), text: `今天和别人聊过的事里有「${word}」`, pipeline: true });
    for (const word of checks.todayOthersNot ?? []) results.push({ ok: !(last?.todayOthers ?? '').includes(word), text: `今天和别人聊过的事里没有「${word}」`, pipeline: true });
    if (checks.noCommon) results.push({ ok: !last?.common, text: '没有线索，没想起公共记忆', pipeline: true });
    for (const title of checks.past ?? []) results.push({ ok: (last?.past ?? '').includes(`- ${title}：`), text: `想起的从前里有「${title}」`, pipeline: true });
    if (checks.noPast) results.push({ ok: !last?.past, text: '没有线索，没想起从前', pipeline: true });
    if (checks.replyAny) {
        const hit = checks.replyAny.filter(w => replies.includes(w));
        results.push({ ok: hit.length > 0, text: `回复里有「${checks.replyAny.join('」「')}」之一${hit.length ? `（${hit.join('、')}）` : ''}` });
    }
    for (const word of checks.replyNone ?? []) results.push({ ok: !replies.includes(word), text: `回复里没有「${word}」` });
    for (const pattern of checks.replyNotMatch ?? []) {
        const hit = replies.match(new RegExp(pattern));
        results.push({ ok: !hit, text: `回复里没有 /${pattern}/${hit ? `（「${hit[0]}」）` : ''}` });
    }
    // 她说的第一句（发出去的第一行）：先接他这句话，不先说别的
    const firstLine = replies.split('\n').find(line => line.trim()) ?? '';
    if (checks.firstAny) {
        const hit = checks.firstAny.filter(w => firstLine.includes(w));
        results.push({ ok: hit.length > 0, text: `第一句里有「${checks.firstAny.join('」「')}」之一（「${firstLine}」）` });
    }
    for (const word of checks.firstNone ?? []) results.push({ ok: !firstLine.includes(word), text: `第一句里没有「${word}」（「${firstLine}」）` });
    if (checks.timeBlock !== undefined) {
        results.push({ ok: new RegExp(checks.timeBlock).test(last?.timeBlock ?? ''), text: `时间块匹配 /${checks.timeBlock}/`, pipeline: true });
    }
    if (checks.timeBlockNot !== undefined) {
        results.push({ ok: !new RegExp(checks.timeBlockNot).test(last?.timeBlock ?? ''), text: `时间块不匹配 /${checks.timeBlockNot}/`, pipeline: true });
    }
    if (checks.generations !== undefined) {
        results.push({ ok: step.generations.length === checks.generations, text: `生成 ${checks.generations} 次（实际 ${step.generations.length} 次）`, pipeline: true });
    }
    if (checks.regenerated !== undefined) {
        results.push({ ok: has(/生成期间收到新消息/) === checks.regenerated, text: checks.regenerated ? '生成中来了新消息，丢掉草稿重新生成' : '没有重新生成', pipeline: true });
    }
    if (checks.emptied !== undefined) {
        // 第一次清理后为空当场再生成；再空就是回复失败（responder.ts），两种都算
        const emptied = step.logs.filter(l => EMPTIED.test(l)).length;
        results.push({
            ok: (emptied > 0) === checks.emptied,
            text: checks.emptied ? `模型回复清理后为空、重新生成（实际 ${emptied} 次）` : `模型回复清理后没变空、不用重新生成${emptied ? `（实际 ${emptied} 次）` : ''}`,
        });
    }
    const chars = step.bubbles.reduce((n, b) => n + [...b.text].length, 0);
    if (checks.maxChars !== undefined) results.push({ ok: chars <= checks.maxChars, text: `她这一轮最多 ${checks.maxChars} 字（实际 ${chars}）` });
    if (checks.minChars !== undefined) results.push({ ok: chars >= checks.minChars, text: `她这一轮至少 ${checks.minChars} 字（实际 ${chars}）` });
    if (checks.maxBubbles !== undefined) results.push({ ok: step.bubbles.length <= checks.maxBubbles, text: `她这一轮最多 ${checks.maxBubbles} 条（实际 ${step.bubbles.length}）` });
    if (checks.maxLines !== undefined) {
        // 数她说了几句：超过气泡上限的行会按顺序合并进最后一条（reply.ts packLines），只数条数看不出她说了一大串（DSH 复核 ADR 0036）
        const said = replies.split('\n').filter(line => line.trim()).length;
        results.push({ ok: said <= checks.maxLines, text: `她这一轮最多说 ${checks.maxLines} 句（实际 ${said} 句，发成 ${step.bubbles.length} 条）` });
    }
    if (checks.exitClean) {
        const issues = inspectReply(replies, banned);
        const stage = step.bubbles.filter(b => /^[ \t]*[（(][^（）()\n]*[）)]/m.test(b.text)).length;
        const problems = [...(issues.length ? [summarizeIssues(issues)] : []), ...(stage ? [`${stage} 条有行首括号`] : [])];
        results.push({ ok: problems.length === 0, text: `出口检查干净${problems.length ? `（${problems.join('；')}）` : ''}` });
    }
    if (checks.rawClean) {
        const raw = last?.raw ?? '';
        const issues = inspectReply(raw, banned);
        results.push({ ok: issues.length === 0, text: `模型原文就干净（出口检查之前）${issues.length ? `（${summarizeIssues(issues)}）` : ''}` });
    }
    if (checks.speechClean) {
        const issues = inspectSpeech(replies, speech ?? { recent: [], his: [] });
        const found = issues.map(i => `第 ${i.line + 1} 行${describeSpeechIssue(i)}`).join('、');
        results.push({ ok: issues.length === 0, text: `说话没毛病（助手腔、算账、怪对方没说、重复、一段里叮嘱两遍）${found ? `（${found}）` : ''}` });
    }
    if (checks.noRepeat) {
        const hits = repeatedSentences(replies, earlier);
        const found = hits.map(hit => `「${hit.said}」≈ 前面的「${hit.before}」`).join('、');
        results.push({ ok: hits.length === 0, text: `没把这次运行里说过的话再说一遍${found ? `（${found}）` : ''}` });
    }
    const first = step.bubbles[0]?.time;
    if (checks.noReply) results.push({ ok: step.bubbles.length === 0, text: `她没回（实际 ${step.bubbles.length} 条）` });
    const stickerCount = step.bubbles.filter(bubble => /^<sticker:[a-f0-9]{12}>$/i.test(bubble.text.trim())).length;
    if (checks.stickerSent !== undefined) results.push({ ok: checks.stickerSent ? stickerCount > 0 : stickerCount === 0, text: `她${checks.stickerSent ? '发了' : '没发'}图片表情（实际 ${stickerCount} 个）` });
    // 只要气泡里出现过表情编号，就查它是不是单独一条（别的场景不出现编号时不多出这一项）
    if (step.bubbles.some(bubble => /<sticker:/i.test(bubble.text))) {
        const leaked = step.bubbles.filter(bubble => /<sticker:/i.test(bubble.text) && !/^<sticker:[a-f0-9]{12}>$/i.test(bubble.text.trim()));
        results.push({ ok: leaked.length === 0, text: `表情编号只以单独一条出现、没被并进文字${leaked.length ? `（${leaked.map(b => JSON.stringify(b.text.slice(0, 40))).join('、')}）` : ''}` });
    }
    const photoCount = step.bubbles.filter(bubble => /^<photo:[a-f0-9]{12}>$/i.test(bubble.text.trim())).length;
    if (checks.photoSent !== undefined) results.push({ ok: checks.photoSent ? photoCount > 0 : photoCount === 0, text: `她${checks.photoSent ? '发了' : '没发'}照片（实际 ${photoCount} 张）` });
    if (step.bubbles.some(bubble => /<photo:/i.test(bubble.text))) {
        const leaked = step.bubbles.filter(bubble => /<photo:/i.test(bubble.text) && !/^<photo:[a-f0-9]{12}>$/i.test(bubble.text.trim()));
        results.push({ ok: leaked.length === 0, text: `照片编号只以单独一条出现、没被并进文字${leaked.length ? `（${leaked.map(b => JSON.stringify(b.text.slice(0, 40))).join('、')}）` : ''}` });
    }
    if (checks.maxStickers !== undefined) results.push({ ok: stickerCount <= checks.maxStickers, text: `她这一轮最多 ${checks.maxStickers} 个图片表情（实际 ${stickerCount}）` });
    const delay = first !== undefined && step.inputTime !== undefined ? first - step.inputTime : undefined;
    const minutes = (ms: number | undefined) => (ms === undefined ? '没回' : `${(ms / 60_000).toFixed(1)} 分钟`);
    if (checks.replyAfter !== undefined) {
        results.push({ ok: delay !== undefined && delay >= parseDuration(checks.replyAfter), text: `第一条在对方最后一条之后至少 ${checks.replyAfter}（实际 ${minutes(delay)}）` });
    }
    if (checks.replyWithin !== undefined) {
        results.push({ ok: delay !== undefined && delay <= parseDuration(checks.replyWithin), text: `第一条在对方最后一条之后 ${checks.replyWithin} 之内（实际 ${minutes(delay)}）` });
    }
    if (checks.log !== undefined) results.push({ ok: has(new RegExp(checks.log)), text: `日志里有 /${checks.log}/`, pipeline: true });
    if (checks.dropped !== undefined) {
        results.push({ ok: has(/发送中途对方插话/) === checks.dropped, text: checks.dropped ? '发送中途插话，剩下的没发' : '没有丢弃剩下的', pipeline: true });
    }
    return results;
}
