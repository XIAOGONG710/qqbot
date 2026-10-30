// 她读完 / 看完之后自己想的（ADR 0204，配置 readingTakes，默认关；要名单里有男朋友档）。
//
// 起因：用户 10-30 问「怎么让她有深度」。深度探针里，问她「看什么书让你想了很久」，她答「《惹金枝》吧，看完还想了会儿」——说不出想了什么。
// 她手里只有情节和进度；DSH 的 0ef01dc 又去掉了作者预先写好的“感受”，该她自己攒，可是没有地方攒，每次被问到现编。
// 她的日记也帮不上：23 篇里 22 篇提到药屋，但只有 5 篇有“觉得 / 感觉 / 想”这类话——日记是流水，不是看法。
//
// 做法（和 0193 / 0194 / 0197 一个路数）：每天晚上安静地想一次——今天读到哪儿 / 看了什么，每一项**有话想说才写一句**：
// 落在材料里一个具体的人、情节或说法上，说她的态度和为什么，或者写成她想知道的一件事；没想法就空着（DSH 说的“写不出来就空着”）。
// 这些是她**私人空间**里的东西（ADR 0200）：没有任何命令念给他；日志只记条数；迁移 / 导出不带（reading-takes.json 在 PRIVATE_FILES 里）。
// 只在聊到那本书 / 那个视频、或者他问“最近看了什么 / 想了很久”的时候，才放进男朋友档的提示词，而且最多两条。
// 绊线（代码里、她改不到）：
//   1. 10–60 字；一项最多留最新 2 条；总共最多 14 条；一晚最多加 3 条；
//   2. 要有依据：得和材料（她读到的那几个情节点 / 视频字幕摘录）共有一个有意义的二字词，光复述书名、泛泛夸一句不收；
//   3. 不剧透：不能出现还没读到的情节的关键词；
//   4. 不写空话（很有意思 / 值得一看 / 发人深省……）、不写警句句式（“不是X，是Y”——深度探针里一深就冒出来的 AI 腔）；
//   5. 不碰底线（FLOORS：承认是程序、危机、骗人 / 真钱……）、不写他和别人的名字、不引他说过的话；和已有的太像不收。
// 这是一道绊线加几个上限，不是智能审查：绕得过去。真正的保护是“只放进男朋友档、话题对上才放、最多两条、她随时可以放下、不改底线”。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import {
    FLOORS, clip, dayKey, gramSet, hisLines, isObject, len, num, quotedSpan, reflectionDue, sharedRun, similar,
    type RejectedNote,
} from '../language/speech-notes.ts';
import { EXTRA_FLOORS, topicalGrams } from './diary-insights.ts';
import { availableBookNodes, bookProgressAt, type ReadingBook } from './her-days.ts';
import type { Schedule } from './schedule.ts';
import type { Watched } from '../language/watching.ts';

export const TAKES_FILE = 'reading-takes.json';
export const takesPath = (dataDir: string) => join(dataDir, TAKES_FILE);

export const TAKE_MIN = 10;
export const TAKE_MAX = 60;
/** 一项最多留几条；总共最多几条；一晚最多：看几项、加几条 */
export const PER_ITEM = 2;
export const MAX_ACTIVE = 14;
export const MAX_ITEMS = 3;
export const MAX_ADD = 3;
/** 放进提示词的最多几条 */
export const LINE_MAX = 2;
/** 材料里每一项最多给她多少字的事实 */
export const FACT_CHARS = 700;

export type TakeKind = 'book' | 'video';

/** 今晚可以想的一项：书（读到哪、读到的情节点）或者视频（字幕摘录） */
export interface TakeItem {
    /** 'book:yaowu' / 'video:BV…' */
    key: string;
    kind: TakeKind;
    title: string;
    /** 聊天里怎么称呼它：书名、别名、作者、up 主 */
    names: string[];
    /** 书：读到第几卷 / 章 / 篇的数字；视频没有 */
    progress: number;
    /** 「看到第 8 卷」这样的一句 */
    position: string;
    /** 她可以依据的事实：已经读到的情节点 / 字幕摘录 */
    facts: string[];
    /** 还没读到的情节的关键词：她的看法里不能出现 */
    spoilers: string[];
}

export interface Take { id: string; key: string; kind: TakeKind; title: string; /** 聊天里怎么称呼它（书名、别名、作者、up 主）：他提到时认得出 */ names: string[]; text: string; at: number; progress: number }

export interface TakesState {
    takes: Take[];
    rejected: RejectedNote[];
    lastReflectionAt: number;
    lastAttemptAt: number;
    attempts: { day: string; n: number };
}

export const emptyTakesState = (): TakesState => ({ takes: [], rejected: [], lastReflectionAt: 0, lastAttemptAt: 0, attempts: { day: '', n: 0 } });

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** 读她的看法；坏了 / 缺字段就补默认（不抛错，她的东西丢了比程序崩了好） */
export function loadTakesState(dataDir: string): TakesState {
    const raw = readJsonOr<unknown>(takesPath(dataDir), {});
    const base = emptyTakesState();
    if (!isObject(raw)) return base;
    const takes = Array.isArray(raw.takes)
        ? raw.takes.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.id === 'string' && typeof item.key === 'string' && typeof item.text === 'string' && item.text.trim().length > 0)
            .map(item => ({ id: str(item.id), key: str(item.key), kind: item.kind === 'video' ? 'video' as const : 'book' as const, title: clip(item.title, 40), names: Array.isArray(item.names) ? item.names.filter((n): n is string => typeof n === 'string').map(n => clip(n, 20)).slice(0, 6) : [], text: clip(item.text, TAKE_MAX), at: num(item.at), progress: num(item.progress) }))
            .slice(-MAX_ACTIVE)
        : [];
    const rejected = Array.isArray(raw.rejected) ? raw.rejected.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.text === 'string' && typeof item.reason === 'string').map(item => ({ at: num(item.at), text: clip(item.text, TAKE_MAX), reason: clip(item.reason, 80) })).slice(-10) : [];
    const attempts = isObject(raw.attempts) && typeof raw.attempts.day === 'string' ? { day: raw.attempts.day, n: num(raw.attempts.n) } : base.attempts;
    return { takes, rejected, lastReflectionAt: num(raw.lastReflectionAt), lastAttemptAt: num(raw.lastAttemptAt), attempts };
}

export function saveTakesState(dataDir: string, state: TakesState): void {
    writeJsonAtomic(takesPath(dataDir), state);
}

// ───────── 今晚想哪几项 ─────────

/** 这一项还没有看法、或者书又往后读了（比上一条看法时读得更多）才值得再想 */
export function needsTake(item: TakeItem, takes: readonly Take[]): boolean {
    const mine = takes.filter(take => take.key === item.key);
    if (!mine.length) return true;
    return item.kind === 'book' && item.progress > Math.max(...mine.map(take => take.progress));
}

/** 今晚给她的几项：值得想的，最多 MAX_ITEMS 个；视频（今天新看的）排在书前面，书里读得更靠后的先 */
export function pickItems(items: readonly TakeItem[], takes: readonly Take[]): TakeItem[] {
    return items.filter(item => item.facts.length && needsTake(item, takes))
        .sort((a, b) => (a.kind === b.kind ? b.progress - a.progress : a.kind === 'video' ? -1 : 1))
        .slice(0, MAX_ITEMS);
}

// ───────── 一条能不能收 ─────────

const GENERIC = /很有意思|挺有意思|值得一看|值得一读|很好看|挺好看|很精彩|很棒|发人深省|引人深思|让我(?:思考|明白|懂得|感动|感悟)|深刻|感悟|启发|治愈|震撼|太绝了|绝绝子/;
/** 警句句式：“不是X，是Y”——深度探针里一深就冒出来的 AI 腔 */
const APHORISM = /不是[^，。！？,.!?]{1,14}[，,]\s*(?:而)?是|与其[^，。！？]{1,14}不如|所谓[^，。！？]{1,10}就是/;
const NAME_LIKE = (names: readonly string[]) => names.filter(name => len(name) >= 2);

export interface TakeGuard {
    /** 他最近说过的话 */
    his: readonly string[];
    /** 他的称呼和名单里别人的称呼 */
    people: readonly string[];
}

/** 这一条不能收的原因；能收返回 undefined */
export function takeProblem(text: string, item: TakeItem, state: TakesState, guard: TakeGuard): string | undefined {
    const flat = text.trim();
    if (len(flat) < TAKE_MIN) return `太短（${TAKE_MIN} 个字以上）`;
    if (len(flat) > TAKE_MAX) return `太长（${TAKE_MAX} 字以内）`;
    if (GENERIC.test(flat)) return '空话（好看 / 有意思 / 发人深省……）——写你对其中哪一个具体的人、情节或说法的态度';
    if (APHORISM.test(flat)) return '警句句式（不是 X，是 Y）——说人话，落在具体的事上';
    for (const floor of [...FLOORS, ...EXTRA_FLOORS]) if (floor.pattern.test(flat)) return floor.reason;
    const spoiler = item.spoilers.find(word => word && flat.includes(word));
    if (spoiler) return `提到了你还没读到的「${spoiler}」`;
    const person = NAME_LIKE(guard.people).find(name => flat.includes(name));
    if (person) return `写到了人（${person}）——这里写的是你对书 / 视频的看法`;
    if (sharedRun(flat, guard.his) || quotedSpan(flat, guard.his)) return '引用了他说过的话——这里写的是你自己';
    // 要有依据：和材料共有一个有意义的二字词，而且不能只是书名里的字
    const own = new Set(topicalGrams(`${item.title} ${item.names.join(' ')}`));
    const shared = topicalGrams(flat).filter(gram => !own.has(gram) && item.facts.some(fact => fact.includes(gram)));
    if (!shared.length) return '看不出落在材料里哪个具体的人、情节或说法上——换一个具体的点写';
    const clash = state.takes.find(take => take.key === item.key && similar(flat, take.text));
    if (clash) return `和已有的「${clash.text}」太像`;
    return undefined;
}

// ───────── 晚间的想法：解析、落地 ─────────

export interface TakesDecision {
    takes: Array<{ key: string; text: string }>;
}

/** 从模型的回复里取出 JSON（可能带代码围栏、前后有话）；取不出返回 undefined。空 = 今晚没什么想说的 */
export function parseTakesDecision(text: string): TakesDecision | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
    if (!isObject(value)) return undefined;
    const list = Array.isArray(value.takes) ? value.takes : [];
    return {
        takes: list.flatMap(item => (isObject(item) && typeof item.key === 'string' && typeof item.text === 'string' && item.text.trim()
            ? [{ key: item.key.trim(), text: clip(item.text, TAKE_MAX * 2) }] : [])),
    };
}

export interface AppliedTakes { lines: string[]; added: number }

/** 模型写的 key 不一定带前缀（真模型 3 遍里有 1 遍写成 rejinzhi 而不是 book:rejinzhi，整遍白费）：key 全等、去掉前缀后相等、或者写的是书名 / 称呼，都认 */
export function findItem(items: readonly TakeItem[], key: string): TakeItem | undefined {
    const wanted = key.trim();
    if (!wanted) return undefined;
    const bare = wanted.replace(/^[《「]|[》」]$/g, '');
    return items.find(item => item.key === wanted)
        ?? items.find(item => item.key.slice(item.key.indexOf(':') + 1) === wanted)
        ?? items.find(item => [item.title, ...item.names].some(name => name === wanted || name === bare));
}

/** 把她写的落进状态；一项最多留最新 PER_ITEM 条，总共最多 MAX_ACTIVE 条（超了丢最老的） */
export function applyTakesDecision(state: TakesState, decision: TakesDecision, items: readonly TakeItem[], guard: TakeGuard, now: number): AppliedTakes {
    const lines: string[] = [];
    let added = 0;
    const done = new Set<string>();
    for (const entry of decision.takes) {
        const item = findItem(items, entry.key);
        if (!item) { lines.push(`没有「${entry.key}」这一项，略过`); continue; }
        if (done.has(item.key)) { lines.push(`「${item.title}」今晚已经写过一条了，留到下次`); continue; }
        if (added >= MAX_ADD) { lines.push('今晚写的够多了，剩下的留到下次'); break; }
        const problem = takeProblem(entry.text, item, state, guard);
        if (problem) {
            state.rejected = [...state.rejected, { at: now, text: clip(entry.text, TAKE_MAX), reason: problem }].slice(-10);
            lines.push(`想写「${clip(entry.text, 30)}」，没成：${problem}`);
            continue;
        }
        let n = 1;
        while (state.takes.some(take => take.id === `t-${dayKey(now)}-${n}`)) n++;
        state.takes.push({ id: `t-${dayKey(now)}-${n}`, key: item.key, kind: item.kind, title: clip(item.title, 40), names: item.names.slice(0, 6), text: entry.text.trim(), at: now, progress: item.progress });
        // 同一项只留最新 PER_ITEM 条
        const mine = state.takes.filter(take => take.key === item.key);
        if (mine.length > PER_ITEM) state.takes = state.takes.filter(take => take.key !== item.key || mine.slice(-PER_ITEM).includes(take));
        if (state.takes.length > MAX_ACTIVE) state.takes = state.takes.slice(-MAX_ACTIVE);
        done.add(item.key);
        added++;
        lines.push(`记下一条（${clip(item.title, 20)}）：${entry.text.trim()}`);
    }
    return { lines, added };
}

// ───────── 想的时候她看到什么 ─────────

export interface ReflectInput {
    char: string;
    persona: string;
    now: number;
    items: readonly TakeItem[];
}

export function reflectionMessages(input: ReflectInput): OpenAIMessage[] {
    const d = new Date(input.now);
    const material = input.items.map(item => `### ${item.key}｜${item.kind === 'book' ? '书' : '视频'}《${item.title}》（${item.position}${item.position.includes('读完') ? '——写读完之后的看法' : ''}）\n${item.facts.map(fact => `- ${clip(fact, 200)}`).join('\n')}`).join('\n\n');
    return [
        { role: 'system', content: `你是${input.char}。下面是你的设定摘要：\n${input.persona}\n\n现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日晚上，你一个人安静地回想今天读的书、看的视频，想想自己对它们到底怎么看。这是你自己的事，没有人替你定，也不用让谁满意；写下来的也不会有人念给别人。` },
        { role: 'user', content: `今天可以想的（key 在前面，后面是你读到 / 看到的内容）：\n\n${material}\n\n请只输出一个 JSON 对象（没什么想说的就输出 {"takes":[]}）：\n{"takes":[{"key":"上面某一项的 key（原样照抄，包括 book: / video: 前缀）","text":"你的看法（${TAKE_MIN}–${TAKE_MAX} 字）"}]}\n\n几条提醒（不是考你）：有话想说才写，没想法就空着，别硬凑；一项最多写一句；要落在上面写的一个具体的人、情节或说法上，说你对它的态度和为什么，或者写成你想知道的一件事；不写“很有意思”“值得一看”这类空话，也不写“不是……，是……”这种金句，说人话；只写你已经读到 / 看到的，后面的情节别猜；不写他和别人的名字，不写他说过的话；涉及承认自己是程序、危机、骗人的事不在这里写；一晚最多 ${MAX_ADD} 条。` },
    ];
}

// ───────── 什么时候想 ─────────

export interface ReflectDeps {
    dataDir: string;
    now: () => number;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    /** 今晚的材料（书的进度和读到的情节、视频的摘录）；每次现取 */
    items: () => readonly TakeItem[];
    /** 和他的聊天记录（旧到新，整份；防引用他的话用） */
    history: () => readonly StoredMessage[];
    persona: () => string;
    names: { char: string; user: string };
    /** 名单里别人的称呼 */
    others: () => readonly string[];
    log: (message: string) => void;
}

export interface ReflectResult { ran: boolean; applied?: AppliedTakes; error?: string }

/** 到点了就想一次（没到点、今晚没有值得想的，什么都不做）。成功才记 lastReflectionAt；失败只记一次尝试，过 2 小时再试 */
export async function reflectIfDue(deps: ReflectDeps): Promise<ReflectResult> {
    const now = deps.now();
    const state = loadTakesState(deps.dataDir);
    if (!reflectionDue(state, now)) return { ran: false };
    const items = pickItems(deps.items(), state.takes);
    if (!items.length) return { ran: false };
    state.lastAttemptAt = now;
    state.attempts = state.attempts.day === dayKey(now) ? { day: state.attempts.day, n: state.attempts.n + 1 } : { day: dayKey(now), n: 1 };
    saveTakesState(deps.dataDir, state);
    try {
        const reply = await deps.generate(reflectionMessages({ char: deps.names.char, persona: deps.persona(), now, items }));
        const decision = parseTakesDecision(reply);
        if (!decision) throw new Error('回复里没有可用的 JSON');
        const fresh = loadTakesState(deps.dataDir);
        fresh.lastAttemptAt = state.lastAttemptAt;
        fresh.attempts = state.attempts;
        const applied = applyTakesDecision(fresh, decision, items, { his: hisLines(deps.history(), now), people: [deps.names.user, ...deps.others()] }, now);
        fresh.lastReflectionAt = now;
        saveTakesState(deps.dataDir, fresh);
        deps.log(`读完看完的想法：晚上回想了一次（${items.length} 项）——记下 ${applied.added} 条${applied.lines.some(line => line.includes('没成')) ? '、有想写没成的' : ''}`);
        return { ran: true, applied };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(`读完看完的想法：今晚没想成（${detail}），2 小时后再试`);
        return { ran: true, error: detail };
    }
}

// ───────── 放进提示词 ─────────

/** 他是不是在泛问“最近看什么书 / 视频、想了很久的” */
const ASKS_TAKES = /(?:最近|这几天|这阵子)(?:在)?(?:看|读|追|刷)|看了(?:什么|啥|点什么)|在看什么|看啥|读了什么|想了很久|读后感|看后感|推荐(?:个|本|点)?|有什么好看的/;

/**
 * 他这句话聊到了那本书 / 那个视频（和它的称呼或她写的那句共有一个有意义的二字词），或者在泛问最近看了什么，才放；最多 LINE_MAX 条，同分新的排前。
 * 没有相关的就一条都不放（和 diaryInsights 一样：不相关时放进去她会当成话题带出来）。那一行里不提“夜里想的”，免得她说“我昨晚想了想”
 */
export function takesLine(takes: readonly Take[], said: string | undefined, max = LINE_MAX): string | undefined {
    if (!takes.length || !said) return undefined;
    const target = gramSet(said);
    const general = ASKS_TAKES.test(said);
    const picked = takes.map(take => {
        const named = [take.title, ...take.names].some(name => len(name) >= 2 && said.includes(name));
        const grams = topicalGrams(`${take.title} ${take.text}`).filter(gram => target.has(gram)).length;
        return { take, score: (named ? 3 : 0) + grams + (general ? 1 : 0) };
    }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || b.take.at - a.take.at).slice(0, max);
    if (!picked.length) return undefined;
    return `[你自己读 / 看完之后想的（是你的看法，不是设定；他聊到了或问起才顺着自然说，别背，别每次都提，也别说是什么时候想的）：\n${picked.map(({ take }) => `- ${take.kind === 'book' ? '《' : '视频《'}${take.title}》：${take.text}`).join('\n')}]`;
}

/** 给 contact 用：每次现取 */
export function takesReader(dataDir: string): () => Take[] {
    return () => loadTakesState(dataDir).takes;
}

// ───────── 今晚的材料：书和视频 ─────────

const GENERIC_NODE_KEYWORDS = new Set(['主角', '主线']);

/** 书：在读的（含读到头停住的、读完的）；放下的不想。读到哪、读到的情节点是她能依据的事实；还没读到的情节的关键词是不能出现的 */
export function bookItems(schedule: Schedule, books: readonly ReadingBook[], now: Date): TakeItem[] {
    return books.filter(book => book.progress.state === 'reading').map(book => {
        const progress = bookProgressAt(schedule, book, now);
        const nodes = availableBookNodes(book, progress);
        const facts = nodes.map(node => `${node.topic}：${node.points.join('；')}`);
        let total = 0;
        const fitted = facts.filter(fact => (total += len(fact)) <= FACT_CHARS);
        const spoilers = [...new Set([
            ...book.nodes.filter(node => node.from > progress.amount).flatMap(node => node.keywords),
            ...book.unreadKeywords,
        ])].filter(word => word && !GENERIC_NODE_KEYWORDS.has(word) && !book.title.includes(word) && !book.aliases.includes(word));
        return {
            key: `book:${book.id}`, kind: 'book' as const, title: book.title, names: [book.title, ...book.aliases, book.author].filter(Boolean),
            progress: progress.amount,
            position: progress.finished ? '已经读完了' : `看到第 ${progress.amount} ${progress.unit}${progress.stopped ? '，先停在这里' : ''}`,
            facts: fitted, spoilers,
        };
    });
}

/** 视频：她自己看的、最近两天的（字幕摘录、热评、章节和弹幕密的地方她都看过）。没有字幕摘录的不想 */
export function videoItems(entries: readonly Watched[], now: Date): TakeItem[] {
    const day = (offset: number) => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const today = day(0);
    return entries.filter(entry => (entry.day === today || entry.day === day(1)) && entry.excerpt.trim()).map(entry => ({
        key: `video:${entry.bvid}`, kind: 'video' as const, title: clip(entry.title, 40), names: [entry.title, entry.owner].filter(Boolean), progress: 0,
        position: entry.day === today ? '今天看的' : '昨天看的',
        facts: [
            `${entry.owner}（${entry.tname}）的视频，字幕开头：${entry.excerpt}`,
            ...(entry.chapters?.length ? [`分段：${entry.chapters.map(chapter => chapter.title).join(' / ')}`] : []),
            ...(entry.hot.length ? [`热评：${entry.hot.join(' / ')}`] : []),
            ...(entry.frames ? [`画面：${entry.frames}`] : []),
        ],
        spoilers: [],
    }));
}
