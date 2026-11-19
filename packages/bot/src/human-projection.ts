import { humanValueTrends, humanValuesAt, type HumanValueFacts } from './human-values.ts';
import { developmentSnapshot, developmentSummary } from './life/development.ts';
import { needsAt, type NeedsSnapshot } from './life/needs.ts';
import type { LifeEvent } from './world/life-events.ts';

/**
 * 她此刻的真人式状态（ADR 0222 / 0251）：从需要锚点和事件账投影到现在，数值和一小时前比出趋势，再给人格成长的摘要。
 * 状态页和给 DSH 的摘要（dsh-state.ts）用的是同一套算法，原来在 app.ts 里两处各写了一遍；ADR 0336 第 6 步合成这一份。
 * 一小时前早于锚点时从锚点算起（趋势窗口相应变短，至少 1 分钟）。会抛错（时间不合法、锚点坏了），由调用方各自记日志。
 */
export function humanStateAt({ anchor, events, at, history, tier }: {
    anchor: NeedsSnapshot;
    events: readonly LifeEvent[];
    at: Date;
    history: HumanValueFacts['history'];
    tier: string;
}) {
    const needs = needsAt(anchor, events, at);
    const values = humanValuesAt({ at, needs, history, tier, events });
    const anchorAt = Date.parse(anchor.at);
    const previousAt = new Date(Math.max(anchorAt, at.getTime() - 60 * 60_000));
    const previous = humanValuesAt({
        at: previousAt,
        needs: needsAt(anchor, events, previousAt),
        history,
        tier,
        events,
    });
    const development = developmentSummary(developmentSnapshot({ at, values, history, events }));
    const trends = humanValueTrends(values, previous, Math.max(1, Math.round((at.getTime() - previousAt.getTime()) / 60_000)));
    return { needs, values, development, trends };
}
