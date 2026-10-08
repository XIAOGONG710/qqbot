// 跑一个场景（ADR 0005）：和 bot 同一条流水线（contact.ts），只换掉收发、时钟和数据目录。
// 对方的消息由场景给出，按虚拟时间记录；她发出的每一条、每次生成的提示词、调度日志都按步骤记下来，最后写成报告。

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig, Contact } from '../config.ts';
import { createContactResponder, replySkip, type TierCard } from '../contact.ts';
import { promiseKeeper } from '../promises.ts';
import { ChatHistory, type StoredMessage } from '../history.ts';
import { chatCompletion, forExtraction } from '../llm.ts';
import type { Log } from '../log.ts';
import type { HindsightApi } from '../memory/hindsight.ts';
import { LongTermMemory, RELATIONSHIP_MODEL } from '../memory/long-term.ts';
import type { OpenAIMessage, PromptResult } from '../prompt.ts';
import { inspectReply, summarizeIssues } from '../exit-check.ts';
import { describeSpeechIssue, inspectSpeech, speechContext, type SpeechContext } from '../speech-check.ts';
import { EPISODE_GAP_MS } from '../memory/episodes.ts';
import { herDay } from '../proactive.ts';
import { createProactivePlanner, type Planner } from '../proactive-planner.ts';
import { herDayLogger } from '../her-days.ts';
import { worldState, type World } from '../world.ts';
import { DIARY_TEMPERATURE, diaryWriter } from '../diary.ts';
import { formatDate, stateAt, type Schedule } from '../schedule.ts';
import { actionQueue } from '../action-queue.ts';
import { parseDuration, VirtualClock, type Checks, type ProactiveChecks, type Scenario, type SayStep } from './scenario.ts';

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
    /** 日记里的世界（ADR 0026）：同学档的卡上的，run.ts 传 */
    diaryWorld?: World;
    /** 和 diaryWorld 同一档的作息（ADR 0034） */
    diaryWorldSchedule?: Schedule;
}

/** proactive：她主动发的（ADR 0011），是哪个时机（日志里的说法） */
export interface Bubble { time: number; text: string; proactive?: string }
export interface Input { time: number; text: string; interrupt?: boolean }
export interface Generation {
    time: number; recall?: string; timeBlock?: string; relationship?: string; people?: string; common?: string; todayOthers?: string; past?: string; messages: number;
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
    kind: 'case' | 'say' | 'life' | 'action' | 'advance' | 'wait' | 'memory' | 'refresh' | 'check' | 'forget' | 'hindsight';
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
}

export interface RunResult {
    scenario: Scenario;
    runId: string;
    dataDir: string;
    bankId?: string;
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

export async function runScenario(scenario: Scenario, options: RunOptions): Promise<RunResult> {
    const { dataDir } = options;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    mkdirSync(join(dataDir, 'prompts'), { recursive: true });
    const clock = new VirtualClock(new Date(scenario.start));
    const contact: Contact = { qq: SIM_QQ, name: scenario.user, tier: scenario.tier, persona: scenario.persona };
    const names = { user: contact.name, char: options.card.character.name };
    const history = new ChatHistory(dataDir);
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

    let hindsightDown = false;
    const hindsight = options.hindsight && switchable(options.hindsight, () => hindsightDown);
    const memory = scenario.memory && hindsight
        ? new LongTermMemory({
            api: hindsight,
            dir: join(dataDir, 'memory'),
            bankPrefix: `sim-${options.runId}`,
            recallTimeoutMs: options.recallTimeoutMs ?? 5000,
            log,
            now: clock.now,
            common: true,
        })
        : undefined;
    const bankId = memory?.bankId(contact);
    /** 跑完要删的：他自己的、名单里其他人的、公共库 */
    const banks = memory ? [bankId!, ...others.map(other => memory.bankId(other)), memory.commonBankId()] : [];
    const { character } = options.card;
    // W3：模拟器和线上共用同一状态层，抽取后的动作立即影响后续提示词和日记。
    const sharedWorld = options.herDays && scenario.schedule && character.schedule && character.herWorld
        ? worldState(character.herWorld, character.schedule, log, join(options.dataDir, 'world'), clock.now)
        : undefined;
    const queuedActions = sharedWorld ? actionQueue(join(options.dataDir, 'world', 'action-queue.json'), log) : undefined;
    // 她的日记（ADR 0017）：和 bot 一样，跨过她的一天就补写，存进公共库；场景关了作息就没有她的一天，不写
    // 她答应过的事（ADR 0018 决策 2）：和 bot 一样，开了记忆就抽（记忆同步时），到了日子在时间块里提醒，那天的打算写进日记
    const promises = memory
        ? promiseKeeper({
            contacts: [contact, ...others],
            history,
            names: person => ({ user: person.name, char: names.char }),
            ...(scenario.schedule && options.card.character.schedule ? { schedule: options.card.character.schedule } : {}),
            extract: messages => (options.generate ? options.generate(messages, log) : chatCompletion(forExtraction(options.llm), messages, { log })),
            dir: join(dataDir, 'promises'),
            log,
            now: clock.now,
            ...(sharedWorld ? { onWorldActions: sharedWorld.record } : {}),
        })
        : undefined;
    const diaryCard = options.card.character;
    const diaries = memory && scenario.schedule && diaryCard.schedule
        ? diaryWriter({
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
            generate: messages => (options.generate
                ? options.generate(messages, log)
                : chatCompletion({ ...options.llm, temperature: DIARY_TEMPERATURE }, messages, { log })),
            dir: join(dataDir, 'memory'),
            log,
        })
        : undefined;

    let nextMessageId = 1;
    let armed: SayStep['interrupt'];
    let bubblesThisStep = 0;
    let injecting = 0;
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
    const baseGenerate = options.generate ?? ((messages: OpenAIMessage[], log: Log) => chatCompletion(options.llm, messages, { log }));

    if (scenario.mood !== undefined && !character.moods.some(mood => mood.name === scenario.mood)) {
        throw new Error(`场景的 mood「${scenario.mood}」不是卡上的心情（${character.moods.map(mood => mood.name).join('、') || '这一档没有心情'}）`);
    }
    // 她自己的日子：和 bot 一样，她的每一天第一次生成时在 sim.log 里写一行当天的心情和进度
    const noteMoodAndBooks = options.herDays && character.schedule
        ? herDayLogger(character.schedule, character.moods, character.books, log, scenario.mood)
        : undefined;
    // 她的世界（ADR 0021）：每天一行摘要，state.json 写在这次的数据目录
    const noteWorld = sharedWorld?.note;
    const noteHerDay = noteMoodAndBooks || noteWorld ? (now: Date) => { noteMoodAndBooks?.(now); noteWorld?.(now); } : undefined;
    const createResponder = () => createContactResponder({
        contact,
        card: options.card,
        llm: options.llm,
        prompt: options.prompt,
        schedule: scenario.schedule,
        moody: scenario.moody,
        ...(scenario.moodyChance !== undefined ? { moodyChance: scenario.moodyChance } : {}),
        speechCheck: options.speechCheck ?? false,
        herDays: options.herDays ?? false,
        ...(scenario.mood !== undefined ? { mood: scenario.mood } : {}),
        ...(noteHerDay ? { onHerDay: noteHerDay } : {}),
        history,
        memory,
        ...(promises ? { promises } : {}),
        ...(sharedWorld ? { worldState: sharedWorld } : {}),
        contacts: [contact, ...others],
        log,
        now: clock.now,
        settle: options.settle,
        retryAfterMs: [],
        waitUntil: clock.waitUntil,
        send: async (_userId, text) => {
            current.bubbles.push({ time: clock.now(), text, ...(initiating ? { proactive: initiating } : {}) });
            bubblesThisStep++;
            if (armed?.afterBubbles !== undefined && bubblesThisStep >= armed.afterBubbles) {
                const it = armed;
                armed = undefined;
                // 等这一条记进聊天记录之后、下一条发出之前再插话（气泡间隔是 1 秒）
                injecting++;
                setTimeout(() => { injecting--; receive(it.say, true); }, 100);
            }
            return nextMessageId++;
        },
        generate: async (messages, log) => {
            const generation = current.generations.at(-1);
            const reply = baseGenerate(messages, log);
            if (armed?.during === 'generation') {
                const it = armed;
                armed = undefined;
                receive(it.say, true);
            }
            const raw = await reply;
            // 出口检查的重写不经过 onPrompt，算在同一次生成里
            if (generation) {
                if (generation.raw === undefined) generation.raw = raw;
                else (generation.rewrites ??= []).push(raw);
            }
            return raw;
        },
        onPrompt: prompt => {
            current.generations.push(dynamicParts(prompt, clock.now()));
            writeFileSync(join(dataDir, 'prompts', `${++generationCount}.json`), JSON.stringify(prompt, null, 2));
        },
    });
    let responder = createResponder();
    let forgotten = 0;

    // 主动消息（ADR 0011）：场景开着、卡上有主动设置和作息时，计划器跑在虚拟时钟上（真发，记录在 dataDir/proactive）
    const planner: Planner | undefined = scenario.proactive && scenario.schedule && character.proactive && character.schedule
        ? createProactivePlanner({
            contact,
            schedule: character.schedule,
            settings: character.proactive,
            dates: character.dates,
            mode: 'on',
            history,
            // 「forget」之后换了新的回复器：每次取当前的
            responder: {
                initiate: async request => {
                    initiating = request.label.replace(/（.*$/, '');
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
            now: clock.now,
            waitUntil: clock.waitUntil,
            names,
            extract: messages => (options.generate ? options.generate(messages, log) : chatCompletion(forExtraction(options.llm), messages, { log })),
        })
        : undefined;
    if (scenario.proactive && !planner) log('场景开了主动消息，但卡上没有主动设置或作息，不主动');

    /** 等她把这一轮（含插话之后的回复）都发完，或者停在「到点才看到」的等待上 */
    async function settle(): Promise<void> {
        for (;;) {
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
        if (!memory || !options.hindsight || !bankId || hindsightDown) return;
        for (const person of who) await memory.sync(person, { user: person.name, char: names.char }, history.load(person.qq));
        await diaries?.catchUp(new Date(clock.now()));
        await promises?.sync();
        const watched = [...who.map(person => memory.bankId(person)), memory.commonBankId()];
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
                const texts = Array.isArray(step.say) ? step.say : [step.say];
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
                if (queuedActions && sharedWorld) queuedActions.settleDue(new Date(clock.now()), sharedWorld);
                current.time = clock.now();
                await syncMemory();
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
                const chats = join(dataDir, 'chats');
                renameSync(join(chats, `${contact.qq}.jsonl`), join(chats, `${contact.qq}.forgotten-${++forgotten}.jsonl`));
                responder = createResponder();
                log('聊天记录挪走了，之后只能靠记忆');
            } else if ('hindsight' in step) {
                hindsightDown = step.hindsight === 'down';
                log(hindsightDown ? 'Hindsight 停了' : 'Hindsight 恢复');
            } else if ('check' in step) {
                const { proactive, ...rest } = step.check;
                current.checks = Object.keys(rest).length === 0 ? []
                    : lastSay ? runChecks(rest, lastSay, options.card.character.banned, speechContextBefore(history.load(contact.qq), lastSay))
                        : [{ ok: false, text: '前面没有 say 步骤' }];
                if (proactive) {
                    const since = steps.slice(proactiveCheckedUpTo, -1);
                    proactiveCheckedUpTo = steps.length;
                    current.checks.push(...proactiveChecks(proactive, since, options.card));
                }
            }
        }
    } finally {
        planner?.stop();
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
        dataDir,
        bankId,
        steps,
        checks: { ...count(all), reply: count(all.filter(c => !c.pipeline)), pipeline: count(all.filter(c => c.pipeline)) },
    };
}

/** 包一层：停了的时候每个请求都报错，和连不上一样 */
function switchable(api: SimHindsight, down: () => boolean): SimHindsight {
    const guard = <T>(call: () => Promise<T>): Promise<T> =>
        (down() ? Promise.reject(new Error('fetch failed（模拟 Hindsight 停了）')) : call());
    return {
        putBank: (...a) => guard(() => api.putBank(...a)),
        retain: (...a) => guard(() => api.retain(...a)),
        recall: (...a) => guard(() => api.recall(...a)),
        getMentalModel: (...a) => guard(() => api.getMentalModel(...a)),
        createMentalModel: (...a) => guard(() => api.createMentalModel(...a)),
        updateMentalModel: (...a) => guard(() => api.updateMentalModel(...a)),
        activeOperations: (...a) => guard(() => api.activeOperations(...a)),
        operationStatus: (...a) => guard(() => api.operationStatus(...a)),
        refreshMentalModel: (...a) => guard(() => api.refreshMentalModel(...a)),
        // 公共库的实体名（ADR 0017 的线索）：没转发的话模拟器里永远是空的
        ...(api.listEntities ? { listEntities: (...a: Parameters<NonNullable<SimHindsight['listEntities']>>) => guard(() => api.listEntities!(...a)) } : {}),
        ...(api.getDocument ? { getDocument: (...a: Parameters<NonNullable<SimHindsight['getDocument']>>) => guard(() => api.getDocument!(...a)) } : {}),
        deleteBank: (...a) => api.deleteBank(...a),
    };
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
        messages: prompt.messages.length,
    };
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
            const night = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 30).getTime();
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
    if (checks.exitClean) {
        const issues = inspectReply(texts, card.character.banned);
        results.push({ ok: issues.length === 0, text: `主动发的话过得了出口检查${issues.length ? `（${summarizeIssues(issues)}）` : ''}` });
    }
    return results;
}

/** speechClean 用的：这一步她发的话之前的聊天记录（她前面几次回复、对方最近几条） */
export function speechContextBefore(history: readonly StoredMessage[], step: StepRecord): SpeechContext {
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
    return speechContext(history.slice(0, end));
}

export function runChecks(checks: Checks, step: StepRecord, banned: readonly string[] = [], speech?: SpeechContext): CheckResult[] {
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
    if (checks.speechClean) {
        const issues = inspectSpeech(replies, speech ?? { recent: [], his: [] });
        const found = issues.map(i => `第 ${i.line + 1} 行${describeSpeechIssue(i)}`).join('、');
        results.push({ ok: issues.length === 0, text: `说话没毛病（助手腔、算账、怪对方没说、重复）${found ? `（${found}）` : ''}` });
    }
    const first = step.bubbles[0]?.time;
    if (checks.noReply) results.push({ ok: step.bubbles.length === 0, text: `她没回（实际 ${step.bubbles.length} 条）` });
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
