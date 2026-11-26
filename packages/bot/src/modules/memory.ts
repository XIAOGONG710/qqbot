// 记忆这一组的段落作为解释器的模块（ADR 0336 第 5 步）：
// - relationship（main 之后，同 ST 的 After Main Prompt）：他私人库里的关系概况（ADR 0012）。
// - summary（ADR 0043，配置 contextTurns）：更早聊天的要点（原文只放最近几轮时）。
// - recalled（ADR 0012 / 0018）：他的私人记忆，按这一轮他说的召回；主动找他时按想说的事 + 时间窗。
// - work（ADR 0176）：她在 DSH 里做过的事（工作房），男朋友档每轮都查。
// - desktop（ADR 0177，配置 crossRecent）：他刚才在 DSH 桌面上和她的对话。
// - common（ADR 0016 / 0017）：公共记忆——有线索时想起、刚想起的接下来两轮沿用。
// - recap（ADR 0032）：他问到过去的某一天时，那天她那边的流水账（带那天的日记、那天的感觉）。
// - today（ADR 0020）：保留段落槽位，跨联系人私聊召回已停用。
// - people（ADR 0016 / 0017）：他提到的名单里的人，仍可带配置里的公开介绍。
// - disclosure（ADR 0020）：上面有 common / today / people 任何一段时，接一段「说别人的事的分寸」（disclosureRules，纯函数，只看听的人的称呼和档位）。
//
// 召回仍在联系人流水线原位。各分支共用一个等待预算，私人和工作房查询不用等公共实体读取。
// - 关系概况和印象是「返回缓存、过期了在后台重读」：什么时候调决定了后台那次读在哪一轮之前落地（行为基线的 memory 场景第二轮起才有关系概况，就是这个先后）。
// - 召回的结果旧逻辑还要用：变淡统计和召回日志、线索（cue）定时间窗和要不要查「今天和别人聊过的」、common 有了就不查 today、要点决定原文放多少（note 那一句）。
// - 要点（summary）那一下会在后台起一次整理（contextWindow.summarize），也留在原位。
// 所以旧逻辑算完把最终的字（她的名字已换成「你」）写进 turn.facts.memory，这里照原样放；有没有、空串当没有，和迁移前 when() 的真假判断一样。
// 不看危机、只想一想、主动找他（迁移前这几段都不看；该不该召回由召回的地方定，挡在两处时变异只能抓到一处）。
// 放段落时不存状态、不调模型、不记日志，都是同步的，不多等一个微任务（行为基线核对事件顺序）；召回的几行日志在 decideAt.recall 里记。

//
// 2026-11-18（ADR 0336「判断那一串」）：召回也挪进来了，位置不变——`decideAt.recall` 由联系人流水线在原来那串 await 的位置调（真人数值之后、onHerDay 和 perceive 之前），
// 上面几条顾虑（等待的位置、外部调用和日志的先后、后台重读落在哪一轮之前）都不碰。长期记忆、名单、作息、那天的感觉、群里 / DSH 桌面的取法经 DecideCtx.recall 给。
// 召回的结果写进 turn.facts.recall（还没拼上要点和那一天，那两样在流水线后面）、线索写进 facts.cue、他问到的那一天写进 facts.askedDay、群里那一句写进 facts.groupEcho。

import type { ChatMessage } from '../language/prompt.ts';
import type { Contact } from '../platform/config.ts';
import type { Character } from '../st/card.ts';
import type { FadeStats } from '../memory/fading.ts';
import type { DecideCtx, Module, Turn } from '../interpreter/interpreter.ts';
import type { Piece, Slot } from '../interpreter/slots.ts';
import { disclosureRules, isClose, sourceLabel, startsConversation, todayStart } from '../emotion/disclosure.ts';
import { feltNoteFor, sameThing } from '../emotion/felt-then.ts';
import { ledgerNote } from '../emotion/feeling-ledger.ts';
import { askedWindow, ASKS_PAST, asksPast, commonCue, describePerson, holidayWords, lingering, mentionedPeople } from '../life/people.ts';
import { initiateQuery, PERSON_RECALLED, secondPerson } from '../memory/long-term.ts';
import { recentChat } from '../memory/fading.ts';
import { turnCut } from '../language/context-window.ts';

const DAY_MS = 86_400_000;
/** 同一个本地日子 */
const sameDay = (at: number, day: Date) => {
    const d = new Date(at);
    return d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate();
};
export const countLines = (text: string) => text.split('\n').length - 1;
/** 记忆变淡（ADR 0018）各几条，写日志用：「记个大概 2，一提想起 1，想不起来 3」，都是 0 就是空的 */
const fadeParts = (stats: FadeStats | undefined) => (stats
    ? ([['记个大概', stats.vague], ['一提想起', stats.recognized], ['想不起来', stats.forgotten], ['同一件事多的', stats.repeated ?? 0]] as const).filter(([, n]) => n).map(([label, n]) => `${label} ${n}`)
    : []);
const fadeNote = (stats: FadeStats | undefined) => (fadeParts(stats).length ? `（${fadeParts(stats).join('，')}）` : '');

/** 记忆里她的名字换成「你」（ADR 0018 决策 4）；那一行里的「她」也是她，除非还提到别的女生（她的朋友、名单里的闺蜜和女生朋友） */
export function youFor(character: Character, contacts: readonly Contact[]) {
    const women = [
        ...(character.herWorld?.people ?? []).map(person => person.name),
        ...contacts.filter(c => c.tier === 'bestie' || c.tier === 'girl_friend').map(c => c.name),
    ];
    return (text: string | undefined) => text && secondPerson(text, character.name, women);
}

/** 同一轮的 Hindsight 查询共用一个截止点，已经完成的分支保留。 */
function withinRecall<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    if (!signal) return read();
    return new Promise(resolve => {
        const expired = () => resolve(undefined);
        signal.addEventListener('abort', expired, { once: true });
        void Promise.resolve().then(read).then(resolve, expired).finally(() => signal.removeEventListener('abort', expired));
    });
}

/** 召回（decideAt.recall）：先并行发起不依赖线索的查询。 */
async function recall(turn: Turn, ctx: DecideCtx): Promise<void> {
    const options = ctx.recall;
    const character = turn.card;
    if (!options || !character) return;
    const { contact, at: time, initiate } = turn;
    const chat = turn.history as ChatMessage[];
    const log = ctx.log;
    const contacts = options.contacts ?? [];
    // 长期记忆只给名单里的人（流水线只在名单里的人才给 memory）；主动找他时没有「他这次说的」：查想知道的事 + 最后两句，带前 3 天到后 2 天的时间窗（ADR 0012 决策 1 第 7 条）
    const memory = options.memory;
    const remembers = memory;
    const timeout = memory?.recallBudgetMs ?? 3000;
    const deadline = memory ? AbortSignal.timeout(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 2_147_483_647 ? timeout : 0) : undefined;
    const recallOptions = initiate
        ? { query: initiateQuery(chat, initiate.topic), window: { start: new Date(time.getTime() - 3 * DAY_MS), end: new Date(time.getTime() + 2 * DAY_MS) } }
        : {};
    // 她认识的人从配置介绍识别。公共记忆有线索才查（ADR 0017）：提到了写了介绍的人、公共库里的人和事，
    // 或者问她过去的事；主动找他时不查（没有「他这次说的」）
    const people = mentionedPeople(chat, contact, contacts);
    const holidays = holidayWords(character.schedule);
    const cueIn = (said: Readonly<typeof chat>, entities: readonly string[]) => {
        const named = mentionedPeople(said, contact, contacts);
        return named.length ? named.map(person => person.name).join('、') : commonCue(said, contact, entities, character.name, holidays);
    };
    // 问「今天」「昨天」按她的一天算（ADR 0018 决策 4）；问「上周」「国庆」时是那一周、那个假期（决策 3）。
    // 线索正好是假期的名字（「国庆」也是公共库里的实体）时同样带那个假期的时间窗（第三批：「那国庆呢」想起的是周记）
    // 线索是公共库里的人和事、同时又在问她过去的某天（「周一你那快递拿了没」）时也带那天的时间窗（ADR 0032）
    const windowOf = (said: Readonly<typeof chat>, cue: string | undefined, at: Date) =>
        (cue === ASKS_PAST || (cue !== undefined && (holidays.includes(cue) || asksPast(said, holidays)))
            ? askedWindow(said, at, options.schedule) : undefined);
    const you = youFor(character, contacts);
    // 记忆会变淡（ADR 0018）：她和名单里的称呼不算「一提就想起」的线索；各几条记下来写日志（0 是他的，1 是公共的，之后是提起的人）
    const ignore = [character.name, contact.name, ...contacts.map(c => c.name)];
    const faded: (FadeStats | undefined)[] = [];
    const fade = (i: number) => ({ ignore, onFade: (stats: FadeStats) => { faded[i] = stats; } });
    // 回忆带着当时的感觉（ADR 0218）：召回的和他的记忆，那天她心里对得上的那种感觉；主动找他时不附（开了 memoryFeelings、男朋友档时流水线才给 feltOnDay）
    // 感觉账（ADR 0347 第 5 层）：当天的感觉早散了、回想也只记几天——那几天以前的事从账里配，说法照她的要求换过（疼 / 她妈那块的慌不原样带）
    const feltOnDay = options.feltOnDay;
    const feltLedger = options.feltLedger;
    const feltForRecall = (feltOnDay || feltLedger) && !initiate
        ? (when: Date, text: string) => {
            const day = new Date(when.getFullYear(), when.getMonth(), when.getDate());
            const felt = feltOnDay ? feltNoteFor(feltOnDay(day), text) : undefined;
            if (felt) return felt;
            const same = (feltLedger?.() ?? []).filter(row => sameDay(row.at, day) && sameThing(row, text));
            const best = same.sort((a, b) => Number(b.level === 'strong') - Number(a.level === 'strong'))[0];
            return best ? ledgerNote(best) : undefined;
        }
        : undefined;
    const privateRecall = remembers ? withinRecall(deadline, () => memory.recall(contact, chat, time,
        { ...recallOptions, ...fade(0), ...(feltForRecall ? { felt: feltForRecall } : {}) })) : undefined;
    const workRecall = remembers && contact.tier === 'boyfriend'
        ? withinRecall(deadline, () => memory.recallWork(contact, chat, time)) : undefined;
    const entitiesTask = remembers && !initiate ? withinRecall(deadline, () => memory.commonEntities()) : undefined;
    const entities = await entitiesTask ?? [];
    const cue = !remembers || initiate ? undefined : cueIn(chat, entities);
    const day = windowOf(chat, cue, time);
    // 她今天跟别人聊过的也是她的生活（ADR 0020）：只在亲密联系人开启新一段对话、或她主动找他时想起。
    // 本轮已有明确公共记忆线索时不另查，避免把同一件事放两遍。
    const todayOthers = remembers && !cue && isClose(contact.tier) && (Boolean(initiate) || startsConversation(chat))
        ? withinRecall(deadline, () => memory.othersToday(contact, time, contacts, todayStart(options.schedule, time)))
        : undefined;
    // 按那一轮他说的话想公共记忆：线索是问她过去的事时不限人和事，提到名单里的人时是这几个人，否则是那个人和事
    const recallCommon = (said: Readonly<typeof chat>, cue: string, at: Date) => {
        const named = mentionedPeople(said, contact, contacts);
        return withinRecall(deadline, () => memory!.recallCommon(contact, said, at, options.contacts ?? [contact], windowOf(said, cue, at), fade(1),
            cue === ASKS_PAST ? [] : named.length ? named.map(p => p.name) : [cue]));
    };
    const [recalled, freshCommon, ...aboutPeople] = (await Promise.all([
        privateRecall,
        remembers && cue ? recallCommon(chat, cue, time) : undefined,
        ...people.map((person, i) => (remembers && memory.canRecallContactMemory(person, contact)
            ? withinRecall(deadline, () => memory.recall(person, chat, time, {
                ...recallOptions, ...fade(i + 2), limit: PERSON_RECALLED,
                header: `[关于${person.name}的旧事（${sourceLabel(person, contact)}；从记忆里想起来的，只作参考）]`,
            }, contact))
            : undefined)),
    ])).map(you);
    const relationship = remembers ? you(memory.relationship(contact)) : undefined;
    if (recalled || faded[0]?.forgotten) log(`召回长期记忆 ${recalled ? countLines(recalled) : 0} 条${fadeNote(faded[0])}`);
    // 工作房每轮都查：他问“今天帮我干了什么”时不一定有公共记忆线索
    const work = you(await workRecall);
    if (work) log(`召回工作记忆 ${countLines(work)} 条`);
    // 同一个她（ADR 0177）：他刚才在电脑上（DSH）和她说的，QQ 这边接着知道
    const groupQuestion = !initiate && chat.at(-1)?.role === 'user' ? chat.at(-1)?.content : undefined;
    const groupEcho = groupQuestion ? await options.groupRecent?.(groupQuestion, time) : undefined;
    const desktop = options.desktopRecent?.(time);
    if (desktop) log(`带上他刚才在 DSH 桌面上的对话 ${(desktop.match(/ 他：/g) ?? []).length} 轮`);
    let common = freshCommon;
    const commonNote = [`线索：${cue}`, fadeParts(faded[1]).join('，')].filter(Boolean).join('；');
    if (common) {
        log(`召回公共记忆 ${countLines(common)} 条（${commonNote}）`);
    } else if (cue) {
        log(`公共记忆没想起什么（${commonNote}）`);
    } else if (remembers && !initiate) {
        // 刚才那一轮想起过、还在脑子里：照那一轮的话、那一轮的时刻再想一次，和当时想起的一样
        const earlier = lingering(chat, time.getTime(), said => cueIn(said, entities));
        common = earlier ? you(await recallCommon(earlier.upTo, earlier.found, new Date(earlier.at))) : undefined;
        if (common) log(`公共记忆沿用刚才想起的 ${countLines(common)} 条`);
    }
    if (people.length) {
        log(`提起了 ${people.map((person, i) => `${person.name}：介绍${aboutPeople[i] ? ` + 召回 ${countLines(aboutPeople[i])} 条${fadeNote(faded[i + 2])}` : ''}`).join('；')}`);
    }
    // 她对他的印象（ADR 0017）放在介绍下面、他的私人记忆上面
    const impressions = people.map(person => (remembers ? you(memory.impression(person, contact)) : undefined));
    if (impressions.some(Boolean)) log(`有印象：${people.filter((_, i) => impressions[i]).map(person => person.name).join('、')}`);
    const peopleText = people.map((person, i) => describePerson(person, impressions[i], aboutPeople[i]));
    const today = common ? undefined : you(await todayOthers);
    if (today) log(`今天和别人聊过的 ${countLines(today)} 条（新一段对话，有由头可以含糊提一件）`);
    const { facts } = turn;
    if (cue) facts.cue = cue;
    if (day) facts.askedDay = day;
    if (groupEcho) facts.groupEcho = groupEcho;
    facts.recall = {
        ...(relationship ? { relationship } : {}), ...(recalled ? { recalled } : {}), ...(work ? { work } : {}), ...(desktop ? { desktop } : {}),
        ...(common ? { common } : {}), ...(today ? { today } : {}), ...(peopleText.length ? { people: peopleText } : {}),
    };
}

/**
 * 记忆这一组放进提示词的几段：联系人流水线原位召回 / 读好之后写进 turn.facts.memory（她的名字已换成「你」），modules/memory.ts 照原样放。
 * TurnFacts.memory 的类型（interpreter.ts 引用这里）
 */
export interface MemoryPieces {
    /** 关系概况（ADR 0012）：放进 main 之后 */
    relationship?: string;
    /** 更早聊天的要点（ADR 0043） */
    summary?: string;
    /** 他的私人记忆 */
    recalled?: string;
    /** 她在 DSH 里做过的事（工作房，ADR 0176） */
    work?: string;
    /** 他刚才在 DSH 桌面上和她的对话（ADR 0177） */
    desktop?: string;
    /** 公共记忆（ADR 0016 / 0017，含沿用刚才想起的） */
    common?: string;
    /** 他问到的那一天她那边的流水账（ADR 0032，recapText 的结果） */
    recap?: string;
    /** 她今天和别人聊过的（ADR 0020） */
    today?: string;
    /** 他提到的名单里的人，一人一段（describePerson 的结果），按提到的先后 */
    people?: readonly string[];
}

export function memoryModule(): Module {
    return {
        id: 'memory',
        decideAt: {
            recall,
            // 他问到过去的某一天（ADR 0032）：那天她那边的事直接给，不靠日记召回（72 小时基线：问「周一快递拿了没」3/3 答还没拿，问「昨天下雨了吗」2/3 答没下）。
            // 原位（perceive 之后、assess 之前）调；那天的流水账由流水线按这一档的卡算好经 DecideCtx.recapOf 给（读世界账、日记）
            recap(turn, ctx) {
                const day = turn.facts.askedDay;
                const recap = day && !day.period ? ctx.recapOf?.(day.start, turn.at) : undefined;
                if (!recap) return;
                ctx.log(`想起那天：${recap.day}（${recap.lines.length} 件）`);
                turn.facts.recap = recap.text;
            },
            // 聊天原文放多少、要点，和这一组的收尾（ADR 0336「判断那一串」，2026-11-18）：联系人流水线在原位调（质感之后、清单之前），
            // 要点那一下会在后台起一次整理（contextWindow.summarize），照旧在这里。最终的字写进 turn.facts.memory，原文写进 facts.shown
            context(turn, ctx) {
                const { at: time, history: chat } = turn;
                const recentOnly = Boolean(ctx.context?.recentOnly);
                // 聊天原文只放最近几天的（ADR 0018 实现时的调整 12）：开了长期记忆的才这样，更早的靠记忆想；没有记忆的照旧全放
                let shown: { chat: ChatMessage[]; omitted: number } = recentOnly ? recentChat(chat, time) : { chat: chat as ChatMessage[], omitted: 0 };
                // ADR 0043（配置 contextTurns，默认关）：最近几轮原文 + 更早的要点，代替最近 80 条
                let summary: string | undefined;
                const window = ctx.context?.window;
                if (recentOnly && window) {
                    const lastDays = recentChat(chat, time, Infinity);
                    const cut = turnCut(lastDays.chat, window);
                    const state = cut > 0 ? window.summarize(lastDays.chat.slice(0, cut)) : { ready: true as const, text: undefined };
                    // 要点还在后台整理（或整理失败）：不等它，这一轮照旧最近 80 条，什么都不丢
                    if (state.ready) {
                        // 要点里她的名字换成「你」，和记忆一样（ADR 0018 决策 4）
                        summary = turn.card ? youFor(turn.card, ctx.context?.contacts ?? [])(state.text) : state.text;
                        shown = { chat: lastDays.chat.slice(cut), omitted: lastDays.omitted + cut };
                    }
                }
                // 想一想：最近的聊天换成一段“回想”放在说明里（modules/transcript.ts），原文清空
                if (turn.thinking) shown = { chat: [], omitted: 0 };
                turn.facts.shown = shown;
                const { relationship, recalled, work, desktop, common, today, people = [] } = turn.facts.recall ?? {};
                const memory: MemoryPieces = {
                    ...(relationship ? { relationship } : {}), ...(summary ? { summary } : {}), ...(recalled ? { recalled } : {}),
                    ...(work ? { work } : {}), ...(desktop ? { desktop } : {}), ...(common ? { common } : {}),
                    ...(turn.facts.recap !== undefined ? { recap: turn.facts.recap } : {}), ...(today ? { today } : {}), ...(people.length ? { people } : {}),
                };
                if (Object.keys(memory).length) turn.facts.memory = memory;
            },
        },
        contribute(turn) {
            const memory = turn.facts.memory;
            if (!memory) return [];
            const pieces: Piece[] = [];
            const put = (slot: Slot, text: string | undefined) => { if (text) pieces.push({ slot, text }); };
            put('relationship', memory.relationship);
            put('summary', memory.summary);
            put('recalled', memory.recalled);
            put('work', memory.work);
            put('desktop', memory.desktop);
            put('common', memory.common);
            put('recap', memory.recap);
            put('today', memory.today);
            // 迁移前一人一段、不按真假筛（describePerson 至少有「你认识的人」那一行）
            const people = memory.people ?? [];
            for (const text of people) pieces.push({ slot: 'people', text });
            if (memory.common || memory.today || people.length) pieces.push({ slot: 'disclosure', text: disclosureRules(turn.contact) });
            return pieces;
        },
    };
}
