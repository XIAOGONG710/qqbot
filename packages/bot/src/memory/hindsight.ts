// Hindsight 服务的 HTTP 客户端，只有用到的几个接口。
// 请求体对照 hindsight-api 0.10.2 的 OpenAPI（test/fixtures/hindsight-openapi-0.10.2.json 是摘出来的部分，测试逐个字段核对）：
//   PUT  /v1/default/banks/{bank_id}                              建库或改配置（mission、disposition）
//   POST /v1/default/banks/{bank_id}/memories                     写入（retain）
//   POST /v1/default/banks/{bank_id}/memories/recall              召回
//   GET / POST / PATCH /v1/default/banks/{bank_id}/mental-models[/{id}]   关系概况（Mental Model）
//   POST /v1/default/banks/{bank_id}/mental-models/{id}/refresh    设定改了之后手动刷新一次
//   GET  /v1/default/banks/{bank_id}/entities                     公共库的实体名（ADR 0017）
//   GET  /v1/default/banks/{bank_id}/documents/{document_id}      读回以前的日记（ADR 0018 周记）
// 模拟器与有持久屏障的派生修复使用：
//   GET    /v1/default/banks/{bank_id}/operations[/{id}]           后台任务（等抽取、整合、刷新做完）
//   GET    /v1/default/banks/{bank_id}/stats?refresh=true           鲜统计证据
//   GET    /v1/default/banks/{bank_id}/documents                  完整来源清单
//   POST   /v1/default/banks/{bank_id}/mental-models/{id}/clear   清已归属模型正文
// 仅模拟器清理或显式隐私遗忘使用：
//   DELETE /v1/default/banks/{bank_id}                             删掉测试 bank
// 出错（连不上、超时、非 2xx）一律抛 HindsightError，由调用方记日志，不在这里吞掉。

import { describeError } from './transient-io.ts';
import { stateObject, stateTimestamp } from './state-schema.ts';
import { createHash } from 'node:crypto';

/** Transport ceiling, independent of the server's token budgets. */
export const HINDSIGHT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class HindsightError extends Error {
    readonly status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.name = 'HindsightError';
        this.status = status;
    }
}

export interface BankConfig {
    name: string;
    retain_mission: string;
    observations_mission: string;
    reflect_mission: string;
    disposition_skepticism: number;
    disposition_literalism: number;
    disposition_empathy: number;
}

export interface MemoryItem {
    content: string;
    /** 内容发生的时间（ISO） */
    timestamp: string;
    context: string;
    document_id: string;
    tags: string[];
    metadata: Record<string, string>;
    /** 和自动抽取的实体合在一起（ADR 0017：公共库写入时把聊天对象和她的名字钉成人） */
    entities?: { text: string; type?: string }[];
}

export interface RecallRequest {
    query: string;
    types: ('world' | 'experience' | 'observation')[];
    /** 观察（多条事实整合出来的）覆盖了的原始事实不再单独返回 */
    prefer_observations: boolean;
    budget: 'low' | 'mid' | 'high';
    max_tokens: number;
    query_timestamp: string;
    tags: string[];
    tags_match: 'all_strict';
    /**
     * entities：每条结果的实体名（ADR 0018 一提就想起），要开着才有；实体的总结不用，预算给最小。
     * source_facts：观察背后的事实（ADR 0018 被提过几次、重要度）；只给总预算，按条限的话整条事实会被丢掉
     */
    include: { entities: { max_tokens: number } | null; source_facts?: { max_tokens: number } };
    /** 时间检索用的时间窗：代替从查询文字里解析日期，只加权、不过滤（ISO，带时区） */
    temporal_window?: { start: string; end: string };
}

export interface RecallResult {
    id: string;
    text: string;
    type?: string | null;
    occurred_start?: string | null;
    occurred_end?: string | null;
    mentioned_at?: string | null;
    document_id?: string | null;
    /** 实体名（请求开了 include.entities 才有） */
    entities?: string[] | null;
    /** 观察背后的事实 id（请求开了 include.source_facts 才有） */
    source_fact_ids?: string[] | null;
    /** 观察背后事实的原文：客户端按 source_fact_ids 从响应的 source_facts 里对上的，不是 Hindsight 的字段 */
    sources?: string[];
}

export interface MentalModelRequest {
    id: string;
    name: string;
    source_query: string;
    tags: string[];
    max_tokens: number;
    /** budget：刷新时检索、迭代的预算（不写是 mid） */
    trigger: { refresh_after_consolidation: boolean; min_refresh_interval_seconds: number; budget?: 'low' | 'mid' | 'high';
        mode?: 'full' | 'delta'; exclude_mental_models?: boolean; fact_types?: ('world' | 'experience' | 'observation')[];
        include_chunks?: boolean; tag_groups?: RepairTagGroup[] | null; tags_match?: 'all_strict'; refresh_cron?: string | null };
}

export interface MentalModel {
    id: string;
    content?: string | null;
    last_refreshed_at?: string | null;
}

export type RetentionStatus = 'not_found' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
const RETENTION_STATUSES: readonly string[] = ['not_found', 'pending', 'processing', 'completed', 'failed', 'cancelled'];
const operationUuid = (value: string): boolean => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export type RepairTagGroup = { tags: string[]; match: 'all_strict' | 'any_strict'; resolve?: 'exact' } | { not: RepairTagGroup };
export interface RepairStats { pending_consolidation: number; failed_consolidation: number; last_memory_write_at: string | null }
export interface RepairOperation { operation_id: string; task_type: string; status: 'pending' | 'processing' | 'failed' | 'cancelled'; mental_model_id: string | null }
export interface RepairModelMetadata { id: string; bank_id: string; name: string; tags: string[]; last_memory_seen_at: string | null; last_refreshed_at: string | null }
export interface RepairModelEvidence extends RepairModelMetadata {
    content: string | null; source_query: string; trigger: Record<string, unknown>; is_stale: boolean;
    /** 客户端计算的证据字段，不是供应商返回字段；safe_configuration仅指暂停自动刷新时的硬配置。 */
    safe_configuration: boolean; configuration_hash: string;
}
export interface RepairDocument { id: string; bank_id: string; content_hash: string | null; tags: string[] }
export type RepairRefreshOutcome = 'content_written' | 'content_unchanged' | 'content_preserved_no_new_facts'
    | 'refresh_failed_empty_candidate' | 'refresh_failed_delta_not_applied' | 'refresh_failed_structured_output' | 'refresh_failed_error';
export interface RepairRefreshOperation { operation_id: string; operation_type: 'refresh_mental_model' | null; mental_model_id: string | null; status: RetentionStatus; outcome: RepairRefreshOutcome | null }
export interface DerivedRepairApi {
    repairStats(bankId: string): Promise<RepairStats>;
    repairActiveOperations(bankId: string): Promise<RepairOperation[]>;
    repairModels(bankId: string): Promise<RepairModelMetadata[]>;
    repairDocuments(bankId: string): Promise<RepairDocument[]>;
    repairModel(bankId: string, modelId: string): Promise<RepairModelEvidence>;
    repairConfigureModel(bankId: string, modelId: string): Promise<RepairModelEvidence>;
    repairClearModel(bankId: string, modelId: string): Promise<RepairModelEvidence>;
    repairRefreshModel(bankId: string, modelId: string): Promise<string>;
    repairRefreshOperation(bankId: string, operationId: string): Promise<RepairRefreshOperation>;
    repairRestoreAutomatic(bankId: string, modelId: string, cadence: number, autoEnabled?: boolean): Promise<RepairModelEvidence>;
}
const repairText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const repairCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const repairTime = (value: unknown) => value == null || stateTimestamp(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : stateObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const repairGroups: RepairTagGroup[] = [{ tags: ['qq-private'], match: 'all_strict', resolve: 'exact' },
    { not: { tags: ['diary', 'week', 'phase'], match: 'any_strict', resolve: 'exact' } }];
export function isSafeRepairModel(model: Pick<RepairModelEvidence, 'trigger'>, automatic = false): boolean {
    const t = model.trigger;
    return t.mode === 'full' && t.exclude_mental_models === true && t.include_chunks === false
        && Array.isArray(t.fact_types) && t.fact_types.length === 2 && t.fact_types.includes('world') && t.fact_types.includes('experience')
        && t.refresh_after_consolidation === automatic && t.refresh_cron == null && repairCount(t.min_refresh_interval_seconds)
        && t.tags_match === 'all_strict' && JSON.stringify(canonical(t.tag_groups)) === JSON.stringify(canonical(repairGroups));
}
export function repairModelConfigHash(model: Pick<RepairModelEvidence, 'id' | 'name' | 'source_query' | 'tags' | 'trigger'>): string {
    return createHash('sha256').update(JSON.stringify(canonical({ id: model.id, name: model.name, source_query: model.source_query, tags: model.tags, trigger: model.trigger }))).digest('hex');
}
/** v0.10.2 sanitize_text + SHA256(UTF8), one MemoryItem per document; 保留合法emoji码点。 */
export function repairDocumentContentHash(content: string): string {
    let sanitized = '';
    for (const point of content) { const code = point.codePointAt(0)!;
        if (!(code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127 || code >= 0xd800 && code <= 0xdfff)) sanitized += point;
    }
    return createHash('sha256').update(sanitized, 'utf8').digest('hex');
}

export interface HindsightApi extends Partial<DerivedRepairApi> {
    putBank(bankId: string, config: BankConfig): Promise<void>;
    retain(bankId: string, item: MemoryItem): Promise<void>;
    /** 可恢复的异步提交：调用方须先持久UUID与不可变请求；成功仅代表受理，不代表完成。 */
    submitRetain?(bankId: string, item: MemoryItem, operationId: string): Promise<void>;
    /** 精确异步任务状态；只有completed能证明对应retain管线已完成。 */
    retentionStatus?(bankId: string, operationId: string): Promise<RetentionStatus>;
    recall(bankId: string, request: RecallRequest, timeoutMs?: number): Promise<RecallResult[]>;
    getMentalModel(bankId: string, id: string): Promise<MentalModel | undefined>;
    createMentalModel(bankId: string, request: MentalModelRequest): Promise<void>;
    /** 改已有的 Mental Model 的设定（源查询、长度、触发条件）；内容要等下一次刷新才变 */
    updateMentalModel(bankId: string, id: string, request: MentalModelRequest): Promise<void>;
    /** 手动刷新，返回后台任务 id */
    refreshMentalModel(bankId: string, id: string): Promise<string>;
    /** bank 里所有实体的名字（ADR 0017：公共记忆的线索）；没有这个方法就不按实体找线索 */
    listEntities?(bankId: string, timeoutMs?: number): Promise<string[]>;
    /** 读回一篇写进去的原文（ADR 0018：写周记时读以前的日记）；没有这篇是 undefined；没有这个方法就不读 */
    getDocument?(bankId: string, documentId: string, timeoutMs?: number): Promise<{ original_text?: string | null } | undefined>;
    /** 删除明确归属的稳定文档；旧自定义API可缺省，但不能冒认清理成功。 */
    deleteDocument?(bankId: string, documentId: string): Promise<void>;
}

/** 写入请求体：后台异步处理（async），一次一个片段 */
export function retainBody(item: MemoryItem) {
    return { items: [item], async: true };
}

/** 改 Mental Model 的请求体：除了 id 都能改 */
export function mentalModelUpdateBody({ id: _id, ...rest }: MentalModelRequest) {
    return rest;
}

export class HindsightClient implements HindsightApi {
    readonly #baseUrl: string;
    readonly #timeoutMs: number;

    constructor(baseUrl: string, timeoutMs: number) {
        this.#baseUrl = baseUrl.replace(/\/+$/, '');
        this.#timeoutMs = timeoutMs;
    }

    #repairRemaining(): () => number {
        if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 2_147_483_647) throw new HindsightError('记忆修复超时配置无效');
        const deadline = performance.now() + this.#timeoutMs;
        return () => { const left = Math.ceil(deadline - performance.now()); if (left <= 0) throw new HindsightError('记忆修复证据请求超时'); return left; };
    }
    #repairError(): never { throw new HindsightError('记忆修复证据格式无效'); }
    #repairMetadata(value: unknown, bank: string): RepairModelMetadata {
        if (!stateObject(value) || !repairText(value.id) || value.bank_id !== bank || typeof value.name !== 'string' || !value.name.trim()
            || !Array.isArray(value.tags) || !value.tags.every(repairText) || !repairTime(value.last_memory_seen_at) || !repairTime(value.last_refreshed_at)) return this.#repairError();
        return { id: value.id, bank_id: bank, name: value.name, tags: [...value.tags], last_memory_seen_at: value.last_memory_seen_at as string ?? null,
            last_refreshed_at: value.last_refreshed_at as string ?? null };
    }
    #repairEvidence(value: unknown, bank: string, id: string): RepairModelEvidence {
        const metadata = this.#repairMetadata(value, bank);
        if (!stateObject(value) || metadata.id !== id || !(value.content == null || typeof value.content === 'string')
            || typeof value.source_query !== 'string' || !value.source_query.trim() || !stateObject(value.trigger) || typeof value.is_stale !== 'boolean') return this.#repairError();
        const result = { ...metadata, content: value.content as string ?? null, source_query: value.source_query, trigger: structuredClone(value.trigger),
            is_stale: value.is_stale, safe_configuration: false, configuration_hash: '' };
        result.safe_configuration = isSafeRepairModel(result); result.configuration_hash = repairModelConfigHash(result); return result;
    }
    async #repairPages<T extends { id?: string; operation_id?: string }>(path: string, field: 'items' | 'operations', parse: (row: unknown) => T, remaining: () => number, bank?: string): Promise<T[]> {
        const out: T[] = [], seen = new Set<string>(); let total: number | undefined;
        for (let offset = 0;;) {
            const page: unknown = await this.#request('GET', `${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`, undefined, remaining());
            if (!stateObject(page) || !repairCount(page.total) || page.limit !== 100 || page.offset !== offset
                || bank !== undefined && page.bank_id !== bank || !Array.isArray(page[field])
                || total !== undefined && page.total !== total || page[field].length !== Math.min(100, page.total - offset)) return this.#repairError();
            total = page.total;
            for (const value of page[field]) { const row = parse(value), id = row.operation_id ?? row.id!;
                if (seen.has(id)) return this.#repairError(); seen.add(id); out.push(row); }
            offset += page[field].length;
            if (offset === total) return out;
        }
    }
    async repairStats(bankId: string): Promise<RepairStats> {
        const remaining = this.#repairRemaining();
        const value: unknown = await this.#request('GET', `${this.#bank(bankId)}/stats?refresh=true`, undefined, remaining());
        if (!stateObject(value) || value.bank_id !== bankId || !repairCount(value.pending_consolidation) || !repairCount(value.failed_consolidation)
            || !repairTime(value.last_memory_write_at)) return this.#repairError();
        return { pending_consolidation: value.pending_consolidation, failed_consolidation: value.failed_consolidation, last_memory_write_at: value.last_memory_write_at as string ?? null };
    }
    async repairActiveOperations(bankId: string): Promise<RepairOperation[]> {
        const remaining = this.#repairRemaining(), out: RepairOperation[] = [];
        // cancelled/failed不是“worker已停止”的证据，旧取消任务也不能作为空闲跳过。
        for (const status of ['pending', 'processing', 'failed', 'cancelled'] as const) out.push(...await this.#repairPages(`${this.#bank(bankId)}/operations?status=${status}&exclude_parents=false`, 'operations', value => {
            if (!stateObject(value) || typeof value.operation_id !== 'string' || !operationUuid(value.operation_id) || !repairText(value.task_type)
                || value.status !== status || value.operation_type != null && value.operation_type !== value.task_type
                || !(value.mental_model_id == null || repairText(value.mental_model_id))) return this.#repairError();
            return { operation_id: value.operation_id, task_type: value.task_type, status, mental_model_id: value.mental_model_id as string ?? null };
        }, remaining, bankId));
        if (new Set(out.map(row => row.operation_id)).size !== out.length) return this.#repairError();
        return out;
    }
    async repairModels(bankId: string): Promise<RepairModelMetadata[]> {
        return this.#repairPages(`${this.#bank(bankId)}/mental-models?detail=metadata`, 'items', row => this.#repairMetadata(row, bankId), this.#repairRemaining());
    }
    async repairDocuments(bankId: string): Promise<RepairDocument[]> {
        return this.#repairPages(`${this.#bank(bankId)}/documents`, 'items', row => {
            if (!stateObject(row) || !repairText(row.id) || row.bank_id !== bankId || !(row.content_hash == null || typeof row.content_hash === 'string' && /^[a-f0-9]{64}$/.test(row.content_hash))
                || !Array.isArray(row.tags) || !row.tags.every(repairText)) return this.#repairError();
            return { id: row.id, bank_id: bankId, content_hash: row.content_hash as string ?? null, tags: [...row.tags] };
        }, this.#repairRemaining());
    }
    async repairModel(bankId: string, modelId: string): Promise<RepairModelEvidence> {
        const value = await this.#request('GET', `${this.#bank(bankId)}/mental-models/${encodeURIComponent(modelId)}`, undefined, this.#repairRemaining()());
        return this.#repairEvidence(value, bankId, modelId);
    }
    async #repairConfigure(bankId: string, modelId: string, automatic: boolean, cadence?: number): Promise<RepairModelEvidence> {
        if (cadence !== undefined && !repairCount(cadence) || typeof automatic !== 'boolean') return this.#repairError();
        const trigger = { mode: 'full', exclude_mental_models: true, fact_types: ['world', 'experience'], include_chunks: false,
            refresh_after_consolidation: automatic, refresh_cron: null, tag_groups: repairGroups, tags_match: 'all_strict',
            ...(cadence !== undefined ? { min_refresh_interval_seconds: cadence } : {}) };
        const value = await this.#request('PATCH', `${this.#bank(bankId)}/mental-models/${encodeURIComponent(modelId)}`, { trigger }, this.#repairRemaining()());
        const model = this.#repairEvidence(value, bankId, modelId);
        if (!isSafeRepairModel(model, automatic) || cadence !== undefined && model.trigger.min_refresh_interval_seconds !== cadence) return this.#repairError();
        return model;
    }
    repairConfigureModel(bankId: string, modelId: string): Promise<RepairModelEvidence> { return this.#repairConfigure(bankId, modelId, false); }
    repairRestoreAutomatic(bankId: string, modelId: string, cadence: number, autoEnabled = true): Promise<RepairModelEvidence> { return this.#repairConfigure(bankId, modelId, autoEnabled, cadence); }
    async repairClearModel(bankId: string, modelId: string): Promise<RepairModelEvidence> {
        const value = await this.#request('POST', `${this.#bank(bankId)}/mental-models/${encodeURIComponent(modelId)}/clear`, undefined, this.#repairRemaining()());
        const model = this.#repairEvidence(value, bankId, modelId);
        if (model.content !== '' || !isSafeRepairModel(model)) return this.#repairError(); return model;
    }
    async repairRefreshModel(bankId: string, modelId: string): Promise<string> {
        const value: unknown = await this.#request('POST', `${this.#bank(bankId)}/mental-models/${encodeURIComponent(modelId)}/refresh`, undefined, this.#repairRemaining()());
        if (!stateObject(value) || value.status !== 'queued' || typeof value.operation_id !== 'string' || !operationUuid(value.operation_id)) return this.#repairError();
        return value.operation_id;
    }
    async repairRefreshOperation(bankId: string, operationId: string): Promise<RepairRefreshOperation> {
        if (!operationUuid(operationId)) return this.#repairError();
        const value: unknown = await this.#request('GET', `${this.#bank(bankId)}/operations/${encodeURIComponent(operationId)}`, undefined, this.#repairRemaining()());
        if (!stateObject(value) || value.operation_id !== operationId || typeof value.status !== 'string' || !RETENTION_STATUSES.includes(value.status)) return this.#repairError();
        if (value.status === 'not_found') {
            if (value.operation_type != null || value.mental_model_id != null) return this.#repairError();
            return { operation_id: operationId, operation_type: null, mental_model_id: null, status: 'not_found', outcome: null };
        }
        if (value.operation_type !== 'refresh_mental_model' || !repairText(value.mental_model_id)) return this.#repairError();
        const outcomes: readonly string[] = ['content_written', 'content_unchanged', 'content_preserved_no_new_facts', 'refresh_failed_empty_candidate',
            'refresh_failed_delta_not_applied', 'refresh_failed_structured_output', 'refresh_failed_error'];
        if (value.details != null && (!stateObject(value.details) || value.details.operation_type !== 'refresh_mental_model' || !outcomes.includes(String(value.details.outcome)))) return this.#repairError();
        const outcome = stateObject(value.details) ? value.details.outcome as RepairRefreshOutcome : null;
        if (value.status === 'completed' && !['content_written', 'content_unchanged', 'content_preserved_no_new_facts'].includes(outcome ?? '')) return this.#repairError();
        return { operation_id: operationId, operation_type: 'refresh_mental_model', mental_model_id: value.mental_model_id, status: value.status as RetentionStatus, outcome };
    }

    async putBank(bankId: string, config: BankConfig): Promise<void> {
        await this.#request('PUT', this.#bank(bankId), config);
    }

    async retain(bankId: string, item: MemoryItem): Promise<void> {
        await this.#request('POST', `${this.#bank(bankId)}/memories`, retainBody(item));
    }

    async retentionStatus(bankId: string, operationId: string): Promise<RetentionStatus> {
        return this.#retentionStatus(bankId, operationId, this.#timeoutMs);
    }

    async #retentionStatus(bankId: string, operationId: string, timeoutMs: number): Promise<RetentionStatus> {
        if (!operationUuid(operationId)) throw new HindsightError('记忆服务任务身份无效');
        let data: unknown;
        try { data = await this.#request('GET', `${this.#bank(bankId)}/operations/${encodeURIComponent(operationId)}`, undefined, timeoutMs); }
        catch (error) { if (error instanceof HindsightError && error.status === 404) return 'not_found'; throw error; }
        if (!stateObject(data) || data.operation_id !== operationId || typeof data.status !== 'string' || !RETENTION_STATUSES.includes(data.status)) {
            throw new HindsightError('记忆服务任务响应格式无效');
        }
        if (data.status !== 'not_found' && data.operation_type !== 'batch_retain' && data.task_type !== 'batch_retain') {
            throw new HindsightError('记忆服务任务类型无效');
        }
        // 父任务空child可能被服务端all([])误判完成；取消也不证明worker已停。
        if (data.status === 'completed' && (!Array.isArray(data.child_operations) || !data.child_operations.length
            || !data.child_operations.every(child => stateObject(child) && child.status === 'completed'))) {
            throw new HindsightError('记忆服务任务完成证据无效');
        }
        return data.status as RetentionStatus;
    }

    /** 持久UUID由调用方管理；不在此处把异步受理冒认为文档完成。 */
    async submitRetain(bankId: string, item: MemoryItem, operationId: string): Promise<void> {
        if (!operationUuid(operationId)) throw new HindsightError('记忆服务任务身份无效');
        const snapshot = structuredClone(item);
        const deadline = performance.now() + this.#timeoutMs;
        const remaining = () => {
            const ms = Math.ceil(deadline - performance.now());
            if (ms <= 0) throw new HindsightError('记忆服务提交超时');
            return ms;
        };
        const known = await this.#retentionStatus(bankId, operationId, remaining());
        if (known !== 'not_found') return;
        // 升级前未跟踪的旧任务也可能迟到覆盖新正文。先保守等待bank写入静止；
        // 带type过滤和total，不能用首100条中恰好没有retain证明没有旧任务。
        for (const status of ['pending', 'processing']) for (const type of ['retain', 'batch_retain', 'file_convert_retain']) {
            let page: unknown;
            try {
                page = await this.#request('GET', `${this.#bank(bankId)}/operations?status=${status}&type=${type}&limit=1&offset=0&exclude_parents=false`, undefined, remaining());
            } catch (error) {
                if (error instanceof HindsightError && error.status === 404) continue;
                throw error;
            }
            if (!stateObject(page) || page.bank_id !== bankId || !Number.isSafeInteger(page.total) || (page.total as number) < 0
                || !Array.isArray(page.operations) || page.operations.length > 1 || ((page.total === 0) !== (page.operations.length === 0))) {
                throw new HindsightError('记忆服务任务列表响应格式无效');
            }
            if ((page.total as number) > 0) throw new HindsightError('记忆服务尚有未完成写入，暂缓新的文档任务');
        }
        const receipt: unknown = await this.#request('POST', `${this.#bank(bankId)}/memories`, { ...retainBody(snapshot), operation_id: operationId }, remaining());
        if (!stateObject(receipt) || receipt.success !== true || receipt.async !== true || receipt.bank_id !== bankId
            || receipt.items_count !== 1 || receipt.operation_id !== operationId
            || !(receipt.operation_ids == null || Array.isArray(receipt.operation_ids) && receipt.operation_ids.length === 1 && receipt.operation_ids[0] === operationId)) {
            throw new HindsightError('记忆服务提交确认格式无效');
        }
    }

    async recall(bankId: string, request: RecallRequest, timeoutMs?: number): Promise<RecallResult[]> {
        const data = await this.#request<{ results?: RecallResult[]; source_facts?: Record<string, { text?: string }> | null }>(
            'POST', `${this.#bank(bankId)}/memories/recall`, request, timeoutMs,
        );
        if (!stateObject(data)) throw new HindsightError('记忆服务召回响应格式无效');
        const facts = data.source_facts ?? {};
        if (!Array.isArray(data.results ?? []) || !stateObject(facts)
            || !(data.results ?? []).every(result => stateObject(result) && typeof result.id === 'string' && typeof result.text === 'string'
                && ['type', 'occurred_start', 'occurred_end', 'mentioned_at', 'document_id'].every(key => result[key] == null || typeof result[key] === 'string')
                && ['entities', 'source_fact_ids'].every(key => result[key] == null || Array.isArray(result[key]) && result[key].every((item: unknown) => typeof item === 'string')))) {
            throw new HindsightError('记忆服务召回响应格式无效');
        }
        return (data.results ?? []).map(({ sources: _untrusted, ...result }) => ({
            ...result,
            ...(result.source_fact_ids?.length ? { sources: result.source_fact_ids.flatMap(id => (Object.hasOwn(facts, id) && typeof facts[id]?.text === 'string' ? [facts[id].text] : [])) } : {}),
        }));
    }

    async getMentalModel(bankId: string, id: string): Promise<MentalModel | undefined> {
        try {
            return await this.#request<MentalModel>('GET', `${this.#bank(bankId)}/mental-models/${encodeURIComponent(id)}`);
        } catch (error) {
            if (error instanceof HindsightError && error.status === 404) return undefined;
            throw error;
        }
    }

    async createMentalModel(bankId: string, request: MentalModelRequest): Promise<void> {
        await this.#request('POST', `${this.#bank(bankId)}/mental-models`, request);
    }

    async updateMentalModel(bankId: string, id: string, request: MentalModelRequest): Promise<void> {
        await this.#request('PATCH', `${this.#bank(bankId)}/mental-models/${encodeURIComponent(id)}`, mentalModelUpdateBody(request));
    }

    /** 还没做完（pending / processing）的后台任务的类型，例如 retain、consolidation、refresh_mental_model */
    async activeOperations(bankId: string): Promise<string[]> {
        const types: string[] = [];
        for (const status of ['pending', 'processing']) {
            const data = await this.#request<{ operations?: { task_type: string }[] }>('GET', `${this.#bank(bankId)}/operations?status=${status}&limit=100`);
            types.push(...(data.operations ?? []).map(op => op.task_type));
        }
        return types;
    }

    /** 某个后台任务的状态：pending / processing / completed / failed / cancelled / not_found */
    async operationStatus(bankId: string, operationId: string): Promise<string> {
        const data = await this.#request<{ status: string }>('GET', `${this.#bank(bankId)}/operations/${encodeURIComponent(operationId)}`);
        return data.status;
    }

    /** 手动刷新关系概况，返回后台任务 id */
    async refreshMentalModel(bankId: string, id: string): Promise<string> {
        const data = await this.#request<{ operation_id: string }>('POST', `${this.#bank(bankId)}/mental-models/${encodeURIComponent(id)}/refresh`);
        return data.operation_id;
    }

    async listEntities(bankId: string, timeoutMs = this.#timeoutMs): Promise<string[]> {
        const names: string[] = [];
        // 一页 100 个，最多读 10 页
        for (let offset = 0; offset < 1000; offset += 100) {
            const page = await this.#request<{ items: { canonical_name: string }[]; total: number }>(
                'GET', `${this.#bank(bankId)}/entities?limit=100&offset=${offset}`, undefined, timeoutMs,
            );
            names.push(...page.items.map(item => item.canonical_name));
            if (offset + 100 >= page.total || page.items.length === 0) break;
        }
        return names;
    }

    async getDocument(bankId: string, documentId: string, timeoutMs = this.#timeoutMs): Promise<{ original_text?: string | null } | undefined> {
        try {
            return await this.#request<{ original_text?: string | null }>('GET', `${this.#bank(bankId)}/documents/${encodeURIComponent(documentId)}`, undefined, timeoutMs);
        } catch (error) {
            if (error instanceof HindsightError && error.status === 404) return undefined;
            throw error;
        }
    }

    async deleteBank(bankId: string): Promise<void> {
        await this.#request('DELETE', this.#bank(bankId));
    }

    /** 删一篇文档（联系人遗忘，ADR 0070 第 9 项）；本来就没有算已经删了 */
    async deleteDocument(bankId: string, documentId: string): Promise<void> {
        await this.#deleteIfPresent(`${this.#bank(bankId)}/documents/${encodeURIComponent(documentId)}`);
    }

    async deleteMentalModel(bankId: string, modelId: string): Promise<void> {
        await this.#deleteIfPresent(`${this.#bank(bankId)}/mental-models/${encodeURIComponent(modelId)}`);
    }

    async #deleteIfPresent(path: string): Promise<void> {
        try {
            await this.#request('DELETE', path);
        } catch (error) {
            if (!(error instanceof HindsightError && error.status === 404)) throw error;
        }
    }

    /** 服务在不在（GET /health，docs/hindsight.md）；不在就抛错 */
    async health(timeoutMs = 3000): Promise<void> {
        await this.#request('GET', '/health', undefined, timeoutMs);
    }

    #bank(bankId: string): string {
        return `/v1/default/banks/${encodeURIComponent(bankId)}`;
    }

    async #request<T>(method: string, path: string, body?: unknown, timeoutMs = this.#timeoutMs): Promise<T> {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new HindsightError('记忆服务超时配置无效');
        const controller = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const timeout = new HindsightError(`记忆服务超时（${timeoutMs} ms）`);
        let timer: ReturnType<typeof setTimeout>;
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                void reader?.cancel().catch(() => undefined);
                reject(timeout);
            }, timeoutMs);
        });
        try {
            return await Promise.race([expired, (async () => {
                const response = await fetch(`${this.#baseUrl}${path}`, {
                    method,
                    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: controller.signal,
                });
                if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); throw timeout; }
                if (!response.ok) {
                    void response.body?.cancel().catch(() => undefined);
                    throw new HindsightError(`记忆服务返回 HTTP ${response.status}`, response.status);
                }
                let text: string;
                if (response.body) {
                    reader = response.body.getReader();
                    const chunks: Uint8Array[] = [];
                    let size = 0;
                    try {
                        for (;;) {
                            const next = await reader.read();
                            if (controller.signal.aborted) throw timeout;
                            if (next.done) break;
                            size += next.value.byteLength;
                            if (size > HINDSIGHT_MAX_RESPONSE_BYTES) throw new HindsightError('记忆服务响应过大');
                            chunks.push(next.value);
                        }
                        text = Buffer.concat(chunks, size).toString('utf8');
                    } finally {
                        void reader.cancel().catch(() => undefined);
                        reader.releaseLock();
                    }
                } else {
                    text = await response.text();
                    if (Buffer.byteLength(text, 'utf8') > HINDSIGHT_MAX_RESPONSE_BYTES) throw new HindsightError('记忆服务响应过大');
                }
                return (text ? JSON.parse(text) : {}) as T;
            })()]);
        } catch (error) {
            if (error instanceof HindsightError) throw error;
            throw new HindsightError(`记忆服务请求失败：${describeError(error)}`);
        } finally {
            clearTimeout(timer!);
        }
    }
}
