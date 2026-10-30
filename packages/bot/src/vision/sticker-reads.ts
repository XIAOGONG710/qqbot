// 他发来的表情包，她看得懂（ADR 0206）
//
// 表情包原来只以「[动画表情]」进聊天记录（vision/media.ts 一向跳过表情包）：线上他的 731 条消息里 83 条是只发一个表情包，
// 她 98% 回了，却不知道图上画的是什么、写了什么字。开着 readStickers 时，用表情包专用的看图要求
// （先抄图上的字，再说画面和情绪，见 STICKER_VISION_PROMPT）读一次，聊天记录里就是
// 「[动画表情：上面写着「……」；画面……]」。同一张图只读一次（按文件名哈希缓存，重启还在）；读不出来照旧「[动画表情]」。
//
// 只管图片表情：商城表情自带名字（「[是的]」），名字就是意思，不读。日志只写字数，不写图上是什么。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 放进聊天记录的那一行里，文字部分、画面部分各最多几个字（表情包的字大多一两句） */
export const STICKER_TEXT_MAX_CHARS = 30;
export const STICKER_SCENE_MAX_CHARS = 50;
/** 缓存最多记几张（最久没见过的先丢） */
export const STICKER_READ_CACHE_MAX = 300;
/** 一条消息里最多读几张表情包 */
export const STICKER_MAX_PER_MESSAGE = 2;

type SegmentData = Record<string, unknown>;

/** 图片表情的 summary 是泛称「[动画表情]」「[表情]」或空；商城表情的 summary 是它的名字（「[是的]」），那种不读 */
export function stickerIsNameless(data: SegmentData): boolean {
    const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
    return summary === '' || /^\[(?:动画)?表情\]$/.test(summary) || summary === '[图片]';
}

/** 同一张图的稳定编号：NapCat 的 file 是内容哈希加扩展名；太短就退回 URL（去掉带时效的查询串） */
export function stickerKey(data: SegmentData): string | undefined {
    const file = typeof data.file === 'string' ? data.file.trim() : '';
    const url = typeof data.url === 'string' ? data.url.split('?')[0]!.trim() : '';
    const raw = file.length >= 8 ? file : url;
    return raw ? createHash('sha256').update(raw).digest('hex').slice(0, 16) : undefined;
}

const flat = (text: string) => text.replace(/\s+/g, ' ').replace(/\[/g, '【').replace(/\]/g, '】').trim();
const clip = (text: string, max: number) => { const chars = [...text]; return chars.length > max ? `${chars.slice(0, max).join('')}…` : text; };
const NONE = /^(?:无|没有|没字|无文字|无字)$/;

/**
 * 看图模型按 STICKER_VISION_PROMPT 返回「文字：…｜画面：…」→ 聊天记录里的一行。
 * 认不出格式就整句当画面；什么都没有返回 undefined。
 */
export function stickerLine(raw: string): string | undefined {
    const text = flat(String(raw ?? ''));
    if (!text) return undefined;
    const parts = /^文字[：:]\s*(.*?)\s*[｜|]\s*画面[：:]\s*(.*)$/.exec(text);
    const written = parts ? flat(parts[1]!).replace(/^[「“"']+|[」”"']+$/g, '').trim() : '';
    const scene = clip(parts ? flat(parts[2]!) : text, STICKER_SCENE_MAX_CHARS);
    const body = written && !NONE.test(written)
        ? `上面写着「${clip(written, STICKER_TEXT_MAX_CHARS)}」${scene ? `；${scene}` : ''}`
        : scene;
    return body ? `[动画表情：${body}]` : undefined;
}

export interface StickerReads {
    get(data: SegmentData): string | undefined;
    set(data: SegmentData, line: string): void;
}

/** 读过的表情包缓存：有文件就落盘（写不进去不挡事），没有就只在内存里 */
export function stickerReads(file?: string, max = STICKER_READ_CACHE_MAX): StickerReads {
    const lines = new Map<string, string>();
    if (file) {
        try {
            const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
            for (const [key, line] of Object.entries(saved)) if (typeof line === 'string' && line.startsWith('[动画表情：')) lines.set(key, line);
        } catch { /* 第一次、或者文件坏了：从空的开始 */ }
    }
    const persist = () => {
        if (!file) return;
        try {
            mkdirSync(dirname(file), { recursive: true });
            const temp = `${file}.tmp`;
            writeFileSync(temp, JSON.stringify(Object.fromEntries(lines)));
            renameSync(temp, file);
        } catch { /* 缓存写不进去，下次再读一遍而已 */ }
    };
    return {
        get(data) {
            const key = stickerKey(data);
            const line = key ? lines.get(key) : undefined;
            if (key && line) { lines.delete(key); lines.set(key, line); }
            return line;
        },
        set(data, line) {
            const key = stickerKey(data);
            if (!key) return;
            lines.delete(key);
            lines.set(key, line);
            while (lines.size > max) lines.delete(lines.keys().next().value as string);
            persist();
        },
    };
}
