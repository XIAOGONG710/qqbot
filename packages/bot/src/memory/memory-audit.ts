// 记忆修改有留痕（ADR 0158，配置 memoryAudit，默认关）。
// 来自 10-25 用户给的清单：「真实记忆保障：尤其发生矛盾时，不擅自删除、伪造共同经历；重要事件如实记录，纠错也留痕」。
// 做法：长期记忆（Hindsight）的所有写入都经过 HindsightApi.retain，把它包一层——每写一条，在哈希链账本（ledger.ts）里记一行：
// 哪个库、哪篇文档、什么时候的内容、多长、内容的哈希前 16 位；**不记原文**（账本不能变成第二份记忆）。
// 删除（privacy-forget 的「忘掉某个联系人」）和用户手动写的纠错说明也记进同一本账。
// 能说明什么：之后任何时候都能对出「这一条是不是真的写进去过、写的是不是这个内容」；账本验得过，说明记录没被悄悄改。
// 不能说明什么：Hindsight 自己的数据库如果被人直接改了（不经过 bot），这里看不到——它没有「列出所有文档」的接口，没法逐条对账。

import { join } from 'node:path';
import { Ledger, sha256 } from './ledger.ts';
import type { HindsightApi, MemoryItem, MentalModelRequest } from '.././memory/hindsight.ts';

export const memoryLedgerPath = (dataDir: string) => join(dataDir, 'identity', 'memory.jsonl');
export const memoryLedger = (dataDir: string) => new Ledger(memoryLedgerPath(dataDir));

export interface AuditOptions {
    now?: () => Date;
    log?: (message: string) => void;
}

/** 写账本出错（磁盘满、被占用）不能让记忆写入失败：记日志，照常写 */
function warn(options: AuditOptions): void { try { options.log?.('记忆账本：记录准备或写入失败，这一条没留痕'); } catch { /* 派生审计不能把主写入改判失败。 */ } }
function snapshot(build: () => Record<string, unknown>): Record<string, unknown> | undefined {
    try { return JSON.parse(JSON.stringify(build())) as Record<string, unknown>; } catch { return undefined; }
}
function safeAppend(ledger: Ledger, kind: string, data: Record<string, unknown> | undefined, options: AuditOptions): void {
    if (!data) { warn(options); return; }
    try {
        ledger.append(kind, data, options.now?.() ?? new Date());
    } catch { warn(options); }
}

/** 把记忆接口包一层：写入成功之后留痕，其余方法原样转发 */
export function auditedApi<T extends HindsightApi>(api: T, ledger: Ledger, options: AuditOptions = {}): T {
    return new Proxy(api, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target) as unknown;
            if (prop === 'retain' || prop === 'submitRetain') {
                if (typeof value !== 'function') return value;
                return async (bankId: string, item: MemoryItem, ...rest: unknown[]) => {
                    const data = snapshot(() => {
                        let chars = 0; for (const _ of item.content) chars++;
                        return { bank: bankId, document: item.document_id, tags: item.tags, occurred: item.timestamp, chars, sha: sha256(item.content).slice(0, 16),
                            ...(prop === 'submitRetain' ? { operation: sha256(String(rest[0])).slice(0, 16), stage: 'accepted' } : {}) };
                    });
                    await (value as (...args: unknown[]) => Promise<void>).call(target, bankId, item, ...rest);
                    safeAppend(ledger, prop === 'retain' ? 'retain' : 'retain-submit', data, options);
                };
            }
            if (prop === 'deleteDocument') {
                if (typeof value !== 'function') return value;
                return async (bankId: string, documentId: string) => {
                    await (value as (bank: string, document: string) => Promise<void>).call(target, bankId, documentId);
                    safeAppend(ledger, 'document-delete', snapshot(() => ({ bank: bankId, document: documentId })), options);
                };
            }
            const repairKinds: Record<string, string> = {
                repairConfigureModel: 'model-repair-configure', repairClearModel: 'model-repair-clear',
                repairRefreshModel: 'model-repair-refresh-submit', repairRestoreAutomatic: 'model-repair-restore',
            };
            if (typeof prop === 'string' && Object.hasOwn(repairKinds, prop)) {
                if (typeof value !== 'function') return value;
                return async (bankId: string, modelId: string, ...rest: unknown[]) => {
                    // 不检查/序列化返回的模型正文；审计是副结果，必须原样交还真实ACK。
                    const data = snapshot(() => ({ bank: bankId, model: modelId,
                        stage: prop === 'repairRefreshModel' ? 'accepted' : 'acknowledged',
                        ...(prop === 'repairRestoreAutomatic' ? {
                            ...(Number.isSafeInteger(rest[0]) && Number(rest[0]) >= 0 ? { cadence: rest[0] } : {}),
                            ...(rest[1] === undefined || typeof rest[1] === 'boolean' ? { automatic: rest[1] ?? true } : {}),
                        } : {}),
                    }));
                    const receipt = await (value as (...args: unknown[]) => Promise<unknown>).call(target, bankId, modelId, ...rest);
                    const recorded = prop === 'repairRefreshModel' && data ? snapshot(() => {
                        if (typeof receipt !== 'string') throw new Error('invalid operation receipt');
                        return { ...data, operation: sha256(receipt).slice(0, 16) };
                    }) : data;
                    safeAppend(ledger, repairKinds[prop]!, recorded, options);
                    return receipt;
                };
            }
            if (prop === 'createMentalModel' || prop === 'updateMentalModel') {
                return async (bankId: string, ...rest: unknown[]) => {
                    const request = (prop === 'createMentalModel' ? rest[0] : rest[1]) as MentalModelRequest;
                    const data = snapshot(() => ({ bank: bankId, model: request.id, name: request.name, query: sha256(request.source_query).slice(0, 16) }));
                    await (value as (...args: unknown[]) => Promise<void>).call(target, bankId, ...rest);
                    safeAppend(ledger, prop === 'createMentalModel' ? 'model-create' : 'model-update', data, options);
                };
            }
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
    });
}

export interface ForgetRecord {
    applied: boolean;
    plan?: { hindsight?: { banks?: string[]; documents?: string[]; mentalModels?: string[] } };
    deleted?: { banks?: string[]; documents?: string[]; mentalModels?: string[] };
    trash?: string;
    failures?: unknown[];
}

/** 「忘掉某个联系人」的结果记进账本：删了哪些库 / 文档 / 印象模型（只记 id 和数量），本地文件挪去了哪里 */
export function recordForget(ledger: Ledger, contact: number, result: ForgetRecord, options: AuditOptions = {}): void {
    const deleted = result.deleted ?? {};
    safeAppend(ledger, result.applied ? 'forget' : 'forget-dry-run', {
        contact: sha256(String(contact)).slice(0, 12),
        banks: deleted.banks ?? result.plan?.hindsight?.banks ?? [],
        documents: (deleted.documents ?? result.plan?.hindsight?.documents ?? []).length,
        mentalModels: (deleted.mentalModels ?? result.plan?.hindsight?.mentalModels ?? []).length,
        ...(result.trash ? { trash: result.trash } : {}),
        failures: result.failures?.length ?? 0,
    }, options);
}

/** 用户手动写的一条说明（纠错、补记、为什么改了某条记忆） */
export function recordNote(ledger: Ledger, text: string, by: string, options: AuditOptions = {}): void {
    safeAppend(ledger, 'note', { by, text: text.slice(0, 400) }, options);
}

/** /记忆 或命令行看的摘要：每种操作各多少条、最近一条、账本验没验过 */
export function summarize(ledger: Ledger): string {
    const chain = ledger.verify();
    const entries = ledger.read();
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    const last = entries.at(-1);
    const parts = [...counts.entries()].map(([kind, n]) => `${LABELS[kind] ?? kind} ${n}`);
    return [
        `记忆账本：${chain.ok ? '验过了' : `验不过——${chain.reason}（从第 ${chain.brokenAt} 条起）`}，共 ${chain.count} 条${parts.length ? `（${parts.join('，')}）` : ''}`,
        last ? `最后一条：${last.at.slice(0, 16).replace('T', ' ')}（${LABELS[last.kind] ?? last.kind}）` : '还没有记录。',
    ].join('\n');
}

const LABELS: Record<string, string> = {
    retain: '写入', 'retain-submit': '异步受理', 'document-delete': '删除文档', 'model-create': '建印象模型', 'model-update': '改印象模型', forget: '忘掉联系人', 'forget-dry-run': '忘掉联系人（只演练）', note: '说明',
    'model-repair-configure': '暂停模型自动刷新', 'model-repair-clear': '清理模型正文',
    'model-repair-refresh-submit': '受理模型重建', 'model-repair-restore': '恢复模型刷新配置',
};
