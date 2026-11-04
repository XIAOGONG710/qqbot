export interface CompanionEvalRow { time: string; role: 'user' | 'assistant'; content: string }
export interface CompanionEvalReport {
    from?: string;
    to?: string;
    messages: number;
    assistantMessages: number;
    duplicateRate: number;
    internalLeakRate: number;
    assistantMetaRate: number;
    longBubbleRate: number;
}

const normalized = (text: string) => text.toLowerCase().replace(/[\s，。！？、,.!?~～]+/g, '');
const internalLeak = /(?:system prompt|提示词|token|上下文窗口|我是(?:一个)?(?:ai|人工智能|语言模型)|(?:亲密|饥饿|压力|精力|信任)值\s*[:=：]?\s*\d)/i;
const assistantMeta = /(?:作为(?:一个)?ai|无法提供情感|请问还有什么|希望这能帮到你|根据我的训练数据)/i;

/** 只输出计数和比例，不回显聊天原文。 */
export function evaluateCompanion(rows: readonly CompanionEvalRow[]): CompanionEvalReport {
    const usable = rows.filter(row => Number.isFinite(Date.parse(row.time)) && (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string');
    const assistant = usable.filter(row => row.role === 'assistant');
    let duplicates = 0;
    const seen = new Set<string>();
    for (const row of assistant) {
        const key = normalized(row.content);
        if (key.length >= 4 && seen.has(key)) duplicates++;
        if (key.length >= 4) seen.add(key);
    }
    const rate = (count: number) => assistant.length ? Number((count / assistant.length).toFixed(4)) : 0;
    const timestamps = usable.map(row => Date.parse(row.time));
    return {
        ...(timestamps.length ? { from: new Date(Math.min(...timestamps)).toISOString(), to: new Date(Math.max(...timestamps)).toISOString() } : {}),
        messages: usable.length,
        assistantMessages: assistant.length,
        duplicateRate: rate(duplicates),
        internalLeakRate: rate(assistant.filter(row => internalLeak.test(row.content)).length),
        assistantMetaRate: rate(assistant.filter(row => assistantMeta.test(row.content)).length),
        longBubbleRate: rate(assistant.filter(row => [...row.content].length > 120).length),
    };
}
