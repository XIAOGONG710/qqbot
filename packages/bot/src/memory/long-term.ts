// 长期记忆（ADR 0004 决策 3）：名单里的联系人每人每个档位一个 Hindsight bank（ADR 0003「实现时的调整」第 3 条：
// 降档后不会召回高档位时的记忆）。
// - 写入：聊天记录按片段（episodes.ts）写入，一个片段一个 document_id。片段结束（安静 45 分钟）时写，
//   还在进行的片段每多 OPEN_EPISODE_STEP 条也整段写一次，免得早先的话被挤出上下文后又还没进记忆。
//   同一联系人的写入串行执行；每个片段写到第几条记在 runtime/bot/memory/<QQ>-<档位>.json，失败的下次再写。
//   这个进度文件读坏了就从头写（同一个 document_id 再写一次是覆盖，不会重复，ADR 0013 决策 3）。
// - 召回：生成前用这次对方发的几条（加上她上一句）去查，限时；查不到、超时、出错都不注入。
//   结果里属于当前片段的去掉（那部分原文已经在上下文里）。
// - 关系概况：bank 里的 Mental Model「relationship」，后台定期读取，放在 main 之后。
// bank ID 不含原始 QQ 号（调研方案 9.3），用 QQ 号和档位的哈希。
// - 公共记忆库（ADR 0016，选项 shared）：另一个 bank「<前缀>-shared」。名单里除陌生人档以外，每个人的片段写进自己的 bank 之后再写一份，
//   document_id 前面带上是谁的；这些人每轮都从公共库召回，去掉自己的片段（自己的 bank 里已经有了）。写到第几条记在各人的进度文件里。
// - 别人提起某个人时（people.ts），用这一轮的查询召回那个人自己的 bank（recall 的 header、limit）。
// - 记忆会变淡（ADR 0018，fading.ts）：三处召回整理前都按记得多清楚筛，想不起来的不放、记个大概的标出来，他一提实体名又想起；
//   写入说明让 Hindsight 给重要的事标【重要】，召回带上观察背后的事实回查。

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectCrisis } from '../emotion/crisis.ts';
import { ownSourceLabel, sourceLabel } from '../emotion/disclosure.ts';
import type { StoredMessage } from './history.ts';
import { MIDNIGHT_RULE } from '../proactive/follow-ups.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { knowsPeople } from '../life/people.ts';
import type { ChatMessage } from '../language/prompt.ts';
import type { MacroNames } from '../st/macros.ts';
import { EPISODE_GAP_MS, episodeTranscript, localIso, splitEpisodes, type Episode } from './episodes.ts';
import { clarity, IMPORTANT, isSummary, LASTING, lastTouched, withoutMark, type Clarity, type FadeStats } from './fading.ts';
import type { BankConfig, HindsightApi, MentalModelRequest, RecallRequest, RecallResult } from './hindsight.ts';

/** 进行中的片段每多这么多条就整段重写一次 */
export const OPEN_EPISODE_STEP = 30;
/** 关系概况多久重新读一次 */
export const RELATIONSHIP_REFRESH_MS = 10 * 60_000;
/**
 * 召回最多注入几条。召回本身由 max_tokens（600）限量，一般 11–14 条。原来取前 8 条；10-04 换成 PGroonga 之后，
 * 埋在句子里的绰号（「铁锅今天又找我茬了」）能召回了，但关键词按命中的二字词计分，「今天」「找我」这类常见词也给别的记忆加分，
 * 它常排在第 8–10 条，取 8 条会被截掉。12 条约 500 token，在调研方案 6.4「按需召回 300–800」之内。
 * ADR 0018 之后召回取 RECALL_TOKENS（1000），想不起来的筛掉之后仍最多放 12 条。
 */
export const MAX_RECALLED = 12;
/** 公共记忆、被提起的人的记忆各注入几条（ADR 0016：各约 250 token） */
export const SHARED_RECALLED = 6;
/** 一段新对话里给亲密联系人看的「今天跟别人聊过的」最多几条 */
export const TODAY_OTHERS = 3;
export const PERSON_RECALLED = 6;
/**
 * 同一个人和事（召回结果的实体）一次最多放几条（DSH 诊断 1.2）：同学档 10-08 召回 8 条里 3 条是土豆（10-05 一条、10-07 两条，说的是一件事），
 * 他前一天刚嫌过「你怎么总说它的事」，她还是接着说猫。他这次说到的不限
 */
export const SAME_THING_RECALLED = 2;
/** 召回取多少（ADR 0018：想不起来的筛掉之后还要够 MAX_RECALLED 条；以前是 600） */
export const RECALL_TOKENS = 1000;
/** 公共记忆问到某一天时多取一些（之后只留那天的） */
export const DAY_RECALL_TOKENS = 2000;
/** 公共库的实体名（有线索才想起，ADR 0017）多久重读一次；公共库写入之后也重读 */
export const ENTITIES_REFRESH_MS = 10 * 60_000;

const TAGS = ['qq-private'];
const RELATIONSHIP_MODEL_ID = 'relationship';

/**
 * 日期换算的两处坑：凌晨说的「明天」（ADR 0011 调整 12）；「这周日」数错一天——10-09 模拟里周四说的「这周日」被记成「10月12日（周日）」，
 * 12 日是周一，她照着说了「周日，10月12号」（ADR 0043 摘要事实审计）。
 */
const DATE_RULE = `- ${MIDNIGHT_RULE.replace(/；$/, '。')}换算时先看那一行的日期是星期几再往后数（周四说「这周日」是三天后）；写了星期的，日期和星期要对得上。`;

/**
 * 调研方案 9.4 的三个 mission，dispositions 取中间值。retain_mission 按 ADR 0012 决策 1 第 4 条逐条写清：
 * mission 放在 Hindsight 内置抽取规则之前、优先级更高，也不进关键词索引（写入的 context 会进，所以角色说明放在这里）。
 */
export function bankMissions(names: MacroNames) {
    const { char, user } = names;
    return {
        retain_mission: [
            `这是${char}和${user}的 QQ 私聊记录。${char}是 AI 扮演的虚拟角色（在读女大学生），${user}是真人。`,
            '记录里都是真实发出去的消息，不是角色卡示例，也不是草稿。',
            `提取明确出现的信息：${user}自己说的偏好、日程和计划、经历、身体和心情，双方的约定，关系里的表达和修复。`,
            `- 每条写清是谁说的、关于谁，用名字（${user}、${char}），不写「用户」「助手」。`,
            // 不写「虚构」：召回的事实会放进她自己的提示词（10-05 dry-run 时抽出了「林梦瑶说的自己的虚构日常」）
            `- ${char}说的她自己的日常（上课、吃饭、宿舍、猫）照记，但写明是${char}说的，不能记成${user}的事。`,
            `- ${user}说的之后要发生的事（考试、面试、出行、看病、约好的事），写成绝对日期，带上午 / 下午 / 晚上或几点；「明天」「下周三」按那一行所在的日期换算。`,
            DATE_RULE,
            `- 绰号、外号写成「绰号（${user}的什么人）」，例如「铁锅（${user}的组长）」。`,
            '- 否定（不吃香菜）、更正（之前说错了）各单独记一条，保留原话里的否定。',
            IMPORTANT_RULE,
            LASTING_RULE,
            '- 生病、心情不好、很累这类近几天的状态也记，带日期。',
            REACTION_RULE(user, char),
            `- ${char}复述以前聊过的事，不算新事实；寒暄、表情、单纯的附和不记。`,
            `- 不推断沉默的动机，不诊断${user}的人格。`,
        ].join('\n'),
        ...SHARED_MISSIONS,
    };
}

/**
 * 公共记忆库（ADR 0016）的 mission：抽取规则和各人的 bank 同一套（不按档位收紧，用户定），只是聊天对象不止一个人，
 * 每条要写清是在和谁的聊天里。每段原文开头有「和 X 的私聊」，context 也写了是谁。
 */
export function commonBankMissions(char: string) {
    return {
        retain_mission: [
            `这是${char}和她 QQ 名单里几个人的私聊记录，汇在一起。${char}是 AI 扮演的虚拟角色（在读女大学生），聊天对象都是真人，每段开头写了是和谁的私聊。`,
            '记录里都是真实发出去的消息，不是角色卡示例，也不是草稿。',
            `也有${char}自己写的日记（开头写着「${char}的日记」和日期）：里面的事是${char}那天做过的，记成${char}的经历，带上那天的日期。`,
            `还有${char}的周记、假期总结（开头写着「${char}的周记」「${char}的国庆节总结」这样的标题和日期范围）：是她对那段时间的回顾，记成${char}的经历，带上那段时间。`,
            `日记、周记、总结里的事都按那段时间记，不加「${LASTING}」。`,
            `提取明确出现的信息：聊天对象自己说的偏好、日程和计划、经历、身体和心情，${char}说的她自己的日常，双方的约定。`,
            `- 每条写清是在和谁的私聊里、谁说的、关于谁，用名字（${char}和聊天对象的称呼），不写「用户」「对方」「助手」。`,
            `- ${char}说的她自己的日常（上课、吃饭、宿舍、猫）照记，但写明是${char}说的、对谁说的。`,
            '- 聊天对象说的之后要发生的事（考试、面试、出行、看病、约好的事），写成绝对日期，带上午 / 下午 / 晚上或几点；「明天」「下周三」按那一行所在的日期换算。',
            DATE_RULE,
            '- 绰号、外号写成「绰号（谁的什么人）」。',
            '- 否定（不吃香菜）、更正（之前说错了）各单独记一条，保留原话里的否定。',
            IMPORTANT_RULE,
            LASTING_RULE,
            REACTION_RULE('聊天对象', char),
            `- ${char}复述以前聊过的事，不算新事实；寒暄、表情、单纯的附和不记。`,
            '- 不推断沉默的动机，不诊断任何人的人格。',
        ].join('\n'),
        ...SHARED_MISSIONS,
    };
}

/**
 * 重要度（ADR 0018 决策 1）：Hindsight 抽事实时顺带标，召回时看事实（观察看背后的事实）开头有没有这个记号，重要的不变淡。
 * 10-06 临时库实验：一周年、面试标上了，午饭、天气没标；整合成观察后记号会丢
 */
const IMPORTANT_RULE = `- 重要的事（生日、纪念日、考试和面试、吵架与和好、第一次做的事）在这一条开头加「${IMPORTANT}」；吃饭、天气这类日常不加。`;

/**
 * 长期知道的（ADR 0018 实现时的调整 11）：Hindsight 只给原话里带时间词的事实写 occurred_start，没写的按哪天说的变淡；
 * 一直成立的事让 Hindsight 在开头标【长期】，和【重要】一样不变淡（日记、周记、总结里的除外，按那段时间算）
 */
const LASTING_RULE = `- 一直成立、过几个月还该记得的事（偏好和忌口、习惯、身份和工作、家里人和身边的人、一直在做的事，例如在健身、在实习）在这一条开头加「${LASTING}」；某一天发生的事、某天的心情和身体、聊天里的调侃和玩笑不加。「${IMPORTANT}」和「${LASTING}」都该加时两个都加。`;

/**
 * 对方对聊天本身的反应（DSH 诊断 1.2）：10-07 鸽鸽说「你怎么总说它的事」，被记成了「林梦瑶说喂出感情了」，召回里猫更多，她更常说猫。
 * 嫌她老说什么要单独记成他嫌的，召回时她才知道收着点
 */
const REACTION_RULE = (who: string, char: string) =>
    `- ${who}对聊天本身的反应（嫌${char}老说某件事、不想聊某个话题、听腻了、不喜欢她这样说话）单独记一条，写清是谁嫌、嫌的是什么，例如「${who}嫌${char}老说那只猫」；不要记成那件事本身（嫌她老说猫，不是「${char}和猫有感情」）。`;

const SHARED_MISSIONS = {
    observations_mission: [
        '只从有来源的事实整合可复用的理解。',
        '偏好和长期模式优先依据重复证据。',
        '一次事件不要概括成“总是、从不”。',
        '明确更正应修订旧理解；保留有意义的不确定性。',
        '把暂时情绪、长期关系与客观事件分开。',
    ].join('\n'),
    reflect_mission: [
        '作为虚拟角色关系记忆的分析器，依据已有证据生成简短的内部参考。',
        '关注当前关系、未解决问题、修复证据、开放约定和适合承接的话题。',
        '不生成发给用户的聊天回复。',
        '不把离线时间自动解释为冷落，不制造新事件或新承诺。',
        '新事实可修正旧看法；引用实际存在的证据。',
        '没有证据时明确未知。',
    ].join('\n'),
    disposition_skepticism: 3,
    disposition_literalism: 3,
    disposition_empathy: 3,
};

// 关系概况每次都放进她的提示词（main 之后），要短、要是她能直接用的话。
// 10-04 模拟器里旧的源查询（「整理当前关系、未解决事项与修复进展，区分事实和看法」）每次刷新出 1,000–2,000 字的报告：
// 证据范围说明、六七个小标题、一串「无证据」，结构每次都变，max_tokens 500 也没压住。
// ADR 0012 决策 1 第 6 条：max_tokens 会变成「写约 N token」的长度指令，取接口允许的最小值 256；刷新用 low 的预算；
// 写具体日期、过去的事只写结果，免得概况里一直留着过期的「他明天面试」。
export const RELATIONSHIP_MODEL: MentalModelRequest = {
    id: RELATIONSHIP_MODEL_ID,
    name: '关系概况',
    source_query: [
        '用中文写一段 150 字以内的内部参考，给扮演林梦瑶的模型在聊天前看：',
        '你们现在的关系怎么样；有什么事还没聊完或没解决；最近答应过、约好的事。',
        '只写聊天里有证据的；没有的就不写，不要写「无证据」「未知」之类的说明。',
        '写具体的几月几日，不写今天、明天、昨天；已经过去的事只写结果。',
        '一段话，不要标题、列表和来源说明；不制造离线事件，不输出角色回复。',
    ].join(''),
    tags: TAGS,
    max_tokens: 256,
    trigger: { refresh_after_consolidation: true, min_refresh_interval_seconds: 1800, budget: 'low' },
};

/**
 * 她眼中的某个人（ADR 0017）：公共库里每人一个，按名字跨所有人的聊天整理（别人说起他的也算），整理之后自动刷新。
 * 写了「别人提起时」的人被提起时放在介绍下面
 */
export function personModel(id: string, name: string, char: string): MentalModelRequest {
    return {
        id,
        name: `她眼中的${name}`,
        source_query: [
            `用中文写一段 150 字以内的内部参考，给扮演${char}的模型在聊天前看：${char}眼中的${name}。`,
            `${name}是谁、做什么的；最近在忙什么、有什么打算；${char}和${name}之间重要的事、还没聊完的事。各个聊天里提到${name}的都算。`,
            '只写聊天里有证据的；没有的就不写，不要写「无证据」「未知」之类的说明。',
            '写具体的几月几日，不写今天、明天、昨天；已经过去的事只写结果。',
            '一段话，不要标题、列表和来源说明；不输出角色回复。',
        ].join(''),
        tags: TAGS,
        max_tokens: 256,
        trigger: { refresh_after_consolidation: true, min_refresh_interval_seconds: 1800, budget: 'low' },
    };
}

/** 记忆按「联系人 + 档位」分开 */
export interface MemoryContact {
    qq: number;
    tier: string;
}

/** 召回时记忆变淡的参数（ADR 0018）：不算「一提就想起」的名字，拿到各几条的回调 */
export interface FadeOptions {
    ignore?: readonly string[];
    onFade?: (stats: FadeStats) => void;
}

/** 带称呼的（公共记忆标出处、印象用） */
export type NamedContact = MemoryContact & { name: string };

/** 日记在公共库里的 document_id 前缀（ADR 0017） */
export const DIARY_PREFIX = 'diary:';

interface ContactState {
    bankId: string;
    /** 已写入的 mission 版本（mission 改了就重新 PUT） */
    bankConfigured?: string;
    /** 已建好的关系概况的设定版本（RELATIONSHIP_MODEL 改了就 PATCH 并刷新一次）；旧的状态文件里是 true */
    relationshipModel?: string | boolean;
    /** 公共库里「她眼中的他」建好时的设定版本（ADR 0017；称呼改了设定就变） */
    personModel?: string;
    /** 片段 id → 已写入的消息条数 */
    retained: Record<string, number>;
    /** 同上，写进公共记忆库的（ADR 0016）；旧的状态文件里没有 */
    common?: Record<string, number>;
}

/** 公共记忆库的状态（<dir>/common.json） */
interface CommonState {
    bankId: string;
    bankConfigured?: string;
}

/** 一次写入或召回的结果 */
export interface MemoryEvent {
    at: number;
    ok: boolean;
    error?: string;
}

export interface LongTermMemoryOptions {
    api: HindsightApi;
    /** 状态文件目录（runtime/bot/memory） */
    dir: string;
    /** bank ID 前缀 */
    bankPrefix: string;
    /** 召回限时 */
    recallTimeoutMs: number;
    log: (message: string) => void;
    now?: () => number;
    /** 公共记忆库（ADR 0016）：名单里除陌生人档以外的人都写、都召回；默认否 */
    common?: boolean;
}

export class LongTermMemory {
    readonly #options: LongTermMemoryOptions;
    readonly #now: () => number;
    /** 每个联系人（按 #key）的写入排队，保证串行 */
    readonly #queues = new Map<string, Promise<void>>();
    readonly #relationship = new Map<string, { content?: string; fetchedAt: number; fetching?: boolean }>();
    #entities: { names: string[]; fetchedAt?: number } = { names: [] };
    /** 最近一次写入、召回的结果（控制台的状态页，ADR 0010） */
    #lastWrite?: MemoryEvent;
    #lastRecall?: MemoryEvent;

    constructor(options: LongTermMemoryOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        mkdirSync(options.dir, { recursive: true });
    }

    /** 这次启动以来最近一次写入、召回的结果；还没发生过就没有 */
    status(): { lastWrite?: MemoryEvent; lastRecall?: MemoryEvent } {
        return { lastWrite: this.#lastWrite, lastRecall: this.#lastRecall };
    }

    bankId(contact: MemoryContact): string {
        return `${this.#options.bankPrefix}-${this.#hash(contact)}`;
    }

    /** 公共记忆库的 bank（ADR 0016）；没开也照样算出来（模拟器跑完要删） */
    commonBankId(): string {
        return `${this.#options.bankPrefix}-common`;
    }

    /** 把还没写入的片段写进 Hindsight；同一联系人排队执行，返回这一次排进去的任务 */
    sync(contact: MemoryContact, names: MacroNames, history: StoredMessage[]): Promise<void> {
        const key = this.#key(contact);
        const previous = this.#queues.get(key) ?? Promise.resolve();
        const next = previous.then(() => this.#sync(contact, names, history)).catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            this.#lastWrite = { at: this.#now(), ok: false, error: message };
            this.#options.log(`[${contact.qq}] 记忆写入失败：${message}`);
        });
        this.#queues.set(key, next);
        return next;
    }

    async #sync(contact: MemoryContact, names: MacroNames, history: StoredMessage[]): Promise<void> {
        const state = this.#load(contact);
        const episodes = splitEpisodes(history);
        const due = (written: Record<string, number> = {}) => episodes.filter(episode => {
            const done = written[episode.id] ?? 0;
            if (done === episode.messages.length) return false;
            const closed = this.#now() - episode.end.getTime() >= EPISODE_GAP_MS;
            return closed || episode.messages.length - done >= OPEN_EPISODE_STEP;
        });
        const pending = due(state.retained);
        if (pending.length) await this.#retainOwn(contact, names, state, pending);
        if (!this.#options.common || !knowsPeople(contact.tier)) return;
        // 危机相关的片段不写进公共记忆库（ADR 0068 决策 8）：私人库保留事实本身，公共库不留
        const common = due(state.common).filter(episode => {
            const sensitive = episode.messages.some(message => message.role === 'user' && detectCrisis(message.content));
            if (sensitive) {
                (state.common ??= {})[episode.id] = episode.messages.length;
                this.#save(contact, state);
            }
            return !sensitive;
        });
        try {
            // 印象（ADR 0017）不等新片段：聊天早就都写进公共库的人（10-06 的鸽鸽），不然一直建不起来
            const bankId = await this.#ensureCommonBank(names.char);
            await this.#ensurePersonModel(contact, names, state, bankId);
            if (common.length) await this.#retainCommon(contact, names, state, common, bankId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#lastWrite = { at: this.#now(), ok: false, error: message };
            this.#options.log(`[${contact.qq}] 记忆（公共）写入失败：${message}`);
        }
    }

    /** 写进公共记忆库：document_id 带上是谁的（哈希，不带 QQ 号），原文开头写和谁的私聊 */
    async #retainCommon(contact: MemoryContact, names: MacroNames, state: ContactState, episodes: Episode[], bankId: string): Promise<void> {
        for (const episode of episodes) {
            await this.#options.api.retain(bankId, {
                content: `和${names.user}的私聊\n${episodeTranscript(episode, names)}`,
                timestamp: localIso(episode.start),
                context: `QQ 私聊：${names.char}（AI 扮演）和${names.user}`,
                document_id: `${this.#hash(contact)}:${episode.id}`,
                tags: TAGS,
                metadata: { source: 'qq', episode: episode.id, messages: String(episode.messages.length) },
                entities: [{ text: names.user, type: 'PERSON' }, { text: names.char, type: 'PERSON' }],
            });
            (state.common ??= {})[episode.id] = episode.messages.length;
            this.#save(contact, state);
            this.#lastWrite = { at: this.#now(), ok: true };
            this.#options.log(`[${contact.qq}] 记忆（公共）：片段 ${episode.id}（${episode.messages.length} 条）已提交给 Hindsight`);
            // 新片段可能带来新的人和事，下一轮重读实体名
            this.#entities.fetchedAt = undefined;
        }
    }

    /**
     * 她的日记（ADR 0017）写进公共库：document_id 是 diary:<日期>（同一天再写是覆盖），标签多一个 diary。
     * 成功返回 true；失败记日志、返回 false（下次再写）
     */
    async retainDiary(date: string, day: Date, text: string, char: string): Promise<boolean> {
        return this.#retainWritten(`${DIARY_PREFIX}${date}`, day, `${char}的日记（${date}）`, text, char, 'diary', `她的日记：${date}`);
    }

    /**
     * 周记、阶段总结（ADR 0018 决策 3）写进公共库：document_id 是 week:<周一>、phase:<假期名>:<最后一天>，标签多一个 week / phase，
     * 时间写最后那天晚上。title 是正文前面那一行（「林梦瑶的周记（10月5日–10月11日）」）
     */
    async retainSummary(documentId: string, lastDay: Date, title: string, text: string, char: string, tag: 'week' | 'phase'): Promise<boolean> {
        return this.#retainWritten(documentId, lastDay, title, text, char, tag, `她的${tag === 'week' ? '周记' : '阶段总结'}：${documentId}`);
    }

    /** 她自己写的东西存进公共库；成功返回 true，失败记日志、返回 false（下次再写） */
    async #retainWritten(documentId: string, day: Date, title: string, text: string, char: string, tag: string, what: string): Promise<boolean> {
        if (!this.#options.common) return false;
        try {
            const bankId = await this.#ensureCommonBank(char);
            await this.#options.api.retain(bankId, {
                content: `${title}\n${text}`,
                // 日记是睡前写的：时间写那天晚上
                timestamp: localIso(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 22)),
                context: `${char}自己写的${tag === 'diary' ? '日记' : tag === 'week' ? '周记' : '阶段总结'}`,
                document_id: documentId,
                tags: [...TAGS, tag],
                metadata: { source: tag, ...(tag === 'diary' ? { date: documentId.slice(DIARY_PREFIX.length) } : { id: documentId }) },
                entities: [{ text: char, type: 'PERSON' }],
            });
            this.#lastWrite = { at: this.#now(), ok: true };
            this.#entities.fetchedAt = undefined;
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#lastWrite = { at: this.#now(), ok: false, error: message };
            this.#options.log(`${what} 写进公共记忆失败，下次再写：${message}`);
            return false;
        }
    }

    /**
     * 读回以前写的日记正文（ADR 0018：写周记要用，本地以前没存原文）。没有这篇、没开公共库、接口没有这个方法都是 undefined；连不上抛错
     */
    async readDiary(date: string): Promise<string | undefined> {
        const get = this.#options.api.getDocument;
        if (!this.#options.common || !get) return undefined;
        const document = await get.call(this.#options.api, this.commonBankId(), `${DIARY_PREFIX}${date}`, this.#options.recallTimeoutMs);
        const text = document?.original_text;
        // 正文前面有一行「林梦瑶的日记（日期）」
        return text ? text.slice(text.indexOf('\n') + 1).trim() || undefined : undefined;
    }

    /** 公共库里「她眼中的他」：没有就建，设定变了（称呼改了）就改设定、刷新一次 */
    async #ensurePersonModel(contact: MemoryContact, names: MacroNames, state: ContactState, bankId: string): Promise<void> {
        const model = personModel(this.#personModelId(contact), names.user, names.char);
        const version = createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0, 12);
        if (state.personModel === version) return;
        if (!(await this.#options.api.getMentalModel(bankId, model.id))) {
            await this.#options.api.createMentalModel(bankId, model);
        } else {
            await this.#options.api.updateMentalModel(bankId, model.id, model);
            await this.#options.api.refreshMentalModel(bankId, model.id);
        }
        state.personModel = version;
        this.#save(contact, state);
        this.#options.log(`[${contact.qq}] 记忆（公共）：「${model.name}」已建好`);
    }

    async #ensureCommonBank(char: string): Promise<string> {
        const path = join(this.#options.dir, 'common.json');
        const bankId = this.commonBankId();
        const stored = readJsonOr<Partial<CommonState>>(path, {}, message => this.#options.log(message));
        const state: CommonState = stored.bankId === bankId ? { bankId, ...(stored.bankConfigured ? { bankConfigured: stored.bankConfigured } : {}) } : { bankId };
        const missions = commonBankMissions(char);
        const version = createHash('sha256').update(JSON.stringify(missions)).digest('hex').slice(0, 12);
        if (state.bankConfigured !== version) {
            await this.#options.api.putBank(bankId, { name: `${char} 的公共记忆（名单里的人）`, ...missions });
            writeJsonAtomic(path, { ...state, bankConfigured: version });
            this.#options.log(`记忆：公共记忆库 ${bankId} 已写入 mission`);
        }
        return bankId;
    }

    async #retainOwn(contact: MemoryContact, names: MacroNames, state: ContactState, pending: Episode[]): Promise<void> {
        await this.#ensureBank(contact, names, state);
        for (const episode of pending) {
            await this.#options.api.retain(state.bankId, {
                content: episodeTranscript(episode, names),
                // 带本机时区：抽取时按这个时间的日期、星期换算「明天」（ADR 0012 决策 1 第 2 条）
                timestamp: localIso(episode.start),
                // context 会进每条事实和关键词索引，只写一句；角色说明在 retain_mission 里（ADR 0012 决策 1 第 1 条）
                context: `QQ 私聊：${names.char}（AI 扮演）和${names.user}`,
                document_id: episode.id,
                tags: TAGS,
                metadata: { source: 'qq', episode: episode.id, messages: String(episode.messages.length) },
            });
            state.retained[episode.id] = episode.messages.length;
            this.#save(contact, state);
            this.#lastWrite = { at: this.#now(), ok: true };
            this.#options.log(`[${contact.qq}] 记忆：片段 ${episode.id}（${episode.messages.length} 条）已提交给 Hindsight`);
        }
    }

    async #ensureBank(contact: MemoryContact, names: MacroNames, state: ContactState): Promise<void> {
        const missions = bankMissions(names);
        const version = createHash('sha256').update(JSON.stringify(missions)).digest('hex').slice(0, 12);
        if (state.bankConfigured !== version) {
            const config: BankConfig = { name: `${names.char} × ${names.user}（${contact.tier}）`, ...missions };
            await this.#options.api.putBank(state.bankId, config);
            state.bankConfigured = version;
            this.#save(contact, state);
            this.#options.log(`[${contact.qq}] 记忆：bank ${state.bankId}（${contact.tier}）已写入 mission`);
        }
        const modelVersion = createHash('sha256').update(JSON.stringify(RELATIONSHIP_MODEL)).digest('hex').slice(0, 12);
        if (state.relationshipModel !== modelVersion) {
            if (!(await this.#options.api.getMentalModel(state.bankId, RELATIONSHIP_MODEL_ID))) {
                await this.#options.api.createMentalModel(state.bankId, RELATIONSHIP_MODEL);
            } else {
                // 已经有了（旧设定建的）：改设定，再刷新一次让内容按新设定重写
                await this.#options.api.updateMentalModel(state.bankId, RELATIONSHIP_MODEL_ID, RELATIONSHIP_MODEL);
                await this.#options.api.refreshMentalModel(state.bankId, RELATIONSHIP_MODEL_ID);
                this.#options.log(`[${contact.qq}] 记忆：关系概况的设定改了，已更新并重新整理`);
            }
            state.relationshipModel = modelVersion;
            this.#save(contact, state);
        }
    }

    /**
     * 召回和这次对话相关的旧事，整理成一段提示；没有就返回 undefined。出错只记日志。
     * query 不传就用 recallQuery；window：时间检索用的时间窗（只加权、不过滤），主动找他时用（ADR 0012 决策 1 第 7 条）。
     * 别人提起这个人时（ADR 0016）也用这个查他的 bank，chat 是提起他的那段聊天，header、limit 换成那一段的。
     * 记忆会变淡（ADR 0018）：ignore 是不算「一提就想起」的名字（她的、名单里的称呼），onFade 拿到各几条
     */
    async recall(
        contact: MemoryContact, chat: ChatMessage[], now: Date,
        options: { query?: string; window?: { start: Date; end: Date }; header?: string; limit?: number } & FadeOptions = {},
    ): Promise<string | undefined> {
        const state = this.#load(contact);
        if (!state.bankConfigured) return undefined;
        const query = options.query ?? recallQuery(chat);
        if (!query) return undefined;
        const results = await this.#recall(state.bankId, recallRequest(query, now, options.window), `[${contact.qq}] 记忆召回失败，这次不带记忆`);
        if (!results) return undefined;
        const current = currentEpisodeId(chat);
        return formatRecalled(results.filter(r => !current || r.document_id !== current), {
            header: options.header, limit: options.limit, now, fade: this.#fade(chat, options),
        });
    }

    #fade(chat: readonly ChatMessage[], options: FadeOptions): FadeRequest {
        return { heard: heardSinceReply(chat), ignore: options.ignore ?? [], ...(options.onFade ? { onFade: options.onFade } : {}) };
    }

    /**
     * 公共记忆（ADR 0016）：名单里除陌生人档以外的人有线索时查（ADR 0017，线索由调用方判断），去掉他自己的片段。
     * 只要事实（带 document_id 才分得出是谁的），不要整合过的观察（可能混着他自己的事）。
     * 每条标出是和谁聊的（ADR 0017）：people 是整个名单，document_id 的哈希对回称呼；日记标「你的日记」。
     * window：问的是某一天（people.ts 的 askedDay）；fade 同 recall
     */
    async recallCommon(
        contact: NamedContact, chat: readonly ChatMessage[], now: Date, people: readonly NamedContact[], window?: { start: Date; end: Date; period?: string }, fade: FadeOptions = {},
        focus: readonly string[] = [],
    ): Promise<string | undefined> {
        if (!this.#options.common || !knowsPeople(contact.tier)) return undefined;
        const stored = readJsonOr<Partial<CommonState>>(join(this.#options.dir, 'common.json'), {}, message => this.#options.log(message));
        if (stored.bankId !== this.commonBankId() || !stored.bankConfigured) return undefined;
        const query = recallQuery(chat);
        if (!query) return undefined;
        // 问的是某一天（ADR 0017）：时间窗只加权，多取一些，只留那天的
        const request: RecallRequest = {
            ...recallRequest(query, now, window), types: ['world', 'experience'], prefer_observations: false, ...(window ? { max_tokens: DAY_RECALL_TOKENS } : {}),
        };
        const commonFound = await this.#recall(stored.bankId, request, `[${contact.qq}] 公共记忆召回失败，这次不带`);
        if (!commonFound) return undefined;
        const found = commonFound;
        // 问上周、问假期时，周记、阶段总结单独按标签再召回一次（ADR 0026：日记里的事多了以后，周记的条目有时排不进上面那次的名额，3/9 次问上周没想起周记）
        const summaryTag = window?.period === 'week' ? 'week' : window?.period === 'holiday' ? 'phase' : undefined;
        const summaries = summaryTag
            ? await this.#recall(stored.bankId, { ...request, tags: [...request.tags, summaryTag] }, `[${contact.qq}] ${summaryTag === 'week' ? '周记' : '阶段总结'}召回失败，这次只用上面的`)
            : undefined;
        const all = summaries?.length ? [...summaries, ...found.filter(r => !summaries.some(s => s.id === r.id))] : found;
        // 问到某段时间时，那段的周记、阶段总结排在前面（ADR 0018：「上周忙啥」「国庆过得怎样」整体答）
        // 问的是某一天：只留那天的，那天的日记排前面（ADR 0018 第二批：「昨天」那天正好是国庆最后一天，总结里的几条占满名额，把那天的日记挤掉了）
        const inWindow = !window ? all
            : window.period
                ? all.filter(r => onDay(r, window.start, window.end) || summaryIn(r, window)).sort((a, b) => Number(isSummary(b)) - Number(isSummary(a)))
                : all.filter(r => onDay(r, window.start, window.end) || diaryIn(r, window)).sort((a, b) => Number(diaryIn(b, window)) - Number(diaryIn(a, window)));
        // 他说起的人和事（focus，ADR 0017 的线索）：带着它的排在前面（ADR 0018 第一批：说起杭州，6 条名额被日记占满，鸽鸽去杭州那条排在外面）
        const about = (r: RecallResult) => focus.some(name => r.entities?.includes(name) || r.text.includes(name));
        const results = focus.length ? [...inWindow].sort((a, b) => Number(about(b)) - Number(about(a))) : inWindow;
        const own = `${this.#hash(contact)}:`;
        return formatRecalled(results.filter(r => !r.document_id?.startsWith(own)), {
            header: `[你和名单里别的人聊天时说过、听过的事（从记忆里想起来的，只作参考；不是和${contact.name}聊的，用不上就别提）]`,
            limit: SHARED_RECALLED,
            now,
            fade: { ...this.#fade(chat, fade), ...(window ? { window } : {}) },
            source: this.#commonSource(contact, people),
        });
    }

    /**
     * 他在 DSH 里让她干的活（工作房）：每轮都查，不依赖“公共记忆线索”。
     * 工作房的事实是 observation、且没有 qq-private 标签，所以单独放开类型和标签过滤。
     */
    async recallWork(contact: NamedContact, chat: readonly ChatMessage[], now: Date): Promise<string | undefined> {
        const query = recallQuery(chat);
        if (!query) return undefined;
        const request: RecallRequest = {
            ...recallRequest(query, now),
            types: ['world', 'experience', 'observation'],
            prefer_observations: true,
            tags: [],
            tags_match: 'any' as unknown as RecallRequest['tags_match'],
        };
        const results = await this.#recall(`${this.#options.bankPrefix}`, request, `[${contact.qq}] DSH 记忆召回失败，这次不带`);
        if (!results?.length) return undefined;
        return formatRecalled(results.map(result => ({ ...result, document_id: result.document_id ?? 'dsh-work' })), {
            header: `[你在 DSH 里做过的事（包括帮他干活；从记忆里想起来的，只作参考）]`,
            limit: 3,
            now,
            fade: this.#fade(chat, {}),
            source: () => '你干过的事',
        });
    }

    /** 她自己决定要记的事（回复里的 <<记住：…>> / <<日记：…>>）：写进公共库，标 self */
    async rememberSelfNote(contact: NamedContact, content: string, kind: '记住' | '日记' = '记住'): Promise<void> {
        const text = content.trim().slice(0, 2000);
        if (!text || !this.#options.common) return;
        await this.#options.api.retain(this.commonBankId(), {
            content: `林梦瑶自己记下的${kind}：${text}`,
            context: kind,
            document_id: `${kind === '日记' ? 'diary-self' : 'self'}:${this.#hash(contact)}:${Date.now()}`,
            timestamp: new Date().toISOString(),
            tags: ['qq-private', 'self'],
            metadata: {},
        });
    }

    /**
     * 今天和名单里别人聊过的（ADR 0020）。只取今天产生的其他联系人片段，不取日记/周记/总结，也不取眼前这个人的。
     * contact.ts 只会在亲密联系人开启一段新对话或她主动找他时调用；这里仍保留通用的权限检查。
     */
    async othersToday(contact: NamedContact, now: Date, people: readonly NamedContact[], start: Date): Promise<string | undefined> {
        if (!this.#options.common || !knowsPeople(contact.tier)) return undefined;
        const stored = readJsonOr<Partial<CommonState>>(join(this.#options.dir, 'common.json'), {}, message => this.#options.log(message));
        if (stored.bankId !== this.commonBankId() || !stored.bankConfigured) return undefined;
        const own = this.#hash(contact);
        const owners = new Set(people.map(person => this.#hash(person)).filter(hash => hash !== own));
        if (owners.size === 0) return undefined;
        const end = new Date(now.getTime() + 60_000);
        const otherNames = people.filter(person => owners.has(this.#hash(person))).map(person => person.name).join('、');
        const all = await this.#recall(stored.bankId, {
            ...recallRequest(`今天和${otherNames}聊了什么`, now, { start, end }),
            types: ['world', 'experience'],
            prefer_observations: false,
        }, `[${contact.qq}] 今天和别人聊过的召回失败，这次不带`);
        if (!all) return undefined;
        const today = all.filter(result => {
            const owner = (result.document_id ?? '').split(':')[0]!;
            return owners.has(owner) && mentionedOnDay(result, start, end);
        });
        return formatRecalled(today, {
            header: `[你今天和别人聊过的事（是你今天的一部分，不是和${contact.name}聊的；只挑大面上的一件，有自然由头时含糊地随口提，不要一上来汇报）]`,
            limit: TODAY_OTHERS,
            now,
            source: this.#commonSource(contact, people),
        });
    }

    /** 公共库每条事实的出处和披露上限（ADR 0020）。 */
    #commonSource(listener: NamedContact, people: readonly NamedContact[]): (result: RecallResult) => string | undefined {
        const owners = new Map(people.map(person => [this.#hash(person), person]));
        return result => {
            const id = result.document_id ?? '';
            if (id.startsWith(DIARY_PREFIX)) return ownSourceLabel('你的日记', listener);
            if (id.startsWith('week:')) return ownSourceLabel('你的周记', listener);
            if (id.startsWith('phase:')) return ownSourceLabel(`你${id.split(':')[1]}的总结`, listener);
            if (id.startsWith('qq-work-') || id.startsWith('dsh-')) return '你干过的事';
            const owner = owners.get(id.split(':')[0]!);
            return owner ? sourceLabel(owner, listener) : '不能说·来源不明';
        };
    }

    async #recall(bankId: string, request: RecallRequest, failure: string): Promise<RecallResult[] | undefined> {
        try {
            const results = await this.#options.api.recall(bankId, request, this.#options.recallTimeoutMs);
            this.#lastRecall = { at: this.#now(), ok: true };
            return results;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#lastRecall = { at: this.#now(), ok: false, error: message };
            this.#options.log(`${failure}：${message}`);
            return undefined;
        }
    }

    /**
     * 公共库里的实体名（ADR 0017：他的话里出现了才去想公共记忆）。过期了就当场重读（本机，限时同召回），读不到用上一次的；
     * 没开公共库、接口没有这个方法、公共库还没建都是空的
     */
    async commonEntities(): Promise<readonly string[]> {
        const list = this.#options.api.listEntities;
        if (!this.#options.common || !list) return [];
        const cached = this.#entities;
        if (cached.fetchedAt !== undefined && this.#now() - cached.fetchedAt < ENTITIES_REFRESH_MS) return cached.names;
        try {
            this.#entities = { names: await list.call(this.#options.api, this.commonBankId(), this.#options.recallTimeoutMs), fetchedAt: this.#now() };
        } catch (error) {
            // 公共库还没建是 404，不用记
            if ((error as { status?: number }).status !== 404) {
                this.#options.log(`读取公共记忆的实体失败，用上一次的：${error instanceof Error ? error.message : String(error)}`);
            }
            this.#entities = { names: cached.names, fetchedAt: this.#now() };
        }
        return this.#entities.names;
    }

    /**
     * 她对这个人的印象（ADR 0017，公共库里的「她眼中的他」）：返回缓存，过期了在后台重新读；没开公共库、还没建、内容为空都是 undefined
     */
    impression(person: NamedContact): string | undefined {
        if (!this.#options.common || !knowsPeople(person.tier) || !this.#load(person).personModel) return undefined;
        const key = `person:${this.#key(person)}`;
        const cached = this.#relationship.get(key);
        if (!cached || (!cached.fetching && this.#now() - cached.fetchedAt >= RELATIONSHIP_REFRESH_MS)) {
            const entry = { content: cached?.content, fetchedAt: cached?.fetchedAt ?? 0, fetching: true };
            this.#relationship.set(key, entry);
            this.#options.api.getMentalModel(this.commonBankId(), this.#personModelId(person))
                .then(model => { entry.content = withoutMark(model?.content ?? '') || undefined; })
                .catch(error => this.#options.log(`[${person.qq}] 读取「她眼中的${person.name}」失败：${error instanceof Error ? error.message : String(error)}`))
                .finally(() => { entry.fetchedAt = this.#now(); entry.fetching = false; });
        }
        const content = this.#relationship.get(key)?.content;
        return content
            ? `[你心里对${person.name}的印象（从你和大家的聊天里整理的，只作参考，不要原样说出来）：里面的事实可以按披露规则使用；你对${person.name}的看法是你自己的念头，不主动说，被问起时按说别人的事的分寸]\n${content}`
            : undefined;
    }

    #personModelId(contact: MemoryContact): string {
        return `person-${this.#hash(contact)}`;
    }

    /** 关系概况：返回缓存，过期了在后台重新读 */
    relationship(contact: MemoryContact): string | undefined {
        const state = this.#load(contact);
        if (!state.relationshipModel) return undefined;
        const key = this.#key(contact);
        const cached = this.#relationship.get(key);
        if (!cached || (!cached.fetching && this.#now() - cached.fetchedAt >= RELATIONSHIP_REFRESH_MS)) {
            const entry = { content: cached?.content, fetchedAt: cached?.fetchedAt ?? 0, fetching: true };
            this.#relationship.set(key, entry);
            this.#options.api.getMentalModel(state.bankId, RELATIONSHIP_MODEL_ID)
                .then(model => { entry.content = withoutMark(model?.content ?? '') || undefined; })
                .catch(error => this.#options.log(`[${contact.qq}] 读取关系概况失败：${error instanceof Error ? error.message : String(error)}`))
                .finally(() => { entry.fetchedAt = this.#now(); entry.fetching = false; });
        }
        const content = this.#relationship.get(key)?.content;
        return content ? `[你们关系的整体情况（从以前的聊天整理的，只作参考，不要原样说出来）]\n${content}` : undefined;
    }

    #key(contact: MemoryContact): string {
        return `${contact.qq}-${contact.tier}`;
    }

    /** bank ID、公共库的 document_id 用的：不含原始 QQ 号 */
    #hash(contact: MemoryContact): string {
        return createHash('sha256').update(`qqbot:${this.#key(contact)}`).digest('hex').slice(0, 16);
    }

    #path(contact: MemoryContact): string {
        return join(this.#options.dir, `${this.#key(contact)}.json`);
    }

    #load(contact: MemoryContact): ContactState {
        const path = this.#path(contact);
        const fresh: ContactState = { bankId: this.bankId(contact), retained: {} };
        const data = readJsonOr<Partial<ContactState>>(path, {}, message => this.#options.log(`[${contact.qq}] ${message}`));
        // 换了 bank 前缀：进度是旧 bank 的，新 bank 从头写 mission 和片段（ADR 0012 决策 1 第 9 条）
        if (data.bankId && data.bankId !== fresh.bankId) return fresh;
        return { ...fresh, ...data, bankId: fresh.bankId, retained: data.retained ?? {} };
    }

    #save(contact: MemoryContact, state: ContactState): void {
        writeJsonAtomic(this.#path(contact), state);
    }
}

/** 查询最多多少字：超过 500 token 时 Hindsight 直接返回 400（ADR 0012 问题 8） */
export const MAX_QUERY_CHARS = 300;

/** 查询：她上一句 + 之后对方发的几条（调研方案 9.5：要带上这次的话题和指代），留最后 MAX_QUERY_CHARS 字 */
export function recallQuery(chat: readonly ChatMessage[]): string {
    const lastReply = chat.findLastIndex(m => m.role === 'assistant');
    const lines = chat.slice(lastReply + 1).filter(m => m.role === 'user').map(m => `对方：${m.content}`);
    if (lines.length === 0) return '';
    if (lastReply >= 0) lines.unshift(`她：${chat[lastReply]!.content}`);
    return lines.join('\n').slice(-MAX_QUERY_CHARS);
}

/**
 * 主动找他时的查询（ADR 0012 决策 1 第 7 条）：没有「他这次说的」。最近几句常是「晚安」「明天见」，里面的「明天」会按现在去解析，
 * 所以开头写想知道什么（topic：他最近在忙什么、这几天的安排，或者待跟进的那件事），再带最后两句当话题；日期交给时间窗
 */
export function initiateQuery(chat: ChatMessage[], topic: string): string {
    const recent = chat.slice(-2).map(m => `${m.role === 'user' ? '对方' : '她'}：${m.content}`);
    return [topic, ...recent].join('\n').slice(0, MAX_QUERY_CHARS);
}

/** 周记、阶段总结按那篇的日子算在不在这段时间里（Hindsight 给抽出来的事实标的日子可能在外面） */
function summaryIn(result: RecallResult, window: { start: Date; end: Date }): boolean {
    const day = isSummary(result) ? lastTouched(result) : undefined;
    return day !== undefined && day >= new Date(window.start.getFullYear(), window.start.getMonth(), window.start.getDate()) && day < window.end;
}

/** 那段时间里写的日记 */
function diaryIn(result: RecallResult, window: { start: Date; end: Date }): boolean {
    const day = result.document_id?.startsWith(DIARY_PREFIX) ? lastTouched(result) : undefined;
    return day !== undefined && day >= new Date(window.start.getFullYear(), window.start.getMonth(), window.start.getDate()) && day < window.end;
}

/** 召回结果是不是那天的事：发生的时间，没有就用说起的时间 */
function onDay(result: RecallResult, start: Date, end: Date): boolean {
    const time = Date.parse(result.occurred_start ?? result.mentioned_at ?? '');
    return !Number.isNaN(time) && time >= start.getTime() && time < end.getTime();
}

/** 「今天聊过」看说起这件事的时间；没有 mentioned_at 才退回事情发生的时间。 */
function mentionedOnDay(result: RecallResult, start: Date, end: Date): boolean {
    const time = Date.parse(result.mentioned_at ?? result.occurred_start ?? '');
    return !Number.isNaN(time) && time >= start.getTime() && time < end.getTime();
}

/**
 * 召回请求：事实、经历、观察都要，有观察时不再单独返回它覆盖了的事实。
 * 带上每条的实体名和观察背后的事实（ADR 0018：一提就想起、被提过几次、重要度）；想不起来的要筛掉，比以前多取一些
 */
function recallRequest(query: string, now: Date, window?: { start: Date; end: Date }): RecallRequest {
    return {
        query,
        types: ['world', 'experience', 'observation'],
        prefer_observations: true,
        budget: 'low',
        max_tokens: RECALL_TOKENS,
        // 带本机时区：「今天」「昨天」按本地的日历日算
        query_timestamp: localIso(now),
        tags: TAGS,
        tags_match: 'all_strict',
        include: { entities: { max_tokens: 1 }, source_facts: { max_tokens: 4000 } },
        ...(window ? { temporal_window: { start: localIso(window.start), end: localIso(window.end) } } : {}),
    };
}

/** 当前片段（最后一条消息所在的片段）的 id */
function currentEpisodeId(chat: readonly ChatMessage[]): string | undefined {
    const timed = chat.flatMap(m => (m.time ? [{ time: m.time, role: m.role, content: m.content }] : []));
    return splitEpisodes(timed).at(-1)?.id;
}

/**
 * 放进她提示词的记忆（召回、关系概况、印象）里她的名字换成「你」（ADR 0018 决策 4）：Hindsight 按名字写（「林梦瑶的日记」「林梦瑶说……」），
 * 提示词里其他地方都是用「你」跟她说话。
 * 带她名字的那一行里的「她」也是说她（「林梦瑶养了一只叫土豆的宠物，她说自己还没喂它」，DSH 诊断 1.2），一起换；
 * 那一行还提到别的女生（women：苏雨桐、闺蜜……）时分不清是谁，「她」不换
 */
export function secondPerson(text: string, char: string, women: readonly string[] = []): string {
    if (!char) return text;
    return text.split('\n').map(line => {
        if (!line.includes(char)) return line;
        const you = line.replaceAll(char, '你');
        return women.some(name => name && line.includes(name)) ? you : you.replaceAll('她', '你');
    }).join('\n');
}

export const RECALLED_HEADER ='[你们以前聊过的事（从记忆里想起来的，只作参考；和最近的聊天对不上时以最近的为准，用不上就别提）]';

/** 标了「记不太清了」时标题里加的一句（ADR 0018 决策 1） */
export const VAGUE_NOTE = '标了「记不太清了」的只记得个大概，说的时候可以说「好像」「记不太清了」，不要补细节';

/** 记忆变淡（ADR 0018）：他这次说的话、不算线索的名字；onFade 拿到这一次各几条（日志用） */
export interface FadeRequest {
    heard: string;
    ignore: readonly string[];
    onFade?: (stats: FadeStats) => void;
    /** 他问的那段时间：那段的周记、阶段总结算一提就想起 */
    window?: { start: Date; end: Date };
}

/**
 * 召回结果整理成一段：标题默认是自己的记忆（RECALLED_HEADER），最多 limit 条（默认 MAX_RECALLED）。
 * 传了 fade 和 now 时先按记得多清楚筛（ADR 0018）：想不起来的不放，记个大概的标「记不太清了」，标题加一句 VAGUE_NOTE
 */
export function formatRecalled(
    results: RecallResult[],
    options: { header?: string; limit?: number; now?: Date; source?: (result: RecallResult) => string | undefined; fade?: FadeRequest } = {},
): string | undefined {
    const valid = (iso: string | null | undefined) => {
        const date = iso ? new Date(iso) : undefined;
        return date && !Number.isNaN(date.getTime()) ? date : undefined;
    };
    const day = (date: Date) => `${date.getMonth() + 1}月${date.getDate()}日`;
    const { fade, now } = options;
    const judged = results.map(r => ({ r, clarity: fade && now ? clarity(r, { now, heard: fade.heard, ignore: fade.ignore, ...(fade.window ? { window: fade.window } : {}) }) : 'lasting' as Clarity }));
    const remembered = judged.filter(item => item.clarity !== 'forgotten');
    const varied = fade ? notCrowded(remembered, fade) : remembered;
    const shown = varied.slice(0, options.limit ?? MAX_RECALLED);
    if (fade) {
        fade.onFade?.({
            vague: shown.filter(item => item.clarity === 'vague').length,
            recognized: shown.filter(item => item.clarity === 'recognized').length,
            forgotten: judged.length - remembered.length,
            repeated: remembered.length - varied.length,
        });
    }
    const lines = shown.map(({ r, clarity }) => {
        // 计划的事（ADR 0017）：发生在现在之后的，日期写说起的那天，括号里写「打算 几号」
        const planned = r.type !== 'observation' && now ? valid(r.occurred_start) : undefined;
        const future = planned && planned.getTime() > now!.getTime() ? planned : undefined;
        // 观察（多条事实整合的）的 occurred_start 是来源里最早的日期，「现在戒糖了」会被标成最早那天：用最近一次被提到的时间
        const when = future ? valid(r.mentioned_at)
            : r.type === 'observation' ? valid(r.mentioned_at) ?? valid(r.occurred_start) : valid(r.occurred_start) ?? valid(r.mentioned_at);
        const faded = clarity === 'vague' ? '记不太清了' : clarity === 'recognized' ? '他一提才想起来，记不太清了' : undefined;
        const notes = [options.source?.(r), future ? `打算 ${day(future)}` : undefined, faded].filter(Boolean);
        const prefix = `${when ? day(when) : ''}${notes.length ? `（${notes.join('，')}）` : ''}`;
        // 事实后面常带「 | When: … | Involving: …」，日期已经写在前面了；【重要】是给我们看的记号
        const text = withoutMark(r.text.split(' | ')[0]!);
        return `- ${prefix ? `${prefix}：` : ''}${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
    });
    if (lines.length === 0) return undefined;
    const header = options.header ?? RECALLED_HEADER;
    const vague = shown.some(item => item.clarity === 'vague' || item.clarity === 'recognized');
    return `${vague ? header.replace(/\]$/, `；${VAGUE_NOTE}]`) : header}\n${lines.join('\n')}`;
}

/**
 * 按排名往下放，同一个人和事已经放了 SAME_THING_RECALLED 条的不再放（DSH 诊断 1.2）。
 * 不算的实体：她和名单里的称呼（fade.ignore，每条都带）、他这次说到的（问的就是它，多给几条）
 */
function notCrowded<T extends { r: RecallResult }>(items: readonly T[], fade: FadeRequest): T[] {
    const told = new Map<string, number>();
    return items.filter(({ r }) => {
        const things = [...new Set(r.entities ?? [])].filter(name => !fade.ignore.includes(name) && !fade.heard.includes(name));
        if (things.some(name => (told.get(name) ?? 0) >= SAME_THING_RECALLED)) return false;
        for (const name of things) told.set(name, (told.get(name) ?? 0) + 1);
        return true;
    });
}

/** 他这次说的话：她上次回复之后他发的几条（一提就想起用） */
export function heardSinceReply(chat: readonly Pick<ChatMessage, 'role' | 'content'>[]): string {
    const lastReply = chat.findLastIndex(m => m.role === 'assistant');
    return chat.slice(lastReply + 1).filter(m => m.role === 'user').map(m => m.content).join('\n');
}
