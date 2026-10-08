// 一位联系人的回复流水线：召回长期记忆 → 按 ST 顺序拼提示词 → 后处理 → 生成 → 清理（含卡上的 ST 正则）→ 出口检查 → 拆条发送（responder.ts 调度）。
// 出口检查带上聊天记录里她最近几次回复和对方最近几条，查说话的毛病（ADR 0014，配置 speechCheck）。
// 她自己的日子（ADR 0015，配置 herDays）：时间块里状态行下面加今天的心情，聊到书或她正在看书时再加「在读的书」，那一轮出口检查顺带查进度数字。
// 她认识的人（ADR 0016）：他或她最近的话里提到名单里另一个人的称呼（那人写了「别人提起时」），召回之后放一段介绍。
// 记忆（ADR 0018）：召回会变淡，她和名单里的称呼不算「一提就想起」的线索；放进提示词的记忆里她的名字换成「你」。
// bot（main.ts）和模拟器（sim/）共用这一份；模拟器只换掉收发、时钟和数据目录（ADR 0005）。

import { dirname, join } from 'node:path';
import { UNLISTED_TIER, type AppConfig, type Contact, type Tier } from './config.ts';
import { disclosureRules, isClose, sourceLabel, startsConversation, todayStart } from './disclosure.ts';
import { reviewReply } from './exit-check.ts';
import type { ChatHistory, StoredMessage } from './history.ts';
import { chatCompletion } from './llm.ts';
import type { Log } from './log.ts';
import { CLEAR_DAYS, recentChat, type FadeStats } from './memory/fading.ts';
import { heardSinceReply, initiateQuery, PERSON_RECALLED, secondPerson, type LongTermMemory } from './memory/long-term.ts';
import { buildPrompt, type OpenAIMessage, type PromptResult } from './prompt.ts';
import { cleanUpReply } from './reply.ts';
import { createResponder, DEFAULT_SETTLE, RETRY_AFTER_MS, type Responder } from './responder.ts';
import { loadCharacterCard, type Character } from './st/card.ts';
import { postProcessPrompt } from './st/prompt-converters.ts';
import { loadWorldInfo, type WorldInfoEntry } from './st/world-info.ts';
import { isAckAfterClosing, moodySkip, typingMs, whenSeen } from './reply-timing.ts';
import { describeMood, moodAt, readingActivities, readingSection } from './her-days.ts';
import { describeIntent } from './intent.ts';
import { describeLength, lengthHint, maybeTypo } from './expression.ts';
import { describeUnsettled } from './open-loops.ts';
import { describeWorld, occupationAt, recapDay, recentWith, unavailableAt, worldAt, type WorldState } from './world.ts';
import { npcMentioned } from './npc.ts';
import { dayPlan, describePlans, describeSlot, planNow } from './day-plan.ts';
import { bodyAt, describeBody, diaryBody, unwell } from './body.ts';
import { describeWarmAffect, warmAffect } from './affect.ts';
import { describePast, pastCue } from './biography.ts';
import { askedWindow, ASKS_PAST, asksPast, commonCue, describePerson, holidayWords, lingering, mentionedPeople } from './people.ts';
import type { PromiseKeeper } from './promises.ts';
import { describeState, herDay, stateAt } from './schedule.ts';
import { speechContext, type BookProgressContext } from './speech-check.ts';
import { describePick, pickBest, PICKED_INTENTS, type PickRules } from './candidates.ts';
import { describeDays, describeTime } from './time-context.ts';
import { estimateTokens } from './tokens.ts';

const DAY_MS = 86_400_000;

/** 召回整理出来的一段有几条（第一行是标题） */
const countLines = (text: string) => text.split('\n').length - 1;

/** 记忆变淡（ADR 0018）各几条，写日志用：「记个大概 2，一提想起 1，想不起来 3」，都是 0 就是空的 */
const fadeParts = (stats: FadeStats | undefined) => (stats
    ? ([['记个大概', stats.vague], ['一提想起', stats.recognized], ['想不起来', stats.forgotten], ['同一件事多的', stats.repeated ?? 0]] as const).filter(([, n]) => n).map(([label, n]) => `${label} ${n}`)
    : []);
const fadeNote = (stats: FadeStats | undefined) => (fadeParts(stats).length ? `（${fadeParts(stats).join('，')}）` : '');

/** 线索认出来的是空列表时算没有（lingering 接着往前找） */
const nonEmpty = <T>(list: T[]) => (list.length ? list : undefined);

export interface TierCard {
    character: Character;
    worldInfo: WorldInfoEntry[];
}

/** 读一个档位的角色卡和它链接的世界书；pattern 是配置里的 characterCard（{tier} 换成档位名），世界书在同目录的 <world>.json */
export function loadTierCard(pattern: string, tier: Tier): TierCard {
    const path = pattern.replaceAll('{tier}', tier);
    const character = loadCharacterCard(path);
    const worldInfo = character.world ? loadWorldInfo(join(dirname(path), `${character.world}.json`), character.world) : [];
    return { character, worldInfo };
}

/**
 * 没回的这一串不回的原因（按作息时）：她已经收尾、对方只回了附和（ADR 0007 决策 7）；看心情不回（ADR 0013 决策 4）。要回就是 undefined。
 * 回复器和主动消息的计划器用同一个（看心情没回的那串不算「有没回的消息」）。chance 只给模拟器用
 */
export function replySkip(character: Character, moody: boolean, chance?: number): (history: StoredMessage[]) => string | undefined {
    return history => (isAckAfterClosing(history)
        ? '她已经收尾，对方只回了附和，不回'
        : moody ? moodySkip(history, character.pace, chance) : undefined);
}

export interface ContactPipelineOptions {
    contact: Contact;
    card: TierCard;
    llm: AppConfig['llm'];
    prompt: AppConfig['prompt'];
    history: Pick<ChatHistory, 'load' | 'append'>;
    /** 长期记忆；名单外的好友（unlisted 档）不用 */
    memory?: LongTermMemory;
    /** 整个名单（ADR 0016）：她认识名单里写了「别人提起时」的人；不传就谁都不认识 */
    contacts?: readonly Contact[];
    send: (userId: number, text: string) => Promise<number>;
    /** 不带联系人前缀，这里会加上 [QQ 号] */
    log: Log;
    /** 每次生成前拿到后处理之后、实际发给模型的提示词 */
    onPrompt?: (prompt: PromptResult) => void;
    /** 毫秒时间戳，默认真实时间；模拟器传虚拟时钟 */
    now?: () => number;
    /** 默认调模型接口（llm.ts）；模拟器包一层，在生成中插入对方的消息 */
    generate?: (messages: OpenAIMessage[], log: Log) => Promise<string>;
    /** 连发合并的等待，默认 DEFAULT_SETTLE（测试用短的） */
    settle?: { quietMs: number; maxMs: number };
    /** 按卡上的作息（ADR 0007）：时间块里加一行她现在在干什么，按作息决定什么时候看到、打字多久，收尾后的附和不回。默认否；卡上没有作息时也不按 */
    schedule?: boolean;
    /** 看心情不回（ADR 0013 决策 4），要按作息；默认否 */
    moody?: boolean;
    /** 出口检查里查说话的毛病（ADR 0014）；默认否 */
    speechCheck?: boolean;
    /** 他难过、说亲密话、收尾时一次生成几个候选、按规则挑一个（ADR 0041）；不写或 1 是不挑 */
    candidates?: number;
    /**
     * 她自己的日子（ADR 0015）：心情行、「在读的书」、看书的空闲活动、进度数字的检查；默认否。
     * 一天怎么算、课多不多按卡上的作息，所以卡上没有作息（或者没有心情、书）就没有；schedule 关着时心情和书照样有，只是没有看书的空闲活动
     */
    herDays?: boolean;
    /** 她答应过的事（ADR 0018 决策 2）：到了日子在时间块里提醒一句；名单外的人不用 */
    promises?: Pick<PromiseKeeper, 'describe'> & Partial<Pick<PromiseKeeper, 'openLoops'>>;
    /** W3：所有联系人、日记和主动消息共用的一份世界动作。 */
    worldState?: Pick<WorldState, 'at'>;
    /** 指定今天的心情（模拟器比较不同心情用）；不传按日期抽 */
    mood?: string;
    /** herDays 开着时每次生成前调一次（app 按她的一天去重，写当天的摘要） */
    onHerDay?: (now: Date) => void;
    /** 看心情不回的概率，不传按档位算；模拟器用 */
    moodyChance?: number;
    /** 看到消息之前的等待（可能几个小时），默认真实定时器；模拟器换成虚拟时钟上的 */
    waitUntil?: (at: number, signal: AbortSignal) => Promise<void>;
    /** 回复失败之后隔多久再试，默认 RETRY_AFTER_MS；模拟器传 []（它的时钟是虚拟的，真等几分钟会插进后面的步骤） */
    retryAfterMs?: readonly number[];
}

/** 问到过去的某一天时，几天以内她那边的事还记得清楚（ADR 0032，同 ADR 0018 的 7 天） */
export const RECAP_DAYS = 7;

export function createContactResponder(options: ContactPipelineOptions): Responder {
    const { contact, card: { character, worldInfo }, llm, memory } = options;
    const names = { user: contact.name, char: character.name };
    const now = options.now ?? Date.now;
    const log: Log = message => options.log(`[${contact.qq}] ${message}`);
    const generate = options.generate ?? ((messages, log) => chatCompletion(llm, messages, { log }));
    const clean = (reply: string) => cleanUpReply(reply, names, character.regexScripts);
    const schedule = options.schedule ? character.schedule : undefined;
    const herSchedule = options.herDays ? character.schedule : undefined;
    const extraFree = herSchedule ? readingActivities(character.books) : [];
    // 这一轮放了「在读的书」时，出口检查拿它核对进度数字。同一个回复器一次只生成一条，review 紧跟着这一轮的 buildPrompt
    let reading: BookProgressContext | undefined;
    // 这一轮要不要挑候选（ADR 0041）：buildPrompt 按意图行定，紧跟着的 generate 用
    let pick: PickRules | undefined;
    // 刚想起的公共记忆（ADR 0017）、从前（ADR 0022）、刚说起的她身边的人（ADR 0033）：接下来两轮没有新线索也沿用，追问时不忘。
    // 不记在这里，每轮从聊天记录往回推（lingering，ADR 0039）：记在内存里的话，重启以后追问「她好了没」就接不上了
    // 他问到过去的某一天（ADR 0032）：那天她那边的事，按这一档的卡算；只到 RECAP_DAYS 天前（ADR 0018：7 天内记得清楚）
    const recapOf = (dayStart: Date, time: Date): { day: string; lines: string[]; text: string } | undefined => {
        if (!herSchedule || !character.herWorld) return undefined;
        const today = herDay(herSchedule, time);
        const back = Math.round((today.getTime() - dayStart.getTime()) / 86_400_000);
        if (back < 1 || back > RECAP_DAYS) return undefined;
        const at = (h: number, m: number) => new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), h, m);
        const then = options.worldState?.at(character.herWorld, herSchedule, at(23, 30)) ?? worldAt(character.herWorld, herSchedule, at(23, 30));
        if (!then) return undefined;
        const lines = recapDay(then);
        const bodyThen = character.herWorld.body ? bodyAt(character.herWorld.body, herSchedule, at(15, 0)) : undefined;
        const body = bodyThen ? diaryBody(bodyThen) : undefined;
        if (body) lines.push(body);
        // 那天改了的打算（ADR 0034）：照打算做的不写——天天一样的空闲活动排成一列，问「昨天干嘛了」她就照着报，想不起那天记得住的事（调整 3）
        lines.push(...dayPlan(herSchedule, character.herWorld.plans, dayStart, { rain: then.weather?.rain, body: bodyThen, homework: then.homework }, extraFree)
            .filter(slot => slot.done !== slot.planned).map(describeSlot));
        if (!lines.length) return undefined;
        const day = `${dayStart.getMonth() + 1}月${dayStart.getDate()}日 ${'日一二三四五六'.split('').map(d => `周${d}`)[dayStart.getDay()]}`;
        return { day, lines, text: `[那天（${day}）你那边的流水账（你自己过的，都是真的：他问到具体的事——下没下雨、喂没喂猫、快递拿没拿——照这个说，别说错；泛泛问那天干了什么时，先说上面记得住的事，这里的不用一件件报）：${lines.join('；')}]` };
    };
    return createResponder({
        userId: contact.qq,
        history: options.history,
        buildPrompt: async (chat, { woken, initiate }) => {
            const time = new Date(now());
            // 长期记忆只给名单里的人；主动找他时没有「他这次说的」：查想知道的事 + 最后两句，带前 3 天到后 2 天的时间窗（ADR 0012 决策 1 第 7 条）
            const remembers = memory && contact.tier !== UNLISTED_TIER;
            const recallOptions = initiate
                ? { query: initiateQuery(chat, initiate.topic), window: { start: new Date(time.getTime() - 3 * DAY_MS), end: new Date(time.getTime() + 2 * DAY_MS) } }
                : {};
            // 她认识的人（ADR 0016）：提到的人查他自己的 bank。公共记忆有线索才查（ADR 0017）：提到了写了介绍的人、公共库里的人和事，
            // 或者问她过去的事；主动找他时不查（没有「他这次说的」）
            const people = mentionedPeople(chat, contact, options.contacts ?? []);
            const holidays = holidayWords(character.schedule);
            const entities = remembers && !initiate ? await memory.commonEntities() : [];
            const cueIn = (said: Readonly<typeof chat>) => {
                const named = mentionedPeople(said, contact, options.contacts ?? []);
                return named.length ? named.map(person => person.name).join('、') : commonCue(said, contact, entities, character.name, holidays);
            };
            const cue = !remembers || initiate ? undefined : cueIn(chat);
            // 问「今天」「昨天」按她的一天算（ADR 0018 决策 4）；问「上周」「国庆」时是那一周、那个假期（决策 3）。
            // 线索正好是假期的名字（「国庆」也是公共库里的实体）时同样带那个假期的时间窗（第三批：「那国庆呢」想起的是周记）
            // 线索是公共库里的人和事、同时又在问她过去的某天（「周一你那快递拿了没」）时也带那天的时间窗（ADR 0032）
            const windowOf = (said: Readonly<typeof chat>, cue: string | undefined, at: Date) =>
                (cue === ASKS_PAST || (cue !== undefined && (holidays.includes(cue) || asksPast(said, holidays)))
                    ? askedWindow(said, at, schedule ?? herSchedule ?? character.schedule) : undefined);
            const day = windowOf(chat, cue, time);
            // 记忆里她的名字换成「你」（ADR 0018 决策 4）；那一行里的「她」也是她，除非还提到别的女生（她的朋友、名单里的闺蜜和女生朋友）
            const women = [
                ...(character.herWorld?.people ?? []).map(person => person.name),
                ...(options.contacts ?? []).filter(c => c.tier === 'bestie' || c.tier === 'girl_friend').map(c => c.name),
            ];
            const you = (text: string | undefined) => text && secondPerson(text, character.name, women);
            // 记忆会变淡（ADR 0018）：她和名单里的称呼不算「一提就想起」的线索；各几条记下来写日志（0 是他的，1 是公共的，之后是提起的人）
            const ignore = [character.name, contact.name, ...(options.contacts ?? []).map(c => c.name)];
            const faded: (FadeStats | undefined)[] = [];
            const fade = (i: number) => ({ ignore, onFade: (stats: FadeStats) => { faded[i] = stats; } });
            // 她今天跟别人聊过的也是她的生活（ADR 0020）：只在亲密联系人开启新一段对话、或她主动找他时想起。
            // 本轮已有明确公共记忆线索时不另查，避免把同一件事放两遍。
            const todayOthers = remembers && !cue && isClose(contact.tier) && (Boolean(initiate) || startsConversation(chat))
                ? memory.othersToday(contact, time, options.contacts ?? [], todayStart(schedule ?? herSchedule ?? character.schedule, time))
                : undefined;
            // 按那一轮他说的话想公共记忆：线索是问她过去的事时不限人和事，提到名单里的人时是这几个人，否则是那个人和事
            const recallCommon = (said: Readonly<typeof chat>, cue: string, at: Date) => {
                const named = mentionedPeople(said, contact, options.contacts ?? []);
                return memory!.recallCommon(contact, said, at, options.contacts ?? [contact], windowOf(said, cue, at), fade(1),
                    cue === ASKS_PAST ? [] : named.length ? named.map(p => p.name) : [cue]);
            };
            const [recalled, freshCommon, ...aboutPeople] = (await Promise.all([
                remembers ? memory.recall(contact, chat, time, { ...recallOptions, ...fade(0) }) : undefined,
                remembers && cue ? recallCommon(chat, cue, time) : undefined,
                ...people.map((person, i) => (remembers
                    ? memory.recall(person, chat, time, {
                        ...recallOptions, ...fade(i + 2), limit: PERSON_RECALLED,
                        header: `[关于${person.name}的旧事（${sourceLabel(person, contact)}；从记忆里想起来的，只作参考）]`,
                    })
                    : undefined)),
            ])).map(you);
            const relationship = remembers ? you(memory.relationship(contact)) : undefined;
            if (recalled || faded[0]?.forgotten) log(`召回长期记忆 ${recalled ? countLines(recalled) : 0} 条${fadeNote(faded[0])}`);
            let common = freshCommon;
            const commonNote = [`线索：${cue}`, fadeParts(faded[1]).join('，')].filter(Boolean).join('；');
            if (common) {
                log(`召回公共记忆 ${countLines(common)} 条（${commonNote}）`);
            } else if (cue) {
                log(`公共记忆没想起什么（${commonNote}）`);
            } else if (remembers && !initiate) {
                // 刚才那一轮想起过、还在脑子里：照那一轮的话、那一轮的时刻再想一次，和当时想起的一样
                const earlier = lingering(chat, time.getTime(), cueIn);
                common = earlier ? you(await recallCommon(earlier.upTo, earlier.found, new Date(earlier.at))) : undefined;
                if (common) log(`公共记忆沿用刚才想起的 ${countLines(common)} 条`);
            }
            if (people.length) {
                log(`提起了 ${people.map((person, i) => `${person.name}：介绍${aboutPeople[i] ? ` + 召回 ${countLines(aboutPeople[i])} 条${fadeNote(faded[i + 2])}` : ''}`).join('；')}`);
            }
            // 她对他的印象（ADR 0017）放在介绍下面、他的私人记忆上面
            const impressions = people.map(person => (remembers ? you(memory.impression(person)) : undefined));
            if (impressions.some(Boolean)) log(`有印象：${people.filter((_, i) => impressions[i]).map(person => person.name).join('、')}`);
            const peopleText = people.map((person, i) => describePerson(person, impressions[i], aboutPeople[i]));
            const today = common ? undefined : you(await todayOthers);
            if (today) log(`今天和别人聊过的 ${countLines(today)} 条（新一段对话，有由头可以含糊提一件）`);
            const days = describeDays(character.dates, time);
            let state = schedule ? stateAt(schedule, time, extraFree) : undefined;
            if (herSchedule) options.onHerDay?.(time);
            // 她那边（ADR 0021）：跟着「她自己的日子」开，卡上有世界才有
            const around = herSchedule && character.herWorld
                ? options.worldState?.at(character.herWorld, herSchedule, time) ?? worldAt(character.herWorld, herSchedule, time)
                : undefined;
            const world = around ? describeWorld(around, time) : undefined;
            // 他问到过去的某一天（ADR 0032）：那天她那边的事直接给，不靠日记召回（72 小时基线：问「周一快递拿了没」3/3 答还没拿，问「昨天下雨了吗」2/3 答没下）
            const recap = day && !day.period ? recapOf(day.start, time) : undefined;
            if (recap) log(`想起那天：${recap.day}（${recap.lines.length} 件）`);
            // 她的身体（ADR 0025）：同样跟着「她自己的日子」，卡上有才有
            const bodyNow = herSchedule && character.herWorld?.body ? bodyAt(character.herWorld.body, herSchedule, time) : undefined;
            // 此刻在做的事接上世界（ADR 0030）：空闲时正好在喂猫、取快递、和家里视频、赶作业，状态行就写这件
            const busy = state?.activity.kind === 'free' && around ? occupationAt(around, time) : undefined;
            if (state && busy) {
                state = { ...state, activity: { kind: 'free', text: busy } };
                log(`此刻在做：${busy}`);
            }
            // 她一天的打算会改（ADR 0034）：醒着时给今天的打算；空闲又没有别的事时，状态行写「本来打算 X，Y，Z」
            const slots = herSchedule && around && state && state.activity.kind !== 'sleep'
                ? dayPlan(herSchedule, character.herWorld?.plans, herDay(herSchedule, time), { rain: around.weather?.rain, body: bodyNow, homework: around.homework }, extraFree)
                : [];
            const revised = state?.activity.kind === 'free' && !busy && herSchedule ? planNow(herSchedule, slots, time) : undefined;
            if (state && revised) {
                state = { ...state, activity: { kind: 'free', text: revised } };
                log(`改了打算：${revised}`);
            }
            const plansLine = herSchedule ? describePlans(herSchedule, slots, time) : undefined;
            const books = herSchedule
                ? readingSection(herSchedule, character.books, time, {
                    history: chat, userName: contact.name,
                    ...(state?.activity.kind === 'free' ? { activity: state.activity.text } : {}),
                })
                : undefined;
            reading = books?.context;
            const body = bodyNow ? describeBody(bodyNow) : undefined;
            const mood = herSchedule ? moodAt(herSchedule, character.moods, time, options.mood, { body: bodyNow, world: around }) : undefined;
            // 她的过去（ADR 0022）：他说到卡上某块的线索才想起；主动找他时不想
            const biography = character.biography;
            let pastChunks = biography && !initiate ? pastCue(chat, biography) : [];
            if (pastChunks.length) {
                log(`想起从前：${pastChunks.map(chunk => chunk.title).join('、')}`);
            } else if (biography && !initiate) {
                pastChunks = lingering(chat, time.getTime(), upTo => nonEmpty(pastCue(upTo, biography)))?.found ?? [];
                if (pastChunks.length) log(`从前沿用刚才想起的：${pastChunks.map(chunk => chunk.title).join('、')}`);
            }
            const past = biography ? describePast(pastChunks, biography) : undefined;
            // 他说起她身边的人（ADR 0033）：那人最近两周怎么样，她知道的；主动找他时不想
            const herPeople = character.herWorld && herSchedule && !initiate ? character.herWorld.people : undefined;
            let npcs = herPeople ? npcMentioned(chat, herPeople) : [];
            if (!npcs.length && herPeople) npcs = lingering(chat, time.getTime(), upTo => nonEmpty(npcMentioned(upTo, herPeople)))?.found ?? [];
            const aboutNpcs = npcs.flatMap(person => {
                const lines = recentWith(character.herWorld!, herSchedule!, time, person.id);
                return lines ? [`[${person.name}最近两周（${person.relation}；你知道的事，他问到了照实说，没写到的别编）：${lines.length ? lines.join('；') : '没病没忙，照常'}]`] : [];
            });
            if (aboutNpcs.length) log(`想起${npcs.map(person => person.name).join('、')}最近的事`);
            const promised = contact.tier !== UNLISTED_TIER ? options.promises?.describe(contact, chat, time) : undefined;
            if (promised) log('时间块里提醒了她答应的事');
            // 挂着的事（ADR 0023）：等他说结果的、她问了他没答的进意图行；没了结的事实放在心情后面，只给事实
            const loops = contact.tier !== UNLISTED_TIER ? options.promises?.openLoops?.(contact, chat, time) : undefined;
            // 陌生人 / 名单外档没有她自己的日子，也不会因为一句越界的「爱你」凭空亲近。
            const affect = character.moods.length ? warmAffect(chat) : undefined;
            const warm = describeWarmAffect(affect);
            const unsettled = loops ? describeUnsettled(loops.unsettled, affect?.kind === 'repair' || affect?.kind === 'comfort') : undefined;
            if (loops && (loops.waiting.length || loops.unanswered.length || loops.unsettled.length)) {
                log(`挂着的事：等结果 ${loops.waiting.length}、没回答 ${loops.unanswered.length}、没了结 ${loops.unsettled.length}`);
            }
            if (affect) log(`情绪余温：${affect.kind}，还影响 ${affect.remaining} 轮`);
            const intent = describeIntent({
                history: chat,
                state,
                schedule: schedule ?? herSchedule,
                now: time,
                promised: Boolean(promised),
                books: Boolean(books),
                initiating: Boolean(initiate),
                waiting: loops?.waiting.map(l => l.what),
                unanswered: loops?.unanswered.map(l => l.what),
            });
            if (intent) log(`这一轮有意图：${intent.slice('[这一轮你想：'.length, -1)}`);
            const picked = (options.candidates ?? 1) > 1 && intent && !initiate ? PICKED_INTENTS.find(p => p.pattern.test(intent)) : undefined;
            pick = picked ? {
                kind: picked.kind, maxLines: picked.maxLines, heard: heardSinceReply(chat), banned: character.banned,
                // 她自己生活里的东西：猫、相机、在读的书、手上的爱好（DSH 诊断 1.2、ADR 0036 的四类）
                own: [...(around?.cat ? [around.cat.name] : []), '相机', ...character.books.map(book => book.title), '追剧', '调色', '构图', '修片', '摄影区'],
                ...(options.speechCheck ? { speech: speechContext(options.history.load(contact.qq)) } : {}),
            } : undefined;
            // 长短不一（ADR 0024）：偶尔回句短的、偶尔话多一点；心情安静的日子不加「话多」
            const length = lengthHint({ history: chat, intent, initiating: Boolean(initiate), low: mood?.mood.name === '安静' || (bodyNow ? unwell(bodyNow) : false) });
            if (length) log(`这一轮说话：${length === 'short' ? '回句短的' : '话多一点'}`);
            // 聊天原文只放最近几天的（ADR 0018 实现时的调整 12）：开了长期记忆的才这样，更早的靠记忆想；没有记忆的照旧全放
            const shown = remembers ? recentChat(chat, time) : { chat, omitted: 0 };
            const prompt = buildPrompt({
                character,
                worldInfo,
                history: shown.chat,
                userName: contact.name,
                userPersona: contact.persona,
                afterMain: relationship ? [relationship] : [],
                afterHistory: [
                    ...(recalled ? [recalled] : []),
                    // 那天的流水账放在日记、记忆后面（ADR 0032 调整 3：放在前面时问「昨天都干嘛了」她照着报喂猫、取快递，想不起那天记得住的麻辣烫，1/3）
                    ...(common ? [common] : []),
                    ...(recap ? [recap.text] : []),
                    ...(today ? [today] : []),
                    ...(past ? [past] : []),
                    ...aboutNpcs,
                    ...peopleText,
                    ...(common || today || peopleText.length ? [disclosureRules(contact)] : []),
                    [
                        describeTime(chat, time, { initiating: Boolean(initiate) }),
                        ...(days ? [days] : []),
                        ...(state ? [describeState(state, schedule!, { userName: contact.name, woken })] : []),
                        ...(mood ? [describeMood(mood, contact.name)] : []),
                        ...(body ? [body] : []),
                        ...(unsettled ? [unsettled] : []),
                        ...(warm ? [warm] : []),
                        ...(books ? [books.text] : []),
                        ...(world ? [world] : []),
                        ...(plansLine ? [plansLine] : []),
                        ...(promised ? [promised] : []),
                        ...(intent ? [intent] : []),
                        ...(length ? [describeLength(length)] : []),
                        ...(initiate ? [initiate.note] : []),
                    ].join('\n'),
                ],
                now: time,
                settings: {
                    maxContext: options.prompt.maxContext,
                    maxTokens: llm.maxTokens,
                    worldInfo: options.prompt.worldInfo,
                    pinExamples: options.prompt.pinExamples,
                },
                countTokens: estimateTokens,
            });
            return {
                ...prompt,
                messages: postProcessPrompt(prompt.messages, llm.promptPostProcessing, names),
                ...((intent && /先接住他此刻的情绪|只接他刚说的你们两个人的事|顺着他的话收尾/.test(intent)) ? { maxBubbles: 2 } : {}),
                ...(shown.omitted ? { note: `较早的聊天原文 ${shown.omitted} 条不放（事实靠长期记忆）` } : {}),
            };
        },
        generate: async messages => {
            const rules = pick;
            if (!rules) return generate(messages, log);
            // 同一份提示词生成几个，挑扣分最少的（ADR 0041）；返回原文，清理照常在回复器里做
            const all = await Promise.all(Array.from({ length: options.candidates! }, () => generate(messages, log)));
            const { index, scored } = pickBest(all, rules, clean);
            log(describePick(index, scored));
            return all[index]!;
        },
        clean,
        // 出口检查：重写时在后处理过的提示词末尾加一条说明，再按同样的方式后处理一次
        // 打错字再改口（ADR 0024）：拆好条之后、发出去之前。种子只看是谁、说了什么，不看时间：同一句话结果固定
        // （带时间时，假模型的测试里「哟，还知道回来啊」有时被打成「知到」，测试时过时不过）
        decorate: (parts, maxBubbles) => {
            const typo = maybeTypo(parts, `${contact.qq} ${parts.join('|')}`, maxBubbles);
            if (typo.note) log(`打错字：${typo.note}`);
            return typo.parts;
        },
        review: (reply, messages) => reviewReply(reply, {
            banned: character.banned,
            userName: contact.name,
            ...(options.speechCheck ? { speech: speechContext(options.history.load(contact.qq)) } : {}),
            ...(reading ? { books: reading } : {}),
            regenerate: async note => clean(await generate(
                postProcessPrompt([...messages, { role: 'system', content: note }], llm.promptPostProcessing, names),
                log,
            )),
            log,
        }),
        send: options.send,
        log,
        now,
        settle: options.settle ?? DEFAULT_SETTLE,
        retryAfterMs: options.retryAfterMs ?? RETRY_AFTER_MS,
        // 睡着时连着发能把她吵醒的只有男朋友档（决策 6）；冷场时多久看到、打字多久乘这一档的节奏系数（ADR 0013 决策 1）
        timing: schedule && {
            whenSeen: (history, at) => whenSeen(history, at, {
                schedule, wakeable: contact.tier === 'boyfriend', pace: character.pace,
                // 洗澡时看不到消息（ADR 0031），按她这一档的世界算
                busy: moment => {
                    if (!herSchedule || !character.herWorld) return undefined;
                    const when = new Date(moment);
                    const around = options.worldState?.at(character.herWorld, herSchedule, when) ?? worldAt(character.herWorld, herSchedule, when);
                    const busy = around ? unavailableAt(around, when) : undefined;
                    return busy ? { until: busy.until.getTime(), reason: busy.reason } : undefined;
                },
            }),
            typingMs: text => typingMs(text, character.pace),
            skip: replySkip(character, options.moody ?? false, options.moodyChance),
        },
        waitUntil: options.waitUntil,
        onPrompt: options.onPrompt,
    });
}
