// 量「一天里群表达机会 eligible 的分钟占比」（ADR 0343 groupAgency A 时间窗的实测）：
// 读真实影子账，按分钟调 groupOpportunity，统计 eligible / motiveAllows 的分钟数和没放行的原因。
// 用法：node --import tsx scripts/measure-group-opportunity.mts [dataDir=runtime/bot-shadow]
// 只读影子账；不生成内容、不发送、不碰线上开关。
import { readAgencyShadow } from '../packages/bot/src/world/agency-shadow.ts';
import { groupOpportunity, motiveAllows } from '../packages/bot/src/social/group-opportunity.ts';

const dataDir = process.argv[2] ?? 'runtime/bot-shadow';
const shadow = readAgencyShadow(dataDir, new Date('2026-11-01T00:00:00+08:00'));

const opportunities = shadow.opportunities.opportunities() ?? [];
console.log('opportunities total', opportunities.length, 'eligible', opportunities.filter(o => o.eligible).length);

function day(startIso: string, minutes: number, label: string) {
    const start = Date.parse(startIso);
    let eligibleMinutes = 0;
    let allowsMinutes = 0;
    let firstEligible: string | undefined;
    let lastEligible: string | undefined;
    const reasons = new Map<string, number>();
    for (let i = 0; i < minutes; i++) {
        const at = new Date(start + i * 60_000);
        const d = groupOpportunity(at, shadow);
        if (d.eligible) {
            eligibleMinutes++;
            firstEligible ??= at.toISOString();
            lastEligible = at.toISOString();
        }
        if (motiveAllows(d)) allowsMinutes++;
        reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1);
    }
    console.log(label, JSON.stringify({
        minutes, eligibleMinutes, allowsMinutes,
        pct: +(eligibleMinutes / minutes * 100).toFixed(2),
        firstEligible, lastEligible,
        reasons: [...reasons].sort((a, b) => b[1] - a[1]),
    }));
}

day('2026-11-21T00:00:00+08:00', 1440, '11-21 full day');
day('2026-11-22T00:00:00+08:00', 22 * 60, '11-22 up to 22:00');
day('2026-11-16T00:00:00+08:00', 1440, '11-16 full day');
