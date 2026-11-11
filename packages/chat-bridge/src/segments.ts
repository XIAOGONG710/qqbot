// OneBot 消息段 ↔ App 的 Part，两个方向。
import { AUDIO_MIMES, IMAGE_MIMES, MediaError, mediaReferenceOf, readMediaReference } from './media.ts';
import type { MediaFetcher, MediaStore } from './media.ts';
import { isRecord } from './types.ts';
import type { Part, Segment } from './types.ts';

export const MAX_PARTS = 20;
export const MAX_TEXT_CHARS = 8000;

/** 这一段 App 显示不了（视频、文件、合并转发……）。发往 App 的那条整条失败，不假装发到了 */
export class UnsupportedSegment extends Error {}

const unescapeCq = (text: string) => text.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
const escapeCqText = (text: string) => text.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
const escapeCqValue = (text: string) => escapeCqText(text).replace(/,/g, '&#44;');

/** CQ 码字符串 → 消息段 */
export function parseCqString(text: string): Segment[] {
    const segments: Segment[] = [];
    const pattern = /\[CQ:([A-Za-z_]+)((?:,[^\]]*)?)\]/g;
    let last = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        if (match.index > last) segments.push({ type: 'text', data: { text: unescapeCq(text.slice(last, match.index)) } });
        const data: Record<string, unknown> = {};
        for (const pair of match[2]!.split(',')) {
            const equals = pair.indexOf('=');
            if (equals > 0) data[pair.slice(0, equals)] = unescapeCq(pair.slice(equals + 1));
        }
        segments.push({ type: match[1]!, data });
        last = match.index + match[0].length;
    }
    if (last < text.length) segments.push({ type: 'text', data: { text: unescapeCq(text.slice(last)) } });
    return segments;
}

/** 动作 / 事件里的 message：段数组、单个段、CQ 字符串都收成段数组；形状不对返回 undefined */
export function normalizeMessage(message: unknown): Segment[] | undefined {
    if (typeof message === 'string') return parseCqString(message);
    const list = Array.isArray(message) ? message : isRecord(message) ? [message] : undefined;
    if (!list) return undefined;
    const segments: Segment[] = [];
    for (const item of list) {
        if (!isRecord(item) || typeof item.type !== 'string') return undefined;
        segments.push({ type: item.type, data: isRecord(item.data) ? item.data : {} });
    }
    return segments;
}

/** 段数组 → CQ 码字符串（事件里的 raw_message） */
export function rawMessage(segments: readonly Segment[]): string {
    return segments.map(segment => {
        if (segment.type === 'text') return escapeCqText(String(segment.data.text ?? ''));
        const fields = Object.entries(segment.data)
            .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
            .map(([key, value]) => `,${key}=${escapeCqValue(String(value))}`);
        return `[CQ:${segment.type}${fields.join('')}]`;
    }).join('');
}

/** QQ 的分享卡片（json 段的 data.data）→ 标题和链接 */
export function cardFromJson(raw: unknown): { title: string; url?: string } {
    let parsed: unknown = raw;
    if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { parsed = undefined; } }
    let title = '';
    let url: string | undefined;
    if (isRecord(parsed)) {
        const blocks = isRecord(parsed.meta) ? Object.values(parsed.meta).filter(isRecord) : [];
        for (const block of blocks) {
            for (const key of ['title', 'desc'] as const) if (!title && typeof block[key] === 'string' && block[key]) title = block[key] as string;
            for (const key of ['qqdocurl', 'jumpUrl', 'url'] as const) {
                const value = block[key];
                if (!url && typeof value === 'string' && /^https?:\/\//i.test(value)) url = value;
            }
        }
        if (!title && typeof parsed.prompt === 'string') title = parsed.prompt;
    }
    return { title: title.slice(0, 200) || '[卡片]', ...(url ? { url: url.slice(0, 2000) } : {}) };
}

export interface ToPartsOptions {
    media: MediaStore;
    fetcher: MediaFetcher;
    /**
     * strict：她发往 App 的。有一段转不了就抛错，整条不算发出。
     * lenient：已经在 QQ 上发生过的（镜像）。转不了的段写成占位文字。
     */
    mode: 'strict' | 'lenient';
}

export interface ConvertedMessage {
    parts: Part[];
    replyTo?: number;
}

const PLACEHOLDERS: Record<string, string> = {
    image: '[图片]', record: '[语音]', video: '[视频]', file: '[文件]', forward: '[聊天记录]', mface: '[表情]',
    json: '[卡片]', music: '[音乐]', contact: '[名片]', location: '[位置]', dice: '[骰子]', rps: '[猜拳]', node: '[聊天记录]',
};

export async function segmentsToParts(segments: readonly Segment[], options: ToPartsOptions): Promise<ConvertedMessage> {
    const parts: Part[] = [];
    let replyTo: number | undefined;
    const text = (value: string) => {
        if (!value) return;
        const last = parts.at(-1);
        if (last?.kind === 'text') last.text += value;
        else parts.push({ kind: 'text', text: value });
    };
    const placeholder = (segment: Segment) => {
        const summary = segment.data.summary;
        text(typeof summary === 'string' && summary ? summary : PLACEHOLDERS[segment.type] ?? `[${segment.type}]`);
    };
    const ingest = async (segment: Segment, kind: 'image' | 'audio') => {
        const reference = mediaReferenceOf(segment.data);
        if (!reference) throw new MediaError('unreadable', '段里没有可读的文件');
        return options.media.put(await readMediaReference(reference, options.fetcher), { kind });
    };

    for (const segment of segments) {
        const data = segment.data;
        try {
            switch (segment.type) {
                case 'text': text(String(data.text ?? '')); break;
                case 'face': {
                    const id = Number(data.id);
                    if (!Number.isSafeInteger(id)) throw new UnsupportedSegment('face 段的 id 不是数字');
                    parts.push({ kind: 'face', id });
                    break;
                }
                case 'image': {
                    const info = await ingest(segment, 'image');
                    parts.push({ kind: 'image', mediaId: info.id, mime: info.mime, ...(typeof data.summary === 'string' && data.summary ? { summary: data.summary.slice(0, 200) } : {}) });
                    break;
                }
                case 'record': {
                    const info = await ingest(segment, 'audio');
                    parts.push({ kind: 'voice', mediaId: info.id, mime: info.mime });
                    break;
                }
                case 'json': parts.push({ kind: 'card', ...cardFromJson(data.data) }); break;
                case 'reply': {
                    const id = Number(data.id);
                    if (Number.isSafeInteger(id)) replyTo = id;
                    break;
                }
                default:
                    if (options.mode === 'strict') throw new UnsupportedSegment(`App 显示不了 ${segment.type} 段`);
                    placeholder(segment);
            }
        } catch (error) {
            if (options.mode === 'strict') throw error instanceof UnsupportedSegment ? error : new UnsupportedSegment(error instanceof MediaError ? error.message : '这一段读不了');
            placeholder(segment);
        }
    }
    return { parts, ...(replyTo !== undefined ? { replyTo } : {}) };
}

export interface ToSegmentsOptions {
    media: MediaStore;
    /** Koishi 那一侧取媒体用的本机地址 */
    localUrl(mediaId: string): string;
}

/** Part → OneBot 段（他在 App 里发的那条拼事件用，也用来把消息账拼成 get_friend_msg_history 的形状） */
export function partsToSegments(parts: readonly Part[], replyTo: number | undefined, options: ToSegmentsOptions): Segment[] {
    const segments: Segment[] = [];
    if (replyTo !== undefined) segments.push({ type: 'reply', data: { id: String(replyTo) } });
    for (const part of parts) {
        switch (part.kind) {
            case 'text': segments.push({ type: 'text', data: { text: part.text } }); break;
            case 'face': segments.push({ type: 'face', data: { id: String(part.id) } }); break;
            case 'image': case 'voice': {
                const info = options.media.get(part.mediaId);
                const name = info ? info.path.split(/[\\/]/).at(-1)! : part.mediaId;
                const common = { file: name, url: options.localUrl(part.mediaId), ...(info ? { file_size: String(info.size) } : {}) };
                if (part.kind === 'image') segments.push({ type: 'image', data: { ...common, ...(part.summary ? { summary: part.summary } : {}), sub_type: 0 } });
                else segments.push({ type: 'record', data: { ...common, ...(info ? { path: info.path } : {}) } });
                break;
            }
            case 'card': segments.push({ type: 'text', data: { text: `[分享]${part.title}${part.url ? ` ${part.url}` : ''}` } }); break;
            case 'poke': break;
        }
    }
    return segments;
}

export type AppPartsResult = { ok: true; parts: Part[] } | { ok: false; message: string };

/** App 发来的 parts：只收文字、小黄脸、已经上传好的图片和语音 */
export function parseAppParts(value: unknown, media: MediaStore): AppPartsResult {
    if (!Array.isArray(value) || !value.length || value.length > MAX_PARTS) return { ok: false, message: `parts 要有 1 到 ${MAX_PARTS} 段` };
    const parts: Part[] = [];
    let chars = 0;
    for (const item of value) {
        if (!isRecord(item)) return { ok: false, message: 'parts 里有不认识的段' };
        switch (item.kind) {
            case 'text':
                if (typeof item.text !== 'string' || !item.text) return { ok: false, message: '文字段是空的' };
                chars += item.text.length;
                parts.push({ kind: 'text', text: item.text });
                break;
            case 'face':
                if (typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id < 0) return { ok: false, message: '表情 id 不对' };
                parts.push({ kind: 'face', id: item.id });
                break;
            case 'image': case 'voice': {
                const info = media.get(item.mediaId);
                const allowed = item.kind === 'image' ? IMAGE_MIMES : AUDIO_MIMES;
                if (!info || !allowed.includes(info.mime)) return { ok: false, message: '没有这个媒体，先上传' };
                if (item.kind === 'image') parts.push({ kind: 'image', mediaId: info.id, mime: info.mime });
                else {
                    const duration = item.durationMs;
                    const valid = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= 3_600_000;
                    parts.push({ kind: 'voice', mediaId: info.id, mime: info.mime, ...(valid ? { durationMs: Math.round(duration) } : {}) });
                }
                break;
            }
            default: return { ok: false, message: 'parts 里有不能发的段' };
        }
    }
    if (chars > MAX_TEXT_CHARS) return { ok: false, message: `文字太长（最多 ${MAX_TEXT_CHARS} 字）` };
    return { ok: true, parts };
}
