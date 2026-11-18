import type { GroupEntry } from './group-chat.ts';
import { formatDate } from '../life/schedule.ts';
import { localDate } from '../local-date.ts';

const LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const QUESTION = /^(?:@你\s+)?我(之前|上次|上周|前几天|昨天)(?:在群里)?(?:说过|提过|说)(?:的)?[，,:： ]*(?:群)?(活动|集合|开会|报名|比赛|彩排|讲座|训练)(?:是)?几点(?:开始|截止|集合)?[？?。]?$/;
const ANNOUNCEMENT = /^(?:群)?(活动|集合|开会|报名|比赛|彩排|讲座|训练)[：: ]*((?:周[一二三四五六日天]|星期[一二三四五六日天])?(?:早上|上午|中午|下午|傍晚|晚上)?(?:[01]?\d|2[0-3])[:：][0-5]\d)(?:开始|截止|集合)?[。！!]?$/;

/** 只查当前群里提问人亲自发出的公开日程文本。 */
export function groupScheduleRecall(
    load: (groupId: number) => readonly GroupEntry[], groupId: number, asker: number, question: string, askedAt: number,
): string | undefined {
    const query = QUESTION.exec(question.trim());
    if (!query || !Number.isFinite(askedAt)) return undefined;
    const date = new Date(askedAt);
    const midnight = (offset: number) => localDate(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime();
    let start = askedAt - LOOKBACK_MS;
    let end = askedAt;
    if (query[1] === '昨天') { start = midnight(-1); end = midnight(0); }
    if (query[1] === '上周') {
        const monday = -((date.getDay() + 6) % 7);
        start = midnight(monday - 7);
        end = midnight(monday);
    }
    if (query[1] === '前几天') { start = midnight(-7); end = midnight(0); }
    for (const message of [...load(groupId)].reverse()) {
        const time = Date.parse(message.time);
        if (message.from !== asker || message.mine || message.history || !Number.isFinite(time) || time < start || time >= end) continue;
        const match = ANNOUNCEMENT.exec(message.content.trim());
        if (!match || match[1] !== query[2]) continue;
        return '[同群旧消息：当前提问人曾于 ' + formatDate(new Date(time))
            + ' 在本群写过「' + match[0] + '」。这是当时的说法，不代表日程现在仍有效。只用它回答这次提问。]';
    }
}
