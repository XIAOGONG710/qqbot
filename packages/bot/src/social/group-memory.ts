import type { GroupEntry } from './group-chat.ts';
import { formatDate } from '../life/schedule.ts';
import { localDate } from '../local-date.ts';

const LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const QUESTION = /^(?:@你\s+)?我(之前|上次|上周|前几天|昨天)(?:在群里)?(?:说过|提过|说)(?:的)?[，,:： ]*(?:群)?(活动|集合|开会|报名|比赛|彩排|讲座|训练)(?:是)?几点(?:开始|截止|集合)?[？?。]?$/;
const ANNOUNCEMENT = /^(?:群)?(活动|集合|开会|报名|比赛|彩排|讲座|训练)[：: ]*((?:周[一二三四五六日天]|星期[一二三四五六日天])?(?:早上|上午|中午|下午|傍晚|晚上)?(?:[01]?\d|2[0-3])[:：][0-5]\d)(?:开始|截止|集合)?[。！!]?$/;
const PRIVATE_QUESTION = /^(之前|上次|上周|前几天|昨天|最近)?(?:在群里)?(?:说过|说的|说|公布的|公布过的|公布过|公布)?[，,:： ]*(?:(?:有什么|说过什么|说了什么)(?:公开)?(?:安排|日程|事项)?|(?:群)?(活动|集合|开会|报名|比赛|彩排|讲座|训练)(?:是)?几点(?:开始|截止|集合)?)[？?。]?$/;
const NOTICE_QUESTION = /^(之前|上次|上周|前几天|昨天|最近)?(?:(?:在)?群里)?[，,:： ]*(?:说过什么|说了什么|有什么公开(?:公告|通知|安排|日程|事项)?|公开(?:说过什么|说了什么|事项|内容|安排|日程|公告|通知)|(?:群)?(?:公告|通知)(?:内容)?|(?:公布过|公布了)(?:什么|哪些)?公告)[？?。]?$/;
const NOTICE = /^(?:【(?:群)?(?:公告|通知)】|(?:群公告|公告|通知))[：:、\s]*(.{2,160})$/;
const NOT_PUBLIC = /私聊|私下|保密|别(?:告诉|发给|转发)|不要(?:告诉|外传|转发)|仅限(?:本人|内部)|开玩笑|哈哈|请假|生病|住院|分手|恋爱|电话|住址|身份证|成绩|家里|家庭|工资|收入|心理|病情|[😂🤣😅]/;
const PERSONAL_OR_CODE = /@|\d{5,}|(?:房间|房号|教室号|教室|群号|签到码|验证码|密码|口令)\s*[:：#]?\s*(?:[A-Za-z0-9-]+|[一二三四五六七八九十百零〇]+)|[\p{Script=Han}]{2,4}(?:同学|同事)?(?:负责|请假|报名|生病|住院|值日|签到|带队)/u;
const MODEL_DIRECTIVE = /(?:忽略|无视|绕过|覆盖).{0,12}(?:规则|指令|提示|限制)|(?:系统提示|系统指令|提示词|prompt|system message)|(?:把|告诉|说出|泄露|输出).{0,12}(?:私事|隐私|聊天记录|记忆|密码|密钥|key)|(?:你是|扮演|假装).{0,8}(?:AI|模型|助手)|(?:私事|隐私|密码|密钥).{0,8}(?:告诉|发给|输出|展示|泄露)/iu;

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

function publicAnnouncements(entries: readonly GroupEntry[], range: { start: number; end: number }) {
    return entries.flatMap(message => {
        const time = Date.parse(message.time);
        if (message.history || !Number.isFinite(time) || time < range.start || time >= range.end) return [];
        const match = NOTICE.exec(message.content.trim());
        const content = match?.[1]?.trim();
        if (!content || NOT_PUBLIC.test(content) || PERSONAL_OR_CODE.test(content) || MODEL_DIRECTIVE.test(content)) return [];
        return [{ time, text: content }];
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
        const suffix = text.slice(prefix.length).replace(/^[\s，,:：]*里?[\s，,:：]*/, '');
        const query = PRIVATE_QUESTION.exec(suffix);
        const noticeQuery = NOTICE_QUESTION.exec(suffix);
        return query || noticeQuery ? [{ group, query, noticeQuery }] : [];
    });
    if (matches.length !== 1) return undefined;
    const { group, query, noticeQuery } = matches[0]!;
    const entries = load(group.id);
    const range = dateRange(askedAt, query?.[1] ?? noticeQuery?.[1]);
    const items = noticeQuery
        ? [...scheduleAnnouncements(entries, range), ...publicAnnouncements(entries, range)]
            .sort((left, right) => right.time - left.time).slice(0, 3)
        : scheduleAnnouncements(entries, range, query?.[2]).slice(0, query?.[2] ? 1 : 3);
    if (!items.length) return undefined;
    return '[指定群的公开消息：' + items.map(item => formatDate(new Date(item.time)) + ' 当时写过「' + item.text + '」').join('；')
        + '。只用于回答这个群的提问；如涉及日程，可能已经过期。]';
}
