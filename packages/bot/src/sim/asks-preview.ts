// 闺蜜的约（ADR 0061）的月历预览：把某一段日子里的约、结果、她按规则答应不答应都列出来，给人看频率「像不像」。
// 用法：node src/sim/asks-preview.ts [起始日 YYYY-MM-DD，默认 2026-11-02] [天数，默认 28] [档位，默认 boyfriend]
// 只读：用卡上的作息、世界、身体，不碰线上数据；和他的见面没有（没有聊天），所以「跟他约好了」这一类不出现。

import { resolve } from 'node:path';
import { bodyAt, unwell } from '../body.ts';
import { describeAsk, judgeAsk, npcAsksBetween, type AskFacts } from '../npc-asks.ts';
import { classesOn } from '../schedule.ts';
import { loadCharacterCard } from '../st/card.ts';
import { worldAt } from '../world.ts';

const [fromText = '2026-11-02', daysText = '28', tier = 'boyfriend'] = process.argv.slice(2);
const card = loadCharacterCard(resolve(import.meta.dirname, `../../../../characters/linmengyao/st/linmengyao-${tier}.json`));
const schedule = card.schedule!;
const world = card.herWorld!;
const [y, m, d] = fromText.split('-').map(Number);
const from = new Date(y!, m! - 1, d);
const to = new Date(y!, m! - 1, d! + Number(daysText) - 1);

const asks = npcAsksBetween(world.people, schedule, from, to);
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const time = (t: Date) => `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;

const counts = { on_time: 0, late: 0, moved: 0, cancelled: 0 };
const verdicts = { accept: 0, meetup: 0, class: 0, unwell: 0, homework: 0 };
console.log(`# 闺蜜的约预览 ${fromText} 起 ${daysText} 天（${tier} 档）\n`);
console.log('| 日期 | 谁说的、什么时候说 | 约的事 | 结果 | 她的答复 |');
console.log('| --- | --- | --- | --- | --- |');
for (const ask of asks) {
    const now = worldAt(world, schedule, ask.askedAt);
    const facts: AskFacts = {
        classes: classesOn(schedule, new Date(`${ask.day}T00:00`)).lessons.map(l => ({ start: l.start, end: l.end })),
        meetups: [],
        ...(now?.homework.some(h => !h.done) ? { homeworkDue: now.homework.filter(h => !h.done).sort((a, b) => a.due.getTime() - b.due.getTime())[0]!.due } : {}),
        unwell: world.body ? unwell(bodyAt(world.body, schedule, ask.start)) : false,
    };
    const verdict = judgeAsk(ask, facts);
    counts[ask.outcome]++;
    if (verdict.accept) verdicts.accept++; else verdicts[verdict.because]++;
    const when = ask.askedAt.getDate() === new Date(`${ask.day}T00:00`).getDate() ? `当天 ${time(ask.askedAt)}` : `前一晚 ${time(ask.askedAt)}`;
    console.log(`| ${ask.day.slice(5)} 周${WEEKDAYS[new Date(`${ask.day}T00:00`).getDay()]} | ${ask.name}，${when} | ${describeAsk(ask).replace(/\|/g, '/')} | ${ask.outcome}${ask.fromState ? `（${ask.fromState}）` : ''} | ${verdict.accept ? '答应' : `推掉：${verdict.reason}`} |`);
}
const weeks = Number(daysText) / 7;
console.log(`\n共 ${asks.length} 次约（每周 ${(asks.length / weeks).toFixed(1)} 次）；结果：按时 ${counts.on_time}、迟到 ${counts.late}、改约 ${counts.moved}、取消 ${counts.cancelled}（不是按时的每周 ${((asks.length - counts.on_time) / weeks).toFixed(1)} 次）`);
console.log(`她的答复：答应 ${verdicts.accept}、推掉 ${asks.length - verdicts.accept}（撞课 ${verdicts.class}、作业 ${verdicts.homework}、身上不舒服 ${verdicts.unwell}、跟他约好了 ${verdicts.meetup}）`);
