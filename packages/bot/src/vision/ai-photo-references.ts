// AI 生活照的非人物参考资料登记（ADR 0242）。只存引用 ID 和内容哈希，不存图片、路径、人脸描述或自由文本。

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';

export const AI_PHOTO_REFERENCE_KINDS = ['cat', 'desk', 'tableware', 'view'] as const;
export type AiPhotoReferenceKind = (typeof AI_PHOTO_REFERENCE_KINDS)[number];

export interface AiPhotoReference {
    id: string;
    kind: AiPhotoReferenceKind;
    contentHash: string;
    referenceId: string;
    addedAt: string;
}

interface ReferenceFile { version: 1; entries: AiPhotoReference[] }

export interface AiPhotoReferenceStore {
    add(input: { kind: AiPhotoReferenceKind; bytes: Uint8Array; referenceId: string; nonHumanSubject: true }): AiPhotoReference;
    remove(id: string): boolean;
    list(kind?: AiPhotoReferenceKind): AiPhotoReference[];
    idsFor(kind: AiPhotoReferenceKind, limit?: number): string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HUMAN_ID = /(?:person|people|human|face|selfie|portrait|人物|人脸|自拍|肖像)/i;
const validEntry = (value: unknown): value is AiPhotoReference => {
    if (!value || typeof value !== 'object') return false;
    const x = value as Partial<AiPhotoReference>;
    return typeof x.id === 'string' && /^[a-f0-9]{12}$/.test(x.id)
        && typeof x.kind === 'string' && AI_PHOTO_REFERENCE_KINDS.includes(x.kind as AiPhotoReferenceKind)
        && typeof x.contentHash === 'string' && /^[a-f0-9]{64}$/.test(x.contentHash)
        && typeof x.referenceId === 'string' && ID.test(x.referenceId) && !HUMAN_ID.test(x.referenceId)
        && typeof x.addedAt === 'string' && Number.isFinite(Date.parse(x.addedAt));
};
const validFile = (value: unknown): value is ReferenceFile => {
    if (!value || typeof value !== 'object') return false;
    const x = value as Partial<ReferenceFile>;
    return x.version === 1 && Array.isArray(x.entries) && x.entries.every(validEntry)
        && new Set(x.entries.map(entry => entry.id)).size === x.entries.length
        && new Set(x.entries.map(entry => entry.referenceId)).size === x.entries.length;
};

export function aiPhotoReferenceStore(options: { file: string; now?: () => Date; log?: (message: string) => void }): AiPhotoReferenceStore {
    const now = options.now ?? (() => new Date());
    let state = readJsonOr<ReferenceFile>(options.file, { version: 1, entries: [] }, options.log, {
        validate: validFile, invalid: 'throw', label: 'AI 照片参考资料',
    });
    const persist = () => { mkdirSync(dirname(options.file), { recursive: true }); writeJsonAtomic(options.file, state); };
    return {
        add(input) {
            if (!AI_PHOTO_REFERENCE_KINDS.includes(input.kind)) throw new Error(`参考资料种类只能是 ${AI_PHOTO_REFERENCE_KINDS.join(' / ')}`);
            if (input.nonHumanSubject !== true) throw new Error('只允许登记不含人物的参考资料');
            if (!input.bytes.length) throw new Error('参考资料不能为空');
            const referenceId = input.referenceId.trim();
            if (!ID.test(referenceId) || HUMAN_ID.test(referenceId)) throw new Error('参考 ID 格式无效或指向人物内容');
            const contentHash = createHash('sha256').update(input.bytes).digest('hex');
            const existing = state.entries.find(entry => entry.contentHash === contentHash || entry.referenceId === referenceId);
            if (existing) return { ...existing };
            const entry: AiPhotoReference = { id: contentHash.slice(0, 12), kind: input.kind, contentHash, referenceId, addedAt: now().toISOString() };
            state = { version: 1, entries: [...state.entries, entry] };
            persist();
            options.log?.(`AI 照片参考资料：登记 ${entry.kind}（${entry.id}）`);
            return { ...entry };
        },
        remove(id) {
            const entries = state.entries.filter(entry => entry.id !== id.toLowerCase());
            if (entries.length === state.entries.length) return false;
            state = { version: 1, entries };
            persist();
            return true;
        },
        list(kind) { return state.entries.filter(entry => !kind || entry.kind === kind).map(entry => ({ ...entry })); },
        idsFor(kind, limit = 4) {
            if (!AI_PHOTO_REFERENCE_KINDS.includes(kind)) return [];
            const count = Number.isInteger(limit) ? Math.max(0, Math.min(8, limit)) : 4;
            return state.entries.filter(entry => entry.kind === kind).slice(-count).map(entry => entry.referenceId);
        },
    };
}
