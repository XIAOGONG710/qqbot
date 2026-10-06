// Hindsight 服务的 HTTP 客户端，只有用到的几个接口。
// 请求体对照 hindsight-api 0.10.2 的 OpenAPI（test/fixtures/hindsight-openapi-0.10.2.json 是摘出来的部分，测试逐个字段核对）：
//   PUT  /v1/default/banks/{bank_id}                              建库或改配置（mission、disposition）
//   POST /v1/default/banks/{bank_id}/memories                     写入（retain）
//   POST /v1/default/banks/{bank_id}/memories/recall              召回
//   GET / POST / PATCH /v1/default/banks/{bank_id}/mental-models[/{id}]   关系概况（Mental Model）
//   POST /v1/default/banks/{bank_id}/mental-models/{id}/refresh    设定改了之后手动刷新一次
// 只有模拟器（sim/，ADR 0005）用的：
//   GET    /v1/default/banks/{bank_id}/operations[/{id}]           后台任务（等抽取、整合、刷新做完）
//   DELETE /v1/default/banks/{bank_id}                             删掉测试 bank
// 出错（连不上、超时、非 2xx）一律抛 HindsightError，由调用方记日志，不在这里吞掉。

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
    include: { entities: null };
    /** 时间检索用的时间窗：代替从查询文字里解析日期，只加权、不过滤（ISO，带时区） */
    temporal_window?: { start: string; end: string };
}

export interface RecallResult {
    id: string;
    text: string;
    type?: string | null;
    occurred_start?: string | null;
    mentioned_at?: string | null;
    document_id?: string | null;
}

export interface MentalModelRequest {
    id: string;
    name: string;
    source_query: string;
    tags: string[];
    max_tokens: number;
    /** budget：刷新时检索、迭代的预算（不写是 mid） */
    trigger: { refresh_after_consolidation: boolean; min_refresh_interval_seconds: number; budget?: 'low' | 'mid' | 'high' };
}

export interface MentalModel {
    id: string;
    content?: string | null;
    last_refreshed_at?: string | null;
}

export interface HindsightApi {
    putBank(bankId: string, config: BankConfig): Promise<void>;
    retain(bankId: string, item: MemoryItem): Promise<void>;
    recall(bankId: string, request: RecallRequest, timeoutMs?: number): Promise<RecallResult[]>;
    getMentalModel(bankId: string, id: string): Promise<MentalModel | undefined>;
    createMentalModel(bankId: string, request: MentalModelRequest): Promise<void>;
    /** 改已有的 Mental Model 的设定（源查询、长度、触发条件）；内容要等下一次刷新才变 */
    updateMentalModel(bankId: string, id: string, request: MentalModelRequest): Promise<void>;
    /** 手动刷新，返回后台任务 id */
    refreshMentalModel(bankId: string, id: string): Promise<string>;
    /** bank 里所有实体的名字（ADR 0017：公共记忆的线索）；没有这个方法就不按实体找线索 */
    listEntities?(bankId: string, timeoutMs?: number): Promise<string[]>;
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

    async putBank(bankId: string, config: BankConfig): Promise<void> {
        await this.#request('PUT', this.#bank(bankId), config);
    }

    async retain(bankId: string, item: MemoryItem): Promise<void> {
        await this.#request('POST', `${this.#bank(bankId)}/memories`, retainBody(item));
    }

    async recall(bankId: string, request: RecallRequest, timeoutMs?: number): Promise<RecallResult[]> {
        const data = await this.#request<{ results?: RecallResult[] }>('POST', `${this.#bank(bankId)}/memories/recall`, request, timeoutMs);
        return data.results ?? [];
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

    async deleteBank(bankId: string): Promise<void> {
        await this.#request('DELETE', this.#bank(bankId));
    }

    /** 服务在不在（GET /health，docs/hindsight.md）；不在就抛错 */
    async health(timeoutMs = 3000): Promise<void> {
        await this.#request('GET', '/health', undefined, timeoutMs);
    }

    #bank(bankId: string): string {
        return `/v1/default/banks/${encodeURIComponent(bankId)}`;
    }

    async #request<T>(method: string, path: string, body?: unknown, timeoutMs = this.#timeoutMs): Promise<T> {
        let response: Response;
        try {
            response = await fetch(`${this.#baseUrl}${path}`, {
                method,
                headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            const reason = error instanceof Error && error.name === 'TimeoutError' ? `超时（${timeoutMs} ms）` : String(error instanceof Error ? error.message : error);
            throw new HindsightError(`${method} ${path} 失败：${reason}`);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new HindsightError(`${method} ${path} 返回 ${response.status}：${text.slice(0, 300)}`, response.status);
        }
        return (text ? JSON.parse(text) : {}) as T;
    }
}
