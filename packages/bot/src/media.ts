// 他发来的语音和图片（ADR 0052）：进聊天记录之前先听一听、看一看，读过的段换成一段文字，segmentsToText 照常拼成一行。
// - 语音：NapCat 的 fetch_ptt_text（QQ 自带的语音转文字，按消息 id 找那条语音）；几秒从本地的语音文件（data.path，SILK / AMR）数帧，
//   OneBot 的消息段里没有时长，文件读不到就不写秒数。转出来是「[语音 8秒：……]」，转不出来是「[语音 8秒]」，秒数也没有就是老样子「[语音]」。
// - 图片：照片、截图跑 NapCat 的 ocr_image（只有 Windows），有字是「[图片，上面写着：……]」（截到 OCR_MAX_CHARS 个字），没字是「[图片]」；
//   表情包（sub_type 不是 0，或者 summary 是它的名字）照旧用名字，不跑 OCR。配置了 DeepSeek 看图（vision）再加上看到的样子。
// - 都有上限：超时、出错就退回老样子，不卡住回复。没字的图 NapCat 的 OCR 一直不回（10-10 实测：没字的 PNG、照片都等不到回应，有字的 0.3–1.1 秒），
//   NapCat 启动后第一次 OCR 也可能要一分钟以上：都按超时算，就是「[图片]」。
// - 聊天记录就是缓存：进了记录的消息（按 QQ 消息 id）不再转（app.ts 先查记录）；同一条正在转的（实时收到的和补回的撞上）共用一次调用（mediaReading）。
// - 回复节奏：听完才回（reply-timing.ts 按 listenMs 把听的时间加在看到之后）。

import { readFile } from 'node:fs/promises';
import { AsyncGate } from './async-gate.ts';
import type { Segment } from './onebot.ts';

/** NapCat 那边能做的（入口传进来：main.ts 用自写的 OneBot 客户端，Koishi 插件用 adapter-onebot） */
export interface MediaReader {
    /** fetch_ptt_text：这条消息里语音转出来的字 */
    voiceToText?(messageId: number, signal?: AbortSignal): Promise<string>;
    /** ocr_image：图上的字，一行一项（image 是图片的 URL、本地路径或 base64://） */
    ocr?(image: string, signal?: AbortSignal): Promise<string[]>;
}

/**
 * 看图（ADR 0055）：一两句话说图里是什么；看不了就抛错。
 * 配置里有 vision 才有（config.ts）；运行时现在接 DeepSeek，测试可以给假的。
 */
export interface ImageDescriber {
    describe(image: { url: string; file?: string; dataUrl?: string; signal?: AbortSignal }): Promise<string>;
}

export interface MediaSources {
    reader?: MediaReader;
    vision?: ImageDescriber;
    /** 测试用：换掉各项的上限 */
    timeouts?: Partial<typeof MEDIA_TIMEOUTS>;
}

/** 各项最多等多久（毫秒）：语音转文字是 QQ 服务器上转的；OCR 有字时本机 1 秒内，没字时不回；看图要调外面的模型 */
export const MEDIA_TIMEOUTS = { voice: 5000, ocr: 5000, vision: 8000 };
/** 图上的字最多放多少个（长截图几十行，太长了占提示词，也不像「扫一眼」） */
export const OCR_MAX_CHARS = 80;
/** 语音转出来的字最多放多少个（QQ 语音最长 60 秒，正常说话不会超） */
export const VOICE_MAX_CHARS = 300;
/** 一条消息里最多看几张图（每张没字的图都要等满上限、NapCat 那边留一个不回的调用） */
export const OCR_MAX_IMAGES = 3;
/** 听语音：知道秒数按秒数；只知道字按每秒 4 个字（最少 2 秒）；都不知道按这么久 */
export const LISTEN_DEFAULT_MS = 6000;
const LISTEN_MAX_MS = 60_000;
const voiceGate = new AsyncGate(2);
const ocrGate = new AsyncGate(2);

/** 表情包、收藏的表情：sub_type 不是 0（NapCat 的 picSubType），或者 summary 是它的名字（「[动画表情]」「[是的]」） */
export function isSticker(data: Record<string, unknown>): boolean {
    const sub = Number(data.sub_type ?? 0);
    const summary = typeof data.summary === 'string' ? data.summary : '';
    return (Number.isFinite(sub) && sub !== 0) || (summary !== '' && summary !== '[图片]');
}

/** 这条消息里有没有要听、要看的（语音、不是表情包的图片） */
export function needsReading(message: Segment[] | string): boolean {
    return typeof message !== 'string' && message.some(s => s.type === 'record' || (s.type === 'image' && !isSticker(s.data ?? {})));
}

/** 放进方括号里的字：去掉换行和方括号（免得把这一行截断，也免得和别的方括号行混），太长截断 */
function inline(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').replace(/\[/g, '【').replace(/\]/g, '】').trim();
    const chars = [...flat];
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

/** 聊天记录里的一条语音 */
export function voiceLine(voice: { seconds?: number; text?: string }): string {
    return `[语音${voice.seconds ? ` ${voice.seconds}秒` : ''}${voice.text ? `：${voice.text}` : ''}]`;
}

/** 聊天记录里的一张图 */
export function imageLine(image: { ocr?: string; description?: string }): string {
    if (image.description) return `[图片：${image.description}${image.ocr ? `；上面写着：${image.ocr}` : ''}]`;
    return image.ocr ? `[图片，上面写着：${image.ocr}]` : '[图片]';
}

const VOICE_LINE = /^\[语音(?: (\d+)秒)?(?:：([\s\S]*))?\]$/;

/** 聊天记录里的一条语音：几秒、转出来的字；不是语音返回 undefined */
export function parseVoiceLine(content: string): { seconds?: number; text?: string } | undefined {
    const match = VOICE_LINE.exec(content.trim());
    if (!match) return undefined;
    return { ...(match[1] ? { seconds: Number(match[1]) } : {}), ...(match[2] ? { text: match[2] } : {}) };
}

/** 听完这条要多久；不是语音是 0 */
export function listenMs(content: string): number {
    const voice = parseVoiceLine(content);
    if (!voice) return 0;
    if (voice.seconds) return Math.min(LISTEN_MAX_MS, voice.seconds * 1000);
    if (voice.text) return Math.min(LISTEN_MAX_MS, Math.max(2000, [...voice.text].length * 250));
    return LISTEN_DEFAULT_MS;
}

/** NapCat ocr_image 的返回：10-10 实测是 [{ text, pt1…pt4, charBox, score }]；它的示例写的是 { texts: [{ text }] }，两种都认 */
export function ocrLines(data: unknown): string[] {
    const items = Array.isArray(data) ? data : (data as { texts?: unknown } | null)?.texts;
    if (!Array.isArray(items)) return [];
    return items.map(item => (typeof item === 'string' ? item : (item as { text?: unknown } | null)?.text))
        .filter((text): text is string => typeof text === 'string' && text.trim() !== '')
        .map(text => text.trim());
}

/**
 * QQ 语音文件有几秒：SILK（开头 [0x02]「#!SILK_V3」，之后每块 2 字节小端长度 + 内容，一块 20 毫秒）
 * 或 AMR-NB（开头「#!AMR\n」，每帧 20 毫秒，长度看帧头）。认不出来返回 undefined。
 */
export function voiceSeconds(file: Uint8Array): number | undefined {
    const buffer = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
    let frames = 0;
    const silk = buffer.indexOf('#!SILK_V3');
    if (silk === 0 || silk === 1) {
        for (let at = silk + 9; at + 2 <= buffer.length;) {
            const size = buffer.readInt16LE(at);
            if (size <= 0 || at + 2 + size > buffer.length) break;
            frames++;
            at += 2 + size;
        }
    } else if (buffer.subarray(0, 6).toString('latin1') === '#!AMR\n') {
        const sizes = [12, 13, 15, 17, 19, 20, 26, 31, 5, 0, 0, 0, 0, 0, 0, 0];
        for (let at = 6; at < buffer.length;) {
            const size = sizes[(buffer[at]! >> 3) & 0x0f]!;
            if (at + 1 + size > buffer.length) break;
            frames++;
            at += 1 + size;
        }
    } else {
        return undefined;
    }
    return frames ? Math.max(1, Math.round(frames * 20 / 1000)) : undefined;
}

/** 超时或上层停机时主动取消；旧适配器不接 signal 时仍按原来的降级逻辑返回。 */
function within<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error(`超时 ${ms / 1000} 秒`)), ms);
    let task: Promise<T>;
    try { task = work(signal); } catch (error) { task = Promise.reject(error); }
    task.catch(() => {});
    const cancelled = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('已取消', 'AbortError')), { once: true });
    });
    return Promise.race([task, cancelled]).finally(() => clearTimeout(timer));
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)} 秒`;

async function hear(data: Record<string, unknown>, messageId: number, sources: MediaSources, log: (message: string) => void, signal?: AbortSignal): Promise<string> {
    const limits = { ...MEDIA_TIMEOUTS, ...sources.timeouts };
    const started = Date.now();
    const path = typeof data.path === 'string' && data.path ? data.path : undefined;
    const [length, text] = await Promise.all([
        path ? within(() => readFile(path), limits.voice, signal).then(voiceSeconds, () => undefined) : Promise.resolve(undefined),
        sources.reader?.voiceToText
            ? voiceGate.run(() => within(inner => sources.reader!.voiceToText!(messageId, inner), limits.voice, signal), signal).then(
                raw => inline(String(raw ?? ''), VOICE_MAX_CHARS) || undefined,
                error => { log(`听语音：没转出来（${reason(error)}）`); return undefined; },
            )
            : Promise.resolve(undefined),
    ]);
    if (text) log(`听语音：转出 ${[...text].length} 个字${length ? `，${length} 秒` : ''}（${seconds(started)}）`);
    return voiceLine({ ...(length ? { seconds: length } : {}), ...(text ? { text } : {}) });
}

async function look(data: Record<string, unknown>, sources: MediaSources, log: (message: string) => void, signal?: AbortSignal): Promise<string> {
    const limits = { ...MEDIA_TIMEOUTS, ...sources.timeouts };
    const url = typeof data.url === 'string' && data.url ? data.url : undefined;
    if (!url) return imageLine({});
    const started = Date.now();
    const [ocr, description] = await Promise.all([
        sources.reader?.ocr
            ? ocrGate.run(() => within(inner => sources.reader!.ocr!(url, inner), limits.ocr, signal), signal).then(
                result => {
                    const lines = Array.isArray(result) ? result : [];
                    const text = inline(lines.join(' '), OCR_MAX_CHARS);
                    // 照片里零星认出一两个字符（噪点）不算有字
                    const meaningful = text.replace(/[\p{P}\p{S}\s]/gu, '').length >= 2;
                    log(`看图：${meaningful ? `上面有 ${lines.length} 行字` : '没认出字'}（${seconds(started)}）`);
                    return meaningful ? text : undefined;
                },
                error => { log(`看图：没认出字（${reason(error)}）`); return undefined; },
            )
            : Promise.resolve(undefined),
        sources.vision
            ? within(inner => sources.vision!.describe({ url, ...(typeof data.file === 'string' ? { file: data.file } : {}), signal: inner }), limits.vision, signal).then(
                text => {
                    const description = inline(String(text ?? ''), OCR_MAX_CHARS) || undefined;
                    // 只记字数，不记图上是什么
                    if (description) log(`看图：看图模型说了 ${description.length} 个字（${seconds(started)}）`);
                    return description;
                },
                error => { log(`看图：看图模型没看出来（${reason(error)}）`); return undefined; },
            )
            : Promise.resolve(undefined),
    ]);
    return imageLine({ ...(ocr ? { ocr } : {}), ...(description ? { description } : {}) });
}

/**
 * 听、看这条消息里的语音和图片：读过的段换成一段文字（「[语音 8秒：……]」「[图片，上面写着：……]」），别的段原样。
 * 没有要读的（纯文字、表情包）原样返回；什么都读不到时也换成老样子的那几个字。
 */
export async function readMedia(message: Segment[] | string, messageId: number, sources: MediaSources, log: (message: string) => void, signal?: AbortSignal): Promise<Segment[] | string> {
    if (!needsReading(message)) return message;
    let images = 0;
    return Promise.all((message as Segment[]).map(async (segment): Promise<Segment> => {
        const data = segment.data ?? {};
        if (segment.type === 'record') return { type: 'text', data: { text: await hear(data, messageId, sources, log, signal) } };
        if (segment.type === 'image' && !isSticker(data)) {
            if (++images > OCR_MAX_IMAGES) return segment;
            return { type: 'text', data: { text: await look(data, sources, log, signal) } };
        }
        return segment;
    }));
}

export interface MediaReading {
    /** 这条要不要等（有要读的、而且有得读） */
    needs(message: Segment[] | string): boolean;
    /** 读这条（同一条正在读就等那一次的结果） */
    read(message: Segment[] | string, messageId: number, log: (message: string) => void): Promise<Segment[] | string>;
    /** Stop queued/in-flight work during shutdown. */
    stop(): void;
}

/**
 * readMedia 加上「同一条只读一次」：按 QQ 消息 id，正在读的共用一个结果（实时收到的和补回的撞上），读完就放掉（之后靠聊天记录去重）。
 * 没有 reader 也没有 vision 时不读（老样子）。
 */
export function mediaReading(sources: MediaSources): MediaReading {
    const reading = new Map<number, Promise<Segment[] | string>>();
    const stopped = new AbortController();
    const enabled = Boolean(sources.reader?.voiceToText || sources.reader?.ocr || sources.vision);
    return {
        needs: message => enabled && needsReading(message),
        read(message, messageId, log) {
            if (!enabled || !needsReading(message)) return Promise.resolve(message);
            let task = reading.get(messageId);
            if (!task) {
                task = readMedia(message, messageId, sources, log, stopped.signal).finally(() => reading.delete(messageId));
                reading.set(messageId, task);
            }
            return task;
        },
        stop() { stopped.abort(new Error('媒体读取已停止')); },
    };
}
