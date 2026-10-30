// 桌面上的她也知道此刻是什么心境（ADR 0197，随 herFeelings 开关，没有新开关）。
//
// 用户一直要的是「无论在哪里都是同一个她」。原来心境（ADR 0102）只在 QQ 的提示词里：她在 QQ 上因为相机到手开心、因为作业快到期担心，
// 他转到 DSH 桌面上和她说话，桌面上的她什么都不知道；而 DSH 常驻进程自己还有另一套心情数值（her-life.mjs 的 mood / resentment，靠关键词涨跌），
// 两边会对不上。这里的做法和 NOW.md / INSIGHTS.json 一样：QQ 是唯一算心境的地方（用户 10-29：核心是 QQ），算完写一份进灵魂目录，桌面插件只读。
//
// 写的是 QQ 那边每次给他生成回复时顺手算好的结果：此刻的感受（种类、轻重、来由、来源）和**已经写好的那一行**（不含他的原话；
// 「他这一轮在关心她」那种只对 QQ 当下一句话有意义的部分不带）。写的时刻就是这份心境算出来的时刻；桌面超过 FEELINGS_STALE_MS 没刷新就不用——
// 心境散得慢（半衰期 3–8 小时），几个钟头内还算数，更久就不拿旧的冒充现在（和 NOW.md 一个道理）。

import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { join } from 'node:path';
import type { Felt } from './feelings.ts';

export const FEELINGS_EXPORT_FILE = 'FEELINGS.json';
export const FEELINGS_EXPORT_KIND = 'qq-feelings';
export const feelingsExportPath = (soulDir: string) => join(soulDir, FEELINGS_EXPORT_FILE);
/** 桌面超过这么久没刷新就不用 */
export const FEELINGS_STALE_MS = 3 * 3_600_000;
/** 内容没变时，隔这么久也重写一次时间戳 */
export const FEELINGS_REFRESH_MS = 10 * 60_000;

/** contact.ts 每次算完心境交出来的 */
export interface FeelingsReport {
    /** 这份心境算出来的时刻（毫秒） */
    at: number;
    felt: readonly Felt[];
    /** 要放进提示词的那一行；这一刻没有明显的感受 / 在小别扭那一轮就是 undefined */
    line: string | undefined;
}

export interface FeelingsExport {
    kind: typeof FEELINGS_EXPORT_KIND;
    generatedAt: string;
    /** 此刻的感受（只留明显以上的，最多 4 条）；不含他的话 */
    felt: Array<{ kind: string; level: string; cause: string; source: string; aboutHim: boolean }>;
    /** 桌面注入用的那一行；没有就是 null（明确告诉桌面「此刻没有明显的感受」，不是没算） */
    line: string | null;
}

const shape = (report: FeelingsReport): Omit<FeelingsExport, 'generatedAt'> => ({
    kind: FEELINGS_EXPORT_KIND,
    felt: report.felt.filter(item => item.level !== 'faint').slice(0, 4).map(item => ({ kind: item.kind, level: item.level, cause: item.cause, source: item.source, aboutHim: item.aboutHim })),
    line: report.line ?? null,
});

/** 内容变了、或时间戳超过 10 分钟没刷新才写；原子写，免得桌面读到半截。返回有没有写 */
export function writeFeelingsExport(soulDir: string, report: FeelingsReport): boolean {
    const path = feelingsExportPath(soulDir);
    const next = shape(report);
    const current = readJsonOr<unknown>(path, {});
    if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
        const old = current as Partial<FeelingsExport>;
        const written = typeof old.generatedAt === 'string' ? Date.parse(old.generatedAt) : NaN;
        const same = old.kind === FEELINGS_EXPORT_KIND && JSON.stringify({ felt: old.felt, line: old.line }) === JSON.stringify({ felt: next.felt, line: next.line });
        if (same && Number.isFinite(written) && report.at - written < FEELINGS_REFRESH_MS && written <= report.at) return false;
    }
    writeJsonAtomic(path, { ...next, generatedAt: new Date(report.at).toISOString() } satisfies FeelingsExport);
    return true;
}
