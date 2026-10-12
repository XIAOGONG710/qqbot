// 只读：审线上影子行动账（世界目录的副本）——每天各类行动多少、有没有重叠、和同一时刻的状态行分叉多少、状态行说的账上缺多少
// 来源：Claude 10-11 ADR 0054 两次审计用的脚本，10-12 放进 exchange；世界目录同样要用副本
// 用法：node <本文件> <代码根> <数据根（线上仓库）> <世界目录副本>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [root, dataRoot, worldDir] = process.argv.slice(2);
const src = (p: string) => `file:///${join(root!, 'packages/bot/src', p).replaceAll('\\', '/')}`;
const { loadCharacterCard } = await import(src('st/card.ts'));
const { worldState } = await import(src('world.ts'));
const { auditLifeStatus, auditLedgerCoverage } = await import(src('sim/life-audit.ts'));
const { saidBedtimes } = await import(src('bedtime.ts'));
const { bodyAt } = await import(src('body.ts'));

const card = loadCharacterCard(join(dataRoot!, 'characters/linmengyao/st/linmengyao-boyfriend.json'));
const state = worldState(card.herWorld, card.schedule, () => undefined, worldDir!, () => Date.now());
const chats = ['2260168937', '2306669773'].map(qq => {
    try { return readFileSync(join(dataRoot!, 'runtime/bot/chats', `${qq}.jsonl`), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)); } catch { return []; }
});
const events = state.events().filter((e: { id: string }) => e.id.startsWith('life:'));
const sources = {
    schedule: card.schedule, plans: card.herWorld.plans, books: card.books,
    worldAt: (time: Date) => state.at(card.herWorld, card.schedule, time), events: () => state.events(),
    ...(card.herWorld.body ? { bodyAt: (time: Date) => bodyAt(card.herWorld.body, card.schedule, time) } : {}),
    bedtimes: () => saidBedtimes(chats, card.schedule, Date.now() - 4 * 86_400_000),
};
const byDay = new Map<string, Map<string, number>>();
for (const e of events) {
    const day = (e.day ?? e.startedAt.slice(0, 10)) as string;
    const kinds = byDay.get(day) ?? new Map();
    kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    byDay.set(day, kinds);
}
for (const [day, kinds] of [...byDay].sort()) console.log(day, [...kinds].map(([k, n]) => `${k} ${n}`).join('、'));
const sorted = [...events].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
let overlaps = 0;
for (let i = 1; i < sorted.length; i++) if (Date.parse(sorted[i].startedAt) < Date.parse(sorted[i - 1].endedAt)) overlaps++;
const mismatches = auditLifeStatus(events, sources);
const gaps = auditLedgerCoverage(events, sources);
console.log(`行动 ${events.length} 件，重叠 ${overlaps}，和状态行分叉 ${mismatches.length}，状态行说了账上缺 ${gaps.length}`);
for (const m of mismatches.slice(0, 8)) console.log('  分叉', JSON.stringify(m).slice(0, 220));
for (const g of gaps.slice(0, 8)) console.log('  缺', JSON.stringify(g).slice(0, 220));
