// 只读：拿线上世界目录的副本，算「你这几天拍照修图」那一行（ADR 0054）在某个时刻会写什么，列出最近 3 天的行动账
// 用法：node photo-line.mts <代码根> <世界目录副本> [时刻 ...]（不给时刻就算现在）
// 世界目录副本：先把线上 runtime/bot/world 整个复制到临时目录，别直接指线上目录
import { join } from 'node:path';
const [root, worldDir, ...times] = process.argv.slice(2);
const src = (p: string) => `file:///${join(root!, 'packages/bot/src', p).replaceAll('\\', '/')}`;
const { loadCharacterCard } = await import(src('st/card.ts'));
const { worldState } = await import(src('world.ts'));
const { recentPhotography, describeRecentPhotography } = await import(src('projects.ts'));
const card = loadCharacterCard(join(root!, 'characters/linmengyao/st/linmengyao-boyfriend.json'));
const state = worldState(card.herWorld, card.schedule, () => undefined, worldDir!, () => Date.now());
for (const t of times.length ? times : [new Date().toISOString()]) {
    const time = new Date(t);
    const p = recentPhotography(state.events(), time, 3, card.schedule);
    console.log(t, p ? describeRecentPhotography(p, time, card.schedule) : '(no line)');
}
const since = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
for (const e of state.events().filter((e: { id: string; day?: string }) => e.id.startsWith('life:') && (e.day ?? '') >= since)) {
    const local = (iso?: string) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '');
    console.log(e.day, e.kind, local(e.startedAt), local(e.endedAt), JSON.stringify(e).slice(0, 200));
}
