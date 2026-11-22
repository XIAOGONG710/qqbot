import { FEWER_RULES_BASICS, fewerRules, isSceneExample } from '../language/fewer-rules.ts';
import { localDate } from '../local-date.ts';
// 一位联系人的回复流水线：召回长期记忆 → 按 ST 顺序拼提示词 → 后处理 → 生成 → 清理（含卡上的 ST 正则）→ 出口检查 → 拆条发送（responder.ts 调度）。
// 出口检查带上聊天记录里她最近几次回复和对方最近几条，查说话的毛病（ADR 0014，配置 speechCheck）。
// 她自己的日子（ADR 0015，配置 herDays）：时间块里状态行下面加今天的心情，聊到书或她正在看书时再加「在读的书」，那一轮出口检查顺带查进度数字。
// 她认识的人（ADR 0016）：他或她最近的话里提到名单里另一个人的称呼（那人写了「别人提起时」），召回之后放一段介绍。
// 记忆（ADR 0018）：召回会变淡，她和名单里的称呼不算「一提就想起」的线索；放进提示词的记忆里她的名字换成「你」。
// bot（main.ts）和模拟器（sim/）共用这一份；模拟器只换掉收发、时钟和数据目录（ADR 0005）。

import { assessTurn, candidatePlan, cleanStages, contributeTurn, DECIDE_STAGES, decideStage, decorateStages, perceiveTurn, reviewStage, type CleanCtx, type DecideCtx, type Draft, type Module, type ReviewCtx, type ReviewStage, type Turn, type TurnFacts } from '../interpreter/interpreter.ts';
import { selfPieces, type Piece, type PlacedPiece } from '../interpreter/slots.ts';
import { promptManifest, type ManifestInput, type PromptManifest } from './prompt-manifest.ts';
import { dirname, join } from 'node:path';
import { noteCharacterTerms } from '../character-terms.ts';
import { UNLISTED_TIER, type AppConfig, type Contact, type Tier } from './config.ts';
import { isClose, sourceLabel, startsConversation, todayStart } from '.././emotion/disclosure.ts';
import { crisisFallback } from '.././language/exit-check.ts';
import type { ChatHistory, StoredMessage } from '.././memory/history.ts';
import { chatCompletion, completionMaxTokens, forExtraction } from '.././language/llm.ts';
import type { Log } from './log.ts';
import { CLEAR_DAYS } from '.././memory/fading.ts';
import type { LongTermMemory } from '.././memory/long-term.ts';
import { buildPrompt, type ChatMessage, type OpenAIMessage, type PromptResult } from '.././language/prompt.ts';
import { cleanUpReply } from '.././language/reply.ts';
import { stripDeviceTokens, type DeviceControl } from './device-actions.ts';
import { createResponder, DEFAULT_SETTLE, RETRY_AFTER_MS, type Responder } from '.././social/responder.ts';
import { loadCharacterCard, type Character } from '.././st/card.ts';
import { postProcessPrompt } from '.././st/prompt-converters.ts';
import { loadWorldInfo, type WorldInfoEntry } from '.././st/world-info.ts';
import { isAckAfterClosing, moodySkip, replyDelays, whenSeen } from '.././social/reply-timing.ts';
import type { SilenceInfo } from '.././social/silence.ts';
import { readingActivities } from '.././life/her-days.ts';
import { crisisInHistory } from '.././emotion/crisis.ts';
import { quoteFix, type QuotePlan } from '.././social/quote-reply.ts';
import type { TurnWeight } from '.././language/turn-weight.ts';
import { DELIBERATE_MAX_BUBBLES } from '.././language/shape.ts';
import { recapDay, unavailableAt, worldAt, type WorldNow, type WorldState } from '.././world/world.ts';
import type { CurrentAiPhotoResult } from '.././proactive/ai-photo-requests.ts';
import { dayPlan, describeSlot } from '.././life/day-plan.ts';
import { bodyAt, diaryBody } from '.././life/body.ts';
import { saidAsleepAt } from '.././life/bedtime.ts';
import { withEveryday } from '.././life/everyday.ts';
import { withMenu } from '.././life/menu.ts';
import { moodShape, tunedMaxBubbles } from '.././emotion/express.ts';
import type { Pursuit } from '.././life/pursuits.ts';
import { appraisals, type Appraisal, type Felt, type Moment } from '.././emotion/feelings.ts';
import type { LedgerEntry } from '../emotion/feeling-ledger.ts';
import type { FeelingsReport } from '../emotion/feeling-export.ts';

import { askedWindow, ASKS_PAST, asksPast, commonCue, describePerson, holidayWords, lingering, mentionedPeople } from '.././life/people.ts';
import { type PromiseKeeper } from '.././life/promises.ts';
import { herDay, type ExtraFreeActivity } from '.././life/schedule.ts';
import type { Summarizer, TurnWindow } from '.././language/context-window.ts';
import { estimateTokens } from '.././language/tokens.ts';
import { selfThreadLine } from '.././language/self-thread.ts';
import { feltDayNote, feltDuring } from '.././emotion/felt-then.ts';
import { lastNight, withLastNight } from '.././life/nights.ts';
import type { HumanValues } from '.././human-values.ts';
import type { PhotoKind, PhotoShelf } from '.././vision/photos.ts';
import type { StickerShelf } from '.././social/stickers.ts';


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
    /** 他问到过去的某一天时，她那天自己写的日记（ADR 0217，默认关）：date 是她的那一天 YYYY-MM-DD */
    diaryOn?: (date: string) => string | undefined;
    /** 回忆带着当时的感觉（ADR 0218，默认关）：想起某一天的事时附一句她那天有依据的感觉；因为他而难过 / 烦 / 担心的不附 */
    memoryFeelings?: boolean;
    /** 感觉账（ADR 0347 第 5 层，默认开）：几天以前的事那天感觉早散了，从只追加的账里配；说法照她的要求换过（疼 / 她妈那块的慌） */
    feltLedger?: () => readonly LedgerEntry[];
    /** 昨晚真的怎么睡的（ADR 0219，默认关）：早上困不困从她说「睡了」、半夜被吵醒、睡前跟他聊推，不按课表；被吵醒有起床气 */
    realNights?: boolean;
    /** 昨晚做的梦（2026-10-31）：一条心境事实 + 早上递给她的一句话 */
    dreams?: () => { appraisals: Appraisal[]; line?: string };
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
    /**
     * 提示词指纹清单（platform/prompt-manifest.ts）：每次生成前（和 onPrompt 同一时机、同一份提示词）拿到这一份的清单——
     * 每段的槽、模块、字数、sha256 和最终消息的条数、哈希，没有正文。不给就不算
     */
    onManifest?: (manifest: PromptManifest) => void;
    /** 能不能把聊天正文写进日志（ADR 0070 第 8 项）；不传就不写 */
    sensitive?: () => boolean;
    /** 毫秒时间戳，默认真实时间；模拟器传虚拟时钟 */
    now?: () => number;
    /** 真人式连续数值（ADR 0222）：只记无原文的审计摘要，不把原始分数交给模型。 */
    humanValues?: (context: { contact: Contact; history: readonly (Pick<StoredMessage, 'role' | 'content'> & { time?: string })[]; at: Date }) => HumanValues | undefined;
    /** 默认调模型接口（llm.ts）；模拟器包一层，在生成中插入对方的消息 */
    generate?: (messages: OpenAIMessage[], log: Log, use?: AppConfig['llm']) => Promise<string>;
    /** 深思（配置 deliberate，ADR 0151）：认真问她的轮次不套字数和条数、用这份更强的模型配置（generate 的第三个参数）、提示词只留一句“先想清楚” */
    deliberate?: { llm: AppConfig['llm'] };
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
    /** 回复节奏（ADR 0075，配置 rhythm）：打字时间按字数、回之前有「看 + 想」；不开就是上线前的老样子（0.8 秒 + 每字 0.1 秒） */
    rhythm?: boolean;
    /** 更短的回复（ADR 0024 的 10-19 调整，配置 shortReplies）：回很短的概率 0.5、认真接话的轮次让路、新措辞；不开就是上线前的老样子（0.35、老措辞） */
    shortReplies?: boolean;
    /** 她自己决定今天想做的事（ADR 0182）：和「在读的书」一起当额外的空闲活动，状态行和「你今天的打算」都带上 */
    herPlan?: (at: Date) => ExtraFreeActivity[];
    /**
     * 她理解人的话（10-30 用户：让她自己学习去理解人说的话）：他这句话和以前被纠正过的事撞上时，
     * 返回一行「上次你这么理解，他纠正过」；没有就不加
     */
    /** 他刚发过「/亲热」（ADR 0170）：接下来几条回复黏一点；每取一次少一条，主动找他、危机回合不取 */
    intimacyLine?: () => string | undefined;
    /** 心境（ADR 0102，配置 herFeelings）：她那边的事、他的态度、作者写下的事，在她心里留下带来由的感受（开心 / 难过 / 担心……），会慢慢散；只给男朋友档，危机回合不放 */
    herFeelings?: boolean;
    /** 每次给他算完心境交出来（ADR 0197）：app.ts 写进灵魂目录，桌面上的她读同一份；出错不影响回复 */
    onFeelings?: (report: FeelingsReport) => void;
    /** 她夜里回想、指出了依据的感受（ADR 0197，配置 feelingReview）：作为「别处算好的评估」进心境；要 herFeelings 开着 */
    feelingReview?: () => readonly Appraisal[];
    /** 设备所有者在当前私聊明确问起已配置的某个群时，按需查该群公开日程或公告 */
    groupRecent?: (question: string, at: Date) => string | undefined | Promise<string | undefined>;
    /** 群里的遭遇（2026-11-14）：有人夸她、冲她发火、说想不开——作为额外评估进心境，要 herFeelings 开着 */
    groupMood?: () => readonly Appraisal[];
    /** 作者写下的、引起她情绪的事（ADR 0102，runtime/bot/moments.json）；每次生成现取 */
    moments?: () => readonly Moment[];
    /** 她自己的追求（ADR 0104，配置 pursuits）：内置两条（别挂科、用新相机拍出满意的东西）加作者在 pursuits.json 里改的 / 加的；每次生成现取 */
    pursuits?: () => readonly Pursuit[];
    /** 她每天碰到的小事（ADR 0106，配置 everydayLife；卡在 loadTierCard 里补）：他问“今天干嘛了 / 有什么好玩的事”时让她从今天的小事里挑具体的说 */
    everydayLife?: boolean;
    /** 回复延迟的长尾（ADR 0105，配置 lagTail）：醒着空着时有一部分消息她在做别的，过一会儿才看到；断网很久之后才回，时间块里写一句（那一句由 modules/time-block.ts 放） */
    lagTail?: boolean;
    /** 她对他的电脑和手机的有限控制（ADR 0148，配置 deviceControl）：只给男朋友档；回复里的 <device:…> 令牌清理时摘出来（Draft.devices），发送前只登记选中那一稿的（App 的 commit 经执行器的 device 动作）。菜单是解释器的模块（modules/devices.ts） */
    devices?: Pick<DeviceControl, 'parse' | 'commit'>;
    /** 他刚才在 DSH 桌面上和她的对话（ADR 0177，配置 crossRecent）：只给男朋友档；返回一段放进提示词的话，没有就不放 */
    desktopRecent?: (now: Date) => string | undefined;
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
    /** 她那边的这件事在桌面上已经说过了（ADR 0347 第 2 层回执，配置 selfReceipts）：经 DecideCtx.toldElsewhere 交给意图阶梯的 news；不给就和原来一样 */
    toldElsewhere?: (id: string) => boolean;
}

/** 问到过去的某一天时，几天以内她那边的事还记得清楚（ADR 0032，同 ADR 0018 的 7 天） */
export const RECAP_DAYS = 7;

export function createContactResponder(options: ContactPipelineOptions): ContactResponder {
    const { contact, card: { character, worldInfo }, llm, memory } = options;
    const names = { user: contact.name, char: character.name };
    const now = options.now ?? Date.now;
    const log: Log = message => options.log(`[${contact.qq}] ${message}`);
    const generate = options.generate ?? ((messages, log, use) => chatCompletion(use ?? llm, messages, { log }));
    /** 深思轮次用更强的模型（ADR 0151）；别的轮次不传，用默认的 */
    const useNow = () => (deliberateNow ? options.deliberate?.llm : undefined);
    /** 清理时交给模块的两个货架（ADR 0336 第 9 步，CleanCtx）：清单的取、聊天记录的写法也还在这里用它们 */
    /** 判断那一串（ADR 0336，DECIDE_STAGES）交给模块的东西：照片货架和「现在的照片」的解析 */
    const decideCtx: DecideCtx = {
        recapOf: (dayStart, time) => recapOf(dayStart, time),
        ...(options.stickers || options.photos ? {
            lists: {
                ...(options.stickers ? { stickers: (context: { text: string; only?: boolean }) => options.stickers!.prompt(context) } : {}),
                ...(options.photos ? { photos: (kind: PhotoKind, dish?: string) => options.photos!.prompt(kind, dish) } : {}),
            },
        } : {}),
        ...(options.dreams ? { dreams: options.dreams } : {}),
        ...(options.continuity ? { continuity: options.continuity } : {}),
        ...(options.intimacyLine ? { intimacyLine: options.intimacyLine } : {}),
        ...(options.selfNote ? { selfNote: options.selfNote } : {}),
        ...(options.promises ? { promises: options.promises } : {}),
        ...(options.toldElsewhere ? { toldElsewhere: options.toldElsewhere } : {}),
        ...(options.humanValues ? { values: { humanValues: options.humanValues, ...(options.worldState?.events ? { worldEvents: () => options.worldState!.events!() } : {}) } } : {}),
        ...(options.stickers ? { stickers: { ...(options.stickerChance !== undefined ? { chance: options.stickerChance } : {}), ...(options.stickerUncued ? { uncued: options.stickerUncued } : {}), ...(options.stickerOnlyChance ? { onlyChance: options.stickerOnlyChance } : {}) } } : {}),
        ...(options.photos ? { photos: options.photos } : {}),
        history: () => options.history.load(contact.qq),
        ...(options.herDays && character.schedule ? { schedule: character.schedule } : {}), ...(options.mood !== undefined ? { mood: options.mood } : {}),
        ...(options.deliberate ? { deliberate: { model: options.deliberate.llm.model, ...(options.turnWeight ? { turnWeight: options.turnWeight } : {}) } } : {}),
        feelings: {
            herFeelings: Boolean(options.herFeelings), everydayLife: Boolean(options.everydayLife), ...(options.herDays && character.schedule ? { schedule: character.schedule } : {}),
            ...(options.pursuits ? { pursuits: options.pursuits } : {}), ...(options.worldState?.events ? { worldEvents: () => options.worldState!.events!() } : {}),
            worldAt: (herWorld, schedule, end) => options.worldState?.at(herWorld, schedule, end) ?? worldAt(herWorld, schedule, end),
            ...(options.moments ? { moments: options.moments } : {}), ...(options.feelingReview ? { feelingReview: options.feelingReview } : {}), ...(options.groupMood ? { groupMood: options.groupMood } : {}),
            ...(options.onFeelings ? { onFeelings: options.onFeelings } : {}),
        }, ...(options.currentAiPhoto ? { currentAiPhoto: options.currentAiPhoto } : {}), log: message => log(message) };
    const shelves: CleanCtx = { ...(options.stickers ? { stickers: options.stickers } : {}), ...(options.photos ? { photos: options.photos } : {}) };
    /**
     * 清理生成的一稿（ADR 0336「生成之后那一段」第 8、9 步）：先摘设备指令（ADR 0148：摘出来放进 Draft.devices，字里不留；没开设备控制也一律摘掉令牌），
     * 再过卡上的 ST 正则、截掉替他说的话（cleanUpReply），最后按清理顺序表交给挂了 cleanAt 的模块（图片表情 → 照片 → 只发表情，modules/media-offers.ts）。
     * 生成的每一稿都清一次：挑候选的每一个、审稿的每次重写、回复器清理的那一稿（次数是行为：货架清理会查索引、记日志）。只清理，不改「选中的那一稿」
     */
    const draftOf = (raw: string): Draft => {
        const devices = options.devices?.parse(raw);
        const text = cleanUpReply(devices ? devices.reply : stripDeviceTokens(raw), names, character.regexScripts);
        const cleaned = turnNow ? cleanStages(options.turnModules ?? [], text, turnNow, shelves) : text;
        return devices ? { text: cleaned, devices } : { text: cleaned };
    };
    /**
     * 这一轮选中的那一稿（Draft）：回复器清理的那一稿（挑候选时就是挑中的那个）；审稿里模块采用了重写（accept）就换成重写稿，
     * 危机回合（dropDevices）换成不带设备指令的。发送前只登记它的设备指令（beforeSend）；挑候选落选的、没被采用的重写稿只清理，不进这里。拼提示词时清掉上一轮的
     */
    let chosen: Draft | undefined;
    const schedule = options.schedule ? character.schedule : undefined;
    const herSchedule = options.herDays ? character.schedule : undefined;
    // 她说过「睡了」（ADR 0042）：对名单里谁说的都算，从说完那一刻起在睡——各个联系人看到的是同一个她（状态行、什么时候看到消息）
    const everyone = [contact.qq, ...(options.contacts ?? []).map(other => other.qq).filter(qq => qq !== contact.qq)];
    const asleepAt = (time: Date) => (schedule ? saidAsleepAt(schedule, everyone.map(qq => options.history.load(qq)), time) : undefined);
    const extraFree = herSchedule ? readingActivities(character.books) : [];
    /** 这一轮是深思轮次（ADR 0151）：生成时用 options.deliberate.llm */
    let deliberateNow = false;
    /** 这一轮第一条要引用他的哪一句（ADR 0136，配置 quoteReply）：buildPrompt 按他没回的那一串定，紧跟着发送时现取 */
    let quoteNow: QuotePlan | undefined;
    /** 这一轮的 turn（拼提示词时建的）：生成之后审稿的模块（ADR 0336 reviewAt）要读它 */
    let turnNow: Turn | undefined;
    /** 这一轮拼出来的提示词（ST 后处理之前，system 还是 system）：事实检查拿它当“她能依据的事实”（ADR 0137） */
    let promptSource: OpenAIMessage[] | undefined;
    /** 每份拼好的提示词对应的清单材料（提示词指纹清单，onManifest 给了才有）：回复器调 onPrompt 时按同一个对象取出、算好交出去 */
    const manifestParts = new WeakMap<object, Pick<ManifestInput, 'at' | 'kind' | 'placed'>>();
    // 刚想起的公共记忆（ADR 0017）、从前（ADR 0022，modules/past.ts）、刚说起的她身边的人（ADR 0033）：接下来两轮没有新线索也沿用，追问时不忘。
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
    const responder = createResponder({
        userId: contact.qq,
        history: options.history,
        buildPrompt: async (chat, { woken, initiate, offlineSince }) => {
            chosen = undefined;
            const time = new Date(now());
            // 只想一想（ADR 0101 内心）：不是在聊天，不要意图行、形状、字数提示、表情；聊天记录当成“回想”放进说明里，不当成要接着回的对话
            const thinking = Boolean(initiate?.think);
            // 这一轮交给解释器的模块（ADR 0336）：turn 在开头就建好（只是一个对象），判断那一串从这里开始；交给别处用的 turnNow 照旧在 perceive 之前才换
            const turn: Turn = {
                contact, at: time, history: chat, thinking, card: character, facts: {},
                ...(initiate ? { initiate } : {}), ...(woken !== undefined ? { woken } : {}), ...(offlineSince !== undefined ? { offlineSince } : {}),
            };
            // 真人数值（ADR 0222）和人格成长层（ADR 0251）是 human-state 模块的 decideAt.values：在这里、第一次 await 之前原位算（理由见 modules/human-state.ts 文件头），
            // 写进 turn.facts.humanValues / development，两行日志也在那里记
            decideStage(options.turnModules ?? [], 'values', turn, decideCtx);
            // 长期记忆只给名单里的人（ADR 0012）
            const remembers = memory && contact.tier !== UNLISTED_TIER;
            // 召回（他的 / 公共的 / 提到的人的、工作房、DSH 桌面、群里最近的、今天和别人聊过的）是记忆模块的 decideAt.recall（modules/memory.ts）：
            // 在这里原位调（几次 await 等 Hindsight、日志的先后都照旧），写进 turn.facts.recall / cue / askedDay / groupEcho
            const recalling = decideStage(options.turnModules ?? [], 'recall', turn, {
                ...decideCtx,
                recall: {
                    ...(remembers ? { memory } : {}), ...(options.contacts ? { contacts: options.contacts } : {}),
                    ...((schedule ?? herSchedule ?? character.schedule) ? { schedule: schedule ?? herSchedule ?? character.schedule } : {}),
                    ...(options.memoryFeelings && contact.tier === 'boyfriend' ? { feltOnDay } : {}),
                    // 感觉账（ADR 0347 第 5 层）：几天以前的事回想记不下那么远，靠账配当时的感觉
                    ...(options.feltLedger ? { feltLedger: options.feltLedger } : {}),
                    ...(options.groupRecent ? { groupRecent: options.groupRecent } : {}), ...(options.desktopRecent ? { desktopRecent: options.desktopRecent } : {}),
                },
            });
            if (recalling instanceof Promise) await recalling;
            // 重要的日子那一行（ADR 0011）是解释器的模块（modules/time-notes.ts）：卡上的日子建卡时就定了，在 contribute 时现算
            if (herSchedule) options.onHerDay?.(time);
            // 先 perceive——看清她此刻（她那边、身体、在干嘛），写进 turn.facts；
            // 下面的旧逻辑和后面的 assess 都读。旧逻辑算的判断在 assess 之前写进同一个 turn
            turnNow = turn;
            const perceived = perceiveTurn(options.turnModules ?? [], turn);
            // 都是同步的钩子时不 await，免得多等一个微任务（行为基线核对事件顺序）
            if (perceived instanceof Promise) await perceived;
            // 她此刻（她那边 ADR 0021、身体 ADR 0025、状态行 ADR 0042 等）是解释器的模块（modules/her-now.ts）：perceive 时写进 turn.facts，
            // 经 turnModules 放进 state、world、body、plans、partnerBack 槽；下面的旧逻辑读 facts
            const { body: bodyNow } = turn.facts;
            // assess 之前原位取的几样（ADR 0336「判断那一串」），先后照旧，写进 turn.facts 给意图阶梯和放段落的模块读：
            // - 他问到过去的某一天（ADR 0032）那天的流水账：记忆模块的 decideAt.recap（流水账经 DecideCtx.recapOf 按这一档的卡算）
            // - 她在 QQ 上的样子（ADR 0083）、她答应的事（ADR 0018）：time-notes 模块的 decideAt.promises
            // - 挂着的事（ADR 0023）：等他说结果的、她问了他没答的、没了结的：warm 模块的 decideAt.loops
            // - 她那边的事还没跟他说过（ADR 0057）：意图阶梯的 decideAt.news
            decideStage(options.turnModules ?? [], 'recap', turn, decideCtx);
            decideStage(options.turnModules ?? [], 'promises', turn, decideCtx);
            decideStage(options.turnModules ?? [], 'loops', turn, decideCtx);
            decideStage(options.turnModules ?? [], 'news', turn, decideCtx);
            // 危机信号（ADR 0068）和小别扭 / 和好的起因（ADR 0074）是解释器的模块（modules/crisis.ts）：排在 assess 的最前面，写进 turn.facts.crisis / grievance；assess 之后读回
            // 接着 assess——模块往 turn.facts 写判断，下面的旧逻辑要读（意图、被打断）；段落到最后再收。
            const assessed = assessTurn(options.turnModules ?? [], turn);
            // 都是同步的钩子时不 await，免得多等一个微任务（行为基线核对事件顺序）
            if (assessed instanceof Promise) await assessed;
            // 这一轮是不是危机回合（ADR 0068，modules/crisis.ts 定的）：下面的梦、连续性、「/亲热」、承认版的卡、兜底、最多几条都按它
            const crisisNow = turn.facts.crisis;
            // 他说起她身边的人（ADR 0033）是解释器的模块（modules/people-around.ts）：assess 时写进 turn.facts.aboutPeople，经 turnModules 放进 npcs 槽；下面的形状和长短读它
            // 意图阶梯（ADR 0019 起）是解释器的模块（modules/intent.ts）：assess 时写进 turn.facts.baseIntent（照片 / 被打断改写之前的那一版）
            // 在读的书（ADR 0015）是解释器的模块（modules/books.ts）：assess 时写进 turn.facts.books、放进 books 槽；这一轮放了书，出口检查拿进度核对
            // 陪玩（ADR 0111）是解释器的模块（modules/together.ts）：assess 时判断、记日志，经 turnModules 放进 together 槽
            // 关系阶段（ADR 0113）是解释器的模块（modules/closeness.ts），经 turnModules 放进 closeness 槽
            // 被打断（ADR 0115）是解释器的模块（modules/interruptions.ts）：聊天正在进行时她那边恰好发生了一件小事，写进 turn.facts.interruption，放进 interrupt 槽
            // 照片（ADR 0109）：他明确要看猫 / 风景 / 她的片子，货架里有这一类，允许发（没连着发、今天没发够、不是危机 / 吵醒 / 小别扭 / 他难过），就发；
            // 没有明确对象（只说“发张照片”）取手上有的第一类；要的是她本人（自拍）不在货架里，照旧走“先不发”
            // 这个判断是解释器的模块（modules/media-offers.ts 的 decideAt.photo）：货架和「现在的照片」的解析经 DecideCtx 给，结果写进 turn.facts（photo、photoDish、photoPrompt、photoUnavailable），下面读
            decideStage(options.turnModules ?? [], 'photo', turn, decideCtx);
            // 陪玩（ADR 0111）、关系阶段（ADR 0113）、被打断（ADR 0115）是解释器的模块（见上面 assess 那里）
            // 小梗（ADR 0114）、他的口头习惯（ADR 0138）是解释器的模块（modules/jokes.ts、modules/idioms.ts），经 turnModules 放进 joke、idiom 槽
            // 网络热梗（ADR 0129）是解释器的模块（modules/memes.ts），经 turnModules 放进 meme 槽
            // 她看视频（ADR 0130）是解释器的模块（modules/watched.ts），经 turnModules 放进 watched 槽
            // 真人例子（ADR 0190）是解释器的模块（modules/exemplars.ts），经 turnModules 放进 exemplar 槽
            // 他这句到底在说什么（2026-10-30）是解释器的模块（modules/reading.ts），经 turnModules 放进 reading 槽
            // 场景应答（2026-10-31：哄睡 / 报错 / 自我怀疑 / 暗号）是解释器的模块（modules/scenes.ts），经 turnModules 放进 scene 槽
            // 多问一句、先表态、拿不准就直说（2026-10-31）是解释器的模块（modules/asks.ts），经 turnModules 放进 askHint、opinion、unsure 槽
            // 她可以说出来（2026-11-01：偶尔告诉她「想让他听见就用语音」）是解释器的模块（modules/voice.ts），经 turnModules 放进 voice 槽
            // 她学的时候没想通的地方（2026-10-31）是解释器的模块（modules/learning-question.ts），经 turnModules 放进 question 槽
            // 命令结果和「可以跑命令」那一行（2026-10-30）是解释器的模块（modules/shell.ts），经 turnModules 放进 shell、shellIntent 槽
            // 梦（2026-10-31）是心境模块的 decideAt.dream：在这里原位读（照片判断之后、最终的意图之前），那一行和它给心境的打分写进 turn.facts
            decideStage(options.turnModules ?? [], 'dream', turn, decideCtx);
            // 她自己最近的日子（心里的线头）、拒绝过的、评价、「你现在的生活」、首轮铺底是解释器的模块（modules/soul.ts）
            // 他的口气（2026-10-30：说话还是使唤、当程序说话、很元的问题、使唤得比说话多）是解释器的模块（modules/register.ts），经 turnModules 放进 register 槽
            // 她自己记下的东西（说话习惯、聊天回顾、日记里发现的自己、读完看完的想法、没想完的问题、她猜的事）是解释器的模块（modules/her-notes.ts）
            // 梗百科词库（2026-10-29）是解释器的模块（modules/meme-dict.ts），挂在热梗之后（读 turn.facts.meme）
            // 主动发的那条（喂完猫拍的）意图在 initiate.note 里，这里不再加“他想看”的意图行
            // 被打断的这一轮（ADR 0115）：不带“先直接回答他刚问的”这类意图、不套形状 / 长短提示——它们和“先接他的话、顺带说一声刚被什么岔了一下”冲突，模型会按更紧的那条来、把打断吞掉（模拟 5/5 没提）
            // 最终的意图和小别扭是否生效是解释器的模块（modules/intent.ts 的 decideAt.intent）：按照片 / 「现在的照片发不了」/ 被打断改写 baseIntent，
            // 写进 turn.facts.intent、grievanceActive、sulk，两行日志也在那里记；下面读
            decideStage(options.turnModules ?? [], 'intent', turn, decideCtx);
            const intent = turn.facts.intent;
            const grievanceActive = Boolean(turn.facts.grievanceActive);
            // 心境那一段（ADR 0102 / 0104 / 0106：她的追求 → 前一天她那边 → 感受 → 那一行、节奏 → 交给桌面上的她）是解释器的模块（modules/feelings.ts 的 decideAt.feelings）：
            // 在原位算（最终的意图、小别扭是否生效之后），按联系人给的那几样经 DecideCtx.feelings 递过去；写进 turn.facts.felt、feelingLine、paceLine，下面的 low、生成时最多几条读
            decideStage(options.turnModules ?? [], 'feelings', turn, decideCtx);
            const feltNow = turn.facts.felt ?? [];
            const moodNow = moodShape(feltNow);
            // 连续性（ADR 0157–0163：设定改动的背景 / QQ 以外做过的事 / 上网查到的 / 自己发现的口味 / 又见到的人）是连续性模块的 decideAt.continuity：
            // 在这里原位取（异步：上网、调模型、记「已告诉他」；只有真去取时才等），取回来的写进 turn.facts.continuity
            const continued = decideStage(options.turnModules ?? [], 'continuity', turn, decideCtx);
            if (continued instanceof Promise) await continued;
            // 图片表情这一轮用不用、抽没抽到、是不是只发表情（ADR 0063 / 0099 / 0132）是解释器的模块（modules/media-offers.ts 的 decideAt.stickers）：
            // 写进 turn.facts.stickersAllowed、stickerDraw、stickerOnly，日志也在那里记；下面读
            decideStage(options.turnModules ?? [], 'stickers', turn, decideCtx);
            // 深思（ADR 0151）和语义路由（ADR 0202）的判断是解释器的模块（modules/deliberate.ts 的 decideAt.deliberate）：在原位判断；要问小模型分类的轮次返回 promise（只有那时才等），
            // 写进 turn.facts.deliberate / routedHint，日志也在那里记。生成时换模型、最多几条还读这里的 deliberateNow
            const deliberated = decideStage(options.turnModules ?? [], 'deliberate', turn, decideCtx);
            if (deliberated instanceof Promise) await deliberated;
            deliberateNow = Boolean(turn.facts.deliberate);
            // 深思时那条只管“怎么答”的意图行（先直接回答 / 很大很抽象的问题）由深思那一句代替；追着要答案、说她不像真人这类纠偏的意图行保留
            // 意图行（深思时去掉「怎么答」那一句）是解释器的模块（modules/intent-line.ts），读 turn.facts.intent / deliberate
            // 引用回复（ADR 0136）是解释器的模块（modules/quote.ts）：contribute 时算、写回 turn.facts.quote，放进 quote 槽；拼完段落之后取回来，发送时引用那条。这里先清掉上一轮的
            quoteNow = undefined;
            // 挑候选（ADR 0041）是解释器的模块（modules/candidates.ts）：contribute 时按最终的意图行定这一轮挑不挑、按什么规则，写进 turn.facts.pick；生成时经 candidatePlan 问
            // 长短和形状要的两样——她这会儿低落不低落（low）、带自己的事时能挑的话题（agendaTopics）——是形状模块的 decideAt.length（modules/shape.ts），今天的心情也在那里现算
            decideStage(options.turnModules ?? [], 'length', turn, decideCtx);
            // 别重复自己（反复说的字词、主动找他的开头、说过了的事，ADR 0098 / 0135）是解释器的模块（modules/repetition.ts），经 turnModules 放进 crutch、opener、told 槽
            // 她最近心里在想的（ADR 0101）是解释器的模块（modules/inner.ts），经 turnModules 放进 inner 槽
            // 「/亲热」（ADR 0170）：他刚让她黏一点，接下来几条回复里放一行；每生成一条取一次
            // 是意图行模块的 decideAt.intimate：在这里原位取（每取一次扣一条、写状态文件），写进 turn.facts.intimateLine
            decideStage(options.turnModules ?? [], 'intimate', turn, decideCtx);
            // 质感（ADR 0131）发出去之前用的上下文是解释器的模块（modules/decorate.ts 的 decideAt.texture，开了 texture 才挂）：写进 turn.facts.texture
            decideStage(options.turnModules ?? [], 'texture', turn, decideCtx);
            // 聊天原文放多少（最近几天 / 最近几轮 + 更早的要点，ADR 0018 / 0043）和记忆这一组的收尾（拼上要点和那一天，写进 turn.facts.memory）是记忆模块的 decideAt.context：
            // 在这里原位调（要点那一下会在后台起一次整理）；放进提示词的原文写进 turn.facts.shown
            decideStage(options.turnModules ?? [], 'context', turn, {
                ...decideCtx,
                context: { recentOnly: Boolean(remembers), ...(options.contextWindow ? { window: options.contextWindow } : {}), ...(options.contacts ? { contacts: options.contacts } : {}) },
            });
            const shown = turn.facts.shown ?? { chat, omitted: 0 };
            const summary = turn.facts.memory?.summary;
            // 危机回合被问是不是真人 / 程序一律承认（ADR 0068 决策 7）：换用承认版的卡，不在运行时叠一条覆盖（ADR 0003 / 0067 的纪律）
            // 想一想的时候卡末尾那句“只输出你要发出去的消息：不写心理活动”正好和要求相反，这一次去掉（只有内心用）
            // 10-30 用户：把她身上「作者写的设定」拿掉——description / personality / scenario / 示例对话不再进提示词。
            // 文件都还在（characters/linmengyao/source 与 st/）；要恢复，把 INJECT_PERSONA 改回 true 即可。
            // 名字、红线（character.banned）、危机承认版卡、每轮拼出来的事实照旧——去掉的是「她该是什么样」，不是「她是谁」。
            // 只留卡里那段「被问是不是 AI」的说明（承认是程序是底线，不能跟设定一起清掉）；open 卡本来没有这段
            const bare = INJECT_PERSONA ? character : { ...character, description: personaFacts(character.description), personality: '', scenario: '', mesExample: '' };
            // 少规矩（ADR 0342，默认关）：卡末尾那段换成只剩真实能力、格式和真话的几句；危机回合照旧用承认版卡
            // 场景世界书里的「场景参考」（只学语气和长短的范例）一并不放
            const plain = fewerRules() ? { ...bare, postHistoryInstructions: FEWER_RULES_BASICS } : bare;
            const plainWorld = fewerRules() ? worldInfo.filter(entry => !isSceneExample(entry)) : worldInfo;
            const turnCard = crisisNow && options.openCard ? options.openCard : thinking ? { character: { ...bare, postHistoryInstructions: '' }, worldInfo } : { character: plain, worldInfo: plainWorld };
            // 图片表情和照片的清单（ADR 0063 / 0109 / 0240）是 media-offers 模块的 decideAt.lists：在这里、所有模块的 contribute 之前原位取
            // （货架每取一次都查索引 / 文件，坏了会抛错；条件一次、内容一次，照旧），写进 turn.facts，经 turnModules 放进 sticker、photo 槽
            decideStage(options.turnModules ?? [], 'lists', turn, decideCtx);
            // 按槽位表拼（ADR 0336）：迁移前这里手写的那一串（第 4 步时包成的「旧逻辑」大模块）已经全部拆成解释器的模块，经 options.turnModules 放；顺序由 interpreter/slots.ts 定
            // 提示词指纹清单（platform/prompt-manifest.ts）：要的时候顺手拿真正放进去的段落（带模块），不要的时候不多算
            const placed: { list?: PlacedPiece[] } = {};
            const ran = contributeTurn(options.turnModules ?? [], turn, options.onManifest ? list => { placed.list = list; } : undefined);
            // 都是同步的钩子时不 await，免得多等一个微任务（行为基线核对事件顺序）
            const { afterMain, afterHistory } = ran instanceof Promise ? await ran : ran;
            // 形状控制（ADR 0091，modules/shape.ts）contribute 时算好写回 turn.facts.shape：生成时按它调最多几条
            const shapeNow = turn.facts.shape;
            quoteNow = turn.facts.quote;
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
            const built = {
                ...prompt,
                messages: postProcessPrompt(prompt.messages, llm.promptPostProcessing, names),
                // 少规矩（ADR 0342）：除了危机回合，不再按心境、意图、形状压条数
                ...(crisisNow ? { maxBubbles: 3 } : fewerRules() ? {} : feltNow.length && !grievanceActive ? { maxBubbles: tunedMaxBubbles(shapeNow ? shapeNow.maxBubbles : 3, moodNow) } : ((intent && /先接住他此刻的情绪|只接他刚说的你们两个人的事|顺着他的话收尾/.test(intent)) || grievanceActive) ? { maxBubbles: shapeNow ? Math.min(2, shapeNow.maxBubbles) : 2 } : shapeNow ? { maxBubbles: shapeNow.maxBubbles } : deliberateNow ? { maxBubbles: DELIBERATE_MAX_BUBBLES } : {}),
                ...(shown.omitted ? { note: `较早的聊天原文 ${shown.omitted} 条不放（事实靠长期记忆${summary ? '和前面的要点' : ''}）` } : {}),
            };
            // 清单跟着这一份提示词走（回复器拿它调 onPrompt 时取）：同一个对象，主动和回复同时在拼也不会串
            if (placed.list) manifestParts.set(built, { at: time, kind: thinking ? 'think' : initiate ? 'initiate' : 'reply', placed: placed.list });
            return built;
        },
        generate: async messages => {
            const plan = turnNow ? candidatePlan(options.turnModules ?? [], turnNow) : undefined;
            if (!plan) return generate(messages, log, useNow());
            // 同一份提示词生成几个，挑扣分最少的（ADR 0041，modules/candidates.ts）：每一个都清理之后再交给模块打分（只清理，不动选中的那一稿）；返回原文，挑中的那个由回复器再清理一次、成为选中的那一稿
            const all = await Promise.all(Array.from({ length: plan.count }, () => generate(messages, log, useNow())));
            return all[plan.choose(all.map(raw => draftOf(raw).text), log)]!;
        },
        // 回复器清理的那一稿就是选中的那一稿
        clean: raw => (chosen = draftOf(raw)).text,
        // 设备指令（ADR 0148）：回复定下来、马上要发的那一刻才登记选中那一稿的（App 经执行器的 device 动作）；挑候选落选的、被丢弃 / 没被采用的重写稿不会操作他的设备
        beforeSend: () => {
            if (chosen?.devices && options.devices) options.devices.commit(chosen.devices);
            chosen = undefined;
        },
        // 出口检查：重写时在后处理过的提示词末尾加一条说明，再按同样的方式后处理一次
        // 发出去之前的修饰（ADR 0336「生成之后那一段」第 11 步）：拆好条之后按修饰顺序表交给挂了 decorateAt 的模块（modules/decorate.ts：先加质感、再打错字，危机回合都不做）
        decorate: (parts, maxBubbles) => (turnNow ? decorateStages(options.turnModules ?? [], parts, turnNow, { original: parts, maxBubbles, canRecall: Boolean(options.recallOwn), log }) : parts),
        review: async (reply, messages, reviewContext) => {
            // 审稿从选中的那一稿开始：模块只改字；重写出来的那一稿先放在一边，模块说采用了（accept）才换成选中的，危机回合（dropDevices）选中的不带设备指令
            let rewrite: Draft | undefined;
            const regenerate = async (note: string) => {
                rewrite = draftOf(await generate(postProcessPrompt([...messages, { role: 'system', content: note }], llm.promptPostProcessing, names), log, useNow()));
                return rewrite.text;
            };
            const onRewriteAccepted = () => { chosen = rewrite; };
            // 审稿顺序表上的位置（ADR 0336「生成之后那一段」）：挂了 reviewAt 的模块在对应的那一步之后跑；都没挂时同步返回原稿，不多等
            const reviewCtx: ReviewCtx = {
                exit: { speechCheck: Boolean(options.speechCheck), tailCap: Boolean(options.tailCap), imageStickers: Boolean(options.stickers) }, history: () => options.history.load(contact.qq),
                regenerate, accept: onRewriteAccepted, dropDevices: () => { chosen = chosen && { text: chosen.text }; }, scratch: {}, log, names, ...(promptSource ? { promptSource } : {}),
                ...(reviewContext?.initiating ? { initiating: true } : {}), ...(reviewContext?.allowRepeat ? { allowRepeat: true } : {}),
            };
            const at = (stage: ReviewStage, text: string) => (turnNow ? reviewStage(options.turnModules ?? [], stage, text, turnNow, reviewCtx) : { text });
            // 逐条事实检查（ADR 0137）是解释器的模块（modules/review-facts.ts），开着 factCheck 时挂在 facts / factsFinal：先于出口检查；主动找他时删光了就 stop，这轮不发
            let atFacts = at('facts', reply);
            if (atFacts instanceof Promise) atFacts = await atFacts;
            if (atFacts.stop) return atFacts.text;
            const factual = atFacts.text;
            // 出口检查那一刻的上下文（禁用词、说话的毛病、在读的书、小黄脸、文字抱抱、图片表情）由出口检查模块在 exit 位置自己算（modules/review-exit.ts），写进 scratch.exitOptions 给删行收尾用；
            // 这个联系人才有的几样经 ReviewCtx.exit / history 给
            // 出口检查 / 危机检查是解释器的模块（modules/review-exit.ts），挂在 exit 位置：危机回合它换成危机检查、不登记设备指令，并到此为止（stop）
            let atExit = at('exit', factual);
            if (atExit instanceof Promise) atExit = await atExit;
            if (atExit.stop) return atExit.text;
            let reviewed = atExit.text;
            // 她想查才查（<<查：…>>）是解释器的模块（modules/review-pull.ts），挂在 pull 位置：查到就带着结果重写一次，查没查到都把标记摘掉
            let atPull = at('pull', reviewed);
            if (atPull instanceof Promise) atPull = await atPull;
            if (atPull.stop) return atPull.text;
            reviewed = atPull.text;
            // 形状控制（配置 shape）：出口检查之后再看字数和条数，超了重写一次、还超就在分句处截断
            // 形状裁剪是形状模块（modules/shape.ts）的 reviewAt.shape：有形状时超字数重写一次、还超就按分句截断
            let atShape = at('shape', reviewed);
            if (atShape instanceof Promise) atShape = await atShape;
            if (atShape.stop) return atShape.text;
            const shaped = atShape.text;
            // 话说到一半（ADR 0141）：形状之后再看，并回去 / 退回去会让一条变长，放在字数检查前面会被再截一次；危机回合不走
            // 话说到一半（ADR 0141）是解释器的模块（modules/review-unfinished.ts），开着 speechCheck 时挂在 unfinished 位置
            let atUnfinished = at('unfinished', shaped);
            if (atUnfinished instanceof Promise) atUnfinished = await atUnfinished;
            if (atUnfinished.stop) return atUnfinished.text;
            const finished = atUnfinished.text;
            // 删行收尾是解释器的模块（modules/review-finalize.ts），挂在 finalize 位置，用上面出口检查那一刻算好的同一份上下文
            let atFinalize = at('finalize', finished);
            if (atFinalize instanceof Promise) atFinalize = await atFinalize;
            if (atFinalize.stop) return atFinalize.text;
            const final = atFinalize.text;
            // 最后再查一次事实：同一个模块，稿子跟第一次查完的不一样时只删行
            let atFactsFinal = at('factsFinal', final);
            if (atFactsFinal instanceof Promise) atFactsFinal = await atFactsFinal;
            return atFactsFinal.text;
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
        // 提示词指纹清单（onManifest）：在原来的 onPrompt 之后，按同一份提示词算清单交出去；算或交出错只记一句，不挡回复。没给 onManifest 时和原来一样
        onPrompt: options.onManifest ? prompt => {
            options.onPrompt?.(prompt);
            const parts = manifestParts.get(prompt);
            if (!parts) return;
            manifestParts.delete(prompt);
            try {
                options.onManifest!(promptManifest({
                    qq: contact.qq, ...parts, messages: prompt.messages,
                    ...(prompt.omittedAfterHistory ? { omittedAfterHistory: prompt.omittedAfterHistory } : {}),
                    fallback: prompt.fallbackReply != null,
                }));
            } catch (error) {
                log(`提示词指纹清单没记下（${error instanceof Error ? error.message : String(error)}），不影响回复`);
            }
        } : options.onPrompt,
        ...(options.sensitive ? { sensitive: options.sensitive } : {}),
    });
    /**
     * 「此刻的她」快照（ADR 0347 第 2 层，方案 docs/plans/2026-11-22-same-her-layer2-self.md 二、1）：不生成、不发送。
     * 和 buildPrompt 同一个 decideCtx、同一份 turnModules、同样的 Turn 构造，只跑「此刻」块要的几步：
     * perceive（她那边、身体、状态行）→ 判断那一串的 promises、loops、news、dream、feelings（按 DECIDE_STAGES 的先后）→ 放段落的那几个模块，
     * 再按 SELF_SLOTS 收段落（slots.ts 的 selfPieces，少规矩跟着同一张表）。段落出自同一个函数、同样的输入，所以和 QQ「此刻」块逐字相同。
     * 堵住的副作用：
     * - 心境不交给 App 的 onFeelings（它改 lastFeelings，回想、梦、群里读）；换成这里接住中性版那一行（melt: false，同 FEELINGS.json），
     *   「他这一句在关心她」的写法只对 QQ 当下那一句有意义；
     * - 判断那一串的日志换成静默的；her-now / inner / warm 自带的日志见 turn.snapshot 不记；
     * - 不跑 values（会落事件）、recall / continuity（等外部）、intimate（每取一次扣一条）、lists、assess、onHerDay；
     * - contribute 只问会给 SELF 槽的那几个模块（SNAPSHOT_MODULES）：别的模块放段落时也记日志、有的抽随机数，跟这份快照无关。
     * 只有 App 给 deviceOwner 建的流水线会被调（ADR 0020 披露分级，见 app.ts）
     */
    const snapshot = async (at: Date): Promise<ContactSnapshot> => {
        const modules = options.turnModules ?? [];
        const history = options.history.load(contact.qq).map(({ role, content, time }) => ({ role, content, time }));
        const turn: Turn = { contact, at, history, thinking: false, card: character, facts: {}, snapshot: true };
        let neutral: FeelingsReport | undefined;
        const quiet: DecideCtx = {
            ...decideCtx, log: () => {},
            ...(decideCtx.feelings ? { feelings: { ...decideCtx.feelings, onFeelings: (report: FeelingsReport) => { neutral = report; } } } : {}),
        };
        const perceived = perceiveTurn(modules, turn);
        if (perceived instanceof Promise) await perceived;
        for (const stage of SNAPSHOT_STAGES) {
            const decided = decideStage(modules, stage, turn, quiet);
            if (decided instanceof Promise) await decided;
        }
        // 心境那一行用中性版（同 FEELINGS.json）：QQ 那一句的 melt 写法不交出去
        if (turn.facts.feelingLine !== undefined) {
            if (neutral?.line) turn.facts.feelingLine = neutral.line;
            else delete turn.facts.feelingLine;
        }
        const pieces: Piece[] = [];
        for (const module of modules) {
            if (!module.contribute || !SNAPSHOT_MODULES.has(module.id)) continue;
            const mine = module.contribute(turn);
            pieces.push(...(mine instanceof Promise ? await mine : mine));
        }
        // 「这两天自己在做的」（selfThread，配置 ownDays）：soul 模块在快照里只放 selfThread 这一行（日记那句 + ownDays 那行，和 QQ 提示词同一段）
        const { world, state, schedule, felt } = turn.facts;
        return { pieces: selfPieces(pieces), facts: { ...(world ? { world } : {}), ...(state ? { state } : {}), ...(schedule ? { schedule } : {}), ...(felt ? { felt } : {}) } };
    };
    return Object.assign(responder, { snapshot });
}

/** 快照跑的判断那一串（先后照 DECIDE_STAGES） */
const SNAPSHOT_STAGES = DECIDE_STAGES.filter(stage => stage === 'promises' || stage === 'loops' || stage === 'news' || stage === 'dream' || stage === 'feelings');
/** 会给 SELF_SLOTS 放段落的模块（状态 / 她那边 / 身体 / 打算、重要的日子 / 答应的事、没了结的、心境 / 梦、念头）；新的 SELF 槽由别的模块放时加在这里 */
const SNAPSHOT_MODULES: ReadonlySet<string> = new Set(['her-now', 'time-notes', 'warm', 'feelings', 'inner', 'soul']);

/** 快照的结果：SELF 要的段落（按 NOW_SLOTS 排好）和算 validUntil / asleep / 她的那一天要的事实 */
export interface ContactSnapshot {
    pieces: Piece[];
    facts: Pick<TurnFacts, 'world' | 'state' | 'schedule' | 'felt'>;
}

/** 联系人流水线：回复器 + 「此刻的她」快照 */
export type ContactResponder = Responder & { snapshot(at: Date): Promise<ContactSnapshot> };
