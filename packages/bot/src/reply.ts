// 模型回复的清理，取 SillyTavern cleanUpMessage（public/script.js）在默认设置下对 Chat Completion 生效的部分：
// allow_name1_display / allow_name2_display = false，trim_spaces = true，collapse_newlines / trim_sentences = false。
// 没有照搬 auto_fix_generated_markdown（补全未闭合的 * 和代码块，对 QQ 纯文本没有意义）。
// 角色卡上作用于 AI 输出的正则脚本在最前面执行，和 ST 一样（st/regex.ts）。

import type { MacroNames } from './st/macros.ts';
import { applyAiOutputScripts, type RegexScript } from './st/regex.ts';

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
export const MAX_BUBBLES = 5;

/**
 * 按行拆成几条消息：模型用换行表示连发几条（同一气泡里换行在 QQ 上不像真人），空行跳过。
 * 认真解释时一行一条会拆出十几条，超过 maxBubbles 行就按顺序合并成 maxBubbles 条，每条里面换行。
 */
export function splitReply(text: string, maxBubbles = MAX_BUBBLES): string[] {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    return lines.length > maxBubbles ? packLines(lines, maxBubbles) : lines;
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
