// 提示词构成盘点的纯统计（从 test/inventory/live-mix.ts 挪来，2026-11-26 DSH 面板计划模块 1）：
// 把一组提示词指纹清单（platform/prompt-manifest.ts：槽、模块、字数，没有正文）汇总成「这套开关下提示词实际由什么构成」。
// 线上组合盘点（npm run inventory:live，合成角色跑两天）和 DSH 面板的「提示词构成」（读 <数据目录>/logs/prompt-manifest-*.jsonl）共用这一份；
// 生产代码不 import test/ 下的东西，所以放在 src。输出只有槽名、模块名、种类和数，不带 QQ 号、哈希和正文。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_FILE, MANIFEST_KINDS, SLOT_KINDS, type ManifestKind, type PromptManifest } from '../platform/prompt-manifest.ts';

export interface SlotStat {
    slot: string; module: string; list: string; rounds: number; chars: number; omitted: number;
    /** 出现在哪种轮次里各几轮（回他 / 主动找他 / 只想一想；群里、审稿重写、挑候选的行没有段落，总是 0） */
    kinds: Record<ManifestKind, number>;
}
export interface Inventory {
    /** total 只数按槽拼的（回他 / 主动 / 想一想）：字数、每轮段数、槽的占比都按这些算；群里开口、审稿重写、挑候选另数 */
    rounds: { total: number; fallback: number } & Record<ManifestKind, number>;
    chars: { avg: number; max: number; min: number };
    piecesPerRound: { main: number; history: number; now: number };
    /** 按这一轮是什么（回他 / 主动找他 / 只想一想 / 群里开口 / 审稿重写 / 挑候选）分开：轮数、平均字数、「此刻」块平均和最多几段 */
    byKind: { kind: string; rounds: number; avgChars: number; avgNow: number; maxNow: number }[];
    slots: SlotStat[];
    modules: { module: string; rounds: number; chars: number }[];
    /** 不按槽拼的那几种细分：审稿重写按哪一步要的、挑候选一共生成了几次、群里按为什么开口 */
    extra: { reviewStages: Record<string, number>; candidateCalls: number; groupReasons: Record<string, number> };
    llmPurposes: Record<string, number>;
}

const zeroKinds = (): Record<ManifestKind, number> => Object.fromEntries(MANIFEST_KINDS.map(kind => [kind, 0])) as Record<ManifestKind, number>;
const slotted = (m: PromptManifest) => (SLOT_KINDS as readonly string[]).includes(m.kind);
const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };

/** 汇总一组清单；transcript 是模拟器的记录（线上组合盘点用来数各用途的模型调用），读真实清单时不给 */
export function inventory(manifests: readonly PromptManifest[], transcript = ''): Inventory {
    const slots = new Map<string, SlotStat>();
    const modules = new Map<string, { module: string; rounds: number; chars: number }>();
    const perList = { main: 0, history: 0, now: 0 };
    const kinds = zeroKinds();
    const extra: Inventory['extra'] = { reviewStages: {}, candidateCalls: 0, groupReasons: {} };
    let fallback = 0;
    for (const m of manifests) {
        if (m.kind in kinds) kinds[m.kind]++;
        if (m.fallback) fallback++;
        if (m.kind === 'review') bump(extra.reviewStages, m.stage ?? '?');
        if (m.kind === 'candidate') extra.candidateCalls += m.calls ?? 0;
        if (m.kind === 'group') bump(extra.groupReasons, m.reason ?? '?');
        const seenSlot = new Set<string>();
        const seenModule = new Set<string>();
        for (const p of m.pieces) {
            const key = `${p.list}|${p.slot}`;
            const stat = slots.get(key) ?? { slot: p.slot, module: p.module, list: p.list, rounds: 0, chars: 0, omitted: 0, kinds: zeroKinds() };
            if (!seenSlot.has(key)) { stat.rounds++; if (m.kind in stat.kinds) stat.kinds[m.kind]++; seenSlot.add(key); }
            stat.chars += p.chars;
            if (p.omitted) stat.omitted++;
            slots.set(key, stat);
            const mod = modules.get(p.module) ?? { module: p.module, rounds: 0, chars: 0 };
            if (!seenModule.has(p.module)) { mod.rounds++; seenModule.add(p.module); }
            mod.chars += p.chars;
            modules.set(p.module, mod);
            if (!p.omitted) perList[p.list]++;
        }
    }
    const built = manifests.filter(slotted);
    const n = built.length || 1;
    const byKind = MANIFEST_KINDS.map(kind => {
        const list = manifests.filter(m => m.kind === kind);
        const now = list.map(m => m.pieces.filter(p => p.list === 'now' && !p.omitted).length);
        const k = list.length || 1;
        return {
            kind, rounds: list.length,
            avgChars: Math.round(list.reduce((a, m) => a + m.chars, 0) / k),
            avgNow: +(now.reduce((a, b) => a + b, 0) / k).toFixed(1),
            maxNow: now.length ? Math.max(...now) : 0,
        };
    });
    const totals = built.map(m => m.chars);
    const llmPurposes: Record<string, number> = {};
    for (const match of transcript.matchAll(/^@ \S+ \S+ llm #\d+ (\S+) model=/gm)) llmPurposes[match[1]!] = (llmPurposes[match[1]!] ?? 0) + 1;
    return {
        rounds: { total: built.length, ...kinds, fallback },
        chars: {
            avg: Math.round(totals.reduce((a, b) => a + b, 0) / n),
            max: totals.length ? Math.max(...totals) : 0,
            min: totals.length ? Math.min(...totals) : 0,
        },
        byKind,
        piecesPerRound: { main: +(perList.main / n).toFixed(1), history: +(perList.history / n).toFixed(1), now: +(perList.now / n).toFixed(1) },
        slots: [...slots.values()].sort((a, b) => b.chars - a.chars),
        modules: [...modules.values()].sort((a, b) => b.chars - a.chars),
        extra,
        llmPurposes,
    };
}

/** 一个目录里的 prompt-manifest-*.jsonl 全读进来；坏行跳过 */
export function readManifests(dir: string): PromptManifest[] {
    const out: PromptManifest[] = [];
    for (const name of readdirSync(dir).filter(file => MANIFEST_FILE.test(file)).sort()) {
        for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const row = JSON.parse(line) as PromptManifest;
                if (Array.isArray(row.pieces) && typeof row.kind === 'string') out.push(row);
            } catch { /* 写到一半的行 */ }
        }
    }
    return out;
}
