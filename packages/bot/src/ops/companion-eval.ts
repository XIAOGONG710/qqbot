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

export interface CompanionRegressionReport {
    passed: boolean;
    baseline: CompanionEvalReport;
    current: CompanionEvalReport;
    regressions: (
        | { kind: 'rate'; metric: 'duplicateRate' | 'internalLeakRate' | 'assistantMetaRate' | 'longBubbleRate'; delta: number; limit: number }
        | { kind: 'sample'; baseline: number; current: number; minimum: number }
    )[];
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

/** 比较两个匿名统计窗口；不输出任何聊天原文。 */
export function compareCompanionWindows(baselineRows: readonly CompanionEvalRow[], currentRows: readonly CompanionEvalRow[], options: {
    maxRateIncrease?: number;
    minimumAssistantMessages?: number;
} = {}): CompanionRegressionReport {
    const baseline = evaluateCompanion(baselineRows);
    const current = evaluateCompanion(currentRows);
    const limit = options.maxRateIncrease ?? 0.03;
    const minimum = options.minimumAssistantMessages ?? 20;
    if (!Number.isFinite(limit) || limit < 0 || limit > 1) throw new Error('回归比例上限不合法');
    if (!Number.isInteger(minimum) || minimum < 1) throw new Error('回归样本下限不合法');
    const metrics = ['duplicateRate', 'internalLeakRate', 'assistantMetaRate', 'longBubbleRate'] as const;
    const regressions: CompanionRegressionReport['regressions'] = baseline.assistantMessages >= minimum && current.assistantMessages >= minimum
        ? metrics.flatMap(metric => {
            const delta = Number((current[metric] - baseline[metric]).toFixed(4));
            return delta > limit ? [{ kind: 'rate' as const, metric, delta, limit }] : [];
        })
        : [{ kind: 'sample', baseline: baseline.assistantMessages, current: current.assistantMessages, minimum }];
    return { passed: regressions.length === 0, baseline, current, regressions };
}
