// node src/ops/consistency-cli.ts [--dir <数据目录>] [--qq <QQ号>] [--card <角色卡 json>] [--since 2026-10-15]（前后一致性检查，ADR 0119）
// 只读：读聊天记录、角色卡的作息、世界账的天气，把她说过的话和当时的账对一对，打印每条规则命中几次和几条例子。线索不是定论。

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConsistency, describeFindings, type SaidRow } from '../consistency.ts';
import { loadCharacterCard } from '../st/card.ts';
import { worldState } from '../world/world.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--dir') ?? resolve(repoRoot, 'runtime/bot'));
const cardFile = resolve(process.env.INIT_CWD ?? process.cwd(), one('--card') ?? resolve(repoRoot, 'characters/linmengyao/st/linmengyao-boyfriend.json'));
let qq = Number(one('--qq'));
if (!qq && existsSync(join(dataDir, 'config.json'))) {
    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { contacts?: { qq: number; tier: string }[] };
    qq = config.contacts?.find(c => c.tier === 'boyfriend')?.qq ?? 0;
}
if (!qq) { console.error('不知道是哪个联系人：用 --qq 给 QQ 号'); process.exit(2); }
const since = one('--since') ? Date.parse(one('--since')!) : 0;
const file = join(dataDir, 'chats', `${qq}.jsonl`);
if (!existsSync(file)) { console.error(`没有聊天记录 ${file}`); process.exit(2); }
const rows: SaidRow[] = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line): SaidRow[] => {
    try {
        const r = JSON.parse(line) as { time: string; role: 'user' | 'assistant'; content?: unknown };
        return [{ time: Date.parse(r.time), role: r.role, text: String(r.content ?? '') }];
    } catch { return []; }
}).filter(r => r.time >= since).sort((a, b) => a.time - b.time);

const card = loadCharacterCard(cardFile);
if (!card.schedule) { console.error('这张卡没有作息，没法对'); process.exit(2); }
// 天气：世界账里这一天下过雨的钟头；没有世界账就不查下雨两条
const world = card.herWorld ? worldState(card.herWorld, card.schedule, () => {}, mkdtempSync(join(tmpdir(), 'qqbot-consistency-')), () => Date.now()) : undefined;
const cache = new Map<string, boolean | undefined>();
const rainAt = world && card.herWorld ? (time: number) => {
    const d = new Date(time);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
    if (!cache.has(key)) {
        const now = world.at(card.herWorld!, card.schedule!, new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 59));
        cache.set(key, now?.weather ? Boolean(now.weather.rainHours?.includes(d.getHours())) : undefined);
    }
    return cache.get(key);
} : undefined;
const findings = checkConsistency({ rows, schedule: card.schedule, ...(rainAt ? { rainAt } : {}) });
console.log(describeFindings(findings, rows.filter(r => r.role === 'assistant').length));
