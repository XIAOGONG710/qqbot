// 线上组合盘点：按线上开关快照（exchange/live/koishi-*.yaml 里 qqbot 插件那一块）在合成角色上跑两天，
// 收每一轮的提示词指纹清单（platform/prompt-manifest.ts：槽、模块、字数，没有正文），统计这套开关下提示词实际由什么构成。
//
// 为什么：线上同时开着八十多个开关，基线每个场景只开一小组，没有任何地方按线上那一套整体跑过；
// 「此刻」块有几十行、哪些槽常驻、谁最占字数，没人说得清。要做减法得先有这份账。
// 只用合成角色和合成的种子（借基线场景里现成的 seed / soul），不读真实资料、不连网；联系人、模型、记忆这些不从快照搬。
//
// 用法（在 packages/bot 下）：npm run inventory:live [-- --snapshot <yaml>] [--json <输出>] [--md <输出>]

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, Contact } from '../../src/platform/config.ts';
import { DEFAULTS } from '../../src/platform/config.ts';
import type { PromptManifest } from '../../src/platform/prompt-manifest.ts';
import { runScenario, type LlmCall, type Replier, type Scenario } from '../baseline/harness.ts';
import { SCENARIOS } from '../baseline/scenarios.ts';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(text: string): unknown };

const REPO = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

/**
 * 快照里有、但这里不搬的键：要么不是开关（联系人、模型、目录），要么会碰真实资料 / 起真的服务。
 * 连网的（B 站、网页、天气……）照搬——harness 把 fetch 一律拦下，和断网时的线上一样只是拿不到东西。
 */
export const NOT_COPIED: Readonly<Record<string, string>> = {
    contacts: '联系人用合成的',
    llm: '假模型',
    prompt: '用基线的提示词设置',
    memory: '长期记忆不连',
    vision: '看图不连',
    dsh: '不连 DSH',
    dataDir: '临时目录',
    characterCard: '合成角色卡',
    timeZone: '固定 Asia/Shanghai',
    identityLedger: '会读真实角色目录并调 git',
    dormancy: '封存会复制真实角色目录',
    deviceControl: '会起真的设备服务、监听端口',
    qqControl: 'QQ 账号控制面，合成环境里没有',
};

export interface LiveSwitches {
    source: string;
    config: Partial<AppConfig>;
    /** 照搬的开关里开着的（true / 非 off 的取值） */
    on: string[];
    /** 快照里有但 DEFAULTS 不认识的键（插件那边的，或已经没用了的） */
    unknown: string[];
    skipped: string[];
    /** 快照之后补开的 */
    alsoOn?: string[];
}

const isOn = (value: unknown) => value === true || (typeof value === 'string' && value !== 'off' && value !== '');

export function latestSnapshot(dir = join(REPO, 'exchange', 'live')): string {
    const files = readdirSync(dir).filter(name => /^koishi-.*\.ya?ml$/.test(name)).sort();
    if (!files.length) throw new Error(`${dir} 下没有线上开关快照`);
    return join(dir, files.at(-1)!);
}

/** 从快照里取 qqbot 插件那一块，按 DEFAULTS 认识的键、同类型搬过来 */
export function liveSwitches(text: string, source = ''): LiveSwitches {
    const root = yaml.load(text) as { plugins?: Record<string, unknown> } | undefined;
    const plugin = Object.values(root?.plugins ?? {}).find(
        (p): p is Record<string, unknown> => Boolean(p && typeof p === 'object' && 'contacts' in p),
    );
    if (!plugin) throw new Error('快照里找不到 qqbot 插件的配置');
    const defaults = DEFAULTS as unknown as Record<string, unknown>;
    const config: Record<string, unknown> = {};
    const on: string[] = [];
    const unknown: string[] = [];
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(plugin)) {
        if (key in NOT_COPIED) { skipped.push(key); continue; }
        if (!(key in defaults)) { unknown.push(key); continue; }
        if (typeof value !== typeof defaults[key] || (value !== null && typeof value === 'object')) { skipped.push(key); continue; }
        config[key] = value;
        if (isOn(value)) on.push(key);
    }
    return { source, config: config as Partial<AppConfig>, on: on.sort(), unknown: unknown.sort(), skipped: skipped.sort() };
}

const boyfriend: Contact = { qq: 10001, name: '阿明', tier: 'boyfriend', persona: '她的男朋友，同校不同专业', knowsBot: true };
const classmate: Contact = { qq: 10002, name: '小周', tier: 'classmate' };

/** 借来种子的基线场景：合成的日记、灵魂目录、她自己记下的东西、小梗、口头习惯、热梗、看过的视频、范例、心境来由、关系阶段 */
const SEEDED_FROM = ['soul', 'her-notes', 'jokes', 'idioms', 'memes', 'watched', 'exemplars', 'feelings-sources', 'closeness'] as const;

function rotating(lines: readonly string[]): Replier {
    let chat = 0;
    return (call: LlmCall) => {
        const last = call.messages.at(-1)?.content;
        const first = call.messages[0]?.content;
        if (/JSON|json/.test(typeof last === 'string' ? last : '') || /JSON|json/.test(typeof first === 'string' ? first : '')) return '[]';
        return lines[chat++ % lines.length]!;
    };
}

export function liveMixScenario(config: Partial<AppConfig>, manifest: (m: PromptManifest) => void): Scenario {
    const donors = SEEDED_FROM.map(name => SCENARIOS.find(s => s.name === name)).filter((s): s is Scenario => Boolean(s));
    return {
        name: 'live-mix',
        about: '线上开关组合、合成角色：两天里不同时段的聊天（早上、上课、午饭、晚上、认真问、难过、深夜、第二天），主动消息按线上开着',
        start: '2026-12-14T07:30:00+08:00',
        contacts: [boyfriend, classmate],
        config,
        seed: (dataDir, start) => { for (const d of donors) d.seed?.(dataDir, start); },
        soul: (dir, start) => { for (const d of donors) d.soul?.(dir, start); },
        reply: () => rotating(['嗯嗯\n刚在看书', '哈哈哈离谱', '行吧\n那你早点睡', '我刚下课\n饿死了', '你在干嘛呢', '好呀']),
        manifest,
        script: async d => {
            await d.at('2026-12-14T08:10:00+08:00');
            d.say(boyfriend.qq, '早上好，到教室了吗');
            await d.at('2026-12-14T10:20:00+08:00');
            d.say(boyfriend.qq, '这节课好无聊');
            await d.at('2026-12-14T12:05:00+08:00');
            d.say(boyfriend.qq, '中午吃啥');
            await d.wait(3 * 60_000);
            d.say(boyfriend.qq, '我想吃麻辣烫');
            await d.at('2026-12-14T16:40:00+08:00');
            d.say(classmate.qq, '你周末去图书馆吗');
            await d.at('2026-12-14T19:30:00+08:00');
            d.say(boyfriend.qq, '最近在看什么书');
            await d.at('2026-12-14T20:30:00+08:00');
            d.say(boyfriend.qq, '认真问你，你觉得我要不要转专业？我最近真的很纠结');
            await d.at('2026-12-14T21:30:00+08:00');
            d.say(boyfriend.qq, '我今天好难过');
            await d.wait(5 * 60_000);
            d.say(boyfriend.qq, '被导师骂了');
            await d.at('2026-12-14T23:50:00+08:00');
            d.say(boyfriend.qq, '睡了吗');
            await d.at('2026-12-15T08:30:00+08:00');
            d.say(boyfriend.qq, '昨天睡得怎么样');
            await d.at('2026-12-15T13:00:00+08:00');
            d.say(boyfriend.qq, '下午没课，好闲');
            await d.at('2026-12-15T22:00:00+08:00');
        },
    };
}

export interface SlotStat { slot: string; module: string; list: string; rounds: number; chars: number; omitted: number }
export interface Inventory {
    rounds: { total: number; reply: number; initiate: number; think: number; fallback: number };
    chars: { avg: number; max: number; min: number };
    piecesPerRound: { main: number; history: number; now: number };
    /** 按这一轮是什么（回他 / 主动找他 / 只想一想）分开：轮数、平均字数、「此刻」块平均和最多几段 */
    byKind: { kind: string; rounds: number; avgChars: number; avgNow: number; maxNow: number }[];
    slots: SlotStat[];
    modules: { module: string; rounds: number; chars: number }[];
    llmPurposes: Record<string, number>;
}

export function inventory(manifests: readonly PromptManifest[], transcript = ''): Inventory {
    const slots = new Map<string, SlotStat>();
    const modules = new Map<string, { module: string; rounds: number; chars: number }>();
    const perList = { main: 0, history: 0, now: 0 };
    const kinds = { reply: 0, initiate: 0, think: 0 };
    let fallback = 0;
    for (const m of manifests) {
        kinds[m.kind]++;
        if (m.fallback) fallback++;
        const seenSlot = new Set<string>();
        const seenModule = new Set<string>();
        for (const p of m.pieces) {
            const key = `${p.list}|${p.slot}`;
            const stat = slots.get(key) ?? { slot: p.slot, module: p.module, list: p.list, rounds: 0, chars: 0, omitted: 0 };
            if (!seenSlot.has(key)) { stat.rounds++; seenSlot.add(key); }
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
    const n = manifests.length || 1;
    const byKind = (['reply', 'initiate', 'think'] as const).map(kind => {
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
    const totals = manifests.map(m => m.chars);
    const llmPurposes: Record<string, number> = {};
    for (const match of transcript.matchAll(/^@ \S+ \S+ llm #\d+ (\S+) model=/gm)) llmPurposes[match[1]!] = (llmPurposes[match[1]!] ?? 0) + 1;
    return {
        rounds: { total: manifests.length, ...kinds, fallback },
        chars: {
            avg: Math.round(totals.reduce((a, b) => a + b, 0) / n),
            max: totals.length ? Math.max(...totals) : 0,
            min: totals.length ? Math.min(...totals) : 0,
        },
        byKind,
        piecesPerRound: { main: +(perList.main / n).toFixed(1), history: +(perList.history / n).toFixed(1), now: +(perList.now / n).toFixed(1) },
        slots: [...slots.values()].sort((a, b) => b.chars - a.chars),
        modules: [...modules.values()].sort((a, b) => b.chars - a.chars),
        llmPurposes,
    };
}

export function renderReport(live: LiveSwitches, inv: Inventory): string {
    const n = inv.rounds.total || 1;
    const out: string[] = [
        '# 线上开关组合的提示词盘点（合成角色）',
        '',
        `快照：\`${live.source}\`；照搬 ${Object.keys(live.config).length} 个键，开着 ${live.on.length} 个。`,
        ...(live.alsoOn?.length ? [`快照之后补开：${live.alsoOn.join('、')}。`] : []),
        `没搬：${live.skipped.join('、') || '无'}。DEFAULTS 不认识的键：${live.unknown.join('、') || '无'}。`,
        '',
        `## 轮次`,
        '',
        `共 ${inv.rounds.total} 轮给联系人生成：回复 ${inv.rounds.reply}、主动 ${inv.rounds.initiate}、只想一想 ${inv.rounds.think}；预算放不下直接兜底 ${inv.rounds.fallback}。`,
        `整份提示词字数：平均 ${inv.chars.avg}，最多 ${inv.chars.max}，最少 ${inv.chars.min}。`,
        `每轮段数（平均）：main ${inv.piecesPerRound.main}、聊天记录之后 ${inv.piecesPerRound.history}、「此刻」块 ${inv.piecesPerRound.now}。`,
        '',
        '| 这一轮 | 轮数 | 平均字数 | 「此刻」平均段数 | 「此刻」最多段数 |',
        '|---|---|---|---|---|',
        ...inv.byKind.map(k => `| ${k.kind} | ${k.rounds} | ${k.avgChars} | ${k.avgNow} | ${k.maxNow} |`),
        '',
        '## 模型调用（按用途，两天合计）',
        '',
        '| 用途 | 次数 |',
        '|---|---|',
        ...Object.entries(inv.llmPurposes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
        '',
        '## 槽（按总字数排）',
        '',
        '| 表 | 槽 | 模块 | 出现轮数 | 占比 | 平均字数（出现时） | 被挤掉 |',
        '|---|---|---|---|---|---|---|',
        ...inv.slots.map(s => `| ${s.list} | ${s.slot} | ${s.module} | ${s.rounds} | ${Math.round((s.rounds / n) * 100)}% | ${Math.round(s.chars / Math.max(1, s.rounds))} | ${s.omitted || ''} |`),
        '',
        '## 模块（按总字数排）',
        '',
        '| 模块 | 出现轮数 | 总字数 |',
        '|---|---|---|',
        ...inv.modules.map(m => `| ${m.module} | ${m.rounds} | ${m.chars} |`),
        '',
    ];
    return out.join('\n');
}

/** 快照之后又打开的开关（快照还没刷新时用 --on a,b 补上），在报告里单列 */
export function withAlsoOn(live: LiveSwitches, also: readonly string[]): LiveSwitches {
    if (!also.length) return live;
    const defaults = DEFAULTS as unknown as Record<string, unknown>;
    const config: Record<string, unknown> = { ...live.config };
    for (const key of also) {
        if (!(key in defaults)) throw new Error(`--on ${key}：配置里没有这个开关`);
        config[key] = typeof defaults[key] === 'string' ? 'on' : true;
    }
    return { ...live, config: config as Partial<AppConfig>, on: [...new Set([...live.on, ...also])].sort(), alsoOn: [...also] };
}

export async function runLiveMix(snapshotPath = latestSnapshot(), also: readonly string[] = []): Promise<{ live: LiveSwitches; inv: Inventory; manifests: PromptManifest[] }> {
    const live = withAlsoOn(liveSwitches(readFileSync(snapshotPath, 'utf8'), snapshotPath.slice(REPO.length + 1).split('\\').join('/')), also);
    const manifests: PromptManifest[] = [];
    const transcript = await runScenario(liveMixScenario(live.config, m => manifests.push(m)));
    return { live, inv: inventory(manifests, transcript), manifests };
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invoked === fileURLToPath(import.meta.url)) {
    const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
    const also = (arg('--on') ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const { live, inv } = await runLiveMix(arg('--snapshot') ? resolve(arg('--snapshot')!) : undefined, also);
    const md = renderReport(live, inv);
    const mdOut = arg('--md');
    const jsonOut = arg('--json');
    if (mdOut) writeFileSync(mdOut, md);
    if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ live, inv }, null, 2)}\n`);
    if (!mdOut) process.stdout.write(md);
}
