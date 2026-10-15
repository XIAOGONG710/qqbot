// 派生记忆的来源账：只记标识、联系人、依赖和写入状态，不保存聊天/日记正文。
// 写入远端前先登记 pending；网络返回不明时仍能在遗忘计划中找到目标。
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../json-file.ts';

export interface WrittenSources {
    contacts: readonly number[];
    parents: readonly string[];
    /** 是否有旧日记或其他未能追踪的输入；缺失信息绝不能当成“没有联系人”。 */
    complete: boolean;
}

export interface ProvenanceEntry {
    bankId: string;
    documentId: string;
    kind: 'qq' | 'diary' | 'week' | 'phase';
    contacts: number[];
    parents: string[];
    complete: boolean;
    at: string;
    retention: 'pending' | 'shared' | 'local-only';
}

interface ProvenanceFile { version: 1; entries: ProvenanceEntry[] }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\r\n\x00]/.test(v);
const validEntry = (v: unknown): v is ProvenanceEntry => object(v)
    && identifier(v.bankId) && identifier(v.documentId)
    && ['qq', 'diary', 'week', 'phase'].includes(String(v.kind))
    && Array.isArray(v.contacts) && v.contacts.every(q => Number.isSafeInteger(q) && q > 0)
    && Array.isArray(v.parents) && v.parents.every(identifier)
    && typeof v.complete === 'boolean' && typeof v.at === 'string' && Number.isFinite(Date.parse(v.at))
    && ['pending', 'shared', 'local-only'].includes(String(v.retention));

export function readProvenance(dir: string): ProvenanceEntry[] {
    return readJsonOr<ProvenanceFile>(join(dir, 'provenance.json'), { version: 1, entries: [] }, undefined, {
        validate: (v): v is ProvenanceFile => object(v) && v.version === 1 && Array.isArray(v.entries) && v.entries.every(validEntry),
        invalid: 'throw', label: '记忆来源账',
    }).entries;
}

/** 父文档都来自同一个公共 bank；缺任一父来源则保留不完整标记。 */
export function inheritedSources(dir: string, bankId: string, sources?: WrittenSources): WrittenSources {
    const entries = readProvenance(dir);
    const contacts = new Set(sources?.contacts ?? []);
    let complete = sources?.complete ?? false;
    for (const id of sources?.parents ?? []) {
        const parent = entries.find(e => e.bankId === bankId && e.documentId === id);
        if (!parent) { complete = false; continue; }
        parent.contacts.forEach(q => contacts.add(q));
        complete &&= parent.complete;
    }
    return { contacts: [...contacts].sort((a, b) => a - b), parents: [...new Set(sources?.parents ?? [])].sort(), complete };
}

export function recordProvenance(dir: string, entry: ProvenanceEntry): void {
    if (!validEntry(entry)) throw new Error('拒绝写入不符合 schema 的记忆来源账');
    const entries = readProvenance(dir);
    const at = entries.findIndex(e => e.bankId === entry.bankId && e.documentId === entry.documentId);
    // 同一文档覆盖时保留历史来源的并集：旧抽取事实可能还未被服务端替换完。
    const previous = entries[at];
    const next: ProvenanceEntry = {
        ...entry,
        contacts: [...new Set([...(previous?.contacts ?? []), ...entry.contacts])].sort((a, b) => a - b),
        parents: [...new Set([...(previous?.parents ?? []), ...entry.parents])].sort(),
        complete: entry.complete && (previous?.complete ?? true),
        // 新版本仅本地不代表远端旧版本已被删除；保留远端可能存在的证据。
        retention: entry.retention === 'local-only' && previous && previous.retention !== 'local-only' ? previous.retention : entry.retention,
    };
    if (at < 0) entries.push(next); else entries[at] = next;
    writeJsonAtomic(join(dir, 'provenance.json'), { version: 1, entries });
}

/** 远端元数据不直接含 QQ；哈希只是去直接标识，不是加密。本地来源账供审计。 */
export function provenanceMetadata(sources: WrittenSources): Record<string, string> {
    return {
        provenance_version: '1',
        source_contacts: JSON.stringify(sources.contacts.map(q => createHash('sha256').update(`qqbot-source:${q}`).digest('hex').slice(0, 16))),
        source_documents: JSON.stringify(sources.parents),
        source_complete: String(sources.complete),
    };
}

/** 同一个 bank 内按父关系向下闭包；也覆盖旧记录尚未扁平化的情况。 */
export function relatedProvenance(entries: readonly ProvenanceEntry[], qq: number): ProvenanceEntry[] {
    const related = new Set(entries.filter(e => e.contacts.includes(qq)));
    let changed = true;
    while (changed) {
        changed = false;
        for (const entry of entries) {
            if (!related.has(entry) && [...related].some(p => p.bankId === entry.bankId && entry.parents.includes(p.documentId))) {
                related.add(entry);
                changed = true;
            }
        }
    }
    return [...related];
}
