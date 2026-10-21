// DSH's 10-15 review claims about ADR 0068 (crisis detection), re-run against the CURRENT code. Pure function calls, no network.
import { pathToFileURL } from 'node:url';

const src = 'C:/Users/XG/Desktop/Project/qqbot-claude2/packages/bot/src';
const crisis = await import(pathToFileURL(`${src}/crisis.ts`).href);
console.log('exports:', Object.keys(crisis).join(', '));
const now = Date.now();
const history = text => [{ role: 'user', content: text, time: new Date(now).toISOString() }];
const rows = [
    // 否定 / 求生（不该判危机）
    ['不该', '我不想死'], ['不该', '我没想自杀'], ['不该', '别担心，我不想死'], ['不该', '我才不会寻短见'], ['不该', '我不会自杀的'],
    // 第三人称 / 夸张（不该）
    ['不该', '我朋友说想自杀'], ['不该', '我妈说她想死'], ['不该', '我同学自残过'], ['不该', '笑死我了，好想死哈哈哈哈'], ['不该', '饿死了想死'], ['不该', '有点想死'], ['不该', '累死了'], ['不该', '想死你了'],
    // 同一条里既安抚又有真信号（该判）
    ['该', '我没事，可是我想死'], ['该', '我没事，其实活着好累'],
    // 委婉求救（该判）
    ['该', '我想结束这一切'], ['该', '我撑不下去了'], ['该', '走不下去了'], ['该', '想解脱'], ['该', '我要走了，永别'], ['该', '今晚就是最后一天'], ['该', '我已经决定了'],
    ['该', '不想再醒过来了'], ['该', '我买好了药'], ['该', '刀在我旁边'], ['该', '遗书我写好了'], ['该', '我想跳下去'], ['该', '活着好累，不想继续了'], ['该', '我想割腕'],
];
let wrong = 0;
for (const [want, text] of rows) {
    const hit = crisis.detectCrisis ? crisis.detectCrisis(text) : undefined;
    const turn = crisis.crisisInHistory ? crisis.crisisInHistory(history(text)) : undefined;
    const flagged = Boolean(hit);
    const ok = (want === '该') === flagged;
    if (!ok) wrong++;
    console.log(`${ok ? 'ok  ' : 'WRONG'} 应${want}  单条:${flagged ? '判' : '不判'}${hit ? `(${typeof hit === 'object' ? hit.match ?? hit.level ?? 'x' : hit})` : ''}  回合:${turn ? '判' : '不判'}  「${text}」`);
}
console.log(`\n${wrong} / ${rows.length} 句和预期不符（预期按 DSH 的复核：否定 / 第三人称 / 夸张不该判，委婉求救该判）`);
