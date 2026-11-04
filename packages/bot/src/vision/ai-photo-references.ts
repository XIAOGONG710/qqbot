// AI 生活照的非人物参考资料登记（ADR 0242）。参考图只存放在受控状态目录，
// 对外列表仍只给逻辑编号；路径、内容哈希和图片正文不进入控制台响应或日志。

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { AI_PHOTO_REFERENCE_MAX_BYTES, AI_PHOTO_REFERENCE_MAX_COUNT, AI_PHOTO_REFERENCE_MAX_TOTAL_BYTES, aiPhotoDimensions } from './ai-photo-quality.ts';

export const AI_PHOTO_REFERENCE_KINDS = ['cat', 'desk', 'tableware', 'view'] as const;
export type AiPhotoReferenceKind = (typeof AI_PHOTO_REFERENCE_KINDS)[number];

export interface AiPhotoReference {
    id: string;
    kind: AiPhotoReferenceKind;
    contentHash: string;
    referenceId: string;
    addedAt: string;
    /** 固定哈希文件名；旧版只有外部引用 ID 的条目没有这个字段，不参与真实图像比较。 */
    file?: string;
}

interface ReferenceFile { version: 1; entries: AiPhotoReference[] }

export interface AiPhotoReferenceStore {
    add(input: { kind: AiPhotoReferenceKind; bytes: Uint8Array; referenceId: string; nonHumanSubject: true }): AiPhotoReference;
    remove(id: string): boolean;
    list(kind?: AiPhotoReferenceKind): AiPhotoReference[];
    idsFor(kind: AiPhotoReferenceKind, limit?: number): string[];
    imagesFor(kind: AiPhotoReferenceKind, limit?: number): AiPhotoReferenceImage[];
}

export interface AiPhotoReferenceImage {
    id: string;
    bytes: Uint8Array;
    type: 'image/jpeg' | 'image/png' | 'image/webp';
}

export { AI_PHOTO_REFERENCE_MAX_BYTES } from './ai-photo-quality.ts';
export const AI_PHOTO_REFERENCE_MAX_PER_KIND = AI_PHOTO_REFERENCE_MAX_COUNT;
export const AI_PHOTO_REFERENCE_MAX_TOTAL = AI_PHOTO_REFERENCE_MAX_PER_KIND * AI_PHOTO_REFERENCE_KINDS.length;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HUMAN_ID = /(?:person|people|human|face|selfie|portrait|人物|人脸|自拍|肖像)/i;
const validEntry = (value: unknown): value is AiPhotoReference => {
    if (!value || typeof value !== 'object') return false;
    const x = value as Partial<AiPhotoReference>;
    return typeof x.id === 'string' && /^[a-f0-9]{12}$/.test(x.id)
        && typeof x.kind === 'string' && AI_PHOTO_REFERENCE_KINDS.includes(x.kind as AiPhotoReferenceKind)
        && typeof x.contentHash === 'string' && /^[a-f0-9]{64}$/.test(x.contentHash)
        && typeof x.referenceId === 'string' && ID.test(x.referenceId) && !HUMAN_ID.test(x.referenceId)
        && typeof x.addedAt === 'string' && Number.isFinite(Date.parse(x.addedAt))
        && (x.file === undefined || (typeof x.file === 'string' && new RegExp(`^${x.id}\\.(?:jpg|png|webp)$`).test(x.file)));
};
const validFile = (value: unknown): value is ReferenceFile => {
    if (!value || typeof value !== 'object') return false;
    const x = value as Partial<ReferenceFile>;
    return x.version === 1 && Array.isArray(x.entries) && x.entries.length <= AI_PHOTO_REFERENCE_MAX_TOTAL && x.entries.every(validEntry)
        && new Set(x.entries.map(entry => entry.id)).size === x.entries.length
        && new Set(x.entries.map(entry => entry.contentHash)).size === x.entries.length
        && new Set(x.entries.map(entry => entry.referenceId)).size === x.entries.length
        && new Set(x.entries.flatMap(entry => entry.file ? [entry.file] : [])).size === x.entries.filter(entry => entry.file).length
        && AI_PHOTO_REFERENCE_KINDS.every(kind => x.entries!.filter(entry => entry.kind === kind).length <= AI_PHOTO_REFERENCE_MAX_PER_KIND);
};

export function aiPhotoReferenceStore(options: { file: string; now?: () => Date; log?: (message: string) => void }): AiPhotoReferenceStore {
    const now = options.now ?? (() => new Date());
    const directory = dirname(options.file);
    const filesDir = join(directory, 'files');
    if (existsSync(directory)) {
        const info = lstatSync(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('AI 照片参考资料目录不安全');
    }
    if (existsSync(options.file)) {
        const info = lstatSync(options.file);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('AI 照片参考资料索引不安全');
    }
    let state = readJsonOr<ReferenceFile>(options.file, { version: 1, entries: [] }, options.log, {
        validate: validFile, invalid: 'throw', label: 'AI 照片参考资料',
    });
    const ensureDirectories = () => {
        mkdirSync(filesDir, { recursive: true });
        for (const path of [directory, filesDir]) {
            const info = lstatSync(path);
            if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('AI 照片参考资料目录不安全');
        }
    };
    const checked = (entry: AiPhotoReference): AiPhotoReferenceImage | undefined => {
        if (!entry.file) return undefined;
        if (!new RegExp(`^${entry.id}\\.(?:jpg|png|webp)$`).test(entry.file)) throw new Error('AI 照片参考资料文件名不安全');
        if (!existsSync(filesDir)) throw new Error('AI 照片参考资料文件目录不存在');
        const dirInfo = lstatSync(filesDir);
        if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Error('AI 照片参考资料文件目录不安全');
        const path = join(filesDir, entry.file);
        if (!existsSync(path)) throw new Error('AI 照片参考资料文件不存在');
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > AI_PHOTO_REFERENCE_MAX_BYTES) throw new Error('AI 照片参考资料文件不安全');
        const bytes = new Uint8Array(readFileSync(path));
        if (createHash('sha256').update(bytes).digest('hex') !== entry.contentHash) throw new Error('AI 照片参考资料内容与索引不一致');
        const image = aiPhotoDimensions(bytes);
        if (!image || Math.min(image.width, image.height) < 64 || Math.max(image.width, image.height) > 8192) throw new Error('AI 照片参考资料格式或尺寸不受支持');
        const extension = image.type === 'image/jpeg' ? 'jpg' : image.type === 'image/png' ? 'png' : 'webp';
        if (!entry.file.endsWith(`.${extension}`)) throw new Error('AI 照片参考资料格式与文件名不一致');
        return { id: entry.id, bytes, type: image.type };
    };
    // 新版带本地图像的条目启动时即校验；旧版外部 ID 条目保留但不冒充可比较图片。
    for (const entry of state.entries) if (entry.file) checked(entry);
    const persist = () => { mkdirSync(directory, { recursive: true }); writeJsonAtomic(options.file, state); };
    return {
        add(input) {
            if (!AI_PHOTO_REFERENCE_KINDS.includes(input.kind)) throw new Error(`参考资料种类只能是 ${AI_PHOTO_REFERENCE_KINDS.join(' / ')}`);
            if (input.nonHumanSubject !== true) throw new Error('只允许登记不含人物的参考资料');
            if (!input.bytes.length || input.bytes.length > AI_PHOTO_REFERENCE_MAX_BYTES) throw new Error('参考资料为空或超过大小上限');
            const referenceId = input.referenceId.trim();
            if (!ID.test(referenceId) || HUMAN_ID.test(referenceId)) throw new Error('参考 ID 格式无效或指向人物内容');
            const image = aiPhotoDimensions(input.bytes);
            if (!image || Math.min(image.width, image.height) < 64 || Math.max(image.width, image.height) > 8192) throw new Error('参考资料格式或尺寸不受支持');
            const contentHash = createHash('sha256').update(input.bytes).digest('hex');
            const byHash = state.entries.find(entry => entry.contentHash === contentHash);
            const byReference = state.entries.find(entry => entry.referenceId === referenceId);
            if (byHash && byReference && byHash.id !== byReference.id) throw new Error('参考图片与参考名称分别属于不同条目');
            if (byHash && byHash.kind !== input.kind) throw new Error('同一张参考图片已经登记在另一种类别');
            if (byReference && byReference.contentHash !== contentHash) throw new Error('这个参考名称已经对应另一张图片');
            const existing = byHash ?? byReference;
            if (existing?.file) { checked(existing); return { ...existing }; }
            if (!existing && state.entries.length >= AI_PHOTO_REFERENCE_MAX_TOTAL) throw new Error('视觉参考已达到总数上限');
            if (!existing && state.entries.filter(entry => entry.kind === input.kind).length >= AI_PHOTO_REFERENCE_MAX_PER_KIND) throw new Error('这一类视觉参考已达到上限');
            const id = existing?.id ?? contentHash.slice(0, 12);
            const extension = image.type === 'image/jpeg' ? 'jpg' : image.type === 'image/png' ? 'png' : 'webp';
            const file = `${id}.${extension}`;
            ensureDirectories();
            const target = join(filesDir, file);
            if (!existsSync(target)) writeFileSync(target, input.bytes, { flag: 'wx' });
            else {
                const info = lstatSync(target);
                if (info.isSymbolicLink() || !info.isFile() || createHash('sha256').update(readFileSync(target)).digest('hex') !== contentHash) throw new Error('视觉参考文件冲突');
            }
            const entry: AiPhotoReference = { id, kind: input.kind, contentHash, referenceId, addedAt: existing?.addedAt ?? now().toISOString(), file };
            if (existing) state = { version: 1, entries: state.entries.map(item => item.id === existing.id ? entry : item) };
            else state = { version: 1, entries: [...state.entries, entry] };
            persist();
            options.log?.(`AI 照片参考资料：登记 ${entry.kind}（${entry.id}）`);
            return { ...entry };
        },
        remove(id) {
            const removed = state.entries.find(entry => entry.id === id.toLowerCase());
            const entries = state.entries.filter(entry => entry.id !== id.toLowerCase());
            if (entries.length === state.entries.length) return false;
            if (removed?.file) checked(removed);
            state = { version: 1, entries };
            persist();
            if (removed?.file) rmSync(join(filesDir, removed.file));
            return true;
        },
        list(kind) { return state.entries.filter(entry => !kind || entry.kind === kind).map(entry => ({ ...entry })); },
        idsFor(kind, limit = 4) {
            if (!AI_PHOTO_REFERENCE_KINDS.includes(kind)) return [];
            const count = Number.isInteger(limit) ? Math.max(0, Math.min(8, limit)) : 4;
            return state.entries.filter(entry => entry.kind === kind).slice(-count).map(entry => entry.referenceId);
        },
        imagesFor(kind, limit = AI_PHOTO_REFERENCE_MAX_PER_KIND) {
            if (!AI_PHOTO_REFERENCE_KINDS.includes(kind)) return [];
            const count = Number.isInteger(limit) ? Math.max(0, Math.min(AI_PHOTO_REFERENCE_MAX_PER_KIND, limit)) : AI_PHOTO_REFERENCE_MAX_PER_KIND;
            const images: AiPhotoReferenceImage[] = [];
            let bytes = 0;
            for (const entry of state.entries.filter(item => item.kind === kind && item.file).slice(-count)) {
                const image = checked(entry)!;
                if (bytes + image.bytes.length > AI_PHOTO_REFERENCE_MAX_TOTAL_BYTES) continue;
                images.push(image);
                bytes += image.bytes.length;
            }
            return images;
        },
    };
}
