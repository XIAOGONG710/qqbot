// 闺蜜的约（ADR 0061）的月历预览：她那边的世界在这段日子里真的会遇到的约、结果、她按规则答应不答应，给人看频率「像不像」。
// 用法：node src/sim/asks-preview.ts [起始日 YYYY-MM-DD，默认 2026-11-02] [天数，默认 28] [档位，默认 boyfriend]
// 只读：用卡上的作息、世界、身体（走的就是线上开着 npcAsks 时世界层的那条路，约的饭跟着世界里排好的那顿饭）；不碰线上数据。
// 和他的见面没有（没有聊天），所以「跟他约好了」这一类不出现。

import { resolve } from 'node:path';
import { worldAt, type FriendDate } from '../world.ts';
import { loadCharacterCard } from '../st/card.ts';

const [fromText = '2026-11-02', daysText = '28', tier = 'boyfriend'] = process.argv.slice(2);
const card = loadCharacterCard(resolve(import.meta.dirname, `../../../../characters/linmengyao/st/linmengyao-${tier}.json`));
const schedule = card.schedule!;
const world = { ...card.herWorld!, asks: true };
const [y, m, d] = fromText.split('-').map(Number);
const days = Number(daysText);

// 每天 23:00 的世界（那一刻今天、明天已经说到她这里的约都在），去重
const seen = new Map<string, FriendDate>();
for (let i = -1; i <= days; i++) {
    for (const date of worldAt(world, schedule, new Date(y!, m! - 1, d! + i, 23))?.dates ?? []) seen.set(date.id, date);
}
const first = new Date(y!, m! - 1, d!).getTime();
const last = new Date(y!, m! - 1, d! + days).getTime();
const dates = [...seen.values()].filter(x => x.start.getTime() >= first && x.start.getTime() < last).sort((a, b) => a.start.getTime() - b.start.getTime());

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const time = (t: Date) => `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
const outcomeText = (x: FriendDate) => {
    const why = x.reason ? `：${x.reason}` : '';
    switch (x.outcome) {
        case 'on_time': return '按时';
        case 'late': return `迟到 ${Math.round((x.actualStart!.getTime() - x.start.getTime()) / 60_000)} 分钟${why}`;
        case 'moved': return `改到 ${time(x.actualStart!)}${why}`;
        case 'cancelled': return `取消${why}`;
    }
};

const counts = { on_time: 0, late: 0, moved: 0, cancelled: 0 };
let declined = 0;
console.log(`# 闺蜜的约预览 ${fromText} 起 ${daysText} 天（${tier} 档）\n`);
console.log('| 日期 | 谁说的、什么时候说 | 约的事（原定时刻） | 结果 | 她的答复 |');
console.log('| --- | --- | --- | --- | --- |');
for (const x of dates) {
    counts[x.outcome]++;
    if (x.declined) declined++;
    const sameDay = x.askedAt.getDate() === x.start.getDate();
    const when = `${sameDay ? '当天' : '前一晚'} ${time(x.askedAt)}`;
    console.log(`| ${String(x.start.getMonth() + 1).padStart(2, '0')}-${String(x.start.getDate()).padStart(2, '0')} 周${WEEKDAYS[x.start.getDay()]} | ${x.person.name}，${when} | ${x.what}（${time(x.start)}${x.where ? `，${x.where}` : ''}） | ${outcomeText(x)} | ${x.declined ? `推掉：${x.declined}` : '答应'} |`);
}
const weeks = days / 7;
console.log(`\n共 ${dates.length} 次约（每周 ${(dates.length / weeks).toFixed(1)} 次）；结果：按时 ${counts.on_time}、迟到 ${counts.late}、改约 ${counts.moved}、取消 ${counts.cancelled}（不是按时的每周 ${((dates.length - counts.on_time) / weeks).toFixed(1)} 次）`);
console.log(`她的答复：答应 ${dates.length - declined}、推掉 ${declined}（课、身上不舒服、快交的作业；跟他约好了这里没有）`);
