// Hindsight 服务的 HTTP 客户端，只有用到的几个接口。
// 请求体对照 hindsight-api 0.10.2 的 OpenAPI（test/fixtures/hindsight-openapi-0.10.2.json 是摘出来的部分，测试逐个字段核对）：
//   PUT  /v1/default/banks/{bank_id}                              建库或改配置（mission、disposition）
//   POST /v1/default/banks/{bank_id}/memories                     写入（retain）
//   POST /v1/default/banks/{bank_id}/memories/recall              召回
//   GET / POST /v1/default/banks/{bank_id}/mental-models[/{id}]   关系概况（Mental Model）
// 只有模拟器（sim/，ADR 0005）用的：
//   GET    /v1/default/banks/{bank_id}/operations?status=          后台任务（等抽取、整合做完）
//   POST   /v1/default/banks/{bank_id}/mental-models/{id}/refresh  手动刷新关系概况
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
    trigger: { refresh_after_consolidation: boolean; min_refresh_interval_seconds: number };
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
}

/** 写入请求体：后台异步处理（async），一次一个片段 */
export function retainBody(item: MemoryItem) {
    return { items: [item], async: true };
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

    /** 某个状态（pending / processing / completed / failed / cancelled）的后台任务有几个 */
    async countOperations(bankId: string, status: string): Promise<number> {
        const data = await this.#request<{ total?: number }>('GET', `${this.#bank(bankId)}/operations?status=${encodeURIComponent(status)}&limit=1`);
        return data.total ?? 0;
    }

    async refreshMentalModel(bankId: string, id: string): Promise<void> {
        await this.#request('POST', `${this.#bank(bankId)}/mental-models/${encodeURIComponent(id)}/refresh`);
    }

    async deleteBank(bankId: string): Promise<void> {
        await this.#request('DELETE', this.#bank(bankId));
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
