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

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredMessage } from '../history.ts';
import { readJsonOr, writeJsonAtomic } from '../json-file.ts';
import { knowsPeople } from '../people.ts';
import type { ChatMessage } from '../prompt.ts';
import type { MacroNames } from '../st/macros.ts';
import { EPISODE_GAP_MS, episodeTranscript, localIso, splitEpisodes, type Episode } from './episodes.ts';
import type { BankConfig, HindsightApi, MentalModelRequest, RecallRequest, RecallResult } from './hindsight.ts';

/** 进行中的片段每多这么多条就整段重写一次 */
export const OPEN_EPISODE_STEP = 30;
/** 关系概况多久重新读一次 */
export const RELATIONSHIP_REFRESH_MS = 10 * 60_000;
/**
 * 召回最多注入几条。召回本身由 max_tokens（600）限量，一般 11–14 条。原来取前 8 条；10-04 换成 PGroonga 之后，
 * 埋在句子里的绰号（「铁锅今天又找我茬了」）能召回了，但关键词按命中的二字词计分，「今天」「找我」这类常见词也给别的记忆加分，
 * 它常排在第 8–10 条，取 8 条会被截掉。12 条约 500 token，在调研方案 6.4「按需召回 300–800」之内。
 */
export const MAX_RECALLED = 12;
/** 公共记忆、被提起的人的记忆各注入几条（ADR 0016：各约 250 token） */
export const SHARED_RECALLED = 6;
export const PERSON_RECALLED = 6;

const TAGS = ['qq-private'];
const RELATIONSHIP_MODEL_ID = 'relationship';

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
            `- 绰号、外号写成「绰号（${user}的什么人）」，例如「铁锅（${user}的组长）」。`,
            '- 否定（不吃香菜）、更正（之前说错了）各单独记一条，保留原话里的否定。',
            '- 生病、心情不好、很累这类近几天的状态也记，带日期。',
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
            `提取明确出现的信息：聊天对象自己说的偏好、日程和计划、经历、身体和心情，${char}说的她自己的日常，双方的约定。`,
            `- 每条写清是在和谁的私聊里、谁说的、关于谁，用名字（${char}和聊天对象的称呼），不写「用户」「对方」「助手」。`,
            `- ${char}说的她自己的日常（上课、吃饭、宿舍、猫）照记，但写明是${char}说的、对谁说的。`,
            '- 聊天对象说的之后要发生的事（考试、面试、出行、看病、约好的事），写成绝对日期，带上午 / 下午 / 晚上或几点；「明天」「下周三」按那一行所在的日期换算。',
            '- 绰号、外号写成「绰号（谁的什么人）」。',
            '- 否定（不吃香菜）、更正（之前说错了）各单独记一条，保留原话里的否定。',
            `- ${char}复述以前聊过的事，不算新事实；寒暄、表情、单纯的附和不记。`,
            '- 不推断沉默的动机，不诊断任何人的人格。',
        ].join('\n'),
        ...SHARED_MISSIONS,
    };
}

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

/** 记忆按「联系人 + 档位」分开 */
export interface MemoryContact {
    qq: number;
    tier: string;
}

interface ContactState {
    bankId: string;
    /** 已写入的 mission 版本（mission 改了就重新 PUT） */
    bankConfigured?: string;
    /** 已建好的关系概况的设定版本（RELATIONSHIP_MODEL 改了就 PATCH 并刷新一次）；旧的状态文件里是 true */
    relationshipModel?: string | boolean;
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
        const common = due(state.common);
        if (common.length === 0) return;
        try {
            await this.#retainCommon(contact, names, state, common);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#lastWrite = { at: this.#now(), ok: false, error: message };
            this.#options.log(`[${contact.qq}] 记忆（公共）写入失败：${message}`);
        }
    }

    /** 写进公共记忆库：document_id 带上是谁的（哈希，不带 QQ 号），原文开头写和谁的私聊 */
    async #retainCommon(contact: MemoryContact, names: MacroNames, state: ContactState, episodes: Episode[]): Promise<void> {
        const bankId = await this.#ensureCommonBank(names.char);
        for (const episode of episodes) {
            await this.#options.api.retain(bankId, {
                content: `和${names.user}的私聊\n${episodeTranscript(episode, names)}`,
                timestamp: localIso(episode.start),
                context: `QQ 私聊：${names.char}（AI 扮演）和${names.user}`,
                document_id: `${this.#hash(contact)}:${episode.id}`,
                tags: TAGS,
                metadata: { source: 'qq', episode: episode.id, messages: String(episode.messages.length) },
            });
            (state.common ??= {})[episode.id] = episode.messages.length;
            this.#save(contact, state);
            this.#lastWrite = { at: this.#now(), ok: true };
            this.#options.log(`[${contact.qq}] 记忆（公共）：片段 ${episode.id}（${episode.messages.length} 条）已提交给 Hindsight`);
        }
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
     * 别人提起这个人时（ADR 0016）也用这个查他的 bank，chat 是提起他的那段聊天，header、limit 换成那一段的
     */
    async recall(
        contact: MemoryContact, chat: ChatMessage[], now: Date,
        options: { query?: string; window?: { start: Date; end: Date }; header?: string; limit?: number } = {},
    ): Promise<string | undefined> {
        const state = this.#load(contact);
        if (!state.bankConfigured) return undefined;
        const query = options.query ?? recallQuery(chat);
        if (!query) return undefined;
        const results = await this.#recall(state.bankId, recallRequest(query, now, options.window), `[${contact.qq}] 记忆召回失败，这次不带记忆`);
        if (!results) return undefined;
        const current = currentEpisodeId(chat);
        return formatRecalled(results.filter(r => !current || r.document_id !== current), { header: options.header, limit: options.limit });
    }

    /**
     * 公共记忆（ADR 0016）：名单里除陌生人档以外的人每轮都查，去掉他自己的片段。只要事实（带 document_id 才分得出是谁的），
     * 不要整合过的观察（可能混着他自己的事）
     */
    async recallCommon(contact: MemoryContact, chat: ChatMessage[], now: Date, userName: string): Promise<string | undefined> {
        if (!this.#options.common || !knowsPeople(contact.tier)) return undefined;
        const stored = readJsonOr<Partial<CommonState>>(join(this.#options.dir, 'common.json'), {}, message => this.#options.log(message));
        if (stored.bankId !== this.commonBankId() || !stored.bankConfigured) return undefined;
        const query = recallQuery(chat);
        if (!query) return undefined;
        const request: RecallRequest = { ...recallRequest(query, now), types: ['world', 'experience'], prefer_observations: false };
        const results = await this.#recall(stored.bankId, request, `[${contact.qq}] 公共记忆召回失败，这次不带`);
        if (!results) return undefined;
        const own = `${this.#hash(contact)}:`;
        return formatRecalled(results.filter(r => !r.document_id?.startsWith(own)), {
            header: `[你和名单里别的人聊天时说过、听过的事（从记忆里想起来的，只作参考；不是和${userName}聊的，用不上就别提）]`,
            limit: SHARED_RECALLED,
        });
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
                .then(model => { entry.content = model?.content?.trim() || undefined; })
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
export function recallQuery(chat: ChatMessage[]): string {
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

/** 召回请求：事实、经历、观察都要，有观察时不再单独返回它覆盖了的事实 */
function recallRequest(query: string, now: Date, window?: { start: Date; end: Date }): RecallRequest {
    return {
        query,
        types: ['world', 'experience', 'observation'],
        prefer_observations: true,
        budget: 'low',
        max_tokens: 600,
        // 带本机时区：「今天」「昨天」按本地的日历日算
        query_timestamp: localIso(now),
        tags: TAGS,
        tags_match: 'all_strict',
        include: { entities: null },
        ...(window ? { temporal_window: { start: localIso(window.start), end: localIso(window.end) } } : {}),
    };
}

/** 当前片段（最后一条消息所在的片段）的 id */
function currentEpisodeId(chat: ChatMessage[]): string | undefined {
    const timed = chat.flatMap(m => (m.time ? [{ time: m.time, role: m.role, content: m.content }] : []));
    return splitEpisodes(timed).at(-1)?.id;
}

export const RECALLED_HEADER = '[你们以前聊过的事（从记忆里想起来的，只作参考；和最近的聊天对不上时以最近的为准，用不上就别提）]';

/** 召回结果整理成一段：标题默认是自己的记忆（RECALLED_HEADER），最多 limit 条（默认 MAX_RECALLED） */
export function formatRecalled(results: RecallResult[], options: { header?: string; limit?: number } = {}): string | undefined {
    const lines = results.slice(0, options.limit ?? MAX_RECALLED).map(r => {
        // 观察（多条事实整合的）的 occurred_start 是来源里最早的日期，「现在戒糖了」会被标成最早那天：用最近一次被提到的时间
        const when = r.type === 'observation' ? r.mentioned_at ?? r.occurred_start : r.occurred_start ?? r.mentioned_at;
        const date = when ? new Date(when) : undefined;
        const prefix = date && !Number.isNaN(date.getTime()) ? `${date.getMonth() + 1}月${date.getDate()}日：` : '';
        // 事实后面常带「 | When: … | Involving: …」，日期已经写在前面了
        const text = r.text.split(' | ')[0]!.trim();
        return `- ${prefix}${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
    });
    if (lines.length === 0) return undefined;
    return `${options.header ?? RECALLED_HEADER}\n${lines.join('\n')}`;
}
