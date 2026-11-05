// 她的日记（ADR 0017 决策 2）：她的每一天（到 02:00）结束后，写一段第一人称日记存进公共记忆库。
// 材料：那天的作息（几点起、在哪、课、空闲活动）、心情和原因、在读的书，加上她那天和名单里每个人的聊天（每人截最后一段）。
// 没聊天的日子也写（用户定），只按作息、心情、书。bot 停过的，下次补最近 DIARY_BACKFILL_DAYS 天；写过的记在 <memory>/diary.json。
// 周记、阶段总结（ADR 0018 决策 3）：她的周一到了，用上周的日记写一段「这周」；作息里的假期结束后，用那几天的日记写一段总结。
// 都存进公共库（week:<周一的日期>、phase:<假期名>:<最后一天>）。日记原文本地也存一份（写周记要用），以前的从 Hindsight 读回来。
// 停过的补最近 WEEK_BACKFILL 周、最近 PHASE_BACKFILL_DAYS 天里结束的假期；一篇日记都没有的不写。

import { localDate } from '../local-date.ts';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { Contact } from '../platform/config.ts';
import { bookProgressOn, moodAt, readingActivities, type DailyMood, type ReadingBook } from './her-days.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { WrittenSourceIntent } from '../memory/written-retain.ts';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { calendarDate, stateObject, stateTimestamp } from '../memory/state-schema.ts';
import { civilDayNumber } from '../memory/civil-time.ts';
import { TransientStateError } from '../memory/transient-io.ts';
import type { LongTermMemory } from '.././memory/long-term.ts';
import { knowsPeople } from './people.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import { classesOn, formatDate, herDay, stateAt, wakeOn, type Schedule } from './schedule.ts';
import { diaryWorld, worldAt, worldErrands, type World, type WorldNow } from '.././world/world.ts';
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
const CIVIL_DAY_MS = 86_400_000;
const civilText = (day: number): string | undefined => {
    if (!Number.isSafeInteger(day) || !Number.isFinite(day * CIVIL_DAY_MS)) return undefined;
    const date = new Date(day * CIVIL_DAY_MS);
    if (!Number.isFinite(date.getTime())) return undefined;
    const text = date.toISOString().slice(0, 10);
    return calendarDate(text) ? text : undefined;
};
/** A skipped local day has no Date representation; never borrow the following day's identity. */
const localCivilDay = (day: number): Date | undefined => {
    const text = civilText(day);
    if (!text) return undefined;
    const utc = new Date(day * CIVIL_DAY_MS);
    const local = localDate(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    return formatDate(local) === text && civilDayNumber(local) === day ? local : undefined;
};
const civilMonthDay = (day: number): string => {
    const text = civilText(day)!;
    return `${Number(text.slice(5, 7))}月${Number(text.slice(8, 10))}日`;
};
const hm = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const atTime = (day: Date, time: string) => {
    const [h, m] = time.split(':').map(Number);
    const target = formatDate(day), at = localDate(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
    if (formatDate(at) === target) return at;
    // An evening DST gap can end this civil day before 23:30. Use its last real
    // instant for the end-of-day snapshot, instead of reading the following day.
    const end = new Date(localDate(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() - 1);
    if (formatDate(end) !== target) throw new Error('日记日期无法安全表示');
    return end;
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

function chatTail(chat: { name: string; messages: readonly StoredMessage[] }): { text: string; used: { message: StoredMessage; fragment: string }[] } {
    let left = DIARY_CHAT_CHARS, clipped = false;
    const parts: string[] = [], used: { message: StoredMessage; fragment: string }[] = [];
    for (let i = chat.messages.length - 1; i >= 0; i--) {
        if (parts.length) { if (!left) { clipped = true; break; } left--; }
        const message = chat.messages[i]!, text = `${hm(new Date(message.time))} ${message.role === 'assistant' ? '我' : chat.name}：${message.content.replaceAll('\n', '／')}`;
        let start = text.length, count = 0;
        while (start > 0 && count < left) {
            start--; const unit = text.charCodeAt(start);
            if (unit >= 0xdc00 && unit <= 0xdfff && start > 0 && text.charCodeAt(start - 1) >= 0xd800 && text.charCodeAt(start - 1) <= 0xdbff) start--;
            count++;
        }
        const fragment = text.slice(start); parts.unshift(fragment); if (fragment) used.unshift({ message, fragment }); left -= count;
        if (start > 0) { clipped = true; break; }
    }
    return { text: `${clipped ? '……' : ''}${parts.join('\n')}`, used };
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
            lines.push(`[和${chat.name}]`, chatTail(chat).text);
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
    /** Production connects TierRecord; absent custom adapters explicitly remain unknown. */
    sourceSince?: (contact: Contact) => string | undefined;
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
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bodyDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const operationId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export interface DiarySourceManifest {
    version: 1;
    kind: 'diary' | 'summary';
    contextHash: string;
    materialHash: string;
    promptHash: string;
    contributors?: { qq: number; tier: string; sinceKnown: boolean; since?: string; messages: { identityHash: string; fragmentHash: string }[] }[];
    dependencies?: { documentId: string; bodyHash: string; sourceHash?: string; legacy: boolean }[];
}
export interface DiaryPrepared {
    version: 1; kind: 'diary' | 'week' | 'phase'; documentId: string; date: string; lastDay: string; title: string; charName: string;
    body: string; bodyHash: string; identityHash: string; materialHash: string; promptHash: string; sourceHash: string;
    manifest: DiarySourceManifest; operationId: string; phase: 'prepared' | 'dispatched';
}
interface DiaryConfirmed { operationId: string; bodyHash: string; sourceHash: string; manifest: DiarySourceManifest; sourceVerified: boolean }
interface DiaryState extends Record<string, unknown> {
    version: 1;
    written: Record<string, number>;
    texts: Record<string, string>;
    weeks: Record<string, number>;
    phases: Record<string, number>;
    prepared: Record<string, DiaryPrepared>;
    confirmed: Record<string, DiaryConfirmed>;
}
const identity = (p: Pick<DiaryPrepared, 'kind' | 'documentId' | 'date' | 'lastDay' | 'title' | 'charName'>) => fingerprint({ kind: p.kind, documentId: p.documentId, date: p.date, lastDay: p.lastDay, title: p.title, charName: p.charName });
function validManifest(value: unknown): value is DiarySourceManifest {
    return stateObject(value) && value.version === 1 && (value.kind === 'diary' || value.kind === 'summary')
        && digest(value.contextHash) && digest(value.materialHash) && digest(value.promptHash)
        && (value.contributors === undefined || Array.isArray(value.contributors) && value.contributors.every(item => stateObject(item)
            && Number.isSafeInteger(item.qq) && Number(item.qq) > 0 && typeof item.tier === 'string' && typeof item.sinceKnown === 'boolean'
            && (item.since === undefined || stateTimestamp(item.since)) && Array.isArray(item.messages)
            && item.messages.every(row => stateObject(row) && digest(row.identityHash) && digest(row.fragmentHash))))
        && (value.dependencies === undefined || Array.isArray(value.dependencies) && value.dependencies.every(item => stateObject(item)
            && typeof item.documentId === 'string' && item.documentId.startsWith('diary:') && calendarDate(item.documentId.slice(6))
            && digest(item.bodyHash) && typeof item.legacy === 'boolean' && (item.sourceHash === undefined || digest(item.sourceHash))));
}
/**
 * lastDay 是内部时刻（toISOString 写出），不是日历键：低年份的一天在 UTC 可能落到公元前（如 0000-01-01 上海地方时 → -000001-12-31T15:54:17Z），
 * 共用的 stateTimestamp 只认四位年份，会让写出的状态自己读不回。这里只要求是能原样往返的规范时刻。
 */
const canonicalInstant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function validPrepared(value: unknown, id: string): value is DiaryPrepared {
    if (!stateObject(value) || value.version !== 1 || typeof value.kind !== 'string' || !['diary', 'week', 'phase'].includes(value.kind) || value.documentId !== id
        || typeof value.date !== 'string' || !calendarDate(value.date) || !canonicalInstant(value.lastDay) || typeof value.title !== 'string' || typeof value.charName !== 'string'
        || typeof value.body !== 'string' || !value.body.trim() || bodyDigest(value.body) !== value.bodyHash
        || !digest(value.identityHash) || !digest(value.materialHash) || !digest(value.promptHash) || !digest(value.sourceHash)
        || !operationId(value.operationId)
        || typeof value.phase !== 'string' || !['prepared', 'dispatched'].includes(value.phase) || !validManifest(value.manifest)) return false;
    const p = value as unknown as DiaryPrepared;
    return identity(p) === p.identityHash && fingerprint(p.manifest) === p.sourceHash && p.manifest.materialHash === p.materialHash && p.manifest.promptHash === p.promptHash
        && (p.kind === 'diary' ? id === `diary:${p.date}` : p.kind === 'week' ? id === `week:${p.date}` : id.startsWith('phase:') && id.endsWith(`:${p.date}`));
}

/** 旧文件可缺少新增字段，但已经提供的进度不能把数组 / null 当成日期表。 */
function validDiaryState(value: unknown): value is Partial<DiaryState> {
    if (!stateObject(value) || value.version !== undefined && value.version !== 1) return false;
    const count = (item: unknown) => Number.isSafeInteger(item) && Number(item) >= 0;
    const map = (field: string, key: (key: string) => boolean, valid: (item: unknown) => boolean) => value[field] === undefined
        || (stateObject(value[field]) && Object.entries(value[field]).every(([name, item]) => key(name) && valid(item)));
    return map('written', calendarDate, count)
        && map('texts', calendarDate, item => typeof item === 'string')
        && map('weeks', calendarDate, count)
        && map('phases', key => {
            const separator = key.lastIndexOf(':');
            return separator > 0 && calendarDate(key.slice(separator + 1));
        }, count)
        && (value.prepared === undefined || stateObject(value.prepared) && Object.entries(value.prepared).every(([id, entry]) => validPrepared(entry, id)))
        && (value.confirmed === undefined || stateObject(value.confirmed) && Object.values(value.confirmed).every(entry => stateObject(entry)
            && operationId(entry.operationId) && digest(entry.bodyHash) && digest(entry.sourceHash) && typeof entry.sourceVerified === 'boolean'
            && validManifest(entry.manifest) && fingerprint(entry.manifest) === entry.sourceHash));
}

/**
 * 补写还没写的日记：她这一天之前的 DIARY_BACKFILL_DAYS 天，一天一篇，按日期从早到晚；之后补周记、阶段总结（ADR 0018）。同一时间只跑一次
 */
export function diaryWriter(options: DiaryWriterOptions): { catchUp(now: Date): Promise<void>; verifySources(now: Date, intents?: readonly WrittenSourceIntent[]): boolean; stop(): Promise<void> | undefined } {
    const path = join(options.dir, 'diary.json');
    let running: Promise<void> | undefined;
    let stopped = false;
    let viewToday: Date | undefined;
    let drain: Promise<void> | undefined;
    const STOPPED = Symbol('diary stopped');
    const cancelReads = new Set<() => void>();
    // 本地texts也是派生资料，不能靠readDiary的远端守卫代替本轮输入检查。
    // 旧注入接口可无此方法；真实LongTermMemory始终提供，未知/坏状态按不可用处理。
    const derivedReady = () => {
        if (stopped) return false;
        try {
            const check = options.memory.derivedAvailable;
            return check === undefined ? !stopped : typeof check === 'function' && check.call(options.memory) === true && !stopped;
        } catch { return false; }
    };
    // 生成和读取可取消等待；迟到结果不再进入调用方。已经派发的 retain 必须等确认并保存完成记录。
    const read = <T>(work: () => Promise<T>): Promise<T> => {
        if (stopped) return Promise.reject(STOPPED);
        return new Promise((resolve, reject) => {
            const cancel = () => { cancelReads.delete(cancel); reject(STOPPED); };
            cancelReads.add(cancel);
            let pending: Promise<T>;
            try { pending = work(); } catch (error) { cancelReads.delete(cancel); reject(error); return; }
            void pending.then(value => { cancelReads.delete(cancel); if (stopped) reject(STOPPED); else resolve(value); },
                error => { cancelReads.delete(cancel); reject(error); });
        });
    };
    const save = (state: DiaryState, today: Date) => {
        const keepFrom = civilText(civilDayNumber(today)! - KEEP_TEXT_DAYS) ?? '0000-01-01';
        for (const date of Object.keys(state.texts)) if (date < keepFrom) delete state.texts[date];
        try { writeJsonAtomic(path, state); }
        catch (error) {
            try { if (isDeepStrictEqual(readJsonOr(path, undefined, undefined, { invalid: 'throw' }), state)) return; } catch { /* Original write failure remains authoritative. */ }
            throw error;
        }
    };
    const loadState = (): DiaryState => {
        try {
            const stored = readJsonOr<Partial<DiaryState>>(path, {}, options.log, { validate: validDiaryState, invalid: 'throw', label: '日记状态' });
            return { ...stored, version: 1, written: stored.written ?? {}, texts: stored.texts ?? {}, weeks: stored.weeks ?? {}, phases: stored.phases ?? {}, prepared: stored.prepared ?? {}, confirmed: stored.confirmed ?? {} };
        } catch (error) {
            if (error instanceof TransientStateError) throw error;
            throw new Error('日记状态无效或读取失败；原文件未重建，请修复后重试');
        }
    };
    interface Input { material: string; messages: OpenAIMessage[]; manifest: DiarySourceManifest }
    interface SourceView { chats: Map<number, Map<string, StoredMessage[]>>; since: Map<number, string | undefined> }
    const dayInput = (day: Date, view?: SourceView): Input => {
        const date = formatDate(day), people = options.contacts.filter(contact => knowsPeople(contact.tier));
        const chats = people.map(contact => ({ name: contact.name, messages: view ? view.chats.get(contact.qq)?.get(date) ?? [] : options.history.load(contact.qq)
            .filter(message => formatDate(herDay(options.sources.schedule, new Date(message.time))) === date) }));
        const plans = options.plans?.(date) ?? [], material = diaryMaterial(options.sources, day, chats, plans), messages = diaryMessages(options.sources.charName, day, material);
        const manifest: DiarySourceManifest = { version: 1, kind: 'diary', contextHash: fingerprint({ sources: options.sources, date, plans }), materialHash: bodyDigest(material), promptHash: fingerprint(messages),
            contributors: people.map((contact, i) => {
                const since = view ? view.since.get(contact.qq) : options.sourceSince?.(contact);
                if (since !== undefined && !stateTimestamp(since)) throw new Error('日记来源权限时间无效');
                return { qq: contact.qq, tier: contact.tier, sinceKnown: options.sourceSince !== undefined, ...(since === undefined ? {} : { since }),
                    messages: chatTail(chats[i]!).used.map(({ message, fragment }) => ({ identityHash: fingerprint({ role: message.role, time: message.time, messageId: message.messageId, messageSeq: message.messageSeq, sourceTime: message.sourceTime, recalled: message.recalled === true }), fragmentHash: bodyDigest(fragment) })) };
            }) };
        return { material, messages, manifest };
    };
    const noteChanged = (documentId: string) => {
        const method = (options.memory as LongTermMemory & { noteWrittenSourceChanged?: (id: string) => void }).noteWrittenSourceChanged;
        if (method) method.call(options.memory, documentId);
    };
    let verifying = false;
    const verifySources = (now: Date, intents: readonly WrittenSourceIntent[] = []): boolean => {
        if (stopped) return false;
        if (verifying) throw new Error('日记来源复核未确认；暂不读取派生资料');
        verifying = true;
        try {
            const today = herDay(options.sources.schedule, now);
            if (!Number.isFinite(now.getTime()) || civilDayNumber(today) === undefined || !calendarDate(formatDate(today))) throw new Error('invalid clock');
            const state = loadState(), view: SourceView = { chats: new Map(), since: new Map() };
            const diaries = Object.entries(state.confirmed).filter(([id, receipt]) => id.startsWith('diary:') && receipt.sourceVerified);
            if (!Array.isArray(intents) || intents.some(intent => !stateObject(intent) || typeof intent.documentId !== 'string'
                || !operationId(intent.operationId) || !digest(intent.requestHash) || typeof intent.phase !== 'string' || !['prepared', 'dispatched', 'completed'].includes(intent.phase))
                || new Set(intents.map(intent => intent.documentId)).size !== intents.length || new Set(intents.map(intent => intent.operationId)).size !== intents.length) throw new Error('invalid written source intents');
            const requiredPrepared: DiaryPrepared[] = intents.flatMap(intent => {
                const prepared = state.prepared[intent.documentId];
                return prepared && prepared.operationId === intent.operationId ? [prepared] : [];
            });
            // herDay maps an instant to its own local civil day or the previous
            // one. An instant before the earliest required local day cannot
            // contribute, but its timestamp must still pass schema validation.
            let earliestSourceInstant = Infinity;
            const sourceDates = [...diaries.map(([id]) => id.slice('diary:'.length)), ...requiredPrepared.filter(prepared => prepared.kind === 'diary').map(prepared => prepared.date)];
            for (const date of sourceDates) {
                const number = civilDayNumber(date), day = number === undefined ? undefined : localCivilDay(number);
                if (!day) { earliestSourceInstant = -Infinity; break; }
                earliestSourceInstant = Math.min(earliestSourceInstant, day.getTime());
            }
            if (diaries.length || requiredPrepared.some(prepared => prepared.kind === 'diary')) for (const contact of options.contacts.filter(contact => knowsPeople(contact.tier))) {
                const days = new Map<string, StoredMessage[]>(), since = options.sourceSince?.(contact);
                if (since !== undefined && !stateTimestamp(since)) throw new Error('invalid source permission');
                for (const message of options.history.load(contact.qq)) {
                    if (!stateTimestamp(message.time)) throw new Error('invalid source time');
                    if (Date.parse(message.time) < earliestSourceInstant) continue;
                    const date = formatDate(herDay(options.sources.schedule, new Date(message.time)));
                    const rows = days.get(date) ?? []; rows.push(message); days.set(date, rows);
                }
                view.chats.set(contact.qq, days); view.since.set(contact.qq, since);
            }
            let changed = false;
            const invalidate = (id: string, receipt: DiaryConfirmed) => {
                // The durable bank barrier must precede publishing an invalid receipt.
                noteChanged(id); receipt.sourceVerified = false; changed = true;
            };
            for (const [id, receipt] of diaries) {
                const date = id.slice('diary:'.length), dayNumber = civilDayNumber(date), day = dayNumber === undefined ? undefined : localCivilDay(dayNumber);
                if (!day) throw new Error('unknown source date');
                if (receipt.manifest.kind !== 'diary' || state.texts[date] !== undefined && bodyDigest(state.texts[date]!) !== receipt.bodyHash
                    || fingerprint(dayInput(day, view).manifest) !== receipt.sourceHash) invalidate(id, receipt);
            }
            for (const [id, receipt] of Object.entries(state.confirmed)) {
                if (!receipt.sourceVerified || receipt.manifest.kind !== 'summary') continue;
                if (receipt.manifest.dependencies?.some(dependency => {
                    const text = state.texts[dependency.documentId.slice('diary:'.length)];
                    if (text !== undefined && bodyDigest(text) !== dependency.bodyHash) return true;
                    const source = state.confirmed[dependency.documentId];
                    if (source === undefined) return !dependency.legacy || dependency.sourceHash !== undefined;
                    return !source.sourceVerified || source.bodyHash !== dependency.bodyHash
                        || dependency.sourceHash !== undefined && source.sourceHash !== dependency.sourceHash;
                })) invalidate(id, receipt);
            }
            if (changed) save(state, today);
            const covered = intents.every(intent => {
                const receipt = state.confirmed[intent.documentId];
                if (receipt && receipt.operationId === intent.operationId) return intent.phase === 'completed' && receipt.sourceVerified
                    && receipt.manifest.kind === (intent.documentId.startsWith('diary:') ? 'diary' : 'summary');
                const prepared = state.prepared[intent.documentId];
                if (!prepared || prepared.operationId !== intent.operationId) return false;
                const current = localPreparedInput(prepared, state, today, view);
                if (!current) return false;
                const fresh = fingerprint(current.manifest) === prepared.sourceHash && fingerprint(current.messages) === prepared.promptHash;
                if (!fresh && prepared.phase === 'dispatched') noteChanged(prepared.documentId);
                return fresh;
            });
            return covered && Object.values(state.confirmed).every(receipt => receipt.sourceVerified);
        } catch {
            throw new Error('日记来源复核未确认；保留原状态与来源屏障');
        } finally { verifying = false; }
    };
    const commit = (state: DiaryState, p: DiaryPrepared, verified: boolean, today: Date) => {
        if (!verified) noteChanged(p.documentId);
        // Source validation may have durably invalidated a dependency while this
        // transport was awaiting ACK. Merge completion into that fresh state.
        const actual = loadState(), live = actual.prepared[p.documentId];
        if (!live || live.operationId !== p.operationId || live.bodyHash !== p.bodyHash || live.identityHash !== p.identityHash) throw new Error('日记提交记录已变化；保留已确认事实等待核对');
        const length = [...p.body].length;
        if (p.kind === 'diary') { actual.written[p.date] = length; actual.texts[p.date] = p.body; }
        else if (p.kind === 'week') actual.weeks[p.date] = length;
        else actual.phases[p.documentId.slice('phase:'.length)] = length;
        actual.confirmed[p.documentId] = { operationId: p.operationId, bodyHash: p.bodyHash, sourceHash: p.sourceHash, manifest: p.manifest, sourceVerified: verified };
        delete actual.prepared[p.documentId]; save(actual, today); Object.assign(state, actual);
    };
    const dispatch = async (state: DiaryState, p: DiaryPrepared, today: Date, input?: Input, allowNew = true): Promise<boolean> => {
        const verified = input !== undefined && fingerprint(input.manifest) === p.sourceHash && fingerprint(input.messages) === p.promptHash;
        if (p.phase === 'prepared' && !verified) { delete state.prepared[p.documentId]; save(state, today); return false; }
        if (p.phase === 'prepared' && !derivedReady()) return false;
        if (!verified) noteChanged(p.documentId);
        if (p.phase === 'prepared') { p.phase = 'dispatched'; save(state, today); }
        if (stopped) return false;
        const args = { operationId: p.operationId, allowSubmit: allowNew && verified && derivedReady(), canSubmit: async (signal?: AbortSignal) => {
            if (!allowNew || stopped || signal?.aborted || !derivedReady()) return false;
            let latest: Input | undefined;
            try { latest = await preparedInput(p, true); } catch { /* Unknown source must not authorize a queued submission. */ }
            if (stopped || signal?.aborted) return false;
            if (!latest || fingerprint(latest.manifest) !== p.sourceHash) { noteChanged(p.documentId); return false; }
            return !stopped && !signal?.aborted && derivedReady();
        } };
        const transport = options.memory as unknown as {
            retainDiary(date: string, day: Date, text: string, char: string, options: typeof args): Promise<boolean>;
            retainSummary(id: string, day: Date, title: string, text: string, char: string, tag: 'week' | 'phase', options: typeof args): Promise<boolean>;
        };
        const ok = p.kind === 'diary'
            ? await transport.retainDiary(p.date, new Date(p.lastDay), p.body, p.charName, args)
            : await transport.retainSummary(p.documentId, new Date(p.lastDay), p.title, p.body, p.charName, p.kind, args);
        if (!ok) return false;
        let latest: Input | undefined;
        try { latest = await preparedInput(p); } catch { /* Unknown current source cannot verify a completed old body. */ }
        commit(state, p, latest !== undefined && fingerprint(latest.manifest) === p.sourceHash, today);
        return true;
    };
    const prepare = async (state: DiaryState, data: Pick<DiaryPrepared, 'kind' | 'documentId' | 'date' | 'lastDay' | 'title'>, input: Input, today: Date): Promise<boolean> => {
        if (!derivedReady()) return false;
        let body: string;
        try { body = (await read(() => options.generate(input.messages))).trim(); }
        catch (error) { if (error !== STOPPED) options.log('她的日记或总结没生成成功，本轮保留原状态'); return false; }
        if (!body) { options.log(`${data.kind === 'diary' ? '她的日记' : '她的总结'}：${data.documentId} 模型回了空的，下次再写`); return false; }
        if (!derivedReady()) return false;
        const p: DiaryPrepared = { ...data, version: 1, charName: options.sources.charName, body, bodyHash: bodyDigest(body), identityHash: '',
            materialHash: input.manifest.materialHash, promptHash: input.manifest.promptHash, sourceHash: fingerprint(input.manifest), manifest: input.manifest, operationId: randomUUID(), phase: 'prepared' };
        p.identityHash = identity(p);
        let latest: Input | undefined;
        try { latest = await preparedInput(p); } catch { return false; }
        if (!latest || fingerprint(latest.manifest) !== p.sourceHash) return false;
        state.prepared[p.documentId] = p; save(state, today);
        // Persistence callbacks may synchronously change the source; never dispatch the old draft blindly.
        try { latest = await preparedInput(p); } catch { latest = undefined; }
        return dispatch(state, p, today, latest);
    };
    const catchUp = async (now: Date) => {
        if (stopped) return;
        let sourcesVerified = false;
        try { sourcesVerified = verifySources(now); }
        catch { options.log('日记来源尚未确认；本轮仅核对既有提交，不生成新正文'); }
        const state = loadState();
        const today = herDay(options.sources.schedule, now);
        viewToday = today;
        const todayDay = civilDayNumber(today);
        if (todayDay === undefined || !civilText(todayDay)) return;
        for (const p of Object.values(state.prepared)) {
            if (stopped) return;
            if (!sourcesVerified && p.phase !== 'dispatched') continue;
            let input: Input | undefined;
            try { input = await preparedInput(p); } catch { /* Only reconcile a known old dispatch. */ }
            if (!(await dispatch(state, p, today, input, sourcesVerified))) return;
        }
        if (!sourcesVerified || !derivedReady()) return;
        for (let back = DIARY_BACKFILL_DAYS; back >= 1; back--) {
            if (!derivedReady()) return;
            const target = todayDay - back, day = localCivilDay(target);
            if (!day || target >= todayDay) continue;
            const date = formatDate(day);
            if (!calendarDate(date)) continue;
            if (state.written[date] !== undefined) continue;
            let input: Input;
            try { input = dayInput(day); }
            catch {
                options.log('她的日记：承诺计划来源暂不可用，本轮停止，不将未知计划当成空白');
                return;
            }
            if (!(await prepare(state, { kind: 'diary', documentId: `diary:${date}`, date, lastDay: day.toISOString(), title: `${options.sources.charName}的日记（${date}）` }, input, today))) return;
            options.log(`她的日记：${date} 已确认提交完成`);
        }
        if (!derivedReady()) return;
        if (!(await catchUpWeeks(state, today))) return;
        if (!derivedReady()) return;
        await catchUpPhases(state, today);
    };

    /** 那几天的日记原文：本地有就用本地的，写过但本地没有的（ADR 0018 之前写的）从 Hindsight 读回来；读不到返回 undefined（下次再写） */
    const diariesOn = async (days: readonly Date[], state: DiaryState, localOnly = false, readOnly = false): Promise<{ date: Date; text: string }[] | undefined> => {
        const found: { date: Date; text: string }[] = [];
        for (const day of days) {
            if (!localOnly && !derivedReady()) return undefined;
            const date = formatDate(day);
            if (state.written[date] === undefined) continue;
            const confirmed = state.confirmed[`diary:${date}`];
            if (state.prepared[`diary:${date}`] || confirmed?.sourceVerified === false) return undefined;
            if (confirmed) {
                let matches = false;
                try { matches = fingerprint(dayInput(day).manifest) === confirmed.sourceHash; } catch { /* Unknown current source is not the confirmed source. */ }
                if (!matches) {
                    if (readOnly) return undefined;
                    noteChanged(`diary:${date}`);
                    confirmed.sourceVerified = false;
                    if (viewToday) save(state, viewToday);
                    return undefined;
                }
            }
            let text = state.texts[date];
            if (!text?.trim()) {
                if (localOnly) return undefined;
                try {
                    text = await read(() => options.memory.readDiary(date));
                } catch (error) {
                    if (error === STOPPED) return undefined;
                    options.log(`她的日记：从公共记忆读 ${date} 的日记失败，周记下次再写：${error instanceof Error ? error.message : String(error)}`);
                    return undefined;
                }
                if (!derivedReady()) return undefined;
                if (text?.trim()) state.texts[date] = text;
            }
            if (!text?.trim()) {
                options.log(`她的日记：${date} 已写但原文暂时读不到，周记和阶段总结下次再写`);
                return undefined;
            }
            if (confirmed && bodyDigest(text) !== confirmed.bodyHash) throw new Error('日记确认正文摘要不一致；保留来源屏障');
            found.push({ date: day, text });
        }
        return found;
    };

    const summaryFromDiaries = (state: DiaryState, diaries: { date: Date; text: string }[], period: string, documentId: string): Input => {
        const messages = summaryMessages(options.sources.charName, period, diaries), material = messages[1]!.content;
        const manifest: DiarySourceManifest = { version: 1, kind: 'summary', contextHash: fingerprint({ sources: options.sources, documentId, period }), materialHash: bodyDigest(material), promptHash: fingerprint(messages),
            dependencies: diaries.map(diary => {
                const documentId = `diary:${formatDate(diary.date)}`, receipt = state.confirmed[documentId];
                return { documentId, bodyHash: bodyDigest(diary.text), ...(receipt ? { sourceHash: receipt.sourceHash } : {}), legacy: receipt === undefined };
            }) };
        return { material, messages, manifest };
    };
    const summaryInput = async (state: DiaryState, days: Date[], period: string, documentId: string, localOnly = false, readOnly = false): Promise<Input | undefined> => {
        const diaries = await diariesOn(days, state, localOnly, readOnly);
        return diaries?.length ? summaryFromDiaries(state, diaries, period, documentId) : undefined;
    };
    // This synchronous path authorizes only a previously prepared immutable
    // request. It cannot use the remote fallback or recursively read a model.
    const localPreparedInput = (p: DiaryPrepared, state: DiaryState, today: Date, view: SourceView): Input | undefined => {
        const start = civilDayNumber(p.date), limit = civilDayNumber(today);
        if (start === undefined || limit === undefined || start >= limit) return undefined;
        if (p.kind === 'diary') { const day = localCivilDay(start); return day ? dayInput(day, view) : undefined; }
        let days: Date[], period: string;
        if (p.kind === 'week') {
            if (start + 6 >= limit) return undefined;
            days = Array.from({ length: 7 }, (_, i) => localCivilDay(start + i)).filter((day): day is Date => day !== undefined);
            period = `这周（${civilMonthDay(start)}–${civilMonthDay(start + 6)}）`;
        } else {
            const holiday = options.sources.schedule.holidays.find(holiday => `phase:${holiday.name}:${holiday.end}` === p.documentId);
            if (!holiday) return undefined;
            const first = civilDayNumber(holiday.start), last = civilDayNumber(holiday.end);
            if (first === undefined || last === undefined || first > last || last >= limit) return undefined;
            days = Object.keys(state.written).filter(date => date >= holiday.start && date <= holiday.end).sort()
                .map(date => localCivilDay(civilDayNumber(date)!)).filter((day): day is Date => day !== undefined);
            period = `这个${holiday.name}（${civilMonthDay(first)}–${civilMonthDay(last)}）`;
        }
        const diaries: { date: Date; text: string }[] = [];
        for (const day of days) {
            const date = formatDate(day), receipt = state.confirmed[`diary:${date}`];
            if (state.written[date] === undefined) continue;
            if (state.prepared[`diary:${date}`] || receipt?.sourceVerified === false) return undefined;
            const text = state.texts[date];
            if (!text?.trim() || receipt && bodyDigest(text) !== receipt.bodyHash) return undefined;
            diaries.push({ date: day, text });
        }
        return diaries.length ? summaryFromDiaries(state, diaries, period, p.documentId) : undefined;
    };
    const preparedInput = async (p: DiaryPrepared, readOnly = false): Promise<Input | undefined> => {
        const dayNumber = civilDayNumber(p.date), today = viewToday && civilDayNumber(viewToday);
        if (dayNumber === undefined || today === undefined || dayNumber >= today) return undefined;
        if (p.kind === 'diary') { const day = localCivilDay(dayNumber); return day ? dayInput(day) : undefined; }
        const state = loadState();
        if (p.kind === 'week') {
            if (dayNumber + 6 >= today) return undefined;
            const days = Array.from({ length: 7 }, (_, i) => localCivilDay(dayNumber + i)).filter((day): day is Date => day !== undefined);
            return summaryInput(state, days, `这周（${civilMonthDay(dayNumber)}–${civilMonthDay(dayNumber + 6)}）`, p.documentId, stopped, readOnly);
        }
        const holiday = options.sources.schedule.holidays.find(holiday => `phase:${holiday.name}:${holiday.end}` === p.documentId);
        if (!holiday) return undefined;
        const start = civilDayNumber(holiday.start), end = civilDayNumber(holiday.end);
        if (start === undefined || end === undefined || start > end || end >= today) return undefined;
        const days = Object.keys(state.written).filter(date => date >= holiday.start && date <= holiday.end).sort()
            .map(date => localCivilDay(civilDayNumber(date)!)).filter((day): day is Date => day !== undefined);
        return summaryInput(state, days, `这个${holiday.name}（${civilMonthDay(start)}–${civilMonthDay(end)}）`, p.documentId, stopped, readOnly);
    };

    /** 周记：她这一周之前的 WEEK_BACKFILL 周（周一到周日）；全都处理完返回 true */
    const catchUpWeeks = async (state: DiaryState, today: Date): Promise<boolean> => {
        const todayDay = civilDayNumber(today)!;
        const thisMonday = todayDay - ((new Date(todayDay * CIVIL_DAY_MS).getUTCDay() + 6) % 7);
        for (let back = WEEK_BACKFILL; back >= 1; back--) {
            if (!derivedReady()) return false;
            const monday = thisMonday - 7 * back, end = monday + 6, id = civilText(monday);
            if (!id || end >= todayDay) continue;
            if (state.weeks[id] !== undefined) continue;
            const days = Array.from({ length: 7 }, (_, i) => localCivilDay(monday + i)).filter((day): day is Date => day !== undefined);
            const diaries = await diariesOn(days, state);
            if (!derivedReady() || !diaries) return false;
            if (diaries.length) {
                const period = `这周（${civilMonthDay(monday)}–${civilMonthDay(end)}）`, input = await summaryInput(state, days, period, `week:${id}`);
                if (!input || !(await prepare(state, { kind: 'week', documentId: `week:${id}`, date: id, lastDay: days.at(-1)!.toISOString(), title: `${options.sources.charName}的周记（${civilMonthDay(monday)}–${civilMonthDay(end)}）` }, input, today))) return false;
                options.log(`她的周记：${id} 那周已确认提交完成`);
            } else {
                state.weeks[id] = 0;
            }
            save(state, today);
        }
        return true;
    };

    /** 阶段总结：作息里结束了 PHASE_BACKFILL_DAYS 天以内的假期 */
    const catchUpPhases = async (state: DiaryState, today: Date): Promise<void> => {
        const todayDay = civilDayNumber(today)!, recent = todayDay - PHASE_BACKFILL_DAYS;
        for (const holiday of options.sources.schedule.holidays.filter(h => {
            const end = civilDayNumber(h.end); return end !== undefined && end < todayDay && end >= recent;
        })) {
            if (!derivedReady()) return;
            const id = `${holiday.name}:${holiday.end}`;
            if (state.phases[id] !== undefined) continue;
            const start = civilDayNumber(holiday.start), end = civilDayNumber(holiday.end);
            if (start === undefined || end === undefined || start > end) continue;
            // Only written dates can contribute; do not enumerate a potentially enormous author range.
            const days = Object.keys(state.written).filter(date => date >= holiday.start && date <= holiday.end).sort()
                .map(date => localCivilDay(civilDayNumber(date)!)).filter((day): day is Date => day !== undefined && civilDayNumber(day)! < todayDay);
            const diaries = await diariesOn(days, state);
            if (!derivedReady() || !diaries) return;
            if (diaries.length) {
                const span = `${civilMonthDay(start)}–${civilMonthDay(end)}`;
                const input = await summaryInput(state, days, `这个${holiday.name}（${span}）`, `phase:${id}`);
                if (!input || !(await prepare(state, { kind: 'phase', documentId: `phase:${id}`, date: holiday.end, lastDay: (localCivilDay(end) ?? days.at(-1)!).toISOString(), title: `${options.sources.charName}的${holiday.name}总结（${span}）` }, input, today))) return;
                options.log(`她的${holiday.name}总结已确认提交完成`);
            } else {
                state.phases[id] = 0;
            }
            save(state, today);
        }
    };
    return {
        verifySources,
        catchUp: now => {
            if (stopped) return Promise.resolve();
            running ??= catchUp(now).finally(() => { running = undefined; });
            return running;
        },
        stop: () => {
            if (stopped) return drain;
            stopped = true;
            for (const cancel of cancelReads) cancel();
            cancelReads.clear();
            drain = running;
            return drain;
        },
    };
}
