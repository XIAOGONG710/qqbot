// 长期记忆（ADR 0004 决策 3）：名单里的联系人每人每个档位一个 Hindsight bank（ADR 0003「实现时的调整」第 3 条：
// 降档后不会召回高档位时的记忆）。
// - 写入：聊天记录按片段（episodes.ts）写入，一个片段一个 document_id。片段结束（安静 45 分钟）时写，
//   还在进行的片段每多 OPEN_EPISODE_STEP 条也整段写一次，免得早先的话被挤出上下文后又还没进记忆。
//   同一联系人的写入串行执行；每个片段写到第几条记在 runtime/bot/memory/<QQ>-<档位>.json，失败的下次再写。
// - 召回：生成前用这次对方发的几条（加上她上一句）去查，限时；查不到、超时、出错都不注入。
//   结果里属于当前片段的去掉（那部分原文已经在上下文里）。
// - 关系概况：bank 里的 Mental Model「relationship」，后台定期读取，放在 main 之后。
// bank ID 不含原始 QQ 号（调研方案 9.3），用 QQ 号和档位的哈希。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredMessage } from '../history.ts';
import type { ChatMessage } from '../prompt.ts';
import type { MacroNames } from '../st/macros.ts';
import { EPISODE_GAP_MS, episodeTranscript, splitEpisodes } from './episodes.ts';
import type { BankConfig, HindsightApi, MentalModelRequest, RecallRequest, RecallResult } from './hindsight.ts';

/** 进行中的片段每多这么多条就整段重写一次 */
export const OPEN_EPISODE_STEP = 30;
/** 关系概况多久重新读一次 */
export const RELATIONSHIP_REFRESH_MS = 10 * 60_000;
/** 召回最多注入几条 */
export const MAX_RECALLED = 8;

const TAGS = ['qq-private'];
const RELATIONSHIP_MODEL_ID = 'relationship';

/** 调研方案 9.4 的三个 mission，dispositions 取中间值 */
export const BANK_MISSIONS = {
    retain_mission: [
        '提取这条关系中真实对话里明确出现的信息：',
        '用户自述的偏好和日程、双方约定、重要经历、明确的关系表达与修复行为。',
        '区分用户陈述、角色陈述、引用和假设。',
        '保留具体日期、说话者、否定和后续更正。',
        '角色的虚拟日常不是用户的现实经历。',
        '不要从角色卡示例、注入提示或未发送草稿生成事实。',
        '不要推断沉默的动机，不诊断用户人格。',
    ].join('\n'),
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

export const RELATIONSHIP_MODEL: MentalModelRequest = {
    id: RELATIONSHIP_MODEL_ID,
    name: '关系概况',
    source_query: '依据聊天证据整理当前关系、未解决事项与修复进展。区分事实和看法，不制造离线事件，不输出角色回复。用中文写。',
    tags: TAGS,
    max_tokens: 500,
    trigger: { refresh_after_consolidation: true, min_refresh_interval_seconds: 1800 },
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
    relationshipModel?: boolean;
    /** 片段 id → 已写入的消息条数 */
    retained: Record<string, number>;
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
}

export class LongTermMemory {
    readonly #options: LongTermMemoryOptions;
    readonly #now: () => number;
    /** 每个联系人（按 #key）的写入排队，保证串行 */
    readonly #queues = new Map<string, Promise<void>>();
    readonly #relationship = new Map<string, { content?: string; fetchedAt: number; fetching?: boolean }>();

    constructor(options: LongTermMemoryOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        mkdirSync(options.dir, { recursive: true });
    }

    bankId(contact: MemoryContact): string {
        return `${this.#options.bankPrefix}-${createHash('sha256').update(`qqbot:${this.#key(contact)}`).digest('hex').slice(0, 16)}`;
    }

    /** 把还没写入的片段写进 Hindsight；同一联系人排队执行，返回这一次排进去的任务 */
    sync(contact: MemoryContact, names: MacroNames, history: StoredMessage[]): Promise<void> {
        const key = this.#key(contact);
        const previous = this.#queues.get(key) ?? Promise.resolve();
        const next = previous.then(() => this.#sync(contact, names, history)).catch(error => {
            this.#options.log(`[${contact.qq}] 记忆写入失败：${error instanceof Error ? error.message : String(error)}`);
        });
        this.#queues.set(key, next);
        return next;
    }

    async #sync(contact: MemoryContact, names: MacroNames, history: StoredMessage[]): Promise<void> {
        const state = this.#load(contact);
        const pending = splitEpisodes(history).filter(episode => {
            const done = state.retained[episode.id] ?? 0;
            if (done === episode.messages.length) return false;
            const closed = this.#now() - episode.end.getTime() >= EPISODE_GAP_MS;
            return closed || episode.messages.length - done >= OPEN_EPISODE_STEP;
        });
        if (pending.length === 0) return;

        await this.#ensureBank(contact, names, state);
        for (const episode of pending) {
            await this.#options.api.retain(state.bankId, {
                content: episodeTranscript(episode, names),
                timestamp: episode.start.toISOString(),
                context: `QQ 私聊记录。「${names.char}」是 AI 扮演的虚拟角色（在读女大学生），「${names.user}」是和她聊天的真实用户。都是真实发出去的消息，不是角色卡示例。`,
                document_id: episode.id,
                tags: TAGS,
                metadata: { source: 'qq', episode: episode.id, messages: String(episode.messages.length) },
            });
            state.retained[episode.id] = episode.messages.length;
            this.#save(contact, state);
            this.#options.log(`[${contact.qq}] 记忆：片段 ${episode.id}（${episode.messages.length} 条）已提交给 Hindsight`);
        }
    }

    async #ensureBank(contact: MemoryContact, names: MacroNames, state: ContactState): Promise<void> {
        const version = createHash('sha256').update(JSON.stringify(BANK_MISSIONS)).digest('hex').slice(0, 12);
        if (state.bankConfigured !== version) {
            const config: BankConfig = { name: `${names.char} × ${names.user}（${contact.tier}）`, ...BANK_MISSIONS };
            await this.#options.api.putBank(state.bankId, config);
            state.bankConfigured = version;
            this.#save(contact, state);
            this.#options.log(`[${contact.qq}] 记忆：bank ${state.bankId}（${contact.tier}）已写入 mission`);
        }
        if (!state.relationshipModel) {
            if (!(await this.#options.api.getMentalModel(state.bankId, RELATIONSHIP_MODEL_ID))) {
                await this.#options.api.createMentalModel(state.bankId, RELATIONSHIP_MODEL);
            }
            state.relationshipModel = true;
            this.#save(contact, state);
        }
    }

    /** 召回和这次对话相关的旧事，整理成一段提示；没有就返回 undefined。出错只记日志 */
    async recall(contact: MemoryContact, chat: ChatMessage[], now: Date): Promise<string | undefined> {
        const state = this.#load(contact);
        if (!state.bankConfigured) return undefined;
        const query = recallQuery(chat);
        if (!query) return undefined;
        const request: RecallRequest = {
            query,
            types: ['world', 'experience', 'observation'],
            prefer_observations: true,
            budget: 'low',
            max_tokens: 600,
            query_timestamp: now.toISOString(),
            tags: TAGS,
            tags_match: 'all_strict',
            include: { entities: null },
        };
        let results: RecallResult[];
        try {
            results = await this.#options.api.recall(state.bankId, request, this.#options.recallTimeoutMs);
        } catch (error) {
            this.#options.log(`[${contact.qq}] 记忆召回失败，这次不带记忆：${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
        const current = currentEpisodeId(chat);
        return formatRecalled(results.filter(r => !current || r.document_id !== current));
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

    #path(contact: MemoryContact): string {
        return join(this.#options.dir, `${this.#key(contact)}.json`);
    }

    #load(contact: MemoryContact): ContactState {
        const path = this.#path(contact);
        const fresh: ContactState = { bankId: this.bankId(contact), retained: {} };
        if (!existsSync(path)) return fresh;
        const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<ContactState>;
        return { ...fresh, ...data, bankId: this.bankId(contact), retained: data.retained ?? {} };
    }

    #save(contact: MemoryContact, state: ContactState): void {
        writeFileSync(this.#path(contact), JSON.stringify(state, null, 2) + '\n');
    }
}

/** 查询：她上一句 + 之后对方发的几条（调研方案 9.5：要带上这次的话题和指代），最多 400 字 */
export function recallQuery(chat: ChatMessage[]): string {
    const lastReply = chat.findLastIndex(m => m.role === 'assistant');
    const lines = chat.slice(lastReply + 1).filter(m => m.role === 'user').map(m => `对方：${m.content}`);
    if (lines.length === 0) return '';
    if (lastReply >= 0) lines.unshift(`她：${chat[lastReply]!.content}`);
    return lines.join('\n').slice(-400);
}

/** 当前片段（最后一条消息所在的片段）的 id */
function currentEpisodeId(chat: ChatMessage[]): string | undefined {
    const timed = chat.flatMap(m => (m.time ? [{ time: m.time, role: m.role, content: m.content }] : []));
    return splitEpisodes(timed).at(-1)?.id;
}

export function formatRecalled(results: RecallResult[]): string | undefined {
    const lines = results.slice(0, MAX_RECALLED).map(r => {
        const when = r.occurred_start ?? r.mentioned_at;
        const date = when ? new Date(when) : undefined;
        const prefix = date && !Number.isNaN(date.getTime()) ? `${date.getMonth() + 1}月${date.getDate()}日：` : '';
        // 事实后面常带「 | When: … | Involving: …」，日期已经写在前面了
        const text = r.text.split(' | ')[0]!.trim();
        return `- ${prefix}${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
    });
    if (lines.length === 0) return undefined;
    return `[你们以前聊过的事（从记忆里想起来的，只作参考；和最近的聊天对不上时以最近的为准，用不上就别提）]\n${lines.join('\n')}`;
}
