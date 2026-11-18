import type { GroupEntry } from './group-chat.ts';
import { formatDate } from '../life/schedule.ts';
import { localDate } from '../local-date.ts';

const LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const QUESTION = /^(?:@你\s+)?我(之前|上次|上周|前几天|昨天)(?:在群里)?(?:说过|提过|说)(?:的)?[，,:： ]*(?:群)?(活动|集合|开会|报名|比赛|彩排|讲座|训练)(?:是)?几点(?:开始|截止|集合)?[？?。]?$/;
const ANNOUNCEMENT = /^(?:群)?(活动|集合|开会|报名|比赛|彩排|讲座|训练)[：: ]*((?:周[一二三四五六日天]|星期[一二三四五六日天])?(?:早上|上午|中午|下午|傍晚|晚上)?(?:[01]?\d|2[0-3])[:：][0-5]\d)(?:开始|截止|集合)?[。！!]?$/;
const PRIVATE_QUESTION = /^(之前|上次|上周|前几天|昨天|最近)?(?:在群里)?(?:说过|说的|说|公布的|公布过的|公布过|公布)?[，,:： ]*(?:(?:有什么|说过什么|说了什么)(?:公开)?(?:安排|日程|事项)?|(?:群)?(活动|集合|开会|报名|比赛|彩排|讲座|训练)(?:是)?几点(?:开始|截止|集合)?)[？?。]?$/;

function dateRange(askedAt: number, period: string | undefined): { start: number; end: number } {
    const date = new Date(askedAt);
    const midnight = (offset: number) => localDate(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime();
    if (period === '昨天') return { start: midnight(-1), end: midnight(0) };
    if (period === '上周') {
        const monday = -((date.getDay() + 6) % 7);
        return { start: midnight(monday - 7), end: midnight(monday) };
    }
    if (period === '前几天') return { start: midnight(-7), end: midnight(0) };
    return { start: askedAt - LOOKBACK_MS, end: askedAt };
}

function scheduleAnnouncements(entries: readonly GroupEntry[], range: { start: number; end: number }, topic?: string, asker?: number) {
    return entries.flatMap(message => {
        const time = Date.parse(message.time);
        if ((asker !== undefined && message.from !== asker) || message.mine || message.history || !Number.isFinite(time) || time < range.start || time >= range.end) return [];
        const match = ANNOUNCEMENT.exec(message.content.trim());
        return match && (!topic || match[1] === topic) ? [{ time, text: match[0] }] : [];
    }).sort((left, right) => right.time - left.time);
}

/** 只查当前群里提问人亲自发出的公开日程文本。 */
export function groupScheduleRecall(
    load: (groupId: number) => readonly GroupEntry[], groupId: number, asker: number, question: string, askedAt: number,
): string | undefined {
    const query = QUESTION.exec(question.trim());
    if (!query || !Number.isFinite(askedAt)) return undefined;
    const item = scheduleAnnouncements(load(groupId), dateRange(askedAt, query[1]), query[2], asker)[0];
    if (item) return '[同群旧消息：当前提问人曾于 ' + formatDate(new Date(item.time))
        + ' 在本群写过「' + item.text + '」。这是当时的说法，不代表日程现在仍有效。只用它回答这次提问。]';
}

/** 设备所有者明确问一个已配置群时，只抽取该群的公开日程。 */
export function privateGroupScheduleRecall(
    load: (groupId: number) => readonly GroupEntry[], groups: readonly { id: number; name: string }[],
    question: string, askedAt: number,
): string | undefined {
    if (!Number.isFinite(askedAt)) return undefined;
    const text = question.trim();
    const matches = groups.flatMap(group => {
        const name = group.name.trim();
        if (!name) return [];
        const prefix = ['「' + name + '」', '“' + name + '”', name].find(value => text.startsWith(value));
        if (!prefix) return [];
        const query = PRIVATE_QUESTION.exec(text.slice(prefix.length).replace(/^[\s，,:：]*里?[\s，,:：]*/, ''));
        return query ? [{ group, query }] : [];
    });
    if (matches.length !== 1) return undefined;
    const { group, query } = matches[0]!;
    const items = scheduleAnnouncements(load(group.id), dateRange(askedAt, query[1]), query[2]).slice(0, query[2] ? 1 : 3);
    if (!items.length) return undefined;
    return '[指定群的公开日程：' + items.map(item => formatDate(new Date(item.time)) + ' 当时写过「' + item.text + '」').join('；')
        + '。只用于回答这个群的提问，旧日程可能已经过期。]';
}
