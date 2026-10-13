// 她的日记（ADR 0017 决策 2）：她的每一天（到 02:00）结束后，写一段第一人称日记存进公共记忆库。
// 材料：那天的作息（几点起、在哪、课、空闲活动）、心情和原因、在读的书，加上她那天和名单里每个人的聊天（每人截最后一段）。
// 没聊天的日子也写（用户定），只按作息、心情、书。bot 停过的，下次补最近 DIARY_BACKFILL_DAYS 天；写过的记在 <memory>/diary.json。
// 周记、阶段总结（ADR 0018 决策 3）：她的周一到了，用上周的日记写一段「这周」；作息里的假期结束后，用那几天的日记写一段总结。
// 都存进公共库（week:<周一的日期>、phase:<假期名>:<最后一天>）。日记原文本地也存一份（写周记要用），以前的从 Hindsight 读回来。
// 停过的补最近 WEEK_BACKFILL 周、最近 PHASE_BACKFILL_DAYS 天里结束的假期；一篇日记都没有的不写。

import { join } from 'node:path';
import type { Contact } from './config.ts';
import { bookProgressOn, moodAt, readingActivities, type DailyMood, type ReadingBook } from './her-days.ts';
import type { StoredMessage } from './history.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import type { LongTermMemory, WrittenRetention } from './memory/long-term.ts';
import { knowsPeople } from './people.ts';
import type { OpenAIMessage } from './prompt.ts';
import { classesOn, formatDate, herDay, stateAt, wakeOn, type Schedule } from './schedule.ts';
import { diaryWorld, worldAt, worldErrands, type World, type WorldNow } from './world.ts';
import { bodyAt, diaryBody } from './body.ts';
import { dayPlan, describeSlot } from './day-plan.ts';

/** bot 停过时往回补几天 */
export const DIARY_BACKFILL_DAYS = 3;
/** 写日记的温度：比聊天低，少编 */
export const DIARY_TEMPERATURE = 0.8;
/** 每个人的聊天最多放多少字（留最后的） */
export const DIARY_CHAT_CHARS = 1500;
/** 周记往回补几周 */
export const WEEK_BACKFILL = 2;
/** 阶段总结：结束了几天以内的假期还补 */
export const PHASE_BACKFILL_DAYS = 14;
/** 日记原文本地留几天（长的假期也够写总结） */
const KEEP_TEXT_DAYS = 120;

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
    /** 她那边、她的身体（ADR 0026）：用同学档的卡（日记进公共库，同学档也会想起来），herDays 关着时不传 */
    world?: World;
    /** 和 world 同一档（同学档）的作息：她那边和空闲时按它算——没有课名，拍照修图换成 cover（ADR 0034）。不传就用 schedule */
    worldSchedule?: Schedule;
    /** W3：让日记看到聊天里已经发生、写回全局世界的动作。 */
    resolveWorld?: (world: World, schedule: Schedule, now: Date) => WorldNow | undefined;
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
    // 她那边今天发生的事、身上舒不舒服（ADR 0026）：一天结束时算（她的一天到 02:00，23:30 已经都发生了）
    const shown = sources.worldSchedule ?? schedule;
    const around = sources.world
        ? sources.resolveWorld?.(sources.world, shown, atTime(day, '23:30')) ?? worldAt(sources.world, shown, atTime(day, '23:30'))
        : undefined;
    const moodBody = sources.world?.body ? bodyAt(sources.world.body, shown, atTime(day, '15:00')) : undefined;
    // 空闲时在干什么（ADR 0034）：和聊天时的状态行同一份打算——同样并上在读的书，下雨、不舒服、作业压着时改了的照实写
    // （以前这里不并书，日记写「晚上在追剧」，聊天里那晚说的是在看书）
    // 按同学档的作息（worldSchedule）：没有课名、修片和刷摄影区是 cover；没传时（旧调用）作业也去掉课名
    const homework = around?.homework.map(h => (sources.worldSchedule ? h : { ...h, course: '' }));
    const free = dayPlan(shown, sources.world?.plans, day, { rain: around?.weather?.rain, ...(around?.weather?.rainHours ? { rainHours: around.weather.rainHours } : {}), body: moodBody, homework, errands: around ? worldErrands(around) : [] }, readingActivities(sources.books))
        .map(describeSlot);
    if (free.length) lines.push(`空闲时：${free.join('；')}`);
    const mood = moodAt(schedule, sources.moods, atTime(day, '12:00'), sources.mood, { body: moodBody, world: around });
    if (mood) lines.push(`心情：${mood.mood.name}（${mood.reason}）`);
    const happened = around ? diaryWorld(around) : [];
    if (happened.length) lines.push(`你那边今天：${happened.join('；')}`);
    const body = moodBody ? diaryBody(moodBody) : undefined;
    if (body) lines.push(`身体：${body}`);
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
                '- 「你那边今天」是今天真发生的事，最多挑一件，一句话带过，和材料一致；聊天里说过的事比它要紧，先写。身体不舒服的写一句。',
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

const md = (day: Date) => `${day.getMonth() + 1}月${day.getDate()}日`;

/**
 * 周记、阶段总结的提示词（ADR 0018 决策 3）：period 是「这周（10月5日–10月11日）」「这个国庆节（10月1日–10月7日）」，
 * diaries 是那几天的日记（日期 + 正文）
 */
export function summaryMessages(charName: string, period: string, diaries: readonly { date: Date; text: string }[]): OpenAIMessage[] {
    return [
        {
            role: 'system',
            content: [
                `你是${charName}，在读的女大学生，翻着自己${period}的日记，写一段小结。`,
                '用第一人称，像大学生随手写的，150–250 字，一段。怎么写：',
                '- 只写日记里有的事，挑印象深的几件按时间串起来，每天的流水不用都写。',
                '- 和谁聊了什么一句带过，写对方的名字。',
                '- 写这段时间整体的心情。',
                '- 有几天没写日记的，不用补。',
                '只输出正文，不要标题和日期。',
            ].join('\n'),
        },
        { role: 'user', content: diaries.map(d => `[${md(d.date)} ${WEEKDAYS[d.date.getDay()]}]\n${d.text}`).join('\n\n') },
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

/** diary.json：写过的日记（日期 → 字数）、日记原文、写过的周记和阶段总结（id → 字数，0 是没有日记、不写） */
interface DiaryState {
    written: Record<string, number>;
    texts: Record<string, string>;
    weeks: Record<string, number>;
    phases: Record<string, number>;
}

/**
 * 补写还没写的日记：她这一天之前的 DIARY_BACKFILL_DAYS 天，一天一篇，按日期从早到晚；之后补周记、阶段总结（ADR 0018）。同一时间只跑一次
 */
export function diaryWriter(options: DiaryWriterOptions): { catchUp(now: Date): Promise<void> } {
    const path = join(options.dir, 'diary.json');
    let running: Promise<void> | undefined;
    const save = (state: DiaryState, today: Date) => {
        const keepFrom = formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - KEEP_TEXT_DAYS));
        for (const date of Object.keys(state.texts)) if (date < keepFrom) delete state.texts[date];
        writeJsonAtomic(path, state);
    };
    const catchUp = async (now: Date) => {
        const stored = readJsonOr<Partial<DiaryState>>(path, {}, options.log);
        const state: DiaryState = { written: stored.written ?? {}, texts: stored.texts ?? {}, weeks: stored.weeks ?? {}, phases: stored.phases ?? {} };
        const { written } = state;
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
            const retention = await options.memory.retainDiary(date, day, text, options.sources.charName);
            if (!retention) return;
            written[date] = [...text].length;
            state.texts[date] = text;
            save(state, today);
            options.log(`她的日记：${date} 已写（${[...text].length} 字，聊过天的 ${chats.filter(c => c.messages.length).length} 人），${retention === 'local-only' ? '含高敏内容，只保留本地' : '存进公共记忆'}`);
        }
        if (!(await catchUpWeeks(state, today))) return;
        await catchUpPhases(state, today);
    };

    /** 那几天的日记原文：本地有就用本地的，写过但本地没有的（ADR 0018 之前写的）从 Hindsight 读回来；读不到返回 undefined（下次再写） */
    const diariesOn = async (days: readonly Date[], state: DiaryState): Promise<{ date: Date; text: string }[] | undefined> => {
        const found: { date: Date; text: string }[] = [];
        for (const day of days) {
            const date = formatDate(day);
            if (state.written[date] === undefined) continue;
            let text = state.texts[date];
            if (text === undefined) {
                try {
                    text = await options.memory.readDiary(date);
                } catch (error) {
                    options.log(`她的日记：从公共记忆读 ${date} 的日记失败，周记下次再写：${error instanceof Error ? error.message : String(error)}`);
                    return undefined;
                }
                if (text !== undefined) state.texts[date] = text;
            }
            if (text) found.push({ date: day, text });
        }
        return found;
    };

    /** 写一段周记或阶段总结；成功返回字数和存放位置，失败记日志返回 undefined */
    const summarize = async (label: string, period: string, diaries: { date: Date; text: string }[], retain: (text: string) => Promise<WrittenRetention>) => {
        let text: string;
        try {
            text = (await options.generate(summaryMessages(options.sources.charName, period, diaries))).trim();
        } catch (error) {
            options.log(`她的${label}没写成（${error instanceof Error ? error.message : String(error)}），下次再写`);
            return undefined;
        }
        if (!text) {
            options.log(`她的${label}：模型回了空的，下次再写`);
            return undefined;
        }
        const retention = await retain(text);
        return retention ? { length: [...text].length, retention } : undefined;
    };

    /** 周记：她这一周之前的 WEEK_BACKFILL 周（周一到周日）；全都处理完返回 true */
    const catchUpWeeks = async (state: DiaryState, today: Date): Promise<boolean> => {
        const thisMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
        for (let back = WEEK_BACKFILL; back >= 1; back--) {
            const monday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7 * back);
            const id = formatDate(monday);
            if (state.weeks[id] !== undefined) continue;
            const days = Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
            const diaries = await diariesOn(days, state);
            if (!diaries) return false;
            if (diaries.length) {
                const period = `这周（${md(days[0]!)}–${md(days[6]!)}）`;
                const summary = await summarize(`周记（${id} 那周）`, period, diaries,
                    text => options.memory.retainSummary(`week:${id}`, days[6]!, `${options.sources.charName}的周记（${md(days[0]!)}–${md(days[6]!)}）`, text, options.sources.charName, 'week'));
                if (!summary) return false;
                state.weeks[id] = summary.length;
                options.log(`她的周记：${id} 那周已写（${summary.length} 字，用了 ${diaries.length} 篇日记），${summary.retention === 'local-only' ? '含高敏内容，只保留本地' : '存进公共记忆'}`);
            } else {
                state.weeks[id] = 0;
            }
            save(state, today);
        }
        return true;
    };

    /** 阶段总结：作息里结束了 PHASE_BACKFILL_DAYS 天以内的假期 */
    const catchUpPhases = async (state: DiaryState, today: Date): Promise<void> => {
        const todayText = formatDate(today);
        const recent = formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - PHASE_BACKFILL_DAYS));
        for (const holiday of options.sources.schedule.holidays.filter(h => h.end < todayText && h.end >= recent)) {
            const id = `${holiday.name}:${holiday.end}`;
            if (state.phases[id] !== undefined) continue;
            const [start, end] = [holiday.start, holiday.end].map(date => { const [y, m, d] = date.split('-').map(Number); return new Date(y!, m! - 1, d); });
            const days: Date[] = [];
            for (let day = start!; day <= end!; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) days.push(day);
            const diaries = await diariesOn(days, state);
            if (!diaries) return;
            if (diaries.length) {
                const span = `${md(start!)}–${md(end!)}`;
                const summary = await summarize(`${holiday.name}总结`, `这个${holiday.name}（${span}）`, diaries,
                    text => options.memory.retainSummary(`phase:${id}`, end!, `${options.sources.charName}的${holiday.name}总结（${span}）`, text, options.sources.charName, 'phase'));
                if (!summary) return;
                state.phases[id] = summary.length;
                options.log(`她的${holiday.name}总结已写（${summary.length} 字，用了 ${diaries.length} 篇日记），${summary.retention === 'local-only' ? '含高敏内容，只保留本地' : '存进公共记忆'}`);
            } else {
                state.phases[id] = 0;
            }
            save(state, today);
        }
    };
    return {
        catchUp: now => {
            running ??= catchUp(now).finally(() => { running = undefined; });
            return running;
        },
    };
}
