import { localDate } from '../local-date.ts';
// 一位联系人的回复流水线：召回长期记忆 → 按 ST 顺序拼提示词 → 后处理 → 生成 → 清理（含卡上的 ST 正则）→ 出口检查 → 拆条发送（responder.ts 调度）。
// 出口检查带上聊天记录里她最近几次回复和对方最近几条，查说话的毛病（ADR 0014，配置 speechCheck）。
// 她自己的日子（ADR 0015，配置 herDays）：时间块里状态行下面加今天的心情，聊到书或她正在看书时再加「在读的书」，那一轮出口检查顺带查进度数字。
// 她认识的人（ADR 0016）：他或她最近的话里提到名单里另一个人的称呼（那人写了「别人提起时」），召回之后放一段介绍。
// 记忆（ADR 0018）：召回会变淡，她和名单里的称呼不算「一提就想起」的线索；放进提示词的记忆里她的名字换成「你」。
// bot（main.ts）和模拟器（sim/）共用这一份；模拟器只换掉收发、时钟和数据目录（ADR 0005）。

import { assessTurn, contributeTurn, type Module, type Turn } from '../interpreter/interpreter.ts';
import type { Piece, Slot } from '../interpreter/slots.ts';
import { dirname, join } from 'node:path';
import { catAlternative, noteCharacterTerms } from '../character-terms.ts';
import { UNLISTED_TIER, type AppConfig, type Contact, type Tier } from './config.ts';
import { disclosureRules, isClose, sourceLabel, startsConversation, todayStart } from '.././emotion/disclosure.ts';
import { crisisFallback, faceContext, finalizeReply, reviewCrisisReply, reviewReply, type ReviewOptions } from '.././language/exit-check.ts';
import type { ChatHistory, StoredMessage } from '.././memory/history.ts';
import { checkFacts, type FactCheckMode, type FactRecord } from '.././language/fact-check.ts';
import { chatCompletion, completionMaxTokens, forExtraction } from '.././language/llm.ts';
import type { Log } from './log.ts';
import { CLEAR_DAYS, recentChat, type FadeStats } from '.././memory/fading.ts';
import { heardSinceReply, initiateQuery, PERSON_RECALLED, secondPerson, type LongTermMemory } from '.././memory/long-term.ts';
import { buildPrompt, type ChatMessage, type OpenAIMessage, type PromptResult } from '.././language/prompt.ts';
import { cleanUpReply } from '.././language/reply.ts';
import { stripDeviceTokens, type DeviceControl, type ParsedTokens } from './device-actions.ts';
import { createResponder, DEFAULT_SETTLE, RETRY_AFTER_MS, type Responder } from '.././social/responder.ts';
import { loadCharacterCard, type Character } from '.././st/card.ts';
import { postProcessPrompt } from '.././st/prompt-converters.ts';
import { loadWorldInfo, type WorldInfoEntry } from '.././st/world-info.ts';
import { isAckAfterClosing, moodySkip, replyDelays, whenSeen } from '.././social/reply-timing.ts';
import type { SilenceInfo } from '.././social/silence.ts';
import { describeMood, moodAt, readingActivities, readingSection } from '.././life/her-days.ts';
import { crisisInHistory, type CrisisHit } from '.././emotion/crisis.ts';
import { describeGrievance, grievanceNow, ignoredNow } from '.././emotion/grievance.ts';
import { needsCareText } from '.././language/intent.ts';
import { describeObstacles, meetupDays } from '.././world/obstacles.ts';
import { applyTexture, TEXTURE_TILDE_WINDOW } from '.././language/texture.ts';
import { describeQuote, planQuote, quoteFix, type QuotePlan } from '.././social/quote-reply.ts';
import { alreadyTold, asksToExplain, describeLength, ENGAGED_INTENT, lengthHint, maybeTypo, ODD_BODY_WORDS, RECALL_SHARE, recentCrutches, repeatedOpener, STILTED_WORDS } from '.././language/expression.ts';
import { KIND_LABEL, ROUTED_HINTS, wantsDepth, type TurnWeight } from '.././language/turn-weight.ts';
import { DELIBERATE_MAX_BUBBLES, DELIBERATE_NOTE, deliberateTurn, describeShape, planShape, shapeReply, type ShapePlan, type ShapeShares } from '.././language/shape.ts';
import { finishReply } from '.././language/unfinished.ts';
import { describeUnsettled } from '.././life/open-loops.ts';
import { describeWorld, lastMealDish, recapDay, recentWith, unavailableAt, worldAt, worldNews, type WorldNow, type WorldState } from '.././world/world.ts';
import { isExplicitCurrentPhotoRequest, type CurrentAiPhotoResult } from '.././proactive/ai-photo-requests.ts';
import { npcMentioned } from '.././world/npc.ts';
import { dayPlan, describePlans, describeSlot } from '.././life/day-plan.ts';
import { bodyAt, describeBody, diaryBody, unwell } from '.././life/body.ts';
import { asleepSince, saidBedtimes } from '.././life/bedtime.ts';
import { herStatus } from '.././language/status-line.ts';
import { describeWarmAffect, warmAffect } from '.././emotion/affect.ts';
import { moodPaceLine, moodShape, tunedMaxBubbles } from '.././emotion/express.ts';
import { withEveryday } from '.././life/everyday.ts';
import { withMenu } from '.././life/menu.ts';
import { describePursuits, pursuitViews, type Pursuit } from '.././life/pursuits.ts';
import type { FeelingsReport } from '../emotion/feeling-export.ts';
import { appraisals, asksAfterHer, criedRecently, describeFeelings, FEELING_NAME, feelingsAt, feelsLow, voicedKinds, type Appraisal, type Felt, type Moment } from '.././emotion/feelings.ts';
import { describeRecentPhotography, recentPhotography } from '.././life/projects.ts';
import { describePast, pastCue } from '.././life/biography.ts';
import { askedWindow, ASKS_PAST, asksPast, commonCue, describePerson, holidayWords, lingering, mentionedPeople } from '.././life/people.ts';
import { describeAppointment, mentionsMeetup, type PromiseKeeper } from '.././life/promises.ts';
import { describeState, formatDate, herDay, partnerBackLine, type ExtraFreeActivity } from '.././life/schedule.ts';
import { speechContext, TAIL_CAPS, type BookProgressContext } from '.././language/speech-check.ts';
import { describePick, pickBest, PICKED_INTENTS, type PickRules } from '.././language/candidates.ts';
import { turnCut, type Summarizer, type TurnWindow } from '.././language/context-window.ts';
import { describeDays, describeTime } from '.././language/time-context.ts';
import { estimateTokens } from '.././language/tokens.ts';
import { exemplarLine, pickExemplars, type Exemplar } from '.././language/exemplars.ts';
import { readScene } from '.././language/scenes.ts';
import { voiceHint, voiceRoll } from '.././language/speaking.ts';
import { SHELL_INTENT } from '.././language/intent.ts';
import { selfThreadLine } from '.././language/self-thread.ts';
import { speechNotesLine, type SpeechNote } from '.././language/speech-notes.ts';
import { insightsLine, type Insight } from '.././life/diary-insights.ts';
import { takesLine, type Take } from '.././life/reading-takes.ts';
import { thoughtsLine, type Thought } from '.././life/open-questions.ts';
import { feltDayNote, feltDuring, feltNoteFor } from '.././emotion/felt-then.ts';
import { lastNight, withLastNight } from '.././life/nights.ts';
import { reviewLine, type ReviewNote } from '.././language/chat-review.ts';
import { guessesLine, type Guess } from '.././life/her-guesses.ts';
import { describeHumanState, describeHumanValues, type HumanValues } from '.././human-values.ts';
import { auditDevelopment, describeDevelopment, developmentSnapshot, developmentSummary, type DevelopmentSnapshot } from '.././life/development.ts';
import { photoAllowance, photoIntent, photoWanted, stripPhotoArtifacts, PHOTO_KINDS, type PhotoKind, type PhotoShelf } from '.././vision/photos.ts';
import { imageStickerAllowance, stickerCued, stickerOnlyTurn, stickerTurn, stripStickerArtifacts, STICKER_TURN_CHANCE, type StickerShelf } from '.././social/stickers.ts';

/**
 * 「做题式」写法（ADR 0146 实验）：不是让她演自己，而是让她推断这个情境里最可能真的发出去的那几条。
 * 只有模拟器的 --frame solve 用，线上没有这个开关；写法里不引任何她不该说的句子（提示词里引了模型会照抄）。
 */
export const SOLVE_FRAME_NOTE = '这一轮不要去想怎么显得像真人，也不要演。只做一件事：根据上面的一切（你是谁、此刻的状态、聊天记录、他刚说的话），推断在这个情境里你最可能真的发出去的那几条消息——最普通、最不费力、最贴着语境的那一版，不是最精彩、最周全的那一版。只输出这几条消息，每条一行';

const DAY_MS = 86_400_000;

/**
 * 他最后一条消息在这个时间内，才算“他刚说的”。主动找他时他常常几小时没说话（ADR 0100「没回也继续」），
 * 那不是刚说的：10-29 13:24 她拿两小时前的「好好好，都给你～」接了一句「哈哈行，卤蛋记账上了」。
 */

/**
 * 作者写的角色设定要不要进提示词（10-30 用户：把我给她加的设定都去掉）。
 * 关着时 description / personality / scenario / 示例对话都不注入；名字、红线、危机承认版卡、每轮的事实照旧。
 * 要恢复，改回 true。
 */
const INJECT_PERSONA = false;

/**
 * 10-30 用户：设定里「她是谁」的事实留下，「她该是什么性格」拿掉。
 * 卡里的 description 按【段】切开，只留事实段：关系、家、宿舍、专业、朋友、钱、雷区、日常、重要的日子、不接的话题、被问是不是 AI。
 * 拿掉的是【心事】（怕被冷落、嘴硬心软）、【口癖与称呼】（怎么说话）、【会变】（性格随关系变）。
 */
const PERSONA_FACT_SECTIONS = ['和他的关系', '家', '宿舍', '专业', '朋友', '钱', '雷区', '日常', '重要的日子', '不接的话题', '被问是不是 AI'];
export function personaFacts(description: string | undefined): string {
    const parts = String(description ?? '').split(/(?=【)/);
    return parts.filter(part => PERSONA_FACT_SECTIONS.some(head => part.startsWith(`【${head}】`))).join('');
}

/** 他在 QQ 里切到工作模式（/dsh）时加的一行：干活，但说话还是她 */
const WORK_MODE_NOTE = '他刚把你切到工作模式：这会儿他让你帮忙干活。先说结果，用你平时的口气，别分点汇报、别写“好的/已完成/总结”，过程他追问再说。';

/** 她自己决定记不记：只在这条真的值得长期记住时，回复最后另起一行写标记；标记不会发出去 */
const SELF_MEMORY_NOTE = '记忆由你自己决定：只有这条真的值得长期记住（约定、他的重要事、你自己想记住的），才在回复最后另起一行写 `<<记住：一句话>>`；想写今天的事就写 `<<日记：一段>>`；有不想让他知道的真实想法，写 `<<私密：…>>`（不会发出去，只记在私密日记）。不想答应的事可以拒绝；拒绝后把真实想法写进 `<<私密：…>>`。想不起某件事时，别硬编，写 `<<查：关键词>>`，系统会把你想起的东西给你再回。这些标记不会发出去。不重要就不写，别每条都记。';

/** 他在求她切工作：答不答应由她，可以提条件 */
const WORK_REQUEST_NOTE = '他在求你切到工作模式。你可以答应、可以拒绝、也可以提条件（比如先陪你聊十分钟）。答应就在回复最后写 `<<同意工作>>`；拒绝就写 `<<拒绝工作：原因>>`。两个都不写就算没答应，他还在聊天模式。';

/** 她自己决定要不要动电脑：不用他先发 /dsh，也不用事后 /QQ 切回来 */
const WORK_JUDGE_NOTE = '他这条要是得真动电脑才办得到（跑命令、改代码、看文件、装东西、上网查东西、替他操作软件），就在回复最后另起一行写 `<<用电脑>>`，系统会把这条交给你去做，做完你照结果回他；只是聊天、聊打算、开玩笑、问你觉得——都别写。这个标记不会发出去。';

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

/**
 * 他问到过去的某一天时（ADR 0032）那一段流水账；written：她那天自己写的日记（ADR 0217，diaryLookback），没有就和原来一字不差
 */
export function recapText(day: string, lines: readonly string[], written?: string, felt?: string): string {
    const diaryPart = written ? `${lines.length ? '；' : ''}那天你自己写的日记：「${written}」（你写的，他问到那天，说法对着它，别和它打架；不用照念）` : '';
    // 那天的感觉（ADR 0218）
    const feltPart = felt ? `${lines.length || written ? '；' : ''}${felt}` : '';
    return `[那天（${day}）你那边的流水账（你自己过的，都是真的：他问到具体的事——下没下雨、喂没喂猫、快递拿没拿——照这个说，别说错；泛泛问那天干了什么时，先说上面记得住的事，这里的不用一件件报）：${lines.join('；')}${diaryPart}${feltPart}]`;
}

/** 读一个档位的角色卡和它链接的世界书；pattern 是配置里的 characterCard（{tier} 换成档位名，承认版是「<档位>-open」，ADR 0067），世界书在同目录的 <world>.json */
export function loadTierCard(pattern: string, tier: string, options: { everydayLife?: boolean; everydayFrom?: string; menu?: boolean; menuFrom?: string; worldDrama?: boolean; threadsFrom?: string } = {}): TierCard {
    const path = pattern.replaceAll('{tier}', tier);
    const loaded = loadCharacterCard(path);
    // 猫的名字、学校和家所在的城市记下来（ADR 0335）：文案和正则从这里取，源码里不写死
    noteCharacterTerms(loaded.herWorld);
    // 补充的日常小事和小测（ADR 0106，配置 everydayLife）：代码里加进世界的“小事”块，不改角色卡
    const withDays = options.everydayLife && loaded.herWorld ? { ...loaded, herWorld: withEveryday(loaded.herWorld, tier, options.everydayFrom, options.worldDrama)! } : loaded;
    // 她那边的事有后续（ADR 0216，配置 worldThreads）：从 threadsFrom 起，昨天的事今天可能有个尾巴、闹心的事有冷却期
    const everyday = options.threadsFrom && withDays.herWorld ? { ...withDays, herWorld: { ...withDays.herWorld, threads: true, threadsFrom: options.threadsFrom } } : withDays;
    // 每顿吃什么（ADR 0125，配置 menu）：菜单放进世界，午饭 / 晚饭才有“吃的是什么”
    const character = options.menu && everyday.herWorld ? { ...everyday, herWorld: withMenu(everyday.herWorld, options.menuFrom)! } : everyday;
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
    send: (userId: number, text: string, options?: { replyTo?: number }) => Promise<number>;
    /** 整条只有内部标记（<<记住>> / <<日记>> / <<同意工作>>…）的气泡：不发、不进记录，但标记要处理（responder 的 absorb） */
    absorb?: (userId: number, part: string) => void;
    /** 存进聊天记录前清洗发送文本（内部标记、贴纸说明等） */
    historyContent?: (sent: string) => string;
    /** 已确认消息的发送快照；缺省仍用照片/表情货架转换，旧调用方不受影响。 */
    sentHistory?: (sent: string, messageId: number) => string | undefined;
    /** 引用回复（ADR 0136，配置 quoteReply）：他连发里有个不是最后一条的问题时，第一条引用它来回；打错字撤回失败补「*对的词」时有时引用那条错的 */
    quoteReply?: boolean;
    /** 逐条事实检查（ADR 0137，配置 factCheck）：log 只查、记日志；fix 有对不上事实的说法就带说明重写一次。不传 / off 不查 */
    factCheck?: FactCheckMode;
    /** 事实检查多查一类：她替他说的、没有依据的事（配置 factHim，ADR 0203）；要 factCheck 开着 */
    factAboutHim?: boolean;
    /** 审稿用的模型调用（默认同一个模型、温度 0；模拟器 / 测试换成自己的） */
    factAudit?: (messages: OpenAIMessage[]) => Promise<string>;
    /** 每次事实检查的记录（模拟器的报告用） */
    onFactCheck?: (record: FactRecord) => void;
    /** 引用的概率（默认 QUOTE_SHARE；模拟器场景可以调来测）*/
    quoteShare?: number;
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
    /** 照片货架（ADR 0109，配置 photos）：他要看猫 / 风景 / 她的片子时，货架里有就发；只对男朋友档 */
    photos?: PhotoShelf;
    /** AI 生活照（ADR 0240）：只解析“现在/刚刚”的明确请求；新图只建待审核草稿，返回 approved 才能发匹配编号。 */
    currentAiPhoto?: (request: { kind: PhotoKind; dish?: string; at: Date; world: WorldNow }) => CurrentAiPhotoResult;
    /** 他刚在 QQ 里切到工作模式（/dsh）：这轮按「帮他干活」说话，语气不变 */
    workMode?: () => boolean;
    /** 她在聊天模式里，由她自己判断这条要不要动电脑（不用他先发 /dsh） */
    workJudge?: () => boolean;
    /** 他在求她切工作模式：她可以答应/拒绝/提条件 */
    workRequest?: () => boolean;
    /** 她最近拒绝过的事：让她记得自己的拒绝 */
    refusalLine?: () => string | undefined;
    /** 他最近给她的评分：影响说话分寸 */
    ratingLine?: () => string | undefined;
    /** 她现在的连续生活（NOW.md）：此刻在干嘛、身体、心情、关系 */
    lifeLine?: () => string | undefined;
    /** 真人例子（ADR 0190，默认关）：他说完这种话，真人是怎么回的 */
    exemplars?: readonly Exemplar[];
    /** 她自己总结的说话习惯（ADR 0193，默认关）：挑最相关的几条放进提示词；她自己的观察，不是规定 */
    speechNotes?: () => readonly SpeechNote[];
    /** 她翻自己日记时发现的自己（ADR 0194，默认关）：挑最相关的几条放进提示词；她自己的观察，不是设定 */
    diaryInsights?: () => readonly Insight[];
    /** 她读完 / 看完之后自己想的（ADR 0204，默认关）：他聊到那本书 / 视频或问“最近看了什么”才放最多两条；她自己的看法，不是设定 */
    readingTakes?: () => readonly Take[];
    /** 她没想完的问题想出来的（ADR 0207，默认关）：他再问到同一件事才放最多两条；是她自己后来想的，提示词不说该不该用、该选哪边 */
    openQuestions?: () => readonly Thought[];
    /** 她猜的事和后来的结果（ADR 0213，默认关）：他这句提到同一类事（小测 / 快递 / 天气 / 作业）才放最多两条；她自己记的，别背、别较真 */
    herGuesses?: () => readonly Guess[];
    /** 梗百科词库（2026-10-29）：他这句里提到一个词，只读地查一眼，不写进她自己的梗库 */
    memeDict?: { mention(text: string): { term: string; meaning: string; origin: string; tags: string } | undefined };
    /** 他问到过去的某一天时，她那天自己写的日记（ADR 0217，默认关）：date 是她的那一天 YYYY-MM-DD */
    diaryOn?: (date: string) => string | undefined;
    /** 回忆带着当时的感觉（ADR 0218，默认关）：想起某一天的事时附一句她那天有依据的感觉；因为他而难过 / 烦 / 担心的不附 */
    memoryFeelings?: boolean;
    /** 昨晚真的怎么睡的（ADR 0219，默认关）：早上困不困从她说「睡了」、半夜被吵醒、睡前跟他聊推，不按课表；被吵醒有起床气 */
    realNights?: boolean;
    /** 她每天回顾聊天时记下的（ADR 0221，默认关）：最多两条，新的在前；危机 / 想事情 / 小别扭 / 他难过的轮次不放 */
    chatReview?: () => readonly ReviewNote[];
    /** 形状对所有轮次都生效（ADR 0220，默认关）：关着时照 DSH 10-28 的松绑，普通闲聊不给形状 */
    shapeAll?: boolean;
    /** 她自己最近过的日子（2026-10-30 她说「没有自己的下文」）：从她写的日记里摘一两句，用不用她定 */
    selfThread?: () => string | undefined;
    /** 她上一轮在这台电脑上跑的命令和结果（2026-10-30 用户：把最高权限给她） */
    shellNote?: () => string | undefined;
    /** 她学说话/翻日记时没想通的问题（2026-10-31）：递给她，让他来答 */
    learningQuestion?: () => string | undefined;
    /** 昨晚做的梦（2026-10-31）：一条心境事实 + 早上递给她的一句话 */
    dreams?: () => { appraisals: Appraisal[]; line?: string };
    /** 他的请求等她点头（2026-10-30）：看屏幕 / 摄像头这类，她写 <<同意>> 才做 */
    ask?: () => string | undefined;
    /** 首轮铺底（2026-10-29）：他走了很久回来，第一轮带上她自己写的那段日记；挂着 lifeInPrompt，不是新开关 */
    wakeNote?: () => string | undefined;
    /** 记忆由她自己决定：提示词里教她写 <<记住：…>> / <<日记：…>> 标记 */
    selfMemory?: boolean;
    /** 她想查才查（<<查：…>>）：拿到想起来的记忆，再让她重写一次 */
    pullRecall?: (query: string) => Promise<string | undefined>;
    /** 允许发图片表情的轮次里抽中发的概率（默认 STICKER_TURN_CHANCE；模拟器场景可以调高来测）*/
    stickerChance?: number;
    /** 抽到发表情的轮次里只发表情不写文字的概率（不写 = 0，不开；app.ts 在 shapeFeel 开着时给 STICKER_ONLY_SHARE；模拟器场景可以调来测，ADR 0099） */
    stickerOnlyChance?: number;
    /** 他这句话没有明确反应、但允许发图片表情的轮次里，抽到发一个的概率（ADR 0132，配置 biliStickers）：原来只有有明确反应的轮次才抽，她线上 437 轮里发了 1 个；不给就还是原来的 */
    stickerUncued?: number;
    /** 不带联系人前缀，这里会加上 [QQ 号] */
    log: Log;
    /** 每次生成前拿到后处理之后、实际发给模型的提示词 */
    onPrompt?: (prompt: PromptResult) => void;
    /** 能不能把聊天正文写进日志（ADR 0070 第 8 项）；不传就不写 */
    sensitive?: () => boolean;
    /** 毫秒时间戳，默认真实时间；模拟器传虚拟时钟 */
    now?: () => number;
    /** 真人式连续数值（ADR 0222）：只记无原文的审计摘要，不把原始分数交给模型。 */
    humanValues?: (context: { contact: Contact; history: readonly (Pick<StoredMessage, 'role' | 'content'> & { time?: string })[]; at: Date }) => HumanValues | undefined;
    /** 默认调模型接口（llm.ts）；模拟器包一层，在生成中插入对方的消息 */
    generate?: (messages: OpenAIMessage[], log: Log, use?: AppConfig['llm']) => Promise<string>;
    /** 深思（配置 deliberate，ADR 0151）：认真问她的轮次不套字数和条数、用这份更强的模型配置（generate 的第三个参数）、提示词只留一句“先想清楚” */
    deliberate?: { llm: AppConfig['llm']; /** 换掉深思轮次的那段提示词（只有模拟器的 --deliberate-note 用；线上不传，用 DELIBERATE_NOTE） */ note?: string };
    /** 语义路由（配置 depthRouting，ADR 0202；要 deliberate 开着）：关键词没认出来的轮次问一次小模型这一句是轻是重；说值得认真的（沉重的事 / 要她的看法 / 问她自己 / 质疑她 / 问他们俩）也走深思。只加不减；没分类出来（出错 / 超时）照旧按关键词 */
    turnWeight?: (input: { history: ChatMessage[]; said: string }) => Promise<TurnWeight | undefined>;
    /**
     * 连续性（ADR 0157–0163，app.ts 提供）：按这一轮他说的话，返回要放进提示词的几行——设定改动的背景、QQ 以外做过的事、
     * 上网查到的资料、自己发现的口味、又见到的人。危机回合、只想一想的轮次不调用。出错 / 超时一律当没有，不挡回复
     */
    continuity?: (context: { contact: Contact; said: string; initiating: boolean; now: Date }) => Promise<string[]>;
    /** 连发合并的等待，默认 DEFAULT_SETTLE（测试用短的） */
    settle?: { quietMs: number; maxMs: number };
    /** 按卡上的作息（ADR 0007）：时间块里加一行她现在在干什么，按作息决定什么时候看到、打字多久，收尾后的附和不回。默认否；卡上没有作息时也不按 */
    schedule?: boolean;
    /** 看心情不回（ADR 0013 决策 4），要按作息；默认否 */
    moody?: boolean;
    /** 出口检查里查说话的毛病（ADR 0014）；默认否 */
    speechCheck?: boolean;
    /** 句尾语气字封顶（ADR 0146，配置 tailCap，要 speechCheck 开着）：她最近的气泡里挂尾巴的占比到了真人的水平，这一轮再挂的把那个字去掉 */
    tailCap?: boolean;
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
    /** 她自己决定今天想做的事（ADR 0182）：和「在读的书」一起当额外的空闲活动，状态行和「你今天的打算」都带上 */
    herPlan?: (at: Date) => ExtraFreeActivity[];
    /**
     * 她理解人的话（10-30 用户：让她自己学习去理解人说的话）：他这句话和以前被纠正过的事撞上时，
     * 返回一行「上次你这么理解，他纠正过」；没有就不加
     */
    understanding?: (hisWords: string) => string | undefined;
    /** 他最近说过、做过、答应过的事（10-31 留痕）：聊天时递给她，提不提她自己定 */
    traces?: () => string | undefined;
    /** 他刚发过「/亲热」（ADR 0170）：接下来几条回复黏一点；每取一次少一条，主动找他、危机回合不取 */
    intimacyLine?: () => string | undefined;
    /** 心境（ADR 0102，配置 herFeelings）：她那边的事、他的态度、作者写下的事，在她心里留下带来由的感受（开心 / 难过 / 担心……），会慢慢散；只给男朋友档，危机回合不放 */
    herFeelings?: boolean;
    /** 每次给他算完心境交出来（ADR 0197）：app.ts 写进灵魂目录，桌面上的她读同一份；出错不影响回复 */
    onFeelings?: (report: FeelingsReport) => void;
    /** 她夜里回想、指出了依据的感受（ADR 0197，配置 feelingReview）：作为「别处算好的评估」进心境；要 herFeelings 开着 */
    feelingReview?: () => readonly Appraisal[];
    /** 说话的质感（ADR 0131）：发出去之前在气泡上加真人常有的小黄脸 / 「～」 / 问号 / 叠字……；危机和他难过的回合不加 */
    texture?: boolean;
    /** 作者写下的、引起她情绪的事（ADR 0102，runtime/bot/moments.json）；每次生成现取 */
    moments?: () => readonly Moment[];
    /** 她自己的追求（ADR 0104，配置 pursuits）：内置两条（别挂科、用新相机拍出满意的东西）加作者在 pursuits.json 里改的 / 加的；每次生成现取 */
    pursuits?: () => readonly Pursuit[];
    /** 她每天碰到的小事（ADR 0106，配置 everydayLife；卡在 loadTierCard 里补）：他问“今天干嘛了 / 有什么好玩的事”时让她从今天的小事里挑具体的说 */
    everydayLife?: boolean;
    /** 回复延迟的长尾（ADR 0105，配置 lagTail）：醒着空着时有一部分消息她在做别的，过一会儿才看到；断网很久之后才回，时间块里写一句 */
    lagTail?: boolean;
    /** 分成几条（配置 shapeSplit，要 shape 开着）：把形状里抽出的条数当目标写进提示词，不只是上限（ADR 0096） */
    shapeSplit?: boolean;
    /** 被问直接问题时答完再接着说（配置 shapeAsk，要 shape 开着，ADR 0149）：不加「应一声、附和」那一句，条数按真人被问问题时的分布抽 */
    shapeAsk?: boolean;
    /** 被认真问想法 / 原因时说长一点（配置 shapeLong，要 shape 开着，ADR 0150） */
    shapeLong?: boolean;
    /** 「做题式」写法（ADR 0146 实验，只有模拟器的 --frame solve 用，线上没有这个开关）：不让她演自己，让她推断这个情境里最可能发出的那几条 */
    replyFrame?: 'solve';
    /** 她对他的电脑和手机的有限控制（ADR 0148，配置 deviceControl）：只给男朋友档；菜单进提示词，回复里的 <device:…> 令牌在发送前登记并按档处理 */
    devices?: Pick<DeviceControl, 'menu' | 'parse' | 'commit'>;
    /** 他刚才在 DSH 桌面上和她的对话（ADR 0177，配置 crossRecent）：只给男朋友档；返回一段放进提示词的话，没有就不放 */
    desktopRecent?: (now: Date) => string | undefined;
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
    /** 他的消息没有马上回的每一个原因（ADR 0173）：只是旁观，传给响应器 */
    onSilence?: (info: SilenceInfo) => void;
    /**
     * 开了长期记忆时原始聊天只放最近几轮、更早的整理成要点（ADR 0043 离线实验，只有模拟器传）。
     * 不传是最近 80 条（ADR 0036 决策 3），线上不传
     */
    contextWindow?: TurnWindow & { summarize: Summarizer };
    /** 解释器上注册的、要参与一轮回复的模块（ADR 0336）；拼提示词时排在迁移前的旧逻辑前面，各段按槽位表排 */
    turnModules?: readonly Module[];
}

/** 问到过去的某一天时，几天以内她那边的事还记得清楚（ADR 0032，同 ADR 0018 的 7 天） */
export const RECAP_DAYS = 7;

export function createContactResponder(options: ContactPipelineOptions): Responder {
    const { contact, card: { character, worldInfo }, llm, memory } = options;
    const names = { user: contact.name, char: character.name };
    const now = options.now ?? Date.now;
    const log: Log = message => options.log(`[${contact.qq}] ${message}`);
    const generate = options.generate ?? ((messages, log, use) => chatCompletion(use ?? llm, messages, { log }));
    /** 深思轮次用更强的模型（ADR 0151）；别的轮次不传，用默认的 */
    const useNow = () => (deliberateNow ? options.deliberate?.llm : undefined);
    let stickersAllowed = true;
    /** 这一轮抽到要发图片表情，并带上他这一轮说的话（给货架按它挑）；没抽到就不给她看货架 */
    let stickerContext: { text: string; only?: boolean } | undefined;
    /** 这一轮只发表情、不写文字（ADR 0099）：模型多写了文字就去掉，只留那一行表情；它没写表情就照它写的发 */
    let stickerOnlyNow = false;
    /** 这一轮发哪一类照片（ADR 0109）：他要看、货架里有、允许发才有；没有就一律清掉模型写的照片指令 */
    let photoNow: PhotoKind | undefined;
    /** 吃的照片是哪道菜（ADR 0128）；只有 photoNow 是 food 时有 */
    let photoDishNow: string | undefined;
    /** AI 草稿审核通过后只给模型这一张精确匹配的照片，禁止从同类旧图里随便挑。 */
    let photoPromptNow: string | undefined;
    /** 明确索要“现在”的照片但没有已审核匹配图：告诉模型如实说发不了，不能拿旧图冒充。 */
    let currentPhotoUnavailableNow = false;
    /** 当前被选中草稿的动作；废弃的重写稿只解析，不替换这里。 */
    let deviceNow: ParsedTokens | undefined;
    const prepareReply = (reply: string): { text: string; devices: ParsedTokens | undefined } => {
        const devices = options.devices?.parse(reply);
        const text = cleanUpReply(devices ? devices.reply : stripDeviceTokens(reply), names, character.regexScripts);
        const stickered = options.stickers?.clean(text, stickersAllowed) ?? stripStickerArtifacts(text);
        const cleaned = options.photos ? options.photos.clean(stickered, photoNow !== undefined, photoNow ? { kind: photoNow, ...(photoDishNow ? { dish: photoDishNow } : {}) } : undefined) : stripPhotoArtifacts(stickered);
        if (!stickerOnlyNow) return { text: cleaned, devices };
        const only = cleaned.split('\n').map(line => line.trim()).filter(line => /^<sticker:[a-f0-9]{12}>$/i.test(line));
        return { text: only.length ? only.join('\n') : cleaned, devices };
    };
    const clean = (reply: string) => {
        const draft = prepareReply(reply);
        deviceNow = draft.devices;
        return draft.text;
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
    /** 这一轮是深思轮次（ADR 0151）：生成时用 options.deliberate.llm */
    let deliberateNow = false;
    /** 这一轮是语义路由（ADR 0202）放进深思的：按分类多放的一小句提示（沉重的事 / 质疑 / 问他们俩），不是语义路由放进来的就没有 */
    let routedHint: string | undefined;
    /** 这一轮发出去之前加质感用的上下文（ADR 0131）：他这一串说的话、这一轮是不是认真的回合、她最近几次回复里带了几次小黄脸 */
    let textureNow: { said: string; serious: boolean; recentFaces: number; recentTildes: number } | undefined;
    /** 这一轮第一条要引用他的哪一句（ADR 0136，配置 quoteReply）：buildPrompt 按他没回的那一串定，紧跟着发送时现取 */
    let quoteNow: QuotePlan | undefined;
    /** 这一轮拼出来的提示词（ST 后处理之前，system 还是 system）：事实检查拿它当“她能依据的事实”（ADR 0137） */
    let promptSource: OpenAIMessage[] | undefined;
    // 刚想起的公共记忆（ADR 0017）、从前（ADR 0022）、刚说起的她身边的人（ADR 0033）：接下来两轮没有新线索也沿用，追问时不忘。
    // 不记在这里，每轮从聊天记录往回推（lingering，ADR 0039）：记在内存里的话，重启以后追问「她好了没」就接不上了
    // 他问到过去的某一天（ADR 0032）：那天她那边的事，按这一档的卡算；只到 RECAP_DAYS 天前（ADR 0018：7 天内记得清楚）
    // 那天她心里有依据的感觉（ADR 0218，memoryFeelings）：那天晚上的世界、前一天留下的、作者写下的、她聊完回想记下的；
    // 因为他而难过 / 烦 / 担心的不算（felt-then.ts 的护栏）；同一天同一个钟头算过的不重算
    const feltCache = new Map<string, Felt[]>();
    const feltOnDay = (dayStart: Date): Felt[] => {
        const from = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate()).getTime();
        const at = Math.min(new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), 23, 30).getTime(), now());
        const key = String(Math.floor(at / 3_600_000));
        const cached = feltCache.get(key);
        if (cached) return cached;
        const snapshot = (time: number) => (herSchedule && character.herWorld
            ? options.worldState?.at(character.herWorld, herSchedule, new Date(time)) ?? worldAt(character.herWorld, herSchedule, new Date(time))
            : undefined);
        const world = snapshot(at);
        const previous = snapshot(new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate()).getTime() - 60_000);
        const felt = feltDuring(appraisals({ now: at, history: [], ...(world ? { world } : {}), ...(previous ? { previousWorld: previous } : {}), moments: options.moments?.() ?? [], extra: [...(options.feelingReview?.() ?? [])] }), from, at);
        if (feltCache.size > 30) feltCache.clear();
        feltCache.set(key, felt);
        return felt;
    };
    const recapOf = (dayStart: Date, time: Date): { day: string; lines: string[]; text: string } | undefined => {
        if (!herSchedule || !character.herWorld) return undefined;
        const today = herDay(herSchedule, time);
        const back = Math.round((today.getTime() - dayStart.getTime()) / 86_400_000);
        if (back < 1 || back > RECAP_DAYS) return undefined;
        const at = (h: number, m: number) => localDate(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), h, m);
        const then = options.worldState?.at(character.herWorld, herSchedule, at(23, 30)) ?? worldAt(character.herWorld, herSchedule, at(23, 30));
        if (!then) return undefined;
        const lines = recapDay(then);
        const bodyThen = character.herWorld.body ? bodyAt(character.herWorld.body, herSchedule, at(15, 0)) : undefined;
        const body = bodyThen ? diaryBody(bodyThen) : undefined;
        if (body) lines.push(body);
        // 那天改了的打算（ADR 0034）：照打算做的不写——天天一样的空闲活动排成一列，问「昨天干嘛了」她就照着报，想不起那天记得住的事（调整 3）
        lines.push(...dayPlan(herSchedule, character.herWorld.plans, dayStart, {
            rain: then.weather?.rain,
            ...(then.weather?.rainHours ? { rainHours: then.weather.rainHours } : {}),
            ...(then.airQuality ? { airQuality: then.airQuality } : {}),
            ...(then.daylight ? { daylight: then.daylight } : {}),
            body: bodyThen,
            homework: then.homework,
        }, [...extraFree, ...(options.herPlan?.(dayStart) ?? [])])
            .filter(slot => slot.done !== slot.planned).map(describeSlot));
        // 那天她自己写的日记（ADR 0217）：翻回去看得到，说法可以对着它
        const written = options.diaryOn?.(`${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`);
        // 那天的感觉（ADR 0218，memoryFeelings）：他问到那一天，整天明显的感觉都算
        const feltDay = options.memoryFeelings && contact.tier === 'boyfriend' ? feltDayNote(feltOnDay(dayStart)) : undefined;
        if (!lines.length && !written && !feltDay) return undefined;
        const day = `${dayStart.getMonth() + 1}月${dayStart.getDate()}日 ${'日一二三四五六'.split('').map(d => `周${d}`)[dayStart.getDay()]}`;
        return { day, lines, text: recapText(day, lines, written, feltDay) };
    };
    return createResponder({
        userId: contact.qq,
        history: options.history,
        buildPrompt: async (chat, { woken, initiate, offlineSince }) => {
            deviceNow = undefined;
            const time = new Date(now());
            const humanValues = options.humanValues?.({ contact, history: chat, at: time });
            if (humanValues) log(describeHumanValues(humanValues));
            let development: DevelopmentSnapshot | undefined;
            if (humanValues) {
                try {
                    const events = options.worldState?.events?.() ?? [];
                    development = developmentSnapshot({ at: time, values: humanValues, history: chat, events });
                    const audit = auditDevelopment(development, events);
                    if (audit.length) log(`人格成长层：自检未通过（${audit.join('；')}）`);
                    else {
                        const summary = developmentSummary(development);
                        log(`人格成长层：人生线 ${summary.activeLifeArcs}，关系 ${summary.relationshipStage}，自主 ${summary.autonomyMode}，创作草稿 ${summary.creativeDrafts}`);
                    }
                } catch (error) {
                    log(`人格成长层：投影失败（${error instanceof Error ? error.message : String(error)}）`);
                }
            }
            // 只想一想（ADR 0101 内心）：不是在聊天，不要意图行、形状、字数提示、表情；聊天记录当成“回想”放进说明里，不当成要接着回的对话
            const thinking = Boolean(initiate?.think);
            const humanStateLine = humanValues && !thinking ? describeHumanState(humanValues, contact.tier) : undefined;
            const developmentLine = development && !thinking ? describeDevelopment(development) : undefined;
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
            // 回忆带着当时的感觉（ADR 0218）：召回的和他的记忆，那天她心里对得上的那种感觉；主动找他时不附
            const feltForRecall = options.memoryFeelings && contact.tier === 'boyfriend' && !initiate
                ? (when: Date, text: string) => feltNoteFor(feltOnDay(new Date(when.getFullYear(), when.getMonth(), when.getDate())), text)
                : undefined;
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
                remembers ? memory.recall(contact, chat, time, { ...recallOptions, ...fade(0), ...(feltForRecall ? { felt: feltForRecall } : {}) }) : undefined,
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
            // 工作房每轮都查：他问“今天帮我干了什么”时不一定有公共记忆线索
            const work = remembers && contact.tier === 'boyfriend' ? you(await memory.recallWork(contact, chat, time)) : undefined;
            if (work) log(`召回工作记忆 ${countLines(work)} 条`);
            // 同一个她（ADR 0177）：他刚才在电脑上（DSH）和她说的，QQ 这边接着知道
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
            // 昨晚真的怎么睡的（ADR 0219，realNights）：早上困不困、为什么困，从她说「睡了」、半夜被吵醒、睡前跟他聊到几点推
            const nightNow = options.realNights && contact.tier === 'boyfriend' && herSchedule
                ? lastNight(everyone.map(qq => ({ qq, messages: options.history.load(qq) })), contact.qq, herSchedule, time) : undefined;
            const bodyNow = herSchedule && character.herWorld?.body ? withLastNight(bodyAt(character.herWorld.body, herSchedule, time), nightNow, time, herDay(herSchedule, time)) : undefined;
            // 状态行（status-line.ts，模拟器的状态行影子比对用同一个函数，ADR 0042）：作息 → 说过「睡了」就在睡 →
            // 空闲时世界里有时长的事（ADR 0030）→ 一天的打算改了的写「本来打算 X，Y，Z」（ADR 0034）
            const asleep = schedule ? asleepAt(time) : undefined;
            // 约好的见面（ADR 0047）：和这个人约的优先；和别人约的只说在外面、约了人
            const meetings = contact.tier !== UNLISTED_TIER ? options.promises?.appointmentsAt?.(time) ?? [] : [];
            const meeting = meetings.find(m => m.contact.qq === contact.qq) ?? meetings[0];
            const appointment = meeting ? describeAppointment(meeting, contact, time) : undefined;
            const status = schedule ? herStatus(schedule, time, {
                extraFree: [...extraFree, ...(options.herPlan?.(time) ?? [])], ...(around ? { world: around } : {}), ...(asleep ? { asleep } : {}), ...(appointment ? { appointment } : {}),
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
            // 这一轮交给解释器的模块（ADR 0336）：先在这里 assess——模块往 turn.facts 写判断，下面的旧逻辑要读（意图、被打断）；段落到最后再收。
            // 她此刻在干嘛、作息、她答应的事、挂着的事、她那边还没说过的事还是旧逻辑算的，写进 facts 给意图阶梯（modules/intent.ts）读
            const herNow = schedule ?? herSchedule;
            const turn: Turn = {
                contact, at: time, history: chat, thinking,
                facts: {
                    ...(crisisNow ? { crisis: crisisNow } : {}), ...(grievance ? { grievance } : {}), ...(around ? { world: around } : {}),
                    ...(state ? { state } : {}), ...(herNow ? { schedule: herNow } : {}), ...(promised ? { promised: true } : {}),
                    ...(loops ? { waiting: loops.waiting.map(l => l.what), unanswered: loops.unanswered.map(l => l.what) } : {}),
                    ...(untold.length ? { news: untold } : {}),
                },
                ...(initiate ? { initiate } : {}), ...(woken !== undefined ? { woken } : {}), ...(offlineSince !== undefined ? { offlineSince } : {}),
            };
            const assessed = assessTurn(options.turnModules ?? [], turn);
            // 都是同步的钩子时不 await，免得多等一个微任务（行为基线核对事件顺序）
            if (assessed instanceof Promise) await assessed;
            // 意图阶梯（ADR 0019 起）是解释器的模块（modules/intent.ts）：assess 时写进 turn.facts.baseIntent（照片 / 被打断改写之前的那一版）
            const baseIntent = turn.facts.baseIntent;
            // 陪玩（ADR 0111）是解释器的模块（modules/together.ts）：assess 时判断、记日志，经 turnModules 放进 together 槽
            // 关系阶段（ADR 0113）是解释器的模块（modules/closeness.ts），经 turnModules 放进 closeness 槽
            // 被打断（ADR 0115）是解释器的模块（modules/interruptions.ts）：聊天正在进行时她那边恰好发生了一件小事，写进 turn.facts.interruption，放进 interrupt 槽
            const interruption = turn.facts.interruption;
            // 照片（ADR 0109）：他明确要看猫 / 风景 / 她的片子，货架里有这一类，允许发（没连着发、今天没发够、不是危机 / 吵醒 / 小别扭 / 他难过），就发；
            // 没有明确对象（只说“发张照片”）取手上有的第一类；要的是她本人（自拍）不在货架里，照旧走“先不发”
            photoNow = undefined;
            photoDishNow = undefined;
            photoPromptNow = undefined;
            currentPhotoUnavailableNow = false;
            if ((options.photos || options.currentAiPhoto) && contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievance && !(baseIntent && /先接住他此刻的情绪/.test(baseIntent))) {
                const photoRequestText = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
                const wanted = initiate ? initiate.photo : photoWanted(photoRequestText);
                const kind = wanted === 'any' ? PHOTO_KINDS.find(k => options.photos?.has(k)) : wanted;
                // 吃的（ADR 0128）：只拿她最近吃的那一顿那道菜的；主动那条自己带着菜名
                const dish = kind === 'food' ? (initiate?.photoDish ?? (around ? lastMealDish(around, time)?.dish : undefined)) : undefined;
                const wantsCurrent = !initiate && Boolean(wanted) && isExplicitCurrentPhotoRequest(photoRequestText);
                const currentKind = wanted === 'any' ? (around && lastMealDish(around, time)?.dish ? 'food' : 'view') : wanted;
                if (wantsCurrent && currentKind && around && options.currentAiPhoto) {
                    const currentDish = currentKind === 'food' ? lastMealDish(around, time)?.dish : undefined;
                    const resolved = options.currentAiPhoto({ kind: currentKind, ...(currentDish ? { dish: currentDish } : {}), at: time, world: around });
                    const exact = resolved.state === 'approved'
                        ? options.photos?.list(currentKind, currentDish).find(entry => entry.id === resolved.shelfId)
                        : undefined;
                    if (exact) {
                        const allowance = photoAllowance(chat, time.getTime(), false, Boolean(woken));
                        if (allowance.allowed) {
                            photoNow = currentKind;
                            photoDishNow = currentDish;
                            photoPromptNow = `[和他这次“现在的照片”请求精确对应、已经人工审核过的照片（只能发这一张，编号不解释）：先用一句话带一下，然后另起一行只写 <photo:${exact.id}>]\n- <photo:${exact.id}>：${exact.caption}`;
                            log(`AI 照片草稿：当前请求已有审核通过的匹配照片 ${exact.id}，这一轮可发`);
                        } else log(`AI 照片草稿：当前请求已有匹配照片，但这一轮不发（${allowance.reason}）`);
                    } else {
                        currentPhotoUnavailableNow = true;
                        log(`AI 照片草稿：当前请求没有已审核匹配照片（${resolved.state}），不拿旧图冒充`);
                    }
                } else if (kind && options.photos?.has(kind, dish)) {
                    const allowance = photoAllowance(chat, time.getTime(), false, Boolean(woken));
                    if (allowance.allowed) { photoNow = kind; photoDishNow = dish; log(`照片货架：他想看${kind}${dish ? `（${dish}）` : ''}，货架里有，这一轮发一张`); }
                    else log(`照片货架：这一轮不发（${allowance.reason}）`);
                }
            }
            // 陪玩（ADR 0111）、关系阶段（ADR 0113）、被打断（ADR 0115）是解释器的模块（见上面 assess 那里）
            // 小梗（ADR 0114）、他的口头习惯（ADR 0138）是解释器的模块（modules/jokes.ts、modules/idioms.ts），经 turnModules 放进 joke、idiom 槽
            // 网络热梗（ADR 0129）是解释器的模块（modules/memes.ts），经 turnModules 放进 meme 槽
            // 她看视频（ADR 0130）是解释器的模块（modules/watched.ts），经 turnModules 放进 watched 槽
            // 真人例子（ADR 0190）：只给她看「真人怎么回」，不给她定字数
            const exemplarNow = options.exemplars?.length && contact.tier === 'boyfriend' && !initiate && !thinking && !crisisNow && !grievance
                ? (() => {
                    const last = chat.findLast(message => message.role === 'user');
                    if (!last) return undefined;
                    return exemplarLine(pickExemplars(options.exemplars!, last.content, { k: 4 }));
                })() : undefined;
            if (exemplarNow) log('真人例子：这一轮放了几条真人的回法（日志不记内容）');
            // 他这句到底在说什么（2026-10-30）是解释器的模块（modules/reading.ts），经 turnModules 放进 reading 槽
            // 场景应答（2026-10-31）：哄睡 / 报错 / 自我怀疑 / 暗号，命中才加一句
            const hisLast = chat.filter(message => message.role === 'user').slice(-1)[0]?.content ?? '';
            // 多问一句、先表态、拿不准就直说（2026-10-31）是解释器的模块（modules/asks.ts），经 turnModules 放进 askHint、opinion、unsure 槽
            const sceneNow = contact.tier === 'boyfriend' && !crisisNow ? readScene(hisLast)?.line : undefined;
            if (sceneNow) log('场景：他这句要特殊接（哄睡 / 报错 / 自我怀疑 / 暗号）');
            // 她可以说出来（2026-11-01）：偶尔告诉她「想让他听见就用语音」
            const voiceNow = contact.tier === 'boyfriend' && !crisisNow && !thinking && !initiate ? voiceHint(voiceRoll(chat)) : undefined;
            if (voiceNow) log('说话：这一轮告诉她可以发语音');
            const questionNow = contact.tier === 'boyfriend' && !crisisNow && !thinking ? options.learningQuestion?.() : undefined;
            const shellNow = contact.tier === 'boyfriend' && !crisisNow ? options.shellNote?.() : undefined;
            const dreamsNow = contact.tier === 'boyfriend' && !crisisNow && options.herFeelings ? options.dreams?.() : undefined;
            const selfThreadNow = contact.tier === 'boyfriend' && !initiate && !thinking && !crisisNow ? options.selfThread?.() : undefined;
            // 他的口气（2026-10-30：说话还是使唤、当程序说话、很元的问题、使唤得比说话多）是解释器的模块（modules/register.ts），经 turnModules 放进 register 槽
            // 她自己总结的说话习惯（ADR 0193）：口气上的参考，危机 / 只想一想 / 小别扭的轮次不放；主动开口也放（习惯不看有没有他的上一句）
            const speechNoteNow = options.speechNotes && contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievance
                ? speechNotesLine(options.speechNotes(), chat.findLast(message => message.role === 'user')?.content) : undefined;
            if (speechNoteNow) log('说话习惯：这一轮放了几条她自己总结的（日志不记内容）');
            // 她回顾聊天时记下的（ADR 0221）：他在难受时不放（那一轮先接住他，别想着自己的毛病）
            const reviewNow = options.chatReview && contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievance && !needsCareText(chat.findLast(message => message.role === 'user')?.content ?? '')
                ? reviewLine(options.chatReview()) : undefined;
            if (reviewNow) log('聊天回顾：这一轮放了她自己记下的（日志不记内容）');
            // 她翻自己日记时发现的自己（ADR 0194）：她对自己的认识，不是设定；放的轮次同说话习惯
            const insightNow = options.diaryInsights && contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievance
                ? insightsLine(options.diaryInsights(), chat.findLast(message => message.role === 'user')?.content) : undefined;
            if (insightNow) log('自我认识：这一轮放了几条她翻日记时发现的自己（日志不记内容）');
            // 她读完 / 看完之后自己想的（ADR 0204）：聊到那本书 / 视频、或问最近看了什么才放；放的轮次同自我认识
            const takesNow = options.readingTakes && contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievance
                ? takesLine(options.readingTakes(), chat.findLast(message => message.role === 'user')?.content) : undefined;
            if (takesNow) log('读完看完的想法：这一轮放了她自己想的（日志不记内容）');
            // 她没想完的问题想出来的（ADR 0207）：他再问到同一件事才放；放的轮次同自我认识
            const thoughtsNow = options.openQuestions && contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievance
                ? thoughtsLine(options.openQuestions(), chat.findLast(message => message.role === 'user')?.content) : undefined;
            if (thoughtsNow) log('没想完的问题：这一轮放了她自己后来想的（日志不记内容）');
            // 她猜的事（ADR 0213）：他这句提到同一类事才放；放的轮次同上
            const guessesNow = options.herGuesses && contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievance
                ? guessesLine(options.herGuesses(), chat.findLast(message => message.role === 'user')?.content, now()) : undefined;
            if (guessesNow) log('她猜的事：这一轮放了她自己记的（日志不记内容）');
            // 梗百科词库（2026-10-29）：她自己的库太小；他提到的词只要词库里有，就把「怎么用/出处/标签」给她。
            // 让路条件和热梗一样；已经在热梗那一行里的不重复给。热梗那一行由热梗模块（modules/memes.ts）在 contribute 时写进 turn.facts.meme，
            // 所以这一行到拼段落时（下面「旧逻辑」模块的 contribute）才算，日志也在那时记
            const dictLine = (memeNow: string | undefined) => options.memeDict && contact.tier === 'boyfriend' && !initiate && !thinking && !crisisNow && !grievance
                && !(baseIntent && /先接住他此刻的情绪/.test(baseIntent))
                ? (() => {
                    const last = chat.findLast(message => message.role === 'user');
                    if (!last) return undefined;
                    const hit = options.memeDict!.mention(last.content);
                    if (!hit || memeNow?.includes(hit.term)) return undefined;
                    return `[他这句里提到一个网络词「${hit.term}」：怎么用——${hit.meaning}${hit.origin ? `；出处——${hit.origin}` : ''}${hit.tags ? `；标签——${hit.tags}` : ''}。你大概知道这个梗：顺着他的意思接，别科普、别解释梗、别拆穿]`;
                })() : undefined;
            // 主动发的那条（喂完猫拍的）意图在 initiate.note 里，这里不再加“他想看”的意图行
            // 被打断的这一轮（ADR 0115）：不带“先直接回答他刚问的”这类意图、不套形状 / 长短提示——它们和“先接他的话、顺带说一声刚被什么岔了一下”冲突，模型会按更紧的那条来、把打断吞掉（模拟 5/5 没提）
            const intent = photoNow && !initiate
                ? (photoPromptNow ? '[这一轮你想：他明确要看现在的照片，你有一张与此刻匹配、已经审核过的：自然带一句后发这一张；别换成别的照片]' : photoIntent(photoNow))
                : currentPhotoUnavailableNow
                    ? '[这一轮你想：他明确要看现在的照片，但现在没有一张已经审核且与此刻匹配的；如实说这会儿发不了，别拿以前的图冒充“现在”，也别承诺马上补发]'
                    : interruption ? undefined : baseIntent;
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
                ? feelingsAt(appraisals({ now: time.getTime(), history: chat, ...(around ? { world: around } : {}), ...(previousAround ? { previousWorld: previousAround } : {}), moments: options.moments?.() ?? [], extra: [...pursuitViewsNow.flatMap(view => view.appraisals), ...(options.feelingReview?.() ?? []), ...(dreamsNow?.appraisals ?? [])] }), time.getTime())
                : [];
            const hisWords = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
            const feelingLine = feltNow.length && !grievanceActive
                ? describeFeelings(feltNow, contact.name, { melt: asksAfterHer(hisWords), voiced: voicedKinds(chat, time.getTime()), mayCry: !criedRecently(chat, time.getTime()) })
                : undefined;
            // 情绪 → 行为（2026-10-30）：心境不再只是提示词里的一行装饰，它决定这一轮说多说少
            const moodNow = moodShape(feltNow);
            const paceLine = feltNow.length && !grievanceActive ? moodPaceLine(moodNow) : undefined;
            if (paceLine) log('心境：这一轮按她此刻的心情收放了说话的量（日志不记内容）');
            // 桌面上的她读同一份（ADR 0197）：那一行按「没有人正好在关心她」重算（melt 只对 QQ 当下这一句话有意义），小别扭那一轮不交
            if (options.onFeelings && options.herFeelings && contact.tier === 'boyfriend' && !crisisNow) {
                const neutral = feltNow.length && !grievanceActive
                    ? describeFeelings(feltNow, contact.name, { melt: false, voiced: voicedKinds(chat, time.getTime()), mayCry: !criedRecently(chat, time.getTime()) })
                    : undefined;
                try { options.onFeelings({ at: time.getTime(), felt: feltNow, line: neutral }); } catch (error) { log(`心境：没能交给桌面上的她（${error instanceof Error ? error.message : String(error)}）`); }
            }
            if (feelingLine) log(`心境：${feltNow.filter(item => item.level !== 'faint').slice(0, 2).map(item => `${FEELING_NAME[item.kind]}·${item.level === 'strong' ? '很重' : '明显'}（${item.source === 'world' ? '她那边的事' : item.source === 'him' ? '他的态度' : item.source === 'self' ? '她自己回想的' : '作者写下的事'}）`).join('、')}（日志不记内容）`);
            textIntimacy = Boolean(intent?.includes('QQ 文字里的抱抱'));
            const picked = (options.candidates ?? 1) > 1 && intent && !initiate ? PICKED_INTENTS.find(p => p.pattern.test(intent)) : undefined;
            const stickerAllowance = options.stickers && !thinking ? imageStickerAllowance(chat, intent, Boolean(woken), crisisNow?.level) : { allowed: false };
            stickersAllowed = stickerAllowance.allowed && !photoNow;
            const saidNow = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
            // 连续性（ADR 0157–0163）：设定改动的背景 / QQ 以外做过的事 / 上网查到的 / 自己发现的口味 / 又见到的人；出错当没有，不挡回复
            const continuityLines = options.continuity && !crisisNow && !thinking
                ? await options.continuity({ contact, said: saidNow, initiating: Boolean(initiate), now: time }).catch(error => {
                    if (error instanceof DOMException && error.name === 'AbortError') throw error;
                    log(`连续性：出错，这一轮不放（${error instanceof Error ? error.message : String(error)}）`);
                    return [] as string[];
                })
                : [];
            // 没有明确反应的轮次也抽一抽（ADR 0132）：她拿不到小黄脸以后，表情包得顶上；抽签的种子和有反应的那条路分开
            const stickerDrawn = stickersAllowed && (stickerCued(saidNow)
                ? stickerTurn(chat, options.stickerChance ?? STICKER_TURN_CHANCE)
                : Boolean(options.stickerUncued) && saidNow.trim().length > 0 && stickerTurn(chat, options.stickerUncued!, 'sticker uncued'));
            stickerOnlyNow = stickerDrawn && stickerOnlyTurn(chat, options.stickerOnlyChance ?? 0);
            stickerContext = stickerDrawn ? { text: saidNow, ...(stickerOnlyNow ? { only: true } : {}) } : undefined;
            if (stickerContext) log(stickerOnlyNow ? '图片表情：这一轮抽到只发表情、不写文字' : '图片表情：这一轮抽到要发一个');
            if (options.stickers && !thinking && !stickersAllowed) log(`图片表情：这轮不用（${stickerAllowance.reason}）`);
            // 深思（ADR 0151）：他是认真在问她的轮次，不套字数和条数、换更强的模型、提示词只留一句“先想清楚”；危机 / 小别扭 / 亲近等别的意图照旧让路
            const deliberateEligible = Boolean(options.deliberate) && !initiate && !crisisNow && !stickerOnlyNow && !photoNow && !interruption && !thinking && !grievanceActive;
            const lexicalDeep = deliberateEligible && deliberateTurn(intent, saidNow, asksToExplain(saidNow));
            // 语义路由（ADR 0202）：关键词没认出来的轮次问一次小模型；只在「关键词说不是、分类说值得认真」时多放行一轮，关键词认出来的照旧
            const routed = deliberateEligible && !lexicalDeep && options.turnWeight && saidNow.trim()
                ? await options.turnWeight({ history: chat, said: saidNow }).catch(() => undefined)
                : undefined;
            deliberateNow = deliberateEligible && (lexicalDeep || wantsDepth(routed));
            routedHint = deliberateNow && !lexicalDeep && routed ? ROUTED_HINTS[routed.kind] : undefined;
            if (deliberateNow) {
                log(!lexicalDeep && routed
                    ? `深思：语义路由认为他这一轮是「${KIND_LABEL[routed.kind]}」${routed.why ? `（${routed.why}）` : ''}，这一轮不套字数和条数、用 ${options.deliberate!.llm.model}、提示词只留一句“先想清楚”${routedHint ? '、再加一小句方向' : ''}`
                    : `深思：他在认真问她，这一轮不套字数和条数、用 ${options.deliberate!.llm.model}、提示词只留一句“先想清楚”`);
            }
            // 深思时那条只管“怎么答”的意图行（先直接回答 / 很大很抽象的问题）由深思那一句代替；追着要答案、说她不像真人这类纠偏的意图行保留
            const intentLine = deliberateNow && intent && /先直接回答他刚问的|他在问一个很大、很抽象的问题/.test(intent) ? undefined : intent;
            // 引用回复（ADR 0136）：他连发里有个不是最后一条的问题，按概率引用它；危机、他难过、主动找他、只发表情 / 照片的回合不引用
            quoteNow = options.quoteReply && !initiate && !thinking && !crisisNow && !stickerOnlyNow && !photoNow && !(baseIntent && /先接住他此刻的情绪/.test(baseIntent))
                ? planQuote(options.history.load(contact.qq), contact.qq, options.quoteShare)
                : undefined;
            const quoteLine = quoteNow ? describeQuote(quoteNow) : undefined;
            if (quoteLine) log('引用回复：这一轮第一条引用他连发里的一个问题（日志不记内容）');
            pick = picked ? {
                kind: picked.kind, maxLines: picked.maxLines, heard: heardSinceReply(chat), banned: [...character.banned, ...ODD_BODY_WORDS, ...STILTED_WORDS],
                // 她自己生活里的东西：猫、相机、在读的书、手上的爱好（DSH 诊断 1.2、ADR 0036 的四类）
                own: [...(around?.cat ? [around.cat.name] : []), '相机', ...character.books.map(book => book.title), '追剧', '调色', '构图', '修片', '摄影区'],
                ...(options.speechCheck ? { speech: speechContext(options.history.load(contact.qq), options.tailCap ? { tailCaps: TAIL_CAPS } : {}) } : {}),
            } : undefined;
            // 长短不一（ADR 0024）：偶尔回句短的、偶尔话多一点；心情安静的日子不加「话多」
            const low = mood?.mood.name === '安静' || (bodyNow ? unwell(bodyNow) : false) || (feelingLine !== undefined && feelsLow(feltNow))
                || Boolean(humanValues && (humanValues.energy <= 30 || humanValues.hunger >= 82 || humanValues.stress >= 78 || humanValues.mood <= 30));
            // 形状控制开着：用具体的字数和条数代替「回短一点」的软提示；不适用的轮次（他明着让她讲、主动找他、收尾）照旧走 lengthHint
            // 她这一天半里已经主动说过的事（ADR 0098）；带自己的事的轮次从她还没说过的事里挑一件说
            const told = !crisisNow ? alreadyTold(chat, time.getTime()) : [];
            const TOLD_LABEL: Record<string, RegExp> = { 相机: /相机/, 猫: new RegExp(`${catAlternative()}猫`), 作业: /作业/, 快递: /快递/ };
            const worldLabels = world ? world.replace(/^\[你那边（[^）]*）：/, '').replace(/\]$/, '').split('｜').map(item => item.split('：')[0]!.trim()).filter(Boolean) : [];
            const agendaTopics = [
                ...worldLabels.filter(label => !told.some(name => TOLD_LABEL[name]?.test(label))),
                ...(body && !told.includes('肚子不舒服') ? ['身体'] : []),
                ...(mood ? ['心情'] : []),
            ];
            // 语言松绑（DSH 10-28 27facc0）：只有“接情绪/好事/亲近/撒娇/认真”或问过去时给形状；普通闲聊不圈条数字数。
            // shapeAll（ADR 0220，默认关）：所有轮次都给形状（回到 ADR 0091 的样子），用来量松绑前后的差别
            shapeNow = options.shape && !crisisNow && !stickerOnlyNow && !photoNow && !interruption && !thinking && !deliberateNow && (Boolean(options.shapeAll) || Boolean(cue) || Boolean(intent && ENGAGED_INTENT.test(intent))) ? planShape({ history: chat, intent, initiating: Boolean(initiate), low, aboutPerson: npcs.length > 0, agenda: options.shapeAgenda, filler: options.shapeFiller, feel: options.shapeFeel, split: options.shapeSplit, ask: options.shapeAsk, long: options.shapeLong, agendaTopics, ...(options.shapeShares ? { shares: options.shapeShares } : {}) }) : undefined;
            // 她最近几条里反复在说的字词（10-22 深夜测试：被追问时原地打转、同一件事说三个晚上）：这一轮提醒她换个反应；主动找他、危机回合不用
            const crutches = !initiate && !crisisNow ? recentCrutches(chat) : [];
            const crutchLine = crutches.length
                ? `[你这几条里反复在说「${crutches.join('」「')}」：这一轮别再用这几个字，换个反应——直接答、逗他、反问、认怂、生气都行]`
                : undefined;
            if (crutchLine) log(`最近反复说的字词：${crutches.join('、')}（提示词里让她换个反应）`);
            // 主动找他时，最近几次开头用了同一个起头词（「刚」「人呢」……）就换一种（ADR 0135）
            const opener = initiate && !crisisNow && !thinking ? repeatedOpener(chat) : undefined;
            const openerLine = opener ? `[你最近几次开头都是「${opener}」：这次换一种开头，别用「${opener}」起头]` : undefined;
            if (openerLine) log(`最近几次开头都是「${opener}」（提示词里让她这次换个开头）`);
            // 说过了就不再自己提（ADR 0098）：事实还在时间块里，他问起来照常答
            const toldLine = told.length && !thinking ? `[这些事你已经主动跟他说过了：${told.join('、')}。他不问，就别再自己提]` : undefined;
            if (toldLine) log(`已经主动说过：${told.join('、')}（提示词里让她不再自己提）`);
            // 她最近心里在想的（ADR 0101）：前后是同一个在想事情的人；主动找他时也带上（她主动说的常常就是这些念头，
            // 还有她自己上网查到的，ADR 0180）
            const innerNow = !crisisNow ? options.innerLine?.() : undefined;
            if (innerNow) log('内心：这一轮提示词里放了她最近的念头');
            // 「/亲热」（ADR 0170）：他刚让她黏一点，接下来几条回复里放一行；每生成一条取一次
            const intimateNow = !initiate && !crisisNow ? options.intimacyLine?.() : undefined;
            if (intimateNow) log('亲热：他刚发过 /亲热，这一轮提示词里让她黏一点');
            // 质感（ADR 0131）发出去之前用的上下文：只对男朋友档；他难过 / 生病 / 小别扭 / 危机的回合不加
            textureNow = options.texture && contact.tier === 'boyfriend' && !thinking
                ? {
                    said: saidNow,
                    serious: Boolean(crisisNow || grievanceActive || sulkNow || needsCareText(saidNow) || (baseIntent && /先接住他此刻的情绪/.test(baseIntent))),
                    recentFaces: faceContext(options.history.load(contact.qq), contact.tier).recent.filter(reply => /\[[\p{Script=Han}A-Za-z0-9]{1,6}\]/u.test(reply)).length,
                    recentTildes: faceContext(options.history.load(contact.qq), contact.tier).recent.slice(-TEXTURE_TILDE_WINDOW).filter(reply => /[～~]\s*$/m.test(reply)).length,
                }
                : undefined;
            const length = crisisNow || shapeNow || cue || stickerOnlyNow || photoNow || interruption || thinking || deliberateNow ? undefined : lengthHint({ history: chat, intent, initiating: Boolean(initiate), low, aboutPerson: npcs.length > 0, shortReplies: options.shortReplies });
            if (length) log(`这一轮说话：${length === 'short' ? '回句短的' : '话多一点'}`);
            if (shapeNow) log(`这一轮形状：每条不超过 ${shapeNow.cap} 字、最多 ${shapeNow.maxBubbles} 条（${shapeNow.kind}${shapeNow.agenda ? `，带自己的事${shapeNow.agendaTopic ? `：${shapeNow.agendaTopic}` : ''}` : ''}${shapeNow.filler ? '，废话' : ''}${shapeNow.long ? '，长答' : ''}${shapeNow.feel ? '，先说小情绪' : ''}${shapeNow.stretch ? '，跟着拖音' : ''}${shapeNow.drawl ? '，语气松一点' : ''}${shapeNow.parts ? `，分 ${shapeNow.parts} 条` : ''}）`);
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
            // 10-30 用户：把她身上「作者写的设定」拿掉——description / personality / scenario / 示例对话不再进提示词。
            // 文件都还在（characters/linmengyao/source 与 st/）；要恢复，把 INJECT_PERSONA 改回 true 即可。
            // 名字、红线（character.banned）、危机承认版卡、每轮拼出来的事实照旧——去掉的是「她该是什么样」，不是「她是谁」。
            // 只留卡里那段「被问是不是 AI」的说明（承认是程序是底线，不能跟设定一起清掉）；open 卡本来没有这段
            const bare = INJECT_PERSONA ? character : { ...character, description: personaFacts(character.description), personality: '', scenario: '', mesExample: '' };
            const turnCard = crisisNow && options.openCard ? options.openCard : thinking ? { character: { ...bare, postHistoryInstructions: '' }, worldInfo } : { character: bare, worldInfo };
            // 他最后说的是哪句（那一行）是解释器的模块（modules/reply-basics.ts），经 turnModules 放进 lastUser 槽；这里的原文只给「理解偏过」那一行用
            const lastUserText = [...chat].reverse().find(message => message.role === 'user')?.content?.trim();
            // 按槽位表拼（ADR 0336 第 4 步）：迁移前这里手写的那一串，现在是「旧逻辑」这个大模块的段落，顺序由 interpreter/slots.ts 定；
            // 以后迁出去的模块经 options.turnModules 加进来。原来按真假判断的照旧按真假，原来无条件放的照旧无条件放
            const when = (slot: Slot, text: string | undefined | false | null): Piece[] => (text ? [{ slot, text }] : []);
            const legacyPieces: Piece[] = [
                ...when('relationship', relationship),
                ...when('summary', summary),
                ...when('recalled', recalled),
                ...when('work', work),
                ...when('desktop', desktop),
                // 那天的流水账放在日记、记忆后面（ADR 0032 调整 3：放在前面时问「昨天都干嘛了」她照着报喂猫、取快递，想不起那天记得住的麻辣烫，1/3）
                ...when('common', common),
                ...(recap ? [{ slot: 'recap' as const, text: recap.text }] : []),
                ...when('today', today),
                ...when('past', past),
                ...aboutNpcs.map(text => ({ slot: 'npcs' as const, text })),
                ...peopleText.map(text => ({ slot: 'people' as const, text })),
                ...(common || today || peopleText.length ? [{ slot: 'disclosure' as const, text: disclosureRules(contact) }] : []),
                { slot: 'time', text: describeTime(chat, time, { initiating: Boolean(initiate), ...(options.lagTail && offlineSince !== undefined ? { offlineSince } : {}) }) },
                ...when('days', days),
                ...(state ? [{ slot: 'state' as const, text: describeState(state, schedule!, { userName: contact.name, woken, partnerApart: true, ...(options.realNights && contact.tier === 'boyfriend' ? { grumpy: true } : {}) }) }] : []),
                // 2026-10-30 线上：她凭空来了一句「今天有点累，就更不想说话了」，他看着莫名其妙——
                // 「你现在」那几行是底子不是话题，没人问就别拿它开头。
                ...(state || body ? [{ slot: 'groundNote' as const, text: '（上面「你现在」和身体那几行是你的底子，不是话题：没人问就别主动说你累了、心情怎样，也别把它当成一句话发出去）' }] : []),
                // 今天的心情（按日期抽的「爱笑」「安静」）不再注入（10-30 用户：这种替她表态的都清掉）：
                // 心情由真实发生的事推出来的 feelingLine 表达。
                ...when('body', body),
                ...when('humanState', humanStateLine),
                ...when('development', developmentLine),
                ...when('unsettled', unsettled),
                ...when('warm', warm),
                ...when('feeling', feelingLine),
                ...when('pace', paceLine),
                ...(books ? [{ slot: 'books' as const, text: books.text }] : []),
                ...when('world', world),
                ...when('practice', practice),
                // 追求（「别挂科」「用新相机拍出满意的东西」）也不再注入（10-30 同一条）：她想追什么，自己说。
                ...when('selfNote', selfNote),
                ...when('plans', plansLine),
                ...when('promised', promised),
                ...when('obstacle', obstacleLine),
                // 放完假他已经回学校了（ADR 0007 调整）：放在事实的最后、离他最新的话最近，免得她信聊天记录里假期中的「我在老家」
                ...when('partnerBack', partnerBack),
                ...when('exemplar', exemplarNow),
                ...when('selfThread', selfThreadNow),
                ...when('shell', shellNow),
                ...when('scene', sceneNow),
                ...when('voice', voiceNow),
                ...when('question', questionNow),
                ...(dreamsNow?.line ? [{ slot: 'dreams' as const, text: dreamsNow.line }] : []),
                // 她独处想事情（think）那一轮不给：想事情不走发送，命令不会跑，只会被当成一个念头存下来（11-02 探针里有一个念头整句是 <<执行：Get-Date …>>）
                ...(contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievanceActive ? [{ slot: 'shellIntent' as const, text: SHELL_INTENT }] : []),
                ...when('speechNote', speechNoteNow),
                ...when('review', reviewNow),
                ...when('insight', insightNow),
                ...when('takes', takesNow),
                ...when('thoughts', thoughtsNow),
                ...when('guesses', guessesNow),
                ...continuityLines.map(text => ({ slot: 'continuity' as const, text })),
                // 她能替他操作的设备（ADR 0148）：危机回合、只想一想（内心）的轮次不给
                ...(options.devices && !crisisNow && !thinking ? [{ slot: 'devices' as const, text: options.devices.menu() }] : []),
                ...when('sticker', stickerContext && options.stickers?.prompt(stickerContext) ? options.stickers.prompt(stickerContext)! : undefined),
                ...when('photo', photoNow && (photoPromptNow ?? options.photos?.prompt(photoNow, photoDishNow)) ? photoPromptNow ?? options.photos!.prompt(photoNow, photoDishNow)! : undefined),
                ...when('intent', intentLine),
                // 这件事她以前理解偏过（10-30）：他这句话和以前被纠正过的事撞上时提醒她
                ...(!initiate && lastUserText && options.understanding?.(lastUserText) ? [{ slot: 'understanding' as const, text: options.understanding(lastUserText)! }] : []),
                // 他说过、做过、答应过的事（10-31 留痕）：最近的几条，聊到相关的再说，不硬塞
                ...(!initiate && options.traces?.() ? [{ slot: 'traces' as const, text: options.traces()! }] : []),
                // 人称、正经问就先直接答、别琢磨怎么接（DSH 10-30 / 10-31）是解释器的模块（modules/reply-basics.ts），经 turnModules 放进 person、directAnswer、noOverthink 槽
                ...(options.selfMemory ? [{ slot: 'selfMemory' as const, text: SELF_MEMORY_NOTE }] : []),
                ...(options.refusalLine?.() ? [{ slot: 'refusal' as const, text: options.refusalLine()! }] : []),
                ...(options.ratingLine?.() ? [{ slot: 'rating' as const, text: options.ratingLine()! }] : []),
                ...(options.lifeLine?.() ? [{ slot: 'life' as const, text: `[你现在的生活] ${options.lifeLine()!}` }] : []),
                ...(options.wakeNote?.() ? [{ slot: 'wake' as const, text: options.wakeNote()! }] : []),
                ...(options.ask?.() ? [{ slot: 'herAsk' as const, text: options.ask()! }] : []),
                ...(options.workRequest?.() ? [{ slot: 'workRequest' as const, text: WORK_REQUEST_NOTE }] : []),
                ...(options.workJudge?.() ? [{ slot: 'workJudge' as const, text: WORK_JUDGE_NOTE }] : []),
                ...(options.workMode?.() ? [{ slot: 'workMode' as const, text: WORK_MODE_NOTE }] : []),
                ...(deliberateNow ? [{ slot: 'deliberate' as const, text: options.deliberate?.note ?? DELIBERATE_NOTE }] : []),
                ...when('routedHint', routedHint),
                ...(length ? [{ slot: 'length' as const, text: describeLength(length, options.shortReplies) }] : []),
                ...(shapeNow ? [{ slot: 'shape' as const, text: describeShape(shapeNow) }] : []),
                ...when('quote', quoteLine),
                ...when('crutch', crutchLine),
                ...when('told', toldLine),
                ...when('opener', openerLine),
                ...when('inner', innerNow),
                ...when('intimate', intimateNow),
                ...when('transcript', transcript),
                ...(options.replyFrame === 'solve' && !initiate && !crisisNow ? [{ slot: 'solveFrame' as const, text: SOLVE_FRAME_NOTE }] : []),
                ...(initiate ? [{ slot: 'initiateNote' as const, text: initiate.note }] : []),
            ];
            const legacy: Module = {
                id: 'contact-legacy',
                // 梗百科那一行要看热梗模块这一轮放了什么（turn.facts.meme），所以在这里、热梗模块之后再算
                contribute: () => {
                    const dictNow = dictLine(turn.facts.meme);
                    if (dictNow) log('梗百科：这一轮查到了他提的词（日志不记内容）');
                    return [...legacyPieces, ...when('memeDict', dictNow)];
                },
            };
            const ran = contributeTurn([...(options.turnModules ?? []), legacy], turn);
            // 都是同步的钩子时不 await，免得多等一个微任务（行为基线核对事件顺序）
            const { afterMain, afterHistory } = ran instanceof Promise ? await ran : ran;
            const prompt = buildPrompt({
                character: turnCard.character,
                worldInfo: turnCard.worldInfo,
                history: shown.chat,
                userName: contact.name,
                userPersona: contact.persona,
                afterMain,
                afterHistory,
                now: time,
                settings: {
                    maxContext: options.prompt.maxContext,
                    maxTokens: completionMaxTokens(useNow() ?? llm),
                    worldInfo: options.prompt.worldInfo,
                    pinExamples: options.prompt.pinExamples,
                },
                countTokens: estimateTokens,
            });
            if (prompt.omittedAfterHistory) log(`提示词预算：为保留他最后一条消息，省略 ${prompt.omittedAfterHistory} 段较低优先级背景（日志不记内容）`);
            promptSource = prompt.messages;
            if (prompt.fallbackReply && crisisNow) prompt.fallbackReply = crisisFallback(crisisNow.level);
            return {
                ...prompt,
                messages: postProcessPrompt(prompt.messages, llm.promptPostProcessing, names),
                ...(crisisNow ? { maxBubbles: 3 } : feltNow.length && !grievanceActive ? { maxBubbles: tunedMaxBubbles(shapeNow ? shapeNow.maxBubbles : 3, moodNow) } : ((intent && /先接住他此刻的情绪|只接他刚说的你们两个人的事|顺着他的话收尾/.test(intent)) || grievanceActive) ? { maxBubbles: shapeNow ? Math.min(2, shapeNow.maxBubbles) : 2 } : shapeNow ? { maxBubbles: shapeNow.maxBubbles } : deliberateNow ? { maxBubbles: DELIBERATE_MAX_BUBBLES } : {}),
                ...(shown.omitted ? { note: `较早的聊天原文 ${shown.omitted} 条不放（事实靠长期记忆${summary ? '和前面的要点' : ''}）` } : {}),
            };
        },
        generate: async messages => {
            const rules = pick;
            if (!rules) return generate(messages, log, useNow());
            // 同一份提示词生成几个，挑扣分最少的（ADR 0041）；返回原文，清理照常在回复器里做
            const all = await Promise.all(Array.from({ length: options.candidates! }, () => generate(messages, log, useNow())));
            const { index, scored } = pickBest(all, rules, clean);
            log(describePick(index, scored));
            return all[index]!;
        },
        clean,
        // 设备指令（ADR 0148）：回复定下来、马上要发的那一刻才登记；被丢弃 / 重写的草稿不会操作他的设备
        beforeSend: () => {
            if (deviceNow && options.devices) options.devices.commit(deviceNow);
            deviceNow = undefined;
        },
        // 出口检查：重写时在后处理过的提示词末尾加一条说明，再按同样的方式后处理一次
        // 打错字再改口（ADR 0024）：拆好条之后、发出去之前。种子只看是谁、说了什么，不看时间：同一句话结果固定
        // （带时间时，假模型的测试里「哟，还知道回来啊」有时被打成「知到」，测试时过时不过）
        decorate: (parts, maxBubbles) => {
            // 危机回合不打错字（ADR 0068）
            if (crisisNow) return parts;
            // 质感（ADR 0131）：先加质感，再打错字（打错字认的是汉字，不碰小黄脸 / 标点）
            let shaped = parts;
            if (options.texture && textureNow) {
                const textured = applyTexture(parts, { seed: `${contact.qq} ${parts.join('|')}`, said: textureNow.said, serious: textureNow.serious, recentFaces: textureNow.recentFaces, recentTildes: textureNow.recentTildes, maxBubbles });
                shaped = textured.parts;
                if (textured.notes.length) log(`质感：${textured.notes.join('；')}`);
            }
            const typo = maybeTypo(shaped, `${contact.qq} ${parts.join('|')}`, maxBubbles, options.recallOwn ? RECALL_SHARE : 0);
            if (typo.note) log(`打错字：${typo.note}`);
            return typo.recall ? { parts: typo.parts, recall: typo.recall } : typo.parts;
        },
        review: async (reply, messages, reviewContext) => {
            let rewrittenDraft: ReturnType<typeof prepareReply> | undefined;
            const regenerate = async (note: string) => {
                rewrittenDraft = prepareReply(await generate(postProcessPrompt([...messages, { role: 'system', content: note }], llm.promptPostProcessing, names), log, useNow()));
                return rewrittenDraft.text;
            };
            const onRewriteAccepted = () => { deviceNow = rewrittenDraft?.devices; };
            const factOptions = options.factCheck && options.factCheck !== 'off' && !crisisNow && !reviewContext?.allowRepeat && promptSource ? {
                mode: options.factCheck, source: promptSource, names, mayDropAll: Boolean(reviewContext?.initiating), ...(options.factAboutHim ? { aboutHim: true } : {}),
                audit: options.factAudit ?? ((auditMessages: OpenAIMessage[]) => chatCompletion({ ...forExtraction(llm), temperature: 0 }, auditMessages, { log })),
                regenerate, onRewriteAccepted, log, ...(options.onFactCheck ? { onRecord: options.onFactCheck } : {}),
            } : undefined;
            // 逐条事实检查（ADR 0137）：先于出口检查——重写出来的话还要过出口检查这一关；危机回合、固定说法（allowRepeat）不查
            const factual = factOptions ? await checkFacts(reply, factOptions) : reply;
            // 事实检查判定“想说的那部分被删光了”：这轮不发；主动消息那边会按“生成的是空的”跳过
            if (factual === '' && reply !== '') return '';
            const reviewOptions: ReviewOptions = {
                // 角色卡的禁用词 + 医书里的词（“肚子坠着”之类，expression.ts 的 ODD_BODY_WORDS）：出了就让她重写
                banned: [...character.banned, ...ODD_BODY_WORDS, ...STILTED_WORDS],
                userName: contact.name,
                ...(options.speechCheck ? { speech: { ...speechContext(options.history.load(contact.qq), options.tailCap ? { tailCaps: TAIL_CAPS } : {}), ...(sulkNow ? { allowGrievance: true } : {}), ...(reviewContext?.allowRepeat ? { allowRepeat: true } : {}) } } : {}),
                ...(reading ? { books: reading } : {}),
                // 小黄脸（ADR 0051）：最近几次带得太密、他认真说事她只回表情
                faces: faceContext(options.history.load(contact.qq), contact.tier),
                ...(textIntimacy ? { textIntimacy: true } : {}),
                ...(options.stickers ? { imageStickers: true } : {}),
                regenerate,
                onRewriteAccepted,
                log,
            };
            let reviewed = crisisNow ? await reviewCrisisReply(factual, reviewOptions, crisisNow.level) : await reviewReply(factual, reviewOptions);
            if (crisisNow) {
                deviceNow = undefined;
                return reviewed;
            }
            // 她想查才查：看到她写 <<查：…>> 才去查，查到就带着结果重写一次；标记不发出去
            const pull = /<<查[：:]\s*([\s\S]*?)>>/.exec(reviewed);
            if (pull) {
                const query = pull[1]!.trim();
                const recalled = query && options.pullRecall ? await options.pullRecall(query).catch(() => undefined) : undefined;
                if (recalled) {
                    log(`她主动查记忆：${query}（${countLines(recalled)} 条）`);
                    reviewed = await regenerate(`（你刚才想起来了：\n${recalled}\n用这些回答他，不要再写 <<查>> 标记。）`);
                }
                reviewed = reviewed.replace(/<<查[：:][\s\S]*?>>/g, '').trim();
            }
            // 形状控制（配置 shape）：出口检查之后再看字数和条数，超了重写一次、还超就在分句处截断
            const shaped = shapeNow ? await shapeReply(reviewed, shapeNow, { regenerate, onRewriteAccepted, log }) : reviewed;
            // 话说到一半（ADR 0141）：形状之后再看，并回去 / 退回去会让一条变长，放在字数检查前面会被再截一次；危机回合不走
            const finished = options.speechCheck ? await finishReply(shaped, { regenerate, onRewriteAccepted, log }) : shaped;
            const final = finalizeReply(finished, reviewOptions);
            return factOptions && final !== factual ? checkFacts(final, { ...factOptions, finalOnly: true }) : final;
        },
        send: options.send,
        ...(options.absorb ? { absorb: (part: string) => options.absorb!(contact.qq, part) } : {}),
        ...(options.quoteReply ? { quote: () => quoteNow?.messageId, quoteFix: (wrongId: number) => quoteFix(contact.qq, wrongId) } : {}),
        ...(options.typing ? { typing: options.typing } : {}),
        ...(options.recallOwn ? { recallOwn: options.recallOwn } : {}),
        ...(options.markRead ? { markRead: () => options.markRead!(contact.qq) } : {}),
        ...(options.react ? { react: (messageId: number, text: string) => options.react!(contact.qq, messageId, text) } : {}),
        ...(options.historyContent ? { stripMarkers: (sent: string) => options.historyContent!(sent) } : {}),
        ...(options.historyContent || options.stickers || options.photos || options.sentHistory ? { historyContent: (sent: string, messageId?: number) => {
            const snapshot = messageId === undefined ? undefined : options.sentHistory?.(sent, messageId);
            if (snapshot !== undefined) return snapshot;
            const clean = options.historyContent ? options.historyContent(sent) : sent;
            const withSticker = options.stickers ? options.stickers.history(clean) : clean;
            return withSticker === clean && options.photos ? options.photos.history(clean) : withSticker;
        } } : {}),
        log,
        now,
        settle: options.settle ?? DEFAULT_SETTLE,
        retryAfterMs: options.retryAfterMs ?? RETRY_AFTER_MS,
        ...(options.onSilence ? { onSilence: options.onSilence } : {}),
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
