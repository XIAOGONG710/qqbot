// 模型回复的清理，取 SillyTavern cleanUpMessage（public/script.js）在默认设置下对 Chat Completion 生效的部分：
// allow_name1_display / allow_name2_display = false，trim_spaces = true，collapse_newlines / trim_sentences = false。
// 没有照搬 auto_fix_generated_markdown（补全未闭合的 * 和代码块，对 QQ 纯文本没有意义）。

import type { MacroNames } from './st/macros.ts';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function cleanUpReply(text: string, names: MacroNames): string {
    // 每行行尾空白
    let reply = text.replace(/[^\S\r\n]+$/gm, '');

    // 以对方名字开头：模型在替对方说话，整条作废；中途出现“\n对方:”则截断
    if (reply.indexOf(`${names.user}:`) === 0) reply = '';
    const wrong = reply.indexOf(`\n${names.user}:`);
    if (wrong >= 0) reply = reply.substring(0, wrong);

    // 去掉行首的“角色名:”
    reply = reply.replace(new RegExp(`(^|\n)${escapeRegex(names.char)}:\\s*`, 'g'), '$1');

    return reply.trim();
}

/** 按行拆成几条消息：模型用换行表示连发几条（同一气泡里换行在 QQ 上不像真人），空行跳过 */
export function splitReply(text: string): string[] {
    return text.split('\n').map(line => line.trim()).filter(Boolean);
}
