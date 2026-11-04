// AI 生活照草稿（ADR 0239）：生图只进入本地待审核区，绝不在这里发送 QQ。
// 审核通过后才复制进现有照片货架；生图密钥与聊天模型密钥分开。

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { detectImageType } from './safe-image.ts';
import { PHOTO_MAX_BYTES, type PhotoKind, type PhotoShelf } from './photos.ts';

export const AI_PHOTO_KINDS = ['cat', 'food', 'desk', 'view'] as const;
export type AiPhotoKind = (typeof AI_PHOTO_KINDS)[number];
export type AiPhotoDraftStatus = 'pending_review' | 'approved' | 'rejected';

export interface AiPhotoContext {
    kind: AiPhotoKind;
    /** 同一件现实事件的稳定键，防止重试时重复付费生成。 */
    eventKey: string;
    /** 画面主体，只写可见事实。 */
    subject: string;
    /** 审核通过后进入照片货架的说明。 */
    caption: string;
    at: string;
    dish?: string;
    weather?: string;
    place?: string;
    activity?: string;
}

export interface AiPhotoDraft {
    id: string;
    eventKey: string;
    kind: AiPhotoKind;
    subject: string;
    caption: string;
    at: string;
    createdAt: string;
    /** 作为“当下照片”有效到什么时候；旧索引没有该字段时按事件时间和种类推导。 */
    expiresAt?: string;
    file: string;
    status: AiPhotoDraftStatus;
    model: string;
    /** 只留哈希用于审计；完整提示词不落盘，避免把位置等上下文扩散到状态文件。 */
    promptHash: string;
    dish?: string;
    reviewedAt?: string;
    shelfId?: string;
}

const AI_PHOTO_FRESH_MS: Record<AiPhotoKind, number> = {
    cat: 6 * 60 * 60_000,
    food: 3 * 60 * 60_000,
    desk: 2 * 60 * 60_000,
    view: 2 * 60 * 60_000,
};

export type AiPhotoDraftFreshness = { fresh: true; expiresAt: string } | { fresh: false; expiresAt: string; reason: string };

/** 过期只影响“当下照片”的批准/发送资格，文件仍保留给人工审计。 */
export function aiPhotoDraftFreshness(entry: Pick<AiPhotoDraft, 'kind' | 'at' | 'expiresAt'>, at: Date = new Date()): AiPhotoDraftFreshness {
    const fallback = Date.parse(entry.at) + AI_PHOTO_FRESH_MS[entry.kind];
    const expires = entry.expiresAt ? Date.parse(entry.expiresAt) : fallback;
    if (!Number.isFinite(expires) || !Number.isFinite(at.getTime())) {
        return { fresh: false, expiresAt: '', reason: '这张照片的时效信息无效，不能作为当前照片使用' };
    }
    const expiresAt = new Date(expires).toISOString();
    return at.getTime() < expires
        ? { fresh: true, expiresAt }
        : { fresh: false, expiresAt, reason: `这张照片已于 ${expiresAt} 过期，不能再作为当前照片使用` };
}

interface AiPhotoIndex { version: 1; entries: AiPhotoDraft[] }
export interface GeneratedAiPhoto { bytes: Uint8Array; model: string }
export type AiPhotoGenerator = (prompt: string) => Promise<GeneratedAiPhoto>;
export type ImageGenerationFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface ImageGenerationOptions {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs?: number;
    fetch?: ImageGenerationFetch;
}

export interface AiPhotoDraftStore {
    generate(context: AiPhotoContext, generator: AiPhotoGenerator): Promise<AiPhotoDraft>;
    list(status?: AiPhotoDraftStatus): AiPhotoDraft[];
    /** 给受控审核界面读取；每次都重新校验普通文件、内容哈希和真实格式。 */
    preview(id: string): { bytes: Uint8Array; type: 'image/jpeg' | 'image/png' | 'image/webp' };
    approve(id: string, shelf: Pick<PhotoShelf, 'add'>): AiPhotoDraft;
    reject(id: string): AiPhotoDraft;
    status(): { total: number; pending: number; approved: number; rejected: number };
}

const MAX_TEXT = 160;
const clean = (value: string | undefined) => value?.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const validDate = (value: string) => Number.isFinite(Date.parse(value));
const validEntry = (value: unknown): value is AiPhotoDraft => {
    if (!value || typeof value !== 'object') return false;
    const x = value as Partial<AiPhotoDraft>;
    return typeof x.id === 'string' && /^[a-f0-9]{12}$/.test(x.id)
        && typeof x.eventKey === 'string' && Boolean(clean(x.eventKey))
        && typeof x.kind === 'string' && AI_PHOTO_KINDS.includes(x.kind as AiPhotoKind)
        && typeof x.subject === 'string' && Boolean(clean(x.subject))
        && typeof x.caption === 'string' && Boolean(clean(x.caption))
        && typeof x.at === 'string' && validDate(x.at)
        && typeof x.createdAt === 'string' && validDate(x.createdAt)
        && (x.expiresAt === undefined || (typeof x.expiresAt === 'string' && validDate(x.expiresAt)))
        && typeof x.file === 'string' && new RegExp(`^${x.id}\\.(?:jpg|png|webp)$`).test(x.file)
        && ['pending_review', 'approved', 'rejected'].includes(x.status ?? '')
        && typeof x.model === 'string' && Boolean(clean(x.model))
        && typeof x.promptHash === 'string' && /^[a-f0-9]{64}$/.test(x.promptHash)
        && (x.dish === undefined || typeof x.dish === 'string')
        && (x.reviewedAt === undefined || (typeof x.reviewedAt === 'string' && validDate(x.reviewedAt)))
        && (x.shelfId === undefined || (typeof x.shelfId === 'string' && /^[a-f0-9]{12}$/.test(x.shelfId)));
};

const validIndex = (value: unknown): value is AiPhotoIndex => {
    if (!value || typeof value !== 'object') return false;
    const x = value as Partial<AiPhotoIndex>;
    return x.version === 1 && Array.isArray(x.entries) && x.entries.every(validEntry)
        && new Set(x.entries.map(entry => entry.id)).size === x.entries.length
        && new Set(x.entries.map(entry => entry.eventKey)).size === x.entries.length
        && new Set(x.entries.map(entry => entry.file)).size === x.entries.length;
};

const kindScene: Record<AiPhotoKind, string> = {
    cat: 'A familiar calico stray cat in an ordinary residential or campus corner; keep the cat visually consistent and do not add a collar.',
    food: 'An ordinary meal as actually served, with plausible portions, tableware and surroundings; no styled restaurant advertisement.',
    desk: 'An ordinary student desk with naturally used objects and mild clutter; screens and pages must contain no readable text.',
    view: 'An ordinary view from a window or a walk, matching the stated time and weather; no famous landmark.',
};

/** 只把世界账中已经存在的事实变成画面约束，不让生图模型续写故事。 */
export function buildAiPhotoPrompt(context: AiPhotoContext): string {
    if (!AI_PHOTO_KINDS.includes(context.kind)) throw new Error(`照片种类只能是 ${AI_PHOTO_KINDS.join(' / ')}`);
    const subject = clean(context.subject);
    const caption = clean(context.caption);
    if (!subject || !caption) throw new Error('画面主体和照片说明不能为空');
    if (!validDate(context.at)) throw new Error('照片时间不是有效日期');
    if (context.kind === 'food' && !clean(context.dish)) throw new Error('食物照片必须给出菜名');
    const facts = [
        `Subject: ${subject}.`,
        clean(context.dish) ? `Dish: ${clean(context.dish)}.` : '',
        clean(context.weather) ? `Weather: ${clean(context.weather)}.` : '',
        clean(context.place) ? `Generic setting: ${clean(context.place)}.` : '',
        clean(context.activity) ? `Current activity: ${clean(context.activity)}.` : '',
        `Local time: ${new Date(context.at).toISOString()}.`,
    ].filter(Boolean).join(' ');
    return [
        'Create one believable, mundane phone snapshot for a fictional adult companion.',
        kindScene[context.kind],
        facts,
        'Use natural ambient light, slightly imperfect framing, realistic materials, subtle phone-sensor noise and ordinary color.',
        'Do not use cinematic grading, studio lighting, advertising composition, excessive HDR or dramatic shallow depth of field.',
        'Show no person, face, body part, hand or reflection of the photographer. Add no readable text, logo, watermark or timestamp.',
        'Do not invent a precise address, famous landmark, extra event or hidden backstory. Depict only the supplied visible facts.',
    ].join(' ');
}

function generationEndpoint(raw: string): string {
    let base: URL;
    try { base = new URL(raw.endsWith('/') ? raw : `${raw}/`); } catch { throw new Error('生图服务地址无效'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(base.hostname.toLowerCase());
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) throw new Error('生图服务必须使用 HTTPS；仅本机服务可使用 HTTP');
    if (base.username || base.password) throw new Error('生图服务地址不能包含账号或密钥');
    return new URL('images/generations', base).href;
}

function decodeBase64(value: unknown): Uint8Array {
    if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('生图服务没有返回有效图片');
    const bytes = new Uint8Array(Buffer.from(value, 'base64'));
    if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) throw new Error('生成图片为空或超过大小上限');
    const type = detectImageType(bytes);
    if (!type || type === 'image/gif') throw new Error('生成图片格式不受支持');
    return bytes;
}

/** 调用兼容 /v1/images/generations 的服务；错误不读取响应正文，避免供应商把输入或密钥回显进日志。 */
export async function generateAiPhoto(prompt: string, options: ImageGenerationOptions): Promise<GeneratedAiPhoto> {
    if (!options.apiKey.trim()) throw new Error('缺少生图服务密钥');
    if (!options.model.trim()) throw new Error('缺少生图模型名称');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('生图超时')), options.timeoutMs ?? 90_000);
    try {
        const fetchImage = options.fetch ?? (globalThis.fetch as ImageGenerationFetch);
        const response = await fetchImage(generationEndpoint(options.baseUrl), {
            method: 'POST',
            headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: options.model, prompt, n: 1, size: '1024x1024', quality: 'medium', output_format: 'jpeg', background: 'opaque' }),
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`生图服务返回 ${response.status}`);
        const body = await response.json() as { data?: Array<{ b64_json?: unknown }> };
        return { bytes: decodeBase64(body.data?.[0]?.b64_json), model: options.model };
    } finally {
        clearTimeout(timer);
    }
}

const extension = (bytes: Uint8Array) => {
    const type = detectImageType(bytes);
    if (type === 'image/jpeg') return 'jpg';
    if (type === 'image/png') return 'png';
    if (type === 'image/webp') return 'webp';
    throw new Error('生成图片格式不受支持');
};

const shelfKind: Record<AiPhotoKind, PhotoKind> = { cat: 'cat', food: 'food', desk: 'work', view: 'view' };

export function aiPhotoDraftStore(options: { dir: string; now?: () => Date; log?: (message: string) => void }): AiPhotoDraftStore {
    const now = options.now ?? (() => new Date());
    const indexFile = join(options.dir, 'index.json');
    const filesDir = join(options.dir, 'files');
    if (existsSync(indexFile) && lstatSync(indexFile).isSymbolicLink()) throw new Error('AI 照片草稿索引不能是符号链接');
    let index = readJsonOr<AiPhotoIndex>(indexFile, { version: 1, entries: [] }, options.log, { validate: validIndex, invalid: 'throw', label: 'AI 照片草稿' });
    const ensureFilesDir = () => {
        mkdirSync(filesDir, { recursive: true });
        const info = lstatSync(filesDir);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('AI 照片草稿文件目录不安全');
    };
    const checkedSource = (entry: AiPhotoDraft) => {
        if (!new RegExp(`^${entry.id}\\.(?:jpg|png|webp)$`).test(entry.file)) throw new Error('草稿图片文件名与编号不一致');
        if (!existsSync(filesDir)) throw new Error('草稿图片文件不存在');
        const dirInfo = lstatSync(filesDir);
        if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Error('AI 照片草稿文件目录不安全');
        const source = join(filesDir, entry.file);
        if (!existsSync(source)) throw new Error('草稿图片文件不存在');
        const info = lstatSync(source);
        if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > PHOTO_MAX_BYTES) throw new Error('草稿图片文件不安全');
        const bytes = readFileSync(source);
        if (createHash('sha256').update(bytes).digest('hex').slice(0, 12) !== entry.id) throw new Error('草稿图片内容与编号不一致');
        const expected = extension(bytes);
        if (!entry.file.endsWith(`.${expected}`)) throw new Error('草稿图片格式与文件名不一致');
        return source;
    };
    const persist = () => { mkdirSync(options.dir, { recursive: true }); writeJsonAtomic(indexFile, index); };
    const find = (id: string) => index.entries.find(entry => entry.id === id.toLowerCase());
    const update = (entry: AiPhotoDraft) => {
        index = { version: 1, entries: index.entries.map(item => item.id === entry.id ? entry : item) };
        persist();
        return entry;
    };
    return {
        async generate(context, generator) {
            const eventKey = clean(context.eventKey);
            if (!eventKey) throw new Error('事件键不能为空');
            const existing = index.entries.find(entry => entry.eventKey === eventKey);
            if (existing) return existing;
            // 先检查落盘目录，再调用可能计费的生图服务；目录异常时不浪费一次额度。
            ensureFilesDir();
            const prompt = buildAiPhotoPrompt(context);
            const generated = await generator(prompt);
            if (generated.bytes.length > PHOTO_MAX_BYTES) throw new Error('生成图片超过大小上限');
            const id = createHash('sha256').update(generated.bytes).digest('hex').slice(0, 12);
            const sameImage = find(id);
            if (sameImage) return sameImage;
            const ext = extension(generated.bytes);
            const file = `${id}.${ext}`;
            writeFileSync(join(filesDir, file), generated.bytes, { flag: 'wx' });
            const entry: AiPhotoDraft = {
                id, eventKey, kind: context.kind, subject: clean(context.subject)!, caption: clean(context.caption)!,
                at: new Date(context.at).toISOString(), createdAt: now().toISOString(),
                expiresAt: new Date(Date.parse(context.at) + AI_PHOTO_FRESH_MS[context.kind]).toISOString(), file,
                status: 'pending_review', model: clean(generated.model) || 'unknown',
                promptHash: createHash('sha256').update(prompt).digest('hex'),
                ...(clean(context.dish) ? { dish: clean(context.dish) } : {}),
            };
            index = { version: 1, entries: [...index.entries, entry] };
            persist();
            options.log?.(`AI 照片草稿：生成 ${entry.kind}（${entry.id}），等待审核`);
            return entry;
        },
        list: status => index.entries.filter(entry => !status || entry.status === status).map(entry => ({ ...entry })),
        preview(id) {
            const entry = find(id);
            if (!entry) throw new Error('找不到这张草稿');
            const bytes = new Uint8Array(readFileSync(checkedSource(entry)));
            const type = detectImageType(bytes);
            if (!type || type === 'image/gif') throw new Error('草稿图片格式不受支持');
            return { bytes, type };
        },
        approve(id, shelf) {
            const entry = find(id);
            if (!entry) throw new Error('找不到这张草稿');
            if (entry.status === 'rejected') throw new Error('已拒绝的草稿不能直接通过');
            if (entry.status === 'approved') return { ...entry };
            const freshness = aiPhotoDraftFreshness(entry, now());
            if (!freshness.fresh) throw new Error(freshness.reason);
            const source = checkedSource(entry);
            const added = shelf.add(source, shelfKind[entry.kind], entry.caption, entry.dish);
            const approved = { ...entry, status: 'approved' as const, reviewedAt: now().toISOString(), shelfId: added.id };
            options.log?.(`AI 照片草稿：审核通过 ${entry.id}，进入照片货架 ${added.id}`);
            return { ...update(approved) };
        },
        reject(id) {
            const entry = find(id);
            if (!entry) throw new Error('找不到这张草稿');
            if (entry.status === 'approved') throw new Error('已通过的草稿不能改为拒绝');
            if (entry.status === 'rejected') return { ...entry };
            const rejected = { ...entry, status: 'rejected' as const, reviewedAt: now().toISOString() };
            options.log?.(`AI 照片草稿：拒绝 ${entry.id}`);
            return { ...update(rejected) };
        },
        status() {
            return {
                total: index.entries.length,
                pending: index.entries.filter(entry => entry.status === 'pending_review').length,
                approved: index.entries.filter(entry => entry.status === 'approved').length,
                rejected: index.entries.filter(entry => entry.status === 'rejected').length,
            };
        },
    };
}
