// 发给模型前对消息列表的后处理，对照 vendor/SillyTavern/src/prompt-converters.js 的 postProcessPrompt / mergeMessages。
// 取值同 ST 自定义接口（Custom, OpenAI-compatible）的 Prompt Post-Processing；ST 的 DeepSeek 接入固定用 semi。
// 只实现无工具调用、无多模态、消息不带 name 的情况（运行时的消息都是这样），也没实现 single。

import type { OpenAIMessage } from '../prompt.ts';

export const PROMPT_POST_PROCESSING = ['', 'merge', 'semi', 'strict'] as const;
export type PromptPostProcessing = (typeof PROMPT_POST_PROCESSING)[number];

/** ST 的 promptPlaceholder 默认值（config.yaml 可改） */
export const PROMPT_PLACEHOLDER = 'Let\'s get started.';

export function postProcessPrompt(messages: OpenAIMessage[], type: PromptPostProcessing): OpenAIMessage[] {
    switch (type) {
        case 'merge':
            return mergeMessages(messages, { strict: false, placeholders: false });
        case 'semi':
            return mergeMessages(messages, { strict: true, placeholders: false });
        case 'strict':
            return mergeMessages(messages, { strict: true, placeholders: true });
        default:
            return messages;
    }
}

/**
 * 合并相邻的同角色消息（用空行连接）。
 * strict：只允许开头一条 system，之后的 system 改成 user 再合并一次；
 * placeholders：strict 时保证 system 之后（或开头）是 user，不是就插一条占位 user 消息。
 */
function mergeMessages(input: OpenAIMessage[], options: { strict: boolean; placeholders: boolean }): OpenAIMessage[] {
    const merged: OpenAIMessage[] = [];
    for (const message of input.map(m => ({ ...m, content: m.content || '' }))) {
        const last = merged.at(-1);
        if (last && last.role === message.role && message.content) {
            last.content += `\n\n${message.content}`;
        } else {
            merged.push(message);
        }
    }

    if (merged.length === 0) merged.unshift({ role: 'user', content: PROMPT_PLACEHOLDER });

    if (options.strict) {
        for (let i = 1; i < merged.length; i++) {
            if (merged[i]!.role === 'system') merged[i]!.role = 'user';
        }
        if (merged.length && options.placeholders) {
            if (merged[0]!.role === 'system' && (merged.length === 1 || merged[1]!.role !== 'user')) {
                merged.splice(1, 0, { role: 'user', content: PROMPT_PLACEHOLDER });
            } else if (merged[0]!.role !== 'system' && merged[0]!.role !== 'user') {
                merged.unshift({ role: 'user', content: PROMPT_PLACEHOLDER });
            }
        }
        return mergeMessages(merged, { strict: false, placeholders: options.placeholders });
    }

    return merged;
}
