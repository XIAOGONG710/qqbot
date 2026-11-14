// 行为基线（ADR 0336 第 2 步）用的假长期记忆：只在场景给了 memory 时换上，代替 Hindsight 服务回答 App 真发出去的 HTTP 请求。
// App 这边一行不改：HindsightClient 照常走全局 fetch，harness 把发到 FAKE_MEMORY_URL 的请求交给这里，别的照旧拦下。
// 回答是固定的：建库、写入（异步受理后立刻算做完）、建 / 读关系概况和印象（内容由场景给）、公共库的实体名、按规则给的召回结果。
// 每个请求在快照里记一行：方法、路径（bank 里的哈希换成 @QQ 号）、请求体里要紧的字段、回了什么。

import { createHash } from 'node:crypto';
import type { Contact } from '../../src/platform/config.ts';
import type { RecallResult } from '../../src/memory/hindsight.ts';

export const FAKE_MEMORY_URL = 'http://127.0.0.1:8888';
export const FAKE_MEMORY_PREFIX = 'baseline';

/** 一条召回规则：查的是这个库、查询里有这段字，就回这几条（按顺序找第一条对得上的，没有就回空的） */
export interface FakeRecall {
    /** 名单里某人的私人库（QQ 号）、公共库、DSH 工作房（bank 前缀本身） */
    bank: number | 'common' | 'work';
    query?: string;
    /** document_id 开头写「@QQ号:」的，换成那个人在公共库里的前缀（他的哈希） */
    results: RecallResult[];
}

export interface FakeMemory {
    recall?: FakeRecall[];
    /** 公共库里的实体名（他的话里出现了就是公共记忆的线索） */
    entities?: string[];
    /** 关系概况（他私人库里的 relationship 模型）建好之后的内容，按 QQ 号 */
    relationship?: Record<number, string>;
    /** 印象（公共库里的「她眼中的他」）建好之后的内容，按 QQ 号 */
    impressions?: Record<number, string>;
}

const hashOf = (contact: Contact) => createHash('sha256').update(`qqbot:${contact.qq}-${contact.tier}`).digest('hex').slice(0, 16);

interface Reply { status: number; json?: unknown; note: string }

/** 返回处理函数：拿到方法、路径（含查询串）、请求体，回一个最小的 Response（没有 body 流，客户端走 text()） */
export function fakeHindsight(memory: FakeMemory, contacts: readonly Contact[], record: (head: string, body?: string) => void) {
    const hashes = new Map(contacts.map(contact => [hashOf(contact), contact]));
    const named = (text: string) => {
        let out = text;
        for (const [hash, contact] of hashes) out = out.split(hash).join(`@${contact.qq}`);
        return out;
    };
    const bankOf = (bank: string): number | 'common' | 'work' | undefined => {
        if (bank === FAKE_MEMORY_PREFIX) return 'work';
        if (bank === `${FAKE_MEMORY_PREFIX}-common`) return 'common';
        return hashes.get(bank.slice(FAKE_MEMORY_PREFIX.length + 1))?.qq;
    };
    const models = new Set<string>();
    const operations = new Set<string>();
    const modelContent = (bank: string, id: string): string | null => {
        const owner = bankOf(bank);
        if (id === 'relationship' && typeof owner === 'number') return memory.relationship?.[owner] ?? null;
        const person = id.startsWith('person-') ? hashes.get(id.slice('person-'.length)) : undefined;
        if (owner === 'common' && person) return memory.impressions?.[person.qq] ?? null;
        return null;
    };
    const answer = (method: string, path: string, body: Record<string, unknown> | undefined): Reply => {
        if (path === '/health') return { status: 200, json: { status: 'healthy' }, note: '在' };
        const match = /^\/v1\/default\/banks\/([^/?]+)(\/[^?]*)?(?:\?(.*))?$/.exec(path);
        if (!match) return { status: 404, note: '404（假服务没有这个接口）' };
        const bank = decodeURIComponent(match[1]!);
        const rest = match[2] ?? '';
        const query = new URLSearchParams(match[3] ?? '');
        if (rest === '' && method === 'PUT') return { status: 200, json: {}, note: '建好了' };
        if (rest === '/memories' && method === 'POST') {
            const id = typeof body?.operation_id === 'string' ? body.operation_id : undefined;
            if (id) operations.add(id);
            const count = Array.isArray(body?.items) ? body.items.length : 0;
            return { status: 200, json: { success: true, async: true, bank_id: bank, items_count: count, ...(id ? { operation_id: id } : {}) }, note: '受理了' };
        }
        if (rest === '/memories/recall' && method === 'POST') {
            const owner = bankOf(bank);
            const text = typeof body?.query === 'string' ? body.query : '';
            const rule = memory.recall?.find(r => r.bank === owner && (r.query === undefined || text.includes(r.query)));
            const results = (rule?.results ?? []).map(result => ({
                ...result,
                ...(result.document_id?.startsWith('@') ? { document_id: result.document_id.replace(/^@(\d+):/, (_, qq: string) => {
                    const contact = contacts.find(c => c.qq === Number(qq));
                    if (!contact) throw new Error(`假记忆：召回结果里的 @${qq} 不在名单里`);
                    return `${hashOf(contact)}:`;
                }) } : {}),
            }));
            return { status: 200, json: { results, source_facts: {} }, note: results.length ? `${results.length} 条：${results.map(r => r.id).join('、')}` : '没有' };
        }
        if (rest === '/mental-models' && method === 'POST') {
            if (typeof body?.id === 'string') models.add(`${bank}/${body.id}`);
            return { status: 200, json: {}, note: '建好了' };
        }
        const model = /^\/mental-models\/([^/]+)(\/refresh)?$/.exec(rest);
        if (model) {
            const id = decodeURIComponent(model[1]!);
            if (!models.has(`${bank}/${id}`)) return { status: 404, note: '404（还没建）' };
            if (model[2] && method === 'POST') return { status: 200, json: { operation_id: `refresh-${id}` }, note: '排上了' };
            if (method === 'PATCH') return { status: 200, json: {}, note: '改好了' };
            if (method === 'GET') {
                const content = modelContent(bank, id);
                return { status: 200, json: { id, content }, note: content ? '有内容' : '空的' };
            }
        }
        if (rest === '/operations' && method === 'GET') {
            return { status: 200, json: { bank_id: bank, total: 0, limit: Number(query.get('limit') ?? 100), offset: Number(query.get('offset') ?? 0), operations: [] }, note: '没有' };
        }
        const operation = /^\/operations\/([^/]+)$/.exec(rest);
        if (operation && method === 'GET') {
            const id = decodeURIComponent(operation[1]!);
            if (!operations.has(id)) return { status: 404, note: '404（没有这个任务）' };
            return { status: 200, json: { operation_id: id, status: 'completed', operation_type: 'batch_retain', child_operations: [{ status: 'completed' }] }, note: '做完了' };
        }
        if (rest === '/entities' && method === 'GET') {
            const names = bankOf(bank) === 'common' ? memory.entities ?? [] : [];
            return { status: 200, json: { items: names.map(name => ({ canonical_name: name })), total: names.length }, note: `${names.length} 个` };
        }
        if (rest === '/documents' && method === 'GET') return { status: 200, json: { items: [], total: 0 }, note: '没有' };
        if (rest.startsWith('/documents/') && method === 'GET') return { status: 404, note: '404（没有这篇）' };
        if (rest.startsWith('/documents/') && method === 'DELETE') return { status: 200, json: {}, note: '删了' };
        return { status: 404, note: '404（假服务没有这个接口）' };
    };
    /** 请求体里要紧的字段：写入记全文（快照里看得到写了什么），召回记查询和过滤条件 */
    const brief = (path: string, body: Record<string, unknown> | undefined): string | undefined => {
        if (!body) return undefined;
        if (path.endsWith('/memories/recall')) {
            const { query, types, prefer_observations, tags, tags_match, max_tokens, query_timestamp, temporal_window } = body;
            return JSON.stringify({ query, types, prefer_observations, tags, tags_match, max_tokens, query_timestamp, ...(temporal_window ? { temporal_window } : {}) });
        }
        if (path.endsWith('/memories')) {
            const items = (Array.isArray(body.items) ? body.items : []) as Record<string, unknown>[];
            return items.map(({ document_id, timestamp, context, tags, entities, content }) =>
                JSON.stringify({ document_id, timestamp, context, tags, ...(entities ? { entities } : {}), content })).join('\n');
        }
        if (/\/mental-models(\/[^/]+)?$/.test(path)) {
            return JSON.stringify(Object.fromEntries(['id', 'name', 'tags', 'max_tokens'].filter(key => key in body).map(key => [key, body[key]])));
        }
        if (/\/banks\/[^/]+$/.test(path)) return JSON.stringify({ name: body.name });
        return JSON.stringify(Object.keys(body));
    };
    return (method: string, path: string, rawBody: string | undefined): Response => {
        const body = rawBody === undefined ? undefined : JSON.parse(rawBody) as Record<string, unknown>;
        const reply = answer(method, path, body);
        const shown = brief(path.split('?')[0]!, body);
        record(named(`记忆 ${method} ${path.replace(/^\/v1\/default/, '')} → ${reply.note}`), shown === undefined ? undefined : named(shown));
        const text = reply.json === undefined ? '' : JSON.stringify(reply.json);
        return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body: null, text: async () => text } as unknown as Response;
    };
}
