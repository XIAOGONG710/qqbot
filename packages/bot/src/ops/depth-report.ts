// 深度评估的数字（ADR 0205）：读 sim 跑出来的目录（report.md + sim.log），只出数字，不出她的原话。
// 用来回答“这个开关开了之后，需要有东西可说的那几轮，走深思的多了吗、常见的几种说法多了吗”——比较两次跑，不评分、不卡她。
// 一次跑 = <目录>/<场景>/r<N>/{report.md,sim.log}；数字按目录合起来算。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tropeShares, type TropeShares } from '../language/tropes.ts';

const HER_LINE = /^- `[^`]*` 她：(.*)$/;
const HIS_LINE = /\*\*对方\*\*：/;

export interface RunNumbers {
    /** 他说了几句（= 需要她回的几个时刻） */
    steps: number;
    /** 其中走深思的几轮（sim.log 里的「深思：」） */
    deliberate: number;
    /** 深思里，是语义路由（ADR 0202）判出来的几轮 */
    routed: number;
    /** 她发的气泡 */
    bubbles: number;
    medianChars: number;
    /** 两个字以内的气泡占比 */
    tinyShare: number;
    tropes: TropeShares;
}

const chars = (text: string) => [...text.trim()].length;
const median = (values: number[]) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** 她在 report.md 里说的话（一个气泡一项，只在内存里用来数，不往外输出） */
export function herBubbles(report: string): string[] {
    return report.split('\n').flatMap(line => {
        const text = HER_LINE.exec(line)?.[1]?.trim();
        return text ? [text] : [];
    });
}

export function numbersOf(runs: readonly { report: string; log: string }[]): RunNumbers {
    let steps = 0, deliberate = 0, routed = 0;
    const bubbles: string[] = [];
    for (const run of runs) {
        steps += run.report.split('\n').filter(line => HIS_LINE.test(line)).length;
        const thinking = run.log.split('\n').filter(line => line.includes('深思：'));
        deliberate += thinking.length;
        routed += thinking.filter(line => line.includes('语义路由')).length;
        bubbles.push(...herBubbles(run.report));
    }
    const lengths = bubbles.map(chars);
    return {
        steps, deliberate, routed, bubbles: bubbles.length,
        medianChars: median(lengths),
        tinyShare: lengths.length ? lengths.filter(length => length <= 2).length / lengths.length : 0,
        tropes: tropeShares(bubbles),
    };
}

/** 目录下所有带 report.md 的跑法（最多往下找 3 层） */
export function collectRuns(dir: string, depth = 0): { report: string; log: string }[] {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    const report = join(dir, 'report.md');
    if (existsSync(report)) {
        const logFile = join(dir, 'sim.log');
        return [{ report: readFileSync(report, 'utf8'), log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' }];
    }
    if (depth >= 3) return [];
    return readdirSync(dir).sort().flatMap(name => collectRuns(join(dir, name), depth + 1));
}

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

/** 一行数字（没有原话） */
export function numbersLine(label: string, numbers: RunNumbers, runs: number): string {
    const { steps, deliberate, routed, bubbles, medianChars, tinyShare, tropes } = numbers;
    return `${label}：${runs} 遍 · 他说了 ${steps} 句 · 走深思 ${deliberate}（其中语义路由 ${routed}） · 她发了 ${bubbles} 个气泡 · 每条中位 ${medianChars} 字 · 两字以内 ${pct(tinyShare)} · 警句式 ${pct(tropes.aphorism)} / 半夜睡不着 ${pct(tropes.insomnia)} / 突然明白 ${pct(tropes.sudden)}`;
}
