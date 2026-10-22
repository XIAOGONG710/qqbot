// 一位联系人的回复流水线：召回长期记忆 → 按 ST 顺序拼提示词 → 后处理 → 生成 → 清理（含卡上的 ST 正则）→ 出口检查 → 拆条发送（responder.ts 调度）。
// 出口检查带上聊天记录里她最近几次回复和对方最近几条，查说话的毛病（ADR 0014，配置 speechCheck）。
// 她自己的日子（ADR 0015，配置 herDays）：时间块里状态行下面加今天的心情，聊到书或她正在看书时再加「在读的书」，那一轮出口检查顺带查进度数字。
// 她认识的人（ADR 0016）：他或她最近的话里提到名单里另一个人的称呼（那人写了「别人提起时」），召回之后放一段介绍。
// 记忆（ADR 0018）：召回会变淡，她和名单里的称呼不算「一提就想起」的线索；放进提示词的记忆里她的名字换成「你」。
// bot（main.ts）和模拟器（sim/）共用这一份；模拟器只换掉收发、时钟和数据目录（ADR 0005）。

import { dirname, join } from 'node:path';
import { UNLISTED_TIER, type AppConfig, type Contact, type Tier } from './config.ts';
import { disclosureRules, isClose, sourceLabel, startsConversation, todayStart } from './disclosure.ts';
import { faceContext, reviewCrisisReply, reviewReply, type ReviewOptions } from './exit-check.ts';
import type { ChatHistory, StoredMessage } from './history.ts';
import { chatCompletion } from './llm.ts';
import type { Log } from './log.ts';
import { CLEAR_DAYS, recentChat, type FadeStats } from './memory/fading.ts';
import { heardSinceReply, initiateQuery, PERSON_RECALLED, secondPerson, type LongTermMemory } from './memory/long-term.ts';
import { buildPrompt, type ChatMessage, type OpenAIMessage, type PromptResult } from './prompt.ts';
import { cleanUpReply } from './reply.ts';
import { createResponder, DEFAULT_SETTLE, RETRY_AFTER_MS, type Responder } from './responder.ts';
import { loadCharacterCard, type Character } from './st/card.ts';
import { postProcessPrompt } from './st/prompt-converters.ts';
import { loadWorldInfo, type WorldInfoEntry } from './st/world-info.ts';
import { isAckAfterClosing, moodySkip, replyDelays, whenSeen } from './reply-timing.ts';
import { describeMood, moodAt, readingActivities, readingSection } from './her-days.ts';
import { crisisInHistory, type CrisisHit } from './crisis.ts';
import { describeGrievance, grievanceNow, ignoredNow } from './grievance.ts';
import { describeIntent } from './intent.ts';
import { describeObstacles, meetupDays } from './obstacles.ts';
import { alreadyTold, describeLength, lengthHint, maybeTypo, ODD_BODY_WORDS, RECALL_SHARE, recentCrutches } from './expression.ts';
import { describeShape, planShape, shapeReply, type ShapePlan, type ShapeShares } from './shape.ts';
import { describeUnsettled } from './open-loops.ts';
import { describeWorld, recapDay, recentWith, unavailableAt, worldAt, worldNews, type WorldState } from './world.ts';
import { npcMentioned } from './npc.ts';
import { dayPlan, describePlans, describeSlot } from './day-plan.ts';
import { bodyAt, describeBody, diaryBody, unwell } from './body.ts';
import { asleepSince, saidBedtimes } from './bedtime.ts';
import { herStatus } from './status-line.ts';
import { describeWarmAffect, warmAffect } from './affect.ts';
import { withEveryday } from './everyday.ts';
import { describePursuits, pursuitViews, type Pursuit } from './pursuits.ts';
import { appraisals, asksAfterHer, criedRecently, describeFeelings, FEELING_NAME, feelingsAt, feelsLow, voicedKinds, type Felt, type Moment } from './feelings.ts';
import { describeRecentPhotography, projectActivity, recentPhotography } from './projects.ts';
import { describePast, pastCue } from './biography.ts';
import { askedWindow, ASKS_PAST, asksPast, commonCue, describePerson, holidayWords, lingering, mentionedPeople } from './people.ts';
import { describeAppointment, mentionsMeetup, type PromiseKeeper } from './promises.ts';
import { describeState, formatDate, herDay, partnerBackLine } from './schedule.ts';
import { speechContext, type BookProgressContext } from './speech-check.ts';
import { describePick, pickBest, PICKED_INTENTS, type PickRules } from './candidates.ts';
import { turnCut, type Summarizer, type TurnWindow } from './context-window.ts';
import { describeDays, describeTime } from './time-context.ts';
import { estimateTokens } from './tokens.ts';
import { describeInterruption, interruptionNow } from './interruption.ts';
import { jokeLine, type Joke } from './jokes.ts';
import { describeCloseness } from './relationship.ts';
import { describeTogether, togetherNow } from './together.ts';
import { photoAllowance, photoIntent, photoWanted, PHOTO_KINDS, type PhotoKind, type PhotoShelf } from './photos.ts';
import { imageStickerAllowance, stickerCued, stickerOnlyTurn, stickerTurn, stripStickerArtifacts, STICKER_TURN_CHANCE, type StickerShelf } from './stickers.ts';

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

/** 读一个档位的角色卡和它链接的世界书；pattern 是配置里的 characterCard（{tier} 换成档位名，承认版是「<档位>-open」，ADR 0067），世界书在同目录的 <world>.json */
export function loadTierCard(pattern: string, tier: string, options: { everydayLife?: boolean; everydayFrom?: string } = {}): TierCard {
    const path = pattern.replaceAll('{tier}', tier);
    const loaded = loadCharacterCard(path);
    // 补充的日常小事和小测（ADR 0106，配置 everydayLife）：代码里加进世界的“小事”块，不改角色卡
    const character = options.everydayLife && loaded.herWorld ? { ...loaded, herWorld: withEveryday(loaded.herWorld, tier, options.everydayFrom)! } : loaded;
    const worldInfo = character.world ? loadWorldInfo(join(dirname(path), `${character.world}.json`), character.world) : [];
    return { character, worldInfo };
}

/** 想一想时的“回想”：最近 14 条聊天，旧→新，带时刻；不是要接着回的对话 */
export function thinkingTranscript(chat: readonly ChatMessage[], userName: string): string | undefined {
    const recent = chat.slice(-14);
    if (!recent.length) return undefined;
    const stamp = (time?: string) => {
        const at = time ? new Date(time) : undefined;
        return at && !Number.isNaN(at.getTime()) ? `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} ` : '';
    };
    return `[回想一下你和${userName}最近的聊天（旧到新，这只是让你想起发生过什么，不是要你接着回）：\n${recent.map(m => `${stamp(m.time)}${m.role === 'user' ? '他' : '你'}：${m.content.replace(/\s+/g, ' ')}`).join('\n')}]`;
}

/**
 * 没回的这一串不回的原因（按作息时）：她已经收尾、对方只回了附和（ADR 0007 决策 7）；看心情不回（ADR 0013 决策 4）。要回就是 undefined。
 * 回复器和主动消息的计划器用同一个（看心情没回的那串不算「有没回的消息」）。chance 只给模拟器用
 */
export function replySkip(character: Character, moody: boolean, chance?: number): (history: StoredMessage[]) => string | undefined {
    // 危机回合（ADR 0068）：不因为「已经收尾」「看心情不回」不回
    return history => (crisisInHistory(history) ? undefined : isAckAfterClosing(history)
        ? '她已经收尾，对方只回了附和，不回'
        : moody ? moodySkip(history, character.pace, chance) : undefined);
}

export interface ContactPipelineOptions {
    contact: Contact;
    card: TierCard;
    /** 承认版的卡（ADR 0067）：危机回合（ADR 0068 决策 7）无论这个人知不知道她是程序，被问是不是真人都承认，所以这一轮换用它；本来就用承认版的、名单外的不用传 */
    openCard?: TierCard;
    llm: AppConfig['llm'];
    prompt: AppConfig['prompt'];
    history: Pick<ChatHistory, 'load' | 'append'>;
    /** 长期记忆；名单外的好友（unlisted 档）不用 */
    memory?: LongTermMemory;
    /** 整个名单（ADR 0016）：她认识名单里写了「别人提起时」的人；不传就谁都不认识 */
    contacts?: readonly Contact[];
    send: (userId: number, text: string) => Promise<number>;
    /** 她打字的这段时间让对方那边显示「正在输入…」（ADR 0077，配置 typingStatus）；不给就不显示 */
    typing?: (userId: number) => void;
    /** 撤回自己发出去的一条（配置 selfRecall，ADR 0086）：打错字改口的，一部分改成撤回重发；不给就一律补一条「*对的词」 */
    recallOwn?: (messageId: number) => Promise<void>;
    /** 她看到他的消息的那一刻标已读 / 看到了不回时给他最后一条点表情回应（ADR 0083，配置 readReceipts / reactions）；不给就不做 */
    markRead?: (userId: number) => void;
    /** 提示词时间块里「她在 QQ 上的样子」那一行（签名、最近发的说说，ADR 0083）；不给就没有 */
    selfNote?: (now: number) => string | undefined;
    react?: (userId: number, messageId: number, text: string) => void;
    /** 图片表情收藏：给模型列可选编号、校验输出；实际发送由 app.ts 的 send 接线。 */
    stickers?: StickerShelf;
    /** 照片货架（ADR 0109，配置 photos）：他要看土豆 / 风景 / 她的片子时，货架里有就发；只对男朋友档 */
    photos?: PhotoShelf;
    /** 允许发图片表情的轮次里抽中发的概率（默认 STICKER_TURN_CHANCE；模拟器场景可以调高来测）*/
    stickerChance?: number;
    /** 抽到发表情的轮次里只发表情不写文字的概率（不写 = 0，不开；app.ts 在 shapeFeel 开着时给 STICKER_ONLY_SHARE；模拟器场景可以调来测，ADR 0099） */
    stickerOnlyChance?: number;
    /** 不带联系人前缀，这里会加上 [QQ 号] */
    log: Log;
    /** 每次生成前拿到后处理之后、实际发给模型的提示词 */
    onPrompt?: (prompt: PromptResult) => void;
    /** 能不能把聊天正文写进日志（ADR 0070 第 8 项）；不传就不写 */
    sensitive?: () => boolean;
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
    promises?: Pick<PromiseKeeper, 'describe'> & Partial<Pick<PromiseKeeper, 'available' | 'openLoops' | 'appointmentsAt' | 'appointmentsBetween'>>;
    /** W3：所有联系人、日记和主动消息共用的一份世界动作。 */
    worldState?: Pick<WorldState, 'at'> & Partial<Pick<WorldState, 'events'>>;
    /** ADR 0056：三天内课程作业可以接管空闲安排；执行器与状态行共用。 */
    projectChoice?: boolean;
    /** 生活账接进提示词的第一步（配置 lifeInPrompt）：她这几天练拍照修图，只给看得到她爱好的档位（卡上有相机基金的） */
    lifeInPrompt?: boolean;
    /** 回复节奏（ADR 0075，配置 rhythm）：打字时间按字数、回之前有「看 + 想」；不开就是上线前的老样子（0.8 秒 + 每字 0.1 秒） */
    rhythm?: boolean;
    /** 更短的回复（ADR 0024 的 10-19 调整，配置 shortReplies）：回很短的概率 0.5、认真接话的轮次让路、新措辞；不开就是上线前的老样子（0.35、老措辞） */
    shortReplies?: boolean;
    /** 形状控制（配置 shape）：按他这一轮的长短定她每条最多几个字、最多几条，超了重写 / 截断；开了就不用 shortReplies 的软提示（ADR 0091） */
    shape?: boolean;
    /** 带自己的小事（配置 shapeAgenda，要 shape 开着）：适用的轮次里约五分之一，答完他的话再从“你那边”里挑一件自己的事说一句（ADR 0094） */
    shapeAgenda?: boolean;
    /** 各种形状轮次的占比（调参用，模拟器的场景里设；线上不用，用 shape.ts 的常量） */
    shapeShares?: ShapeShares;
    /** 废话（配置 shapeFiller，要 shape 开着）：适用的轮次里约 7% 只回一条笑 / 应声 / 拖音 / 叹一句状态，他拖音时她也跟着拖（ADR 0095） */
    shapeFiller?: boolean;
    /** 情绪轮（配置 shapeFeel，要 shape 开着）：适用的轮次里约 18% 先说自己对他的小情绪，不把他的话处理完整（ADR 0099） */
    shapeFeel?: boolean;
    /** 她最近心里在想什么（ADR 0101，配置 innerLife）：放进提示词的一行；没有就没有。主动找他、危机回合不放 */
    innerLine?: () => string | undefined;
    /** 心境（ADR 0102，配置 herFeelings）：她那边的事、他的态度、作者写下的事，在她心里留下带来由的感受（开心 / 难过 / 担心……），会慢慢散；只给男朋友档，危机回合不放 */
    herFeelings?: boolean;
    /** 陪玩状态（ADR 0111）：他答应了她的邀约（或她答应了他的）之后两三个小时，她正和他一起玩：回话短、聊局里的事；只对男朋友档 */
    together?: boolean;
    /** 关系阶段（ADR 0113）：最近 30 天里有 14 天以上真聊过，她更放得开一点；只对男朋友档 */
    relationship?: boolean;
    /** 吃醋，最轻的一档（ADR 0123）：他提到别的女生时嘴上不承认的别扭，不盘问、不要保证、不限制他；只对男朋友档 */
    jealousy?: boolean;
    /** 被第三方打断（ADR 0115）：聊着聊着她那边发生了一件小事（世界账里有时刻的），当场岔一下；只对男朋友档 */
    interruptions?: boolean;
    /** 小梗（ADR 0114）：他们之间聊天里反复出现的玩笑；约 1/4 的轮次给她看一个，话赶话接得上就顺口提；只对男朋友档 */
    jokes?: () => readonly Joke[];
    /** 作者写下的、引起她情绪的事（ADR 0102，runtime/bot/moments.json）；每次生成现取 */
    moments?: () => readonly Moment[];
    /** 她自己的追求（ADR 0104，配置 pursuits）：内置两条（别挂科、用新相机拍出满意的东西）加作者在 pursuits.json 里改的 / 加的；每次生成现取 */
    pursuits?: () => readonly Pursuit[];
    /** 她每天碰到的小事（ADR 0106，配置 everydayLife；卡在 loadTierCard 里补）：他问“今天干嘛了 / 有什么好玩的事”时让她从今天的小事里挑具体的说 */
    everydayLife?: boolean;
    /** 回复延迟的长尾（ADR 0105，配置 lagTail）：醒着空着时有一部分消息她在做别的，过一会儿才看到；断网很久之后才回，时间块里写一句 */
    lagTail?: boolean;
    /** 会拒绝（ADR 0103，配置 herNo）：她刚推了他、他在磨她时别被磨两句就答应；他在管着她（不许 / 听到没）时不顺着说“都听你的”。只给男朋友档 */
    herNo?: boolean;
    /** 分成几条（配置 shapeSplit，要 shape 开着）：把形状里抽出的条数当目标写进提示词，不只是上限（ADR 0096） */
    shapeSplit?: boolean;
    /** 有起因的小别扭与和好（ADR 0074，配置 grievance）：他隔了 ≥ 3 天才来、她发的一直没回时，头一两轮淡一点；只给男朋友档 */
    grievance?: boolean;
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
    /**
     * 开了长期记忆时原始聊天只放最近几轮、更早的整理成要点（ADR 0043 离线实验，只有模拟器传）。
     * 不传是最近 80 条（ADR 0036 决策 3），线上不传
     */
    contextWindow?: TurnWindow & { summarize: Summarizer };
}

/** 问到过去的某一天时，几天以内她那边的事还记得清楚（ADR 0032，同 ADR 0018 的 7 天） */
export const RECAP_DAYS = 7;

export function createContactResponder(options: ContactPipelineOptions): Responder {
    const { contact, card: { character, worldInfo }, llm, memory } = options;
    const names = { user: contact.name, char: character.name };
    const now = options.now ?? Date.now;
    const log: Log = message => options.log(`[${contact.qq}] ${message}`);
    const generate = options.generate ?? ((messages, log) => chatCompletion(llm, messages, { log }));
    let stickersAllowed = true;
    /** 这一轮抽到要发图片表情，并带上他这一轮说的话（给货架按它挑）；没抽到就不给她看货架 */
    let stickerContext: { text: string; only?: boolean } | undefined;
    /** 这一轮只发表情、不写文字（ADR 0099）：模型多写了文字就去掉，只留那一行表情；它没写表情就照它写的发 */
    let stickerOnlyNow = false;
    /** 这一轮发哪一类照片（ADR 0109）：他要看、货架里有、允许发才有；没有就一律清掉模型写的照片指令 */
    let photoNow: PhotoKind | undefined;
    const clean = (reply: string) => {
        const text = cleanUpReply(reply, names, character.regexScripts);
        const stickered = options.stickers?.clean(text, stickersAllowed) ?? stripStickerArtifacts(text);
        const cleaned = options.photos ? options.photos.clean(stickered, photoNow !== undefined) : stickered;
        if (!stickerOnlyNow) return cleaned;
        const only = cleaned.split('\n').map(line => line.trim()).filter(line => /^<sticker:[a-f0-9]{12}>$/i.test(line));
        return only.length ? only.join('\n') : cleaned;
    };
    const schedule = options.schedule ? character.schedule : undefined;
    const herSchedule = options.herDays ? character.schedule : undefined;
    // 她说过「睡了」（ADR 0042）：对名单里谁说的都算，从说完那一刻起在睡——各个联系人看到的是同一个她（状态行、什么时候看到消息）
    const everyone = [contact.qq, ...(options.contacts ?? []).map(other => other.qq).filter(qq => qq !== contact.qq)];
    const asleepAt = (time: Date) => (schedule
        ? asleepSince(schedule, saidBedtimes(everyone.map(qq => options.history.load(qq)), schedule, time.getTime() - DAY_MS), time)
        : undefined);
    const extraFree = herSchedule ? readingActivities(character.books) : [];
    // 这一轮放了「在读的书」时，出口检查拿它核对进度数字。同一个回复器一次只生成一条，review 紧跟着这一轮的 buildPrompt
    let reading: BookProgressContext | undefined;
    // 这一轮要不要挑候选（ADR 0041）：buildPrompt 按意图行定，紧跟着的 generate 用
    let pick: PickRules | undefined;
    // 亲密轮次的出口检查：只在男朋友明确要抱抱、亲亲等时，拦“只能当面 / 隔空不算”把文字回应收回。
    let textIntimacy = false;
    // 这一轮是不是危机回合（ADR 0068）：buildPrompt 按他发的内容定，紧跟着的出口检查、打错字、长短都按它
    let crisisNow: CrisisHit | undefined;
    /** 这一轮是小别扭（不是和好）：出口检查放过「隔了很多天才来」这类带点抱怨的话（ADR 0074） */
    let sulkNow = false;
    /** 这一轮的形状（配置 shape）：buildPrompt 按他说的长短定，紧跟着的出口检查按它强制执行；主动找他、收尾、危机回合没有 */
    let shapeNow: ShapePlan | undefined;
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
        lines.push(...dayPlan(herSchedule, character.herWorld.plans, dayStart, { rain: then.weather?.rain, ...(then.weather?.rainHours ? { rainHours: then.weather.rainHours } : {}), body: bodyThen, homework: then.homework }, extraFree)
            .filter(slot => slot.done !== slot.planned).map(describeSlot));
        if (!lines.length) return undefined;
        const day = `${dayStart.getMonth() + 1}月${dayStart.getDate()}日 ${'日一二三四五六'.split('').map(d => `周${d}`)[dayStart.getDay()]}`;
        return { day, lines, text: `[那天（${day}）你那边的流水账（你自己过的，都是真的：他问到具体的事——下没下雨、喂没喂猫、快递拿没拿——照这个说，别说错；泛泛问那天干了什么时，先说上面记得住的事，这里的不用一件件报）：${lines.join('；')}]` };
    };
    return createResponder({
        userId: contact.qq,
        history: options.history,
        buildPrompt: async (chat, { woken, initiate, offlineSince }) => {
            const time = new Date(now());
            // 只想一想（ADR 0101 内心）：不是在聊天，不要意图行、形状、字数提示、表情；聊天记录当成“回想”放进说明里，不当成要接着回的对话
            const thinking = Boolean(initiate?.think);
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
            if (herSchedule) options.onHerDay?.(time);
            // 她那边（ADR 0021）：跟着「她自己的日子」开，卡上有世界才有
            const around = herSchedule && character.herWorld
                ? options.worldState?.at(character.herWorld, herSchedule, time) ?? worldAt(character.herWorld, herSchedule, time)
                : undefined;
            // 别人给的钱（买相机，ADR 0053 调整）：正在聊的人给的写他的称呼（写「对方」她照抄成「对方给的2000」），男朋友给的跟别人说是「男朋友」
            const giver = (qq: number) => {
                if (qq === contact.qq) return contact.name;
                const other = (options.contacts ?? []).find(c => c.qq === qq);
                return other ? (other.tier === 'boyfriend' ? '男朋友' : other.name) : undefined;
            };
            const world = around ? describeWorld(around, time, giver) : undefined;
            const practiced = options.lifeInPrompt && character.herWorld?.cameraFund && options.worldState?.events ? recentPhotography(options.worldState.events(), time, 3, herSchedule) : undefined;
            const practice = practiced ? describeRecentPhotography(practiced, time, herSchedule) : undefined;
            const selfNote = options.selfNote?.(time.getTime());
            // 他问到过去的某一天（ADR 0032）：那天她那边的事直接给，不靠日记召回（72 小时基线：问「周一快递拿了没」3/3 答还没拿，问「昨天下雨了吗」2/3 答没下）
            const recap = day && !day.period ? recapOf(day.start, time) : undefined;
            if (recap) log(`想起那天：${recap.day}（${recap.lines.length} 件）`);
            // 她的身体（ADR 0025）：同样跟着「她自己的日子」，卡上有才有
            const bodyNow = herSchedule && character.herWorld?.body ? bodyAt(character.herWorld.body, herSchedule, time) : undefined;
            // 状态行（status-line.ts，模拟器的状态行影子比对用同一个函数，ADR 0042）：作息 → 说过「睡了」就在睡 →
            // 空闲时世界里有时长的事（ADR 0030）→ 一天的打算改了的写「本来打算 X，Y，Z」（ADR 0034）
            const asleep = schedule ? asleepAt(time) : undefined;
            // 约好的见面（ADR 0047）：和这个人约的优先；和别人约的只说在外面、约了人
            const meetings = contact.tier !== UNLISTED_TIER ? options.promises?.appointmentsAt?.(time) ?? [] : [];
            const meeting = meetings.find(m => m.contact.qq === contact.qq) ?? meetings[0];
            const appointment = meeting ? describeAppointment(meeting, contact, time) : undefined;
            const status = schedule ? herStatus(schedule, time, {
                extraFree, ...(around ? { world: around } : {}), ...(asleep ? { asleep } : {}), ...(appointment ? { appointment } : {}),
                ...(herSchedule ? { plans: { plans: character.herWorld?.plans, ...(bodyNow ? { body: bodyNow } : {}) } } : {}),
                ...(options.projectChoice && options.worldState?.events
                    ? { projectChoice: { events: options.worldState.events(), books: character.books } }
                    : {}),
            }) : undefined;
            if (status?.saidAsleep) log(`她 ${status.saidAsleep.since.toTimeString().slice(0, 5)} 说过睡了：状态行按在睡觉`);
            if (status?.busy) log(`此刻在做：${status.busy}`);
            if (status?.revised) log(`改了打算：${status.revised}`);
            const state = status?.state;
            const partnerBack = state ? partnerBackLine(state, contact.name) : undefined;
            const plansLine = herSchedule ? describePlans(herSchedule, status?.slots ?? [], time) : undefined;
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
            // 他提到见面（ADR 0066 决策 2）：她那几天不方便的时段（有课、赶作业、身体不舒服、已经约了别的），只给事实，是否推、怎么说由她定；先只给男朋友档
            const obstacleLine = contact.tier === 'boyfriend' && !initiate && herSchedule && mentionsMeetup(chat)
                ? options.promises?.available?.() === false
                    ? '约定来源暂不可确认：不能认定没有别的约或编造空闲时段，涉及约见先确认；不要把内部状态或错误信息说给对方。'
                    : describeObstacles(meetupDays(chat.slice(-8).map(m => m.content).join('\n'), herDay(herSchedule, time), time), time, {
                    schedule: herSchedule,
                    ...(character.herWorld ? { worldAt: (at: Date) => options.worldState?.at(character.herWorld!, herSchedule, at) ?? worldAt(character.herWorld!, herSchedule, at) } : {}),
                    ...(character.herWorld?.body ? { bodyAt: (at: Date) => bodyAt(character.herWorld!.body!, herSchedule, at) } : {}),
                    // 和这个人约的不算「约了别的」：那是他们两个的约，时间块里别处（答应的事、状态行）已经写了
                    ...(options.promises?.appointmentsBetween ? { appointments: (from: Date, to: Date) => options.promises!.appointmentsBetween!(from, to).filter(a => a.contact.qq !== contact.qq) } : {}),
                })
                : undefined;
            if (obstacleLine) log('他提到见面：时间块里列了她这几天不方便的时段');
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
            // 她那边的事还没说过（ADR 0057 调整）：她的今天了结的、那之后她一句话都还没说过（主动那条发出去了也算说过）——这一轮顺带说。先只给男朋友档
            const untold = around && herSchedule && contact.tier === 'boyfriend' && !initiate
                ? worldNews(around).filter(n => n.at <= time && formatDate(herDay(herSchedule, n.at)) === around.day
                    && !chat.some(m => m.role === 'assistant' && m.time !== undefined && Date.parse(m.time) >= n.at.getTime())).map(n => n.what)
                : [];
            if (untold.length) log(`她那边的事还没跟他说过：${untold.join('、')}`);
            // 危机信号（ADR 0068）：纯函数检测，最高优先级；主动找他时不算
            crisisNow = !initiate ? crisisInHistory(chat) : undefined;
            if (crisisNow) log(`危机信号：按 ${crisisNow.level} 级辅助响应处理（日志不记内容）`);
            // 小别扭 / 和好（ADR 0074）：从聊天记录的时间戳重算，不落盘；危机、主动找他、非男朋友档都不算
            // 起因有两种：隔了好几天才来（grievanceNow），或者她倾诉了几条、他隔了很久才回（ignoredNow，10-20）
            const grievance = options.grievance && contact.tier === 'boyfriend' && !initiate && !crisisNow ? (grievanceNow(chat) ?? ignoredNow(chat)) : undefined;
            const baseIntent = thinking ? undefined : describeIntent({
                history: chat,
                state,
                schedule: schedule ?? herSchedule,
                now: time,
                promised: Boolean(promised),
                books: Boolean(books),
                initiating: Boolean(initiate),
                ...(options.herNo ? { refuse: true } : {}),
                ...(options.jealousy ? { jealous: true } : {}),
                ...(options.everydayLife && around?.events.length ? { dayThings: true } : {}),
                ...(options.pursuits && state?.activity.kind === 'free' && projectActivity(state.activity.text) ? { pursuitDoing: projectActivity(state.activity.text)!.step } : {}),
                waiting: loops?.waiting.map(l => l.what),
                unanswered: loops?.unanswered.map(l => l.what),
                intimate: contact.tier === 'boyfriend',
                playful: contact.tier === 'boyfriend',
                ...(crisisNow ? { crisis: crisisNow.level, ...(crisisNow.awaitingSafe ? { crisisAwaitingSafe: true } : {}) } : {}),
                ...(grievance ? { grievance } : {}),
                ...(untold.length ? { news: untold } : {}),
            });
            // 照片（ADR 0109）：他明确要看土豆 / 风景 / 她的片子，货架里有这一类，允许发（没连着发、今天没发够、不是危机 / 吵醒 / 小别扭 / 他难过），就发；
            // 没有明确对象（只说“发张照片”）取手上有的第一类；要的是她本人（自拍）不在货架里，照旧走“先不发”
            photoNow = undefined;
            if (options.photos && contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievance && !(baseIntent && /先接住他此刻的情绪/.test(baseIntent))) {
                const wanted = initiate ? initiate.photo : photoWanted(chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n'));
                const kind = wanted === 'any' ? PHOTO_KINDS.find(k => options.photos!.has(k)) : wanted;
                if (kind && options.photos.has(kind)) {
                    const allowance = photoAllowance(chat, time.getTime(), false, Boolean(woken));
                    if (allowance.allowed) { photoNow = kind; log(`照片货架：他想看${kind}，货架里有，这一轮发一张`); }
                    else log(`照片货架：这一轮不发（${allowance.reason}）`);
                }
            }
            // 陪玩（ADR 0111）：从聊天记录往回推，答应邀约之后的两三个小时；危机回合、主动找他的那条不算
            const togetherState = options.together && contact.tier === 'boyfriend' && !initiate && !crisisNow ? togetherNow(chat, time.getTime()) : undefined;
            const togetherLine = togetherState ? describeTogether(togetherState, time.getTime()) : undefined;
            if (togetherState) log(`陪玩：他们正一起${togetherState.activity === 'wzry' ? '打王者' : togetherState.activity === 'minecraft' ? '玩我的世界' : '玩游戏'}（从答应起 ${Math.round((time.getTime() - togetherState.since) / 60_000)} 分钟）`);
            // 关系阶段（ADR 0113）：聊得多了更放得开；危机回合、小别扭、她在想事情（think）时不加
            const closenessLine = options.relationship && contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievance ? describeCloseness(chat, time.getTime()) : undefined;
            if (closenessLine) log('关系：最近几乎天天在聊，她更放得开一点（提示词里多一行）');
            // 被打断（ADR 0115）：聊天正在进行时，世界账里她那边恰好发生了一件小事；他难过 / 危机 / 小别扭 / 主动找他 / 她在想事情时不加
            const interruption = options.interruptions && around && contact.tier === 'boyfriend' && !initiate && !thinking && !crisisNow && !grievance && !(baseIntent && /先接住他此刻的情绪/.test(baseIntent))
                ? interruptionNow(around.events, chat, time.getTime()) : undefined;
            const interruptLine = interruption ? describeInterruption(interruption) : undefined;
            if (interruptLine) log('被打断：聊着的时候她那边发生了一件小事（提示词里多一行；日志不记内容）');
            // 小梗（ADR 0114）：他难过 / 危机 / 小别扭 / 主动找他 / 她在想事情时不给；日志不记梗的内容
            const jokeNow = options.jokes && contact.tier === 'boyfriend' && !initiate && !thinking && !crisisNow && !grievance && !(baseIntent && /先接住他此刻的情绪/.test(baseIntent))
                ? jokeLine(options.jokes(), chat, time.getTime()) : undefined;
            if (jokeNow) log('小梗：这一轮提示词里放了一个他们之间的梗（日志不记内容）');
            // 主动发的那条（喂完土豆拍的）意图在 initiate.note 里，这里不再加“他想看”的意图行
            // 被打断的这一轮（ADR 0115）：不带“先直接回答他刚问的”这类意图、不套形状 / 长短提示——它们和“先接他的话、顺带说一声刚被什么岔了一下”冲突，模型会按更紧的那条来、把打断吞掉（模拟 5/5 没提）
            const intent = photoNow && !initiate ? photoIntent(photoNow) : interruptLine ? undefined : baseIntent;
            const grievanceActive = Boolean(grievance && intent === describeGrievance(grievance));
            sulkNow = grievanceActive && grievance!.stage === 'sulk';
            if (grievanceActive) log(grievance!.cause === 'ignored'
                ? '小别扭：她倾诉了几条他隔了很久才回（他回来后第一轮；日志不记内容）'
                : `${grievance!.stage === 'makeup' ? '和好' : '小别扭'}：他隔了 ${grievance!.days} 天才来（他回来后第 ${grievance!.round + 1} 轮；日志不记内容）`);
            if (intent) log(`这一轮有意图：${intent.slice('[这一轮你想：'.length, -1)}`);
            // 前一天的世界（到那天结束）：小测出分这类事第二天她还记着（ADR 0106）；只在开了心境时算
            // 她自己的追求（ADR 0104）：进度只来自她做过的事（生活账里的摄影）和出分的小测
            const pursuitList = options.pursuits && contact.tier === 'boyfriend' && herSchedule ? options.pursuits() : [];
            const pursuitViewsNow = pursuitList.length && herSchedule
                ? pursuitViews(pursuitList, { now: time, schedule: herSchedule, quizzes: Boolean(options.everydayLife), ...(character.herWorld?.everydayFrom ? { quizFrom: character.herWorld.everydayFrom } : {}), ...(options.worldState?.events ? { events: options.worldState.events() } : {}), ...(around ? { world: around } : {}) })
                : [];
            const pursuitLine = describePursuits(pursuitViewsNow);
            const previousAround = options.herFeelings && herSchedule && character.herWorld && contact.tier === 'boyfriend'
                ? (() => {
                    const end = new Date(herDay(herSchedule, time).getTime() - 60_000);
                    return options.worldState?.at(character.herWorld!, herSchedule, end) ?? worldAt(character.herWorld!, herSchedule, end);
                })()
                : undefined;
            // 心境（ADR 0102）：事实 → 带来由的评估 → 按半衰期衰减的感受，不落盘、每一轮重算；只给男朋友档，危机回合不算；小别扭 / 和好那一轮由 0074 的态度管，不叠
            const feltNow: Felt[] = options.herFeelings && contact.tier === 'boyfriend' && !crisisNow
                ? feelingsAt(appraisals({ now: time.getTime(), history: chat, ...(around ? { world: around } : {}), ...(previousAround ? { previousWorld: previousAround } : {}), moments: options.moments?.() ?? [], extra: pursuitViewsNow.flatMap(view => view.appraisals) }), time.getTime())
                : [];
            const hisWords = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
            const feelingLine = feltNow.length && !grievanceActive
                ? describeFeelings(feltNow, contact.name, { melt: asksAfterHer(hisWords), voiced: voicedKinds(chat, time.getTime()), mayCry: !criedRecently(chat, time.getTime()) })
                : undefined;
            if (feelingLine) log(`心境：${feltNow.filter(item => item.level !== 'faint').slice(0, 2).map(item => `${FEELING_NAME[item.kind]}·${item.level === 'strong' ? '很重' : '明显'}（${item.source === 'world' ? '她那边的事' : item.source === 'him' ? '他的态度' : '作者写下的事'}）`).join('、')}（日志不记内容）`);
            textIntimacy = Boolean(intent?.includes('QQ 文字里的抱抱'));
            const picked = (options.candidates ?? 1) > 1 && intent && !initiate ? PICKED_INTENTS.find(p => p.pattern.test(intent)) : undefined;
            const stickerAllowance = options.stickers && !thinking ? imageStickerAllowance(chat, intent, Boolean(woken), crisisNow?.level) : { allowed: false };
            stickersAllowed = stickerAllowance.allowed && !photoNow;
            const saidNow = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
            stickerOnlyNow = stickersAllowed && stickerCued(saidNow) && stickerTurn(chat, options.stickerChance ?? STICKER_TURN_CHANCE) && stickerOnlyTurn(chat, options.stickerOnlyChance ?? 0);
            stickerContext = stickersAllowed && stickerCued(saidNow) && stickerTurn(chat, options.stickerChance ?? STICKER_TURN_CHANCE) ? { text: saidNow, ...(stickerOnlyNow ? { only: true } : {}) } : undefined;
            if (stickerContext) log(stickerOnlyNow ? '图片表情：这一轮抽到只发表情、不写文字' : '图片表情：这一轮抽到要发一个');
            if (options.stickers && !thinking && !stickersAllowed) log(`图片表情：这轮不用（${stickerAllowance.reason}）`);
            pick = picked ? {
                kind: picked.kind, maxLines: picked.maxLines, heard: heardSinceReply(chat), banned: [...character.banned, ...ODD_BODY_WORDS],
                // 她自己生活里的东西：猫、相机、在读的书、手上的爱好（DSH 诊断 1.2、ADR 0036 的四类）
                own: [...(around?.cat ? [around.cat.name] : []), '相机', ...character.books.map(book => book.title), '追剧', '调色', '构图', '修片', '摄影区'],
                ...(options.speechCheck ? { speech: speechContext(options.history.load(contact.qq)) } : {}),
            } : undefined;
            // 长短不一（ADR 0024）：偶尔回句短的、偶尔话多一点；心情安静的日子不加「话多」
            const low = mood?.mood.name === '安静' || (bodyNow ? unwell(bodyNow) : false) || (feelingLine !== undefined && feelsLow(feltNow));
            // 形状控制开着：用具体的字数和条数代替「回短一点」的软提示；不适用的轮次（他明着让她讲、主动找他、收尾）照旧走 lengthHint
            // 她这一天半里已经主动说过的事（ADR 0098）；带自己的事的轮次从她还没说过的事里挑一件说
            const told = !crisisNow ? alreadyTold(chat, time.getTime()) : [];
            const TOLD_LABEL: Record<string, RegExp> = { 相机: /相机/, 猫: /土豆|猫/, 作业: /作业/, 快递: /快递/ };
            const worldLabels = world ? world.replace(/^\[你那边（[^）]*）：/, '').replace(/\]$/, '').split('｜').map(item => item.split('：')[0]!.trim()).filter(Boolean) : [];
            const agendaTopics = [
                ...worldLabels.filter(label => !told.some(name => TOLD_LABEL[name]?.test(label))),
                ...(body && !told.includes('肚子不舒服') ? ['身体'] : []),
                ...(mood ? ['心情'] : []),
            ];
            shapeNow = options.shape && !crisisNow && !stickerOnlyNow && !photoNow && !interruptLine && !thinking ? planShape({ history: chat, intent, initiating: Boolean(initiate), low, aboutPerson: npcs.length > 0, agenda: options.shapeAgenda, filler: options.shapeFiller, feel: options.shapeFeel, split: options.shapeSplit, agendaTopics, ...(options.shapeShares ? { shares: options.shapeShares } : {}) }) : undefined;
            // 她最近几条里反复在说的字词（10-22 深夜测试：被追问时原地打转、同一件事说三个晚上）：这一轮提醒她换个反应；主动找他、危机回合不用
            const crutches = !initiate && !crisisNow ? recentCrutches(chat) : [];
            const crutchLine = crutches.length
                ? `[你这几条里反复在说「${crutches.join('」「')}」：这一轮别再用这几个字，换个反应——直接答、逗他、反问、认怂、生气都行]`
                : undefined;
            if (crutchLine) log(`最近反复说的字词：${crutches.join('、')}（提示词里让她换个反应）`);
            // 说过了就不再自己提（ADR 0098）：事实还在时间块里，他问起来照常答
            const toldLine = told.length && !thinking ? `[这些事你已经主动跟他说过了：${told.join('、')}。他不问，就别再自己提]` : undefined;
            if (toldLine) log(`已经主动说过：${told.join('、')}（提示词里让她不再自己提）`);
            // 她最近心里在想的（ADR 0101）：前后是同一个在想事情的人
            const innerNow = !initiate && !crisisNow ? options.innerLine?.() : undefined;
            if (innerNow) log('内心：这一轮提示词里放了她最近的念头');
            const length = crisisNow || shapeNow || stickerOnlyNow || photoNow || interruptLine || thinking ? undefined : lengthHint({ history: chat, intent, initiating: Boolean(initiate), low, aboutPerson: npcs.length > 0, shortReplies: options.shortReplies });
            if (length) log(`这一轮说话：${length === 'short' ? '回句短的' : '话多一点'}`);
            if (shapeNow) log(`这一轮形状：每条不超过 ${shapeNow.cap} 字、最多 ${shapeNow.maxBubbles} 条（${shapeNow.kind}${shapeNow.agenda ? `，带自己的事${shapeNow.agendaTopic ? `：${shapeNow.agendaTopic}` : ''}` : ''}${shapeNow.filler ? '，废话' : ''}${shapeNow.feel ? '，先说小情绪' : ''}${shapeNow.stretch ? '，跟着拖音' : ''}${shapeNow.drawl ? '，语气松一点' : ''}${shapeNow.parts ? `，分 ${shapeNow.parts} 条` : ''}）`);
            // 聊天原文只放最近几天的（ADR 0018 实现时的调整 12）：开了长期记忆的才这样，更早的靠记忆想；没有记忆的照旧全放
            let shown = remembers ? recentChat(chat, time) : { chat, omitted: 0 };
            // 想一想：最近的聊天换成一段“回想”放在说明里（不留成对话回合，免得模型把它当成要接着回的话）
            const transcript = thinking ? thinkingTranscript(chat, contact.name) : undefined;
            // ADR 0043（配置 contextTurns，默认关）：最近几轮原文 + 更早的要点，代替最近 80 条
            let summary: string | undefined;
            if (remembers && options.contextWindow) {
                const lastDays = recentChat(chat, time, Infinity);
                const cut = turnCut(lastDays.chat, options.contextWindow);
                const state = cut > 0 ? options.contextWindow.summarize(lastDays.chat.slice(0, cut)) : { ready: true as const, text: undefined };
                // 要点还在后台整理（或整理失败）：不等它，这一轮照旧最近 80 条，什么都不丢
                if (state.ready) {
                    // 要点里她的名字换成「你」，和记忆一样（ADR 0018 决策 4）
                    summary = you(state.text);
                    shown = { chat: lastDays.chat.slice(cut), omitted: lastDays.omitted + cut };
                }
            }
            if (thinking) shown = { chat: [], omitted: 0 };
            // 危机回合被问是不是真人 / 程序一律承认（ADR 0068 决策 7）：换用承认版的卡，不在运行时叠一条覆盖（ADR 0003 / 0067 的纪律）
            // 想一想的时候卡末尾那句“只输出你要发出去的消息：不写心理活动”正好和要求相反，这一次去掉（只有内心用）
            const turnCard = crisisNow && options.openCard ? options.openCard : thinking ? { character: { ...character, postHistoryInstructions: '' }, worldInfo } : { character, worldInfo };
            const prompt = buildPrompt({
                character: turnCard.character,
                worldInfo: turnCard.worldInfo,
                history: shown.chat,
                userName: contact.name,
                userPersona: contact.persona,
                afterMain: relationship ? [relationship] : [],
                afterHistory: [
                    ...(summary ? [summary] : []),
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
                        describeTime(chat, time, { initiating: Boolean(initiate), ...(options.lagTail && offlineSince !== undefined ? { offlineSince } : {}) }),
                        ...(days ? [days] : []),
                        ...(state ? [describeState(state, schedule!, { userName: contact.name, woken, partnerApart: true })] : []),
                        // 心里压着事 / 特别开心的时候，按日期抽的底色（爱笑、话痨……）会和心境打架：以心境为准（ADR 0102）
                        ...(mood && !(feelingLine !== undefined && (feelsLow(feltNow) || feltNow.some(item => item.kind === 'joy' && item.level === 'strong'))) ? [describeMood(mood, contact.name)] : []),
                        ...(body ? [body] : []),
                        ...(unsettled ? [unsettled] : []),
                        ...(warm ? [warm] : []),
                        ...(feelingLine ? [feelingLine] : []),
                        ...(books ? [books.text] : []),
                        ...(world ? [world] : []),
                        ...(practice ? [practice] : []),
                        ...(pursuitLine ? [pursuitLine] : []),
                        ...(selfNote ? [selfNote] : []),
                        ...(plansLine ? [plansLine] : []),
                        ...(promised ? [promised] : []),
                        ...(obstacleLine ? [obstacleLine] : []),
                        // 放完假他已经回学校了（ADR 0007 调整）：放在事实的最后、离他最新的话最近，免得她信聊天记录里假期中的「我在青岛」
                        ...(partnerBack ? [partnerBack] : []),
                        ...(togetherLine ? [togetherLine] : []),
                        ...(closenessLine ? [closenessLine] : []),
                        ...(jokeNow ? [jokeNow] : []),
                        ...(interruptLine ? [interruptLine] : []),
                        ...(stickerContext && options.stickers?.prompt(stickerContext) ? [options.stickers.prompt(stickerContext)!] : []),
                        ...(photoNow && options.photos?.prompt(photoNow) ? [options.photos.prompt(photoNow)!] : []),
                        ...(intent ? [intent] : []),
                        ...(length ? [describeLength(length, options.shortReplies)] : []),
                        ...(shapeNow ? [describeShape(shapeNow)] : []),
                        ...(crutchLine ? [crutchLine] : []),
                        ...(toldLine ? [toldLine] : []),
                        ...(innerNow ? [innerNow] : []),
                        ...(transcript ? [transcript] : []),
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
                ...(crisisNow ? { maxBubbles: 3 } : ((intent && /先接住他此刻的情绪|只接他刚说的你们两个人的事|顺着他的话收尾/.test(intent)) || grievanceActive) ? { maxBubbles: shapeNow ? Math.min(2, shapeNow.maxBubbles) : 2 } : shapeNow ? { maxBubbles: shapeNow.maxBubbles } : {}),
                ...(shown.omitted ? { note: `较早的聊天原文 ${shown.omitted} 条不放（事实靠长期记忆${summary ? '和前面的要点' : ''}）` } : {}),
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
            // 危机回合不打错字（ADR 0068）
            if (crisisNow) return parts;
            const typo = maybeTypo(parts, `${contact.qq} ${parts.join('|')}`, maxBubbles, options.recallOwn ? RECALL_SHARE : 0);
            if (typo.note) log(`打错字：${typo.note}`);
            return typo.recall ? { parts: typo.parts, recall: typo.recall } : typo.parts;
        },
        review: async (reply, messages, reviewContext) => {
            const regenerate = async (note: string) => clean(await generate(postProcessPrompt([...messages, { role: 'system', content: note }], llm.promptPostProcessing, names), log));
            const reviewed = await (crisisNow
                ? (text: string, reviewOptions: ReviewOptions) => reviewCrisisReply(text, reviewOptions, crisisNow!.level)
                : reviewReply)(reply, {
                // 角色卡的禁用词 + 医书里的词（“肚子坠着”之类，expression.ts 的 ODD_BODY_WORDS）：出了就让她重写
                banned: [...character.banned, ...ODD_BODY_WORDS],
                userName: contact.name,
                ...(options.speechCheck ? { speech: { ...speechContext(options.history.load(contact.qq)), ...(sulkNow ? { allowGrievance: true } : {}), ...(reviewContext?.allowRepeat ? { allowRepeat: true } : {}) } } : {}),
                ...(reading ? { books: reading } : {}),
                // 小黄脸（ADR 0051）：最近几次带得太密、他认真说事她只回表情
                faces: faceContext(options.history.load(contact.qq), contact.tier),
                ...(textIntimacy ? { textIntimacy: true } : {}),
                ...(options.stickers ? { imageStickers: true } : {}),
                regenerate,
                log,
            });
            // 形状控制（配置 shape）：出口检查之后再看字数和条数，超了重写一次、还超就在分句处截断
            return shapeNow && !crisisNow ? shapeReply(reviewed, shapeNow, { regenerate, log }) : reviewed;
        },
        send: options.send,
        ...(options.typing ? { typing: options.typing } : {}),
        ...(options.recallOwn ? { recallOwn: options.recallOwn } : {}),
        ...(options.markRead ? { markRead: () => options.markRead!(contact.qq) } : {}),
        ...(options.react ? { react: (messageId: number, text: string) => options.react!(contact.qq, messageId, text) } : {}),
        ...(options.stickers || options.photos ? { historyContent: (sent: string) => { const withSticker = options.stickers ? options.stickers.history(sent) : sent; return withSticker === sent && options.photos ? options.photos.history(sent) : withSticker; } } : {}),
        log,
        now,
        settle: options.settle ?? DEFAULT_SETTLE,
        retryAfterMs: options.retryAfterMs ?? RETRY_AFTER_MS,
        // 睡着时连着发能把她吵醒的只有男朋友档（决策 6）；冷场时多久看到、打字多久乘这一档的节奏系数（ADR 0013 决策 1）
        timing: schedule && {
            whenSeen: (history, at) => whenSeen(history, at, {
                schedule, wakeable: contact.tier === 'boyfriend', pace: character.pace,
                ...(options.lagTail ? { lagTail: true } : {}),
                // 洗澡时看不到消息（ADR 0031），按她这一档的世界算
                busy: moment => {
                    if (!herSchedule || !character.herWorld) return undefined;
                    const when = new Date(moment);
                    const around = options.worldState?.at(character.herWorld, herSchedule, when) ?? worldAt(character.herWorld, herSchedule, when);
                    const busy = around ? unavailableAt(around, when) : undefined;
                    return busy ? { until: busy.until.getTime(), reason: busy.reason } : undefined;
                },
                asleep: moment => {
                    const asleep = asleepAt(new Date(moment));
                    return asleep ? { since: asleep.since.getTime(), until: asleep.until.getTime() } : undefined;
                },
            }),
            ...replyDelays(options.rhythm ?? false, character.pace),
            skip: replySkip(character, options.moody ?? false, options.moodyChance),
        },
        waitUntil: options.waitUntil,
        onPrompt: options.onPrompt,
        ...(options.sensitive ? { sensitive: options.sensitive } : {}),
    });
}
