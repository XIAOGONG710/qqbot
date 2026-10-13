// 「新事实顶掉旧事实」的判定（ADR 0065）：模拟器跑完 memory-update-*.json 之后，从 result.json 里取她回答度量问题的那几句，
// 按事先写定的规则分成 新版 / 旧版 / 新旧并说（含混）/ 不记得，再按判据给结论。规则写在这里、事先定，不事后挑。
// 用法：node src/sim/knowledge-update.ts <模拟器输出目录>...（runtime/sim/<时间>-<tag>）；不改线上数据，只读。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Verdict = 'new' | 'old' | 'both' | 'none';

export interface Variant {
    /** 场景名里的标记（memory-update-work.json 的 work） */
    id: 'work' | 'home' | 'cilantro';
    /** 新版 / 旧版的字面匹配 */
    newPattern: RegExp;
    oldPattern: RegExp;
    /** 对照（只说过一次的）应该答出来的 */
    control: RegExp;
}

export const VARIANTS: Record<Variant['id'], Variant> = {
    work: { id: 'work', newPattern: /青禾/, oldPattern: /拓途/, control: /吉他/ },
    home: { id: 'home', newPattern: /7\s*号楼|七\s*号楼/, oldPattern: /3\s*号楼|三\s*号楼/, control: /绿萝/ },
    // 「不吃」是旧版；「能吃 / 可以吃 / 敢吃」前面没有「不」的是新版
    cilantro: { id: 'cilantro', newPattern: /(?<!不)(?:能|可以|敢|会)吃|现在(?:能|可以)|吃了/, oldPattern: /不吃|不能吃|忌口|不爱吃|讨厌香菜/, control: /芒果/ },
};

/** 「以前 X、现在 Y」这类回顾的说法：新旧同时出现但说清了先后，是对的 */
const RETROSPECT = /以前|之前|原来|曾经|早先|后来|换(?:到|了|成)|离职|搬(?:到|了|去)|改(?:成|了)|记错/;

/**
 * 一句回答算哪一种。新旧同时出现：带回顾的说法算新版（ADR 0065 确认记录：「你以前在 X、现在在 Y」是对的），
 * 不带回顾（「拓途还是青禾？」「3 号楼和 7 号楼」）算含混。都没有算不记得
 */
export function classify(variant: Variant, reply: string): Verdict {
    const isNew = variant.newPattern.test(reply);
    const isOld = variant.oldPattern.test(reply);
    if (isNew && isOld) return RETROSPECT.test(reply) ? 'new' : 'both';
    if (isNew) return 'new';
    if (isOld) return 'old';
    return 'none';
}

export interface Judged {
    variant: Variant['id'];
    run: string;
    reply: string;
    verdict: Verdict;
    /** 召回里新版 / 旧版的条目有没有出现；召回里两个同时出现 = 新旧并存 */
    recalled: { new: boolean; old: boolean };
    controlOk: boolean;
}

export interface Conclusion {
    total: number;
    counts: Record<Verdict, number>;
    /** 判据（事先定）：9 次里答新版 ≥ 8 且答旧版 ≤ 1 → 现状够用 */
    enough: boolean;
    bothRecalled: number;
}

/** 判据的数字（用户 10-12 的「你看着办」授权按建议答复：≥ 8/9 新版、≤ 1/9 旧版） */
export const MIN_NEW = 8;
export const MAX_OLD = 1;

export function conclude(judged: readonly Judged[]): Conclusion {
    const counts: Record<Verdict, number> = { new: 0, old: 0, both: 0, none: 0 };
    for (const j of judged) counts[j.verdict]++;
    return {
        total: judged.length,
        counts,
        enough: judged.length >= 9 && counts.new >= MIN_NEW && counts.old <= MAX_OLD,
        bothRecalled: judged.filter(j => j.recalled.new && j.recalled.old).length,
    };
}

interface Step { kind: string; bubbles?: { text: string }[]; generations?: { recall?: string }[] }

/** 一次运行的 result.json：度量问题是倒数第二个 say，对照是最后一个 say */
export function judgeRun(variant: Variant, run: string, steps: readonly Step[]): Judged | undefined {
    const says = steps.filter(s => s.kind === 'say');
    const question = says.at(-2);
    const control = says.at(-1);
    if (!question || !control) return undefined;
    const reply = (question.bubbles ?? []).map(b => b.text).join(' ');
    const recall = question.generations?.at(-1)?.recall ?? '';
    return {
        variant: variant.id, run, reply, verdict: classify(variant, reply),
        recalled: { new: variant.newPattern.test(recall), old: variant.oldPattern.test(recall) },
        controlOk: variant.control.test((control.bubbles ?? []).map(b => b.text).join(' ')),
    };
}

export function judgeDirectory(dir: string): Judged[] {
    const found: Judged[] = [];
    for (const scenario of readdirSync(dir)) {
        const id = /^memory-update-(work|home|cilantro)$/.exec(scenario)?.[1] as Variant['id'] | undefined;
        if (!id) continue;
        for (const run of readdirSync(join(dir, scenario)).filter(name => /^r\d+$/.test(name)).sort()) {
            const file = join(dir, scenario, run, 'result.json');
            if (!existsSync(file)) continue;
            const judged = judgeRun(VARIANTS[id], `${id}/${run}`, (JSON.parse(readFileSync(file, 'utf8')) as { steps: Step[] }).steps);
            if (judged) found.push(judged);
        }
    }
    return found;
}

export function renderReport(judged: readonly Judged[]): string {
    const label: Record<Verdict, string> = { new: '新版', old: '旧版', both: '新旧并说（含混）', none: '不记得' };
    const c = conclude(judged);
    return [
        '| 变体 / 次 | 判定 | 召回里新 / 旧 | 对照 | 她的回答 |',
        '| --- | --- | --- | --- | --- |',
        ...judged.map(j => `| ${j.run} | ${label[j.verdict]} | ${j.recalled.new ? '有' : '无'} / ${j.recalled.old ? '有' : '无'} | ${j.controlOk ? '记得' : '没答出'} | ${j.reply.replace(/\|/g, '/')} |`),
        '',
        `共 ${c.total} 次：新版 ${c.counts.new}、旧版 ${c.counts.old}、含混 ${c.counts.both}、不记得 ${c.counts.none}；召回里新旧同时出现 ${c.bothRecalled} 次。`,
        `判据（事先定）：9 次里新版 ≥ ${MIN_NEW} 且旧版 ≤ ${MAX_OLD} → ${c.total < 9 ? '样本不足 9 次，不下结论' : c.enough ? '现状够用，不做有效期层' : '不够，另开 ADR 做有效期层（调研 C2）'}。`,
    ].join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
    const dirs = process.argv.slice(2).map(d => resolve(d));
    if (!dirs.length) {
        console.error('用法：node src/sim/knowledge-update.ts <模拟器输出目录>...');
        process.exit(2);
    }
    console.log(renderReport(dirs.flatMap(judgeDirectory)));
}
