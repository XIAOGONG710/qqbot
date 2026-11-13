// 只想一想时的「回想」作为解释器的模块（ADR 0336 第 5 步）：想一想（内心）的轮次里聊天原文不留成对话回合，
// 换成最近 14 条的一段回想放进「此刻」块的 transcript 槽（免得模型把它当成要接着回的话）。没有开关，不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 closeness 场景的只想一想那一轮核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { ChatMessage } from '../language/prompt.ts';

/** 想一想时的“回想”：最近 14 条聊天，旧→新，带时刻；不是要接着回的对话 */
export function thinkingTranscript(chat: readonly ChatMessage[], userName: string): string | undefined {
    const recent = chat.slice(-14);
    if (!recent.length) return undefined;
    const stamp = (time?: string) => {
        const at = time ? new Date(time) : undefined;
        return at && !Number.isNaN(at.getTime()) ? `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} ` : '';
    };
    return `[回想一下你和${userName}最近的聊天（旧到新，这只是让你想起发生过什么，不是要你接着回）：\n${recent.map(m => `${stamp(m.time)}${m.role === 'user' ? '他' : '你'}：${m.content.replace(/\s+/g, ' ')}`).join('\n')}]`;
}

export function transcriptModule(): Module {
    return {
        id: 'transcript',
        contribute(turn) {
            if (!turn.thinking) return [];
            const text = thinkingTranscript(turn.history, turn.contact.name);
            return text ? [{ slot: 'transcript', text }] : [];
        },
    };
}
