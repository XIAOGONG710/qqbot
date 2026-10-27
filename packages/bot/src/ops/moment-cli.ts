// node src/ops/moment-cli.ts list|add|remove [--dir <数据目录>]（作者写下的事，ADR 0102）
//   list                         列出现有的事，和它们此刻在她心里还剩多重
//   add --id <名字> --kind <joy|relief|worry|sad|annoyed|tired> --strength <1|2|3> --cause "<她能说出口的一句事实>" [--at "2026-10-25 20:00"|now] [--half-life <小时>]
//   remove <id>
// 写的是 <数据目录>/moments.json（默认 runtime/bot）；文件由作者管，代码和模型都不往里写。强度：1 小事，2 明显，3 大事。
// 来由要像她自己能说的一句事实（“高数小测没考好”），不要写她的情绪或台词；事情是作者定的，别让她经历作者没批准的大事。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../memory/json-file.ts';
import { appraisals, FEELING_KINDS, FEELING_NAME, feelingsAt, validMoments, type Moment } from '../emotion/feelings.ts';
import { momentsPath } from '../emotion/moments.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--dir') ?? resolve(repoRoot, 'runtime/bot'));
const path = momentsPath(dir);
const command = args[0];

function load(): Moment[] {
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!validMoments(parsed)) throw new Error(`${path} 格式不对，先别改它，看一眼里面写了什么`);
    return parsed.moments;
}
const show = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false });

if (command === 'list') {
    const moments = load();
    if (!moments.length) console.log('还没有作者写下的事');
    const now = Date.now();
    for (const moment of moments) {
        const felt = feelingsAt(appraisals({ now, history: [], moments: [moment] }), now)[0];
        console.log(`${moment.id}  ${show(moment.at)}  ${FEELING_NAME[moment.kind]}·${['', '小事', '明显', '大事'][moment.strength]}  ${moment.cause}  → 此刻${felt ? `${felt.level === 'strong' ? '很重' : felt.level === 'clear' ? '明显' : '快散了'}` : '已经散了'}`);
    }
} else if (command === 'add') {
    const id = one('--id');
    const kind = one('--kind');
    const strength = Number(one('--strength'));
    const cause = one('--cause');
    const atText = one('--at') ?? 'now';
    const at = atText === 'now' ? new Date() : new Date(atText.replace(' ', 'T'));
    const halfLife = one('--half-life');
    const moment = { id, at: at.toISOString(), kind, strength, cause, ...(halfLife ? { halfLifeH: Number(halfLife) } : {}) };
    if (!id || !kind || !FEELING_KINDS.includes(kind as never) || ![1, 2, 3].includes(strength) || !cause || Number.isNaN(at.getTime())) {
        console.error(`用法：add --id <名字> --kind <${FEELING_KINDS.join('|')}> --strength <1|2|3> --cause "<一句事实>" [--at "2026-10-25 20:00"|now] [--half-life <小时>]`);
        process.exit(2);
    }
    const moments = load();
    if (moments.some(existing => existing.id === id)) { console.error(`已经有叫 ${id} 的了；先 remove 再 add`); process.exit(2); }
    const next = [...moments, moment as Moment];
    if (!validMoments({ moments: next })) { console.error('这条不合格（来由 2–60 字，id 只能是字母数字下划线横线）'); process.exit(2); }
    writeJsonAtomic(path, { moments: next });
    console.log(`记下了：${id}（${show(moment.at)}，${FEELING_NAME[moment.kind as Moment['kind']]}，来由：${cause}）`);
} else if (command === 'remove') {
    const id = args[1];
    const moments = load();
    if (!id || !moments.some(moment => moment.id === id)) { console.error(`没有叫 ${id} 的`); process.exit(2); }
    writeJsonAtomic(path, { moments: moments.filter(moment => moment.id !== id) });
    console.log(`删掉了：${id}`);
} else {
    console.error('用法：moment-cli.ts list | add ... | remove <id>');
    process.exit(2);
}
