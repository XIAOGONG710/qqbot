// 「同一个她」第 2 层（ADR 0177，配置 crossRecent，默认关）：两边互读最近几轮。
//
// 为什么：共用一份记忆（ADR 0176）以后，她在 QQ 上和在 DSH 桌面上仍然「不知道对方刚才发生了什么」——记忆是语义召回，刚说完的话不一定召得回来，
// 也要等 Hindsight 整理。他在电脑上让她整理了文件，转头在 QQ 上问「弄好了吗」，她得知道。反过来，他刚在 QQ 上说了心情不好，回到电脑前她也该知道。
//   · DSH → QQ：DSH 插件每个桌面对话回合往 <数据目录>/memory/desktop-recent.jsonl 追加一行 { at, user, assistant }（最近 40 行），QQ 这边读最近几行放进提示词；
//   · QQ → DSH：DSH 插件读他的 QQ 聊天记录文件（chats/<QQ>.jsonl）的最后几行放进提示词（这个读法在插件里，见 dsh-plugins/dsh-linmengyao-memory/index.js）。
// 只给男朋友档（他在桌面上的对话不会出现在别人的提示词里）。窗口 6 小时：更早的靠语义召回。
// 机器自己发起的回合（QQ 工作模式派的活、随机醒来 / 睡眠整合的提示）不算「桌面对话」，由环境变量 HER_CHANNEL 标出来，插件不记。

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 只看最近这么久的（更早的靠语义召回） */
export const CROSS_WINDOW_MS = 6 * 3_600_000;
/** QQ 这边最多放几轮桌面对话 */
export const DESKTOP_MAX_TURNS = 3;
/** 每一边每句最多放多少字 */
export const CROSS_LINE_CHARS = 200;
/** 从文件尾部最多读这么多字节（文件只追加，不整个读） */
const TAIL_BYTES = 64 * 1024;

export interface DesktopTurn {
    /** 毫秒时间戳 */
    at: number;
    user: string;
    assistant: string;
}

export const desktopRecentPath = (memoryDir: string): string => join(memoryDir, 'desktop-recent.jsonl');

/** 文件最后 maxBytes 字节里的完整行（头上那一行可能被截断，丢掉）；没有文件 / 读不了返回空 */
export function tailLines(file: string, maxBytes = TAIL_BYTES): string[] {
    try {
        if (!existsSync(file)) return [];
        const size = statSync(file).size;
        const start = Math.max(0, size - maxBytes);
        const fd = openSync(file, 'r');
        try {
            const buffer = Buffer.alloc(size - start);
            readSync(fd, buffer, 0, buffer.length, start);
            const lines = buffer.toString('utf8').split('\n');
            if (start > 0) lines.shift();
            return lines.map(line => line.trim()).filter(Boolean);
        } finally { closeSync(fd); }
    } catch { return []; }
}

export function readDesktopTurns(file: string, now: number, windowMs = CROSS_WINDOW_MS): DesktopTurn[] {
    const turns: DesktopTurn[] = [];
    for (const line of tailLines(file)) {
        try {
            const value = JSON.parse(line) as Partial<DesktopTurn>;
            if (typeof value.at !== 'number' || typeof value.user !== 'string' || typeof value.assistant !== 'string') continue;
            if (now - value.at > windowMs || value.at > now + 60_000) continue;
            turns.push({ at: value.at, user: value.user, assistant: value.assistant });
        } catch { /* 写到一半 / 坏行：跳过 */ }
    }
    return turns.sort((a, b) => a.at - b.at);
}

const hhmm = (at: number): string => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const clip = (text: string, max: number): string => { const flat = text.replace(/\s+/g, ' ').trim(); return [...flat].length > max ? `${[...flat].slice(0, max).join('')}…` : flat; };

/** 放进 QQ 提示词的一段：他刚才在电脑上（DSH）和她的最近几轮；没有（或都超过窗口）返回 undefined */
export function desktopBlock(file: string, now: number, options: { maxTurns?: number; windowMs?: number } = {}): string | undefined {
    const turns = readDesktopTurns(file, now, options.windowMs).slice(-(options.maxTurns ?? DESKTOP_MAX_TURNS));
    if (!turns.length) return undefined;
    const lines = turns.flatMap(turn => [
        `${hhmm(turn.at)} 他：${clip(turn.user, CROSS_LINE_CHARS)}`,
        `${hhmm(turn.at)} 你：${clip(turn.assistant, CROSS_LINE_CHARS)}`,
    ]);
    return `[你刚才在电脑上（DSH）和他的对话——同一个他、同一个你；接着聊就行，不用复述，也别说成「我在电脑上看到」]\n${lines.join('\n')}`;
}
