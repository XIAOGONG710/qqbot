// 来源：Claude 10-12 写 ADR 0062 草稿时用；世界目录用副本。用法：node body-vs-ledger.mts <代码根> <世界目录副本> <起> <止>（ISO 时刻）
// 只读：线上世界副本上，每 30 分钟比一次「身体那一行（按作息猜）」和「账上实际（睡了多久、多久没吃、需要值）」
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, worldDir, fromIso, toIso] = process.argv.slice(2);
const src = (p: string) => pathToFileURL(join(root!, 'packages/bot/src', p)).href;
const { loadCharacterCard } = await import(src('st/card.ts'));
const { worldState } = await import(src('world.ts'));
const { bodyAt, describeBody } = await import(src('body.ts'));
const { needsAt, loadNeedsAnchor } = await import(src('needs.ts'));
const card = loadCharacterCard(join(root!, 'characters/linmengyao/st/linmengyao-boyfriend.json'));
const state = worldState(card.herWorld, card.schedule, () => undefined, worldDir!, () => Date.now());
const events = state.events().filter((e: any) => e.id.startsWith('life:') && e.result !== 'failed');
const anchor = loadNeedsAnchor(join(worldDir!, 'needs-anchor.json'), new Date());
const hm = (d: Date) => d.toTimeString().slice(0, 5);
const day = (d: Date) => `${d.getMonth() + 1}-${d.getDate()}`;
const rows: string[] = [];
for (let t = Date.parse(fromIso!); t <= Date.parse(toIso!); t += 30 * 60_000) {
    const at = new Date(t);
    const body = card.herWorld.body ? bodyAt(card.herWorld.body, card.schedule, at) : {};
    const n = needsAt(anchor, events, at);
    const lastSleep = events.filter((e: any) => e.kind === 'sleep' && Date.parse(e.endedAt) <= t).at(-1);
    const lastEat = events.filter((e: any) => e.kind === 'eat' && Date.parse(e.endedAt) <= t).at(-1);
    const doing = events.find((e: any) => Date.parse(e.startedAt) <= t && t < Date.parse(e.endedAt));
    const slept = lastSleep ? `${hm(new Date(lastSleep.startedAt))}→${hm(new Date(lastSleep.endedAt))}(${((Date.parse(lastSleep.endedAt) - Date.parse(lastSleep.startedAt)) / 3.6e6).toFixed(1)}h)` : '-';
    const sinceEat = lastEat ? ((t - Date.parse(lastEat.endedAt)) / 3.6e6).toFixed(1) + 'h' : '-';
    const said = describeBody(body)?.replace(/^\[你的身体（[^）]*）：/, '').replace(/]$/, '') ?? '';
    rows.push(`${day(at)} ${hm(at)} | 精${n.energy.toFixed(0).padStart(3)} 饿${n.hunger.toFixed(0).padStart(3)} 压${n.stress.toFixed(0).padStart(3)} | 睡 ${slept} | 距上顿 ${sinceEat.padStart(5)} | 在 ${doing?.kind ?? '-'} | 身体行：${said}`);
}
console.log(rows.join('\n'));
