// 她的日记（ADR 0017 决策 2）：她的每一天（到 02:00）结束后，写一段第一人称日记存进公共记忆库。
// 材料：那天的作息（几点起、在哪、课、空闲活动）、心情和原因、在读的书，加上她那天和名单里每个人的聊天（每人截最后一段）。
// 没聊天的日子也写（用户定），只按作息、心情、书。bot 停过的，下次补最近 DIARY_BACKFILL_DAYS 天；写过的记在 <memory>/diary.json。

import { join } from 'node:path';
import type { Contact } from './config.ts';
import { bookProgressOn, moodAt, type DailyMood, type ReadingBook } from './her-days.ts';
import type { StoredMessage } from './history.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import type { LongTermMemory } from './memory/long-term.ts';
import { knowsPeople } from './people.ts';
import type { OpenAIMessage } from './prompt.ts';
import { classesOn, formatDate, herDay, stateAt, wakeOn, type Schedule } from './schedule.ts';

/** bot 停过时往回补几天 */
export const DIARY_BACKFILL_DAYS = 3;
/** 写日记的温度：比聊天低，少编 */
export const DIARY_TEMPERATURE = 0.8;
/** 每个人的聊天最多放多少字（留最后的） */
export const DIARY_CHAT_CHARS = 1500;

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const hm = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const atTime = (day: Date, time: string) => {
    const [h, m] = time.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
};

export interface DiarySources {
    charName: string;
    schedule: Schedule;
    /** herDays 关着时传空的 */
    moods: readonly DailyMood[];
    books: readonly ReadingBook[];
    /** 模拟器指定的心情（场景的 mood），和聊天时一样 */
    mood?: string;
}

/** 她那一天的材料，一段给模型看的文字；plans：她之前说过那天打算做的事（ADR 0018 决策 2） */
export function diaryMaterial(
    sources: DiarySources, day: Date, chats: readonly { name: string; messages: readonly StoredMessage[] }[], plans: readonly string[] = [],
): string {
    const { schedule } = sources;
    const lines: string[] = [];
    const morning = stateAt(schedule, atTime(day, '10:00'));
    // 不写在哪、教室：日记进公共库，城市、学校这些同学档要保密（ADR 0003），日记不该天天把它们写进去
    lines.push(`日期：${day.getMonth() + 1}月${day.getDate()}日 ${WEEKDAYS[day.getDay()]}${morning.holiday ? `（${morning.holiday.name}放假）` : ''}`);
    lines.push(`几点起：${hm(wakeOn(schedule, day))}`);
    const { lessons } = classesOn(schedule, day);
    lines.push(lessons.length
        // 课名也不写，只写课型（「专业课」「机房课」）：同学档的卡上没有课名，课名看得出专业
        ? `课：${lessons.map(l => `${hm(l.start)}–${hm(l.end)} ${schedule.kinds[l.kind]?.label?.split('，')[0] || '课'}`).join('；')}`
        : '课：没有课');
    // 空闲时在干什么：作息按日期固定选，取上午、下午、晚上各一个时刻
    const free = ['10:30', '15:30', '20:30'].flatMap(time => {
        const activity = stateAt(schedule, atTime(day, time)).activity;
        return activity.kind === 'free' ? [`${time.startsWith('10') ? '上午' : time.startsWith('15') ? '下午' : '晚上'}${activity.text}`] : [];
    });
    if (free.length) lines.push(`空闲时：${free.join('；')}`);
    const mood = moodAt(schedule, sources.moods, atTime(day, '12:00'), sources.mood);
    if (mood) lines.push(`心情：${mood.mood.name}（${mood.reason}）`);
    // 放下的书不写：每篇日记都写一遍，召回时会挤掉别的事
    const reading = sources.books.filter(book => book.progress.state !== 'put_down').map(book => {
        const progress = bookProgressOn(book, day);
        return `《${book.title}》${progress.finished ? '读完了' : `看到第 ${progress.amount} ${progress.unit}`}`;
    });
    if (reading.length) lines.push(`在读：${reading.join('、')}`);
    if (plans.length) lines.push(`之前说过今天打算：${plans.join('；')}`);
    const talked = chats.filter(chat => chat.messages.length);
    if (talked.length === 0) {
        lines.push('今天没和名单里的人聊天。');
    } else {
        lines.push('今天和名单里的人的聊天（「我」是你）：');
        for (const chat of talked) {
            const text = chat.messages.map(m => `${hm(new Date(m.time))} ${m.role === 'assistant' ? '我' : chat.name}：${m.content.replaceAll('\n', '／')}`).join('\n');
            lines.push(`[和${chat.name}]`, [...text].length > DIARY_CHAT_CHARS ? `……${[...text].slice(-DIARY_CHAT_CHARS).join('')}` : text);
        }
    }
    return lines.join('\n');
}

/** 写日记的提示词：只写「怎么写」（ADR 0014：说明里的每句话她都会照做） */
export function diaryMessages(charName: string, day: Date, material: string): OpenAIMessage[] {
    return [
        {
            role: 'system',
            content: [
                `你是${charName}，在读的女大学生，睡前在写今天（${day.getMonth() + 1}月${day.getDate()}日）的日记。`,
                '用第一人称，像真的大学生写日记一样随意，150–300 字，一两段。怎么写：',
                '- 作息里的课和活动是你今天做过的，挑几件写。',
                '- 聊天里你说过自己做了什么、去了哪、吃了什么、看了什么，就是你今天做过的，照写，细节和说过的一致。',
                '- 之前说过今天打算做的事，聊天里没说变卦，就写做了。',
                '- 和谁聊了什么一句带过，写对方的名字。',
                '- 写今天的心情。',
                '- 在读的书最多一句。',
                '- 只写材料里有的事；材料没写到的时候就按平常的日子写，一笔带过。',
                '只输出日记正文，不要标题和日期。',
            ].join('\n'),
        },
        { role: 'user', content: material },
    ];
}

export interface DiaryWriterOptions {
    sources: DiarySources;
    /** 整个名单（陌生人档的聊天不进日记，同公共库） */
    contacts: readonly Contact[];
    history: { load(qq: number): StoredMessage[] };
    memory: LongTermMemory;
    /** 她之前说过那天打算做的事（ADR 0018 决策 2，promises.ts）；不传就没有 */
    plans?: (date: string) => string[];
    /** 写日记的模型调用（温度用低一点的） */
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    /** 状态文件目录（runtime/bot/memory） */
    dir: string;
    log: (message: string) => void;
}

/** 补写还没写的日记：她这一天之前的 DIARY_BACKFILL_DAYS 天，一天一篇，按日期从早到晚；同一时间只跑一次 */
export function diaryWriter(options: DiaryWriterOptions): { catchUp(now: Date): Promise<void> } {
    const path = join(options.dir, 'diary.json');
    let running: Promise<void> | undefined;
    const catchUp = async (now: Date) => {
        const written = readJsonOr<{ written?: Record<string, number> }>(path, {}, options.log).written ?? {};
        const today = herDay(options.sources.schedule, now);
        for (let back = DIARY_BACKFILL_DAYS; back >= 1; back--) {
            const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
            const date = formatDate(day);
            if (written[date] !== undefined) continue;
            const chats = options.contacts.filter(contact => knowsPeople(contact.tier)).map(contact => ({
                name: contact.name,
                messages: options.history.load(contact.qq).filter(m => formatDate(herDay(options.sources.schedule, new Date(m.time))) === date),
            }));
            const material = diaryMaterial(options.sources, day, chats, options.plans?.(date) ?? []);
            let text: string;
            try {
                text = (await options.generate(diaryMessages(options.sources.charName, day, material))).trim();
            } catch (error) {
                options.log(`她的日记：${date} 没写成（${error instanceof Error ? error.message : String(error)}），下次再写`);
                return;
            }
            if (!text) {
                options.log(`她的日记：${date} 模型回了空的，下次再写`);
                return;
            }
            const ok = await options.memory.retainDiary(date, day, text, options.sources.charName);
            if (!ok) return;
            written[date] = [...text].length;
            writeJsonAtomic(path, { written });
            options.log(`她的日记：${date} 已写（${[...text].length} 字，聊过天的 ${chats.filter(c => c.messages.length).length} 人），存进公共记忆`);
        }
    };
    return {
        catchUp: now => {
            running ??= catchUp(now).finally(() => { running = undefined; });
            return running;
        },
    };
}
