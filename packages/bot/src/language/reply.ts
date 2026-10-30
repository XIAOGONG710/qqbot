// 模型回复的清理，取 SillyTavern cleanUpMessage（public/script.js）在默认设置下对 Chat Completion 生效的部分：
// allow_name1_display / allow_name2_display = false，trim_spaces = true，collapse_newlines / trim_sentences = false。
// 没有照搬 auto_fix_generated_markdown（补全未闭合的 * 和代码块，对 QQ 纯文本没有意义）。
// 角色卡上作用于 AI 输出的正则脚本在最前面执行，和 ST 一样（st/regex.ts）。

import type { MacroNames } from '.././st/macros.ts';
import { applyAiOutputScripts, type RegexScript } from '.././st/regex.ts';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function cleanUpReply(text: string, names: MacroNames, scripts: readonly RegexScript[] = []): string {
    let reply = applyAiOutputScripts(text, scripts, names);

    // 每行行尾空白
    reply = reply.replace(/[^\S\r\n]+$/gm, '');

    // 以对方名字开头：模型在替对方说话，整条作废；中途出现“\n对方:”则截断
    if (reply.indexOf(`${names.user}:`) === 0) reply = '';
    const wrong = reply.indexOf(`\n${names.user}:`);
    if (wrong >= 0) reply = reply.substring(0, wrong);

    // 去掉行首的“角色名:”
    reply = reply.replace(new RegExp(`(^|\n)${escapeRegex(names.char)}:\\s*`, 'g'), '$1');

    return reply.trim();
}

/** 一次回复最多几条气泡（ADR 0006 决策 4） */
export const MAX_BUBBLES = 8;

/**
 * 按行拆成几条消息：模型用换行表示连发几条（同一气泡里换行在 QQ 上不像真人），空行跳过。
 * 认真解释时一行一条会拆出十几条，超过 maxBubbles 行就按顺序合并成 maxBubbles 条，每条里面换行。
 */
export function splitReply(text: string, maxBubbles = MAX_BUBBLES): string[] {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean).flatMap(line => splitRunOn(line));
    if (lines.length <= maxBubbles) return lines;
    return lines.some(line => STICKER_LINE.test(line)) ? packAroundStickers(lines, maxBubbles) : packLines(lines, maxBubbles);
}

/** 图片表情的发送指令（stickers.ts 的 EXACT_TOKEN，ADR 0063）：一行就是一条消息，并进文字就认不出来了 */
const STICKER_LINE = /^<(?:sticker|photo):[a-f0-9]{12}>$/i;

/**
 * 有图片表情指令时的合并：指令那一行自己占一条、绝不并进文字（并进去发送时认不出，编号会当文字发给对方，10-12 模拟器 ADR 0063 复测撞到）。
 * 文字按指令前后分成两段，剩下的条数按字数分给两段；条数不够两段各占一条时，文字合在一起放前面、指令放最后。
 */
function packAroundStickers(lines: string[], count: number): string[] {
    const at = lines.findIndex(line => STICKER_LINE.test(line));
    const sticker = lines[at]!;
    const before = lines.slice(0, at).filter(line => !STICKER_LINE.test(line));
    const after = lines.slice(at + 1).filter(line => !STICKER_LINE.test(line));
    const text = [...before, ...after];
    const slots = count - 1;
    if (slots <= 0) return text.length ? packLines(text, 1) : [sticker];
    if (!text.length) return [sticker];
    const pack = (list: string[], n: number) => (list.length > n ? packLines(list, n) : list);
    if (!before.length) return [sticker, ...pack(after, slots)];
    if (!after.length || slots < 2) return [...pack(text, slots), sticker];
    const chars = (list: string[]) => list.reduce((sum, line) => sum + [...line].length, 0);
    const forBefore = Math.min(slots - 1, Math.max(1, Math.round(slots * chars(before) / (chars(before) + chars(after)))));
    return [...pack(before, forBefore), sticker, ...pack(after, slots - forBefore)];
}

/** 按顺序把几行合成 count 条，让字数最多的那条尽量短（线性划分） */
function packLines(lines: string[], count: number): string[] {
    const n = lines.length;
    const prefix = [0];
    for (const line of lines) prefix.push(prefix.at(-1)! + [...line].length);
    // best[k][j]：前 j 行合成 k 条时最长一条的最小字数；start[k][j]：这时最后一条从第几行开始
    const best = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(Infinity));
    const start = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(0));
    best[0]![0] = 0;
    for (let k = 1; k <= count; k++) {
        for (let j = k; j <= n; j++) {
            for (let i = k - 1; i < j; i++) {
                const cost = Math.max(best[k - 1]![i]!, prefix[j]! - prefix[i]!);
                if (cost < best[k]![j]!) {
                    best[k]![j] = cost;
                    start[k]![j] = i;
                }
            }
        }
    }
    const bubbles: string[] = [];
    for (let k = count, j = n; k > 0; k--) {
        const i = start[k]![j]!;
        bubbles.unshift(lines.slice(i, j).join('\n'));
        j = i;
    }
    return bubbles;
}

/** 一句话里该有的停顿（没有这些 = 一口气顶下来） */
const HARD_PUNCT = /[。！？!?，,；;：:]/;

/**
 * 把一口气顶下来的长句拆成两条（2026-10-30 线上「行、我听进去了就是这些话别忽然整太多我会晕这个」）。
 * 只在「超过 limit 个字、而且一个像样的停顿都没有」时动手；有逗号句号的、短句一律不动。
 */
export function splitRunOn(line: string, limit = 22): string[] {
    const chars = [...line];
    if (chars.length <= limit || HARD_PUNCT.test(line)) return [line];
    let cut = Math.floor(chars.length / 2);
    // 找一个靠中间的顿号或空格断开，找不到就正中切
    for (let i = Math.floor(chars.length / 3); i < chars.length; i++) {
        if (/[、\s]/.test(chars[i]!)) { cut = i + 1; break; }
    }
    const head = chars.slice(0, cut).join('').trim();
    const tail = chars.slice(cut).join('').replace(/^[、\s]+/, '').trim();
    return head && tail ? [head, tail] : [line];
}
