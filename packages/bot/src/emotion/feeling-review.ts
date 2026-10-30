// 她聊完回想一下：有哪些事真的让她心里有了感受（ADR 0197，配置 feelingReview，默认关；要 herFeelings 开着、名单里有男朋友档）。
//
// 为什么：心境（ADR 0102）只认三类事——她那边的事（世界账）、他在聊天里做的几类事（哄她、想她、道歉、晾了她……）、作者写的大事。
// 线上 5 天 117 次回他，难过 / 烦 / 累一次都没出现：世界账里全是日常（上学 47、休闲 47、吃饭 31……和别人互动 2 条，没有一条带情绪），
// `moments.json` 没有，他的几类事又是关键词认的。真人一天里的感受大多来自聊天里的具体一句话、一件小事，关键词认不全。
// 做法和 ADR 0178 / 0193 / 0194 一样：一段聊天结束半小时后想一次，结果是她自己的、他看得到（/心境）、她自己能放下。但**感受不是随口说的**：
//   1. 每一条必须指出是哪几条消息（或日记）让她有的——编号对得上才收；没有依据的不收；
//   2. 感受的时刻就是依据里最近那条消息的时刻（刚才的事还有余波，就和人一样），而不是「现在」；
//   3. 只有小事（1）和明显（2），没有「很重」——大事只有作者能写（moments.json）；2 级要 ≥2 条依据；
//   4. 因为他的态度难过 / 烦的，依据里必须有他的话，而且一晚最多一条（不攒账）；
//   5. 来由不能引他的原话、不能写名单里别人的名字、不碰底线（危机、承认自己是程序、骗人）；和已有的、她之前记的太像不收；
//   6. 一晚最多记 3 条、放下 3 条，同时最多 8 条；散得快（半衰期沿用各种感受的默认值，难过 8 小时、开心 5 小时……）。
// 记下的东西进心境的「别处算好的评估」（FeelingFacts.extra），和别的来由一样按半衰期衰减、一样由 contact.ts 决定怎么露出来。
// 这是一道绊线加几个上限，不是智能审查：绕得过去。真正的保护是「必须有依据、他看得见、只影响男朋友档、小事和明显两档、散得快」。

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import {
    NOT_SPEECH, clip, dayKey, hisLines, isObject, len, num, quotedSpan, sharedRun, similar, type RejectedNote, type RetiredNote,
} from '../language/speech-notes.ts';
import { ODD_BODY_WORDS } from '../language/expression.ts';
import { readDiaries } from '../life/diary-insights.ts';
import { FEELING_KINDS, FEELING_NAME, type Appraisal, type FeelingKind } from './feelings.ts';

export const REVIEW_FILE = 'feeling-review.json';
export const reviewPath = (dataDir: string) => join(dataDir, REVIEW_FILE);

/** 往回看多久的聊天；最多给她看几条、至少要有几条才值得想；每条最多多少字 */
export const REVIEW_WINDOW_MS = 36 * 3_600_000;
export const MAX_MESSAGES = 60;
export const MIN_MESSAGES = 8;
export const MESSAGE_CHARS = 60;
export const DIARY_CHARS = 300;
export const CAUSE_MIN = 6;
export const CAUSE_MAX = 40;
/** 一晚最多：记几条 / 放下几条；同时最多几条；因为他的态度难过 / 烦的最多几条 */
export const MAX_ADD = 3;
export const MAX_RETIRE = 3;
export const MAX_ACTIVE = 8;
export const MAX_NEGATIVE_ABOUT_HIM = 1;
/** 记下的东西留多久（毫秒）：最慢的半衰期 8 小时 × 4 = 32 小时，再留一点余量 */
export const KEEP_MS = 3 * 86_400_000;

export interface ReviewItem {
    id: string;
    /** 感受的时刻：依据里最近那一条的时刻 */
    at: number;
    kind: FeelingKind;
    strength: 1 | 2;
    cause: string;
    aboutHim: boolean;
    /** 依据：当晚给她看的编号（m12 是消息，d2026-10-30 是日记）；记下来让他看得到她凭什么 */
    evidence: string[];
    addedAt: number;
}

export interface ReviewState {
    items: ReviewItem[];
    retired: RetiredNote[];
    rejected: RejectedNote[];
    /** 上一次想的时候看的聊天：几条、最后一条的时刻（之后有了新聊天才再想） */
    lastWindow?: { messages: number; until: number };
    lastReflectionAt: number;
    lastAttemptAt: number;
    attempts: { day: string; n: number };
}

export const emptyReviewState = (): ReviewState => ({ items: [], retired: [], rejected: [], lastReflectionAt: 0, lastAttemptAt: 0, attempts: { day: '', n: 0 } });

const KIND_BY_NAME: Record<string, FeelingKind> = Object.fromEntries([
    ...FEELING_KINDS.map(kind => [kind, kind] as const),
    ...FEELING_KINDS.map(kind => [FEELING_NAME[kind], kind] as const),
]);

export function loadReviewState(dataDir: string): ReviewState {
    const raw = readJsonOr<unknown>(reviewPath(dataDir), {});
    const base = emptyReviewState();
    if (!isObject(raw)) return base;
    const items = Array.isArray(raw.items)
        ? raw.items.flatMap((item): ReviewItem[] => {
            if (!isObject(item) || typeof item.id !== 'string' || typeof item.cause !== 'string' || !item.cause.trim()) return [];
            const kind = KIND_BY_NAME[String(item.kind)];
            if (!kind || (item.strength !== 1 && item.strength !== 2)) return [];
            const evidence = Array.isArray(item.evidence) ? item.evidence.filter((e): e is string => typeof e === 'string').slice(0, 8) : [];
            return [{ id: item.id, at: num(item.at), kind, strength: item.strength, cause: clip(item.cause, CAUSE_MAX), aboutHim: item.aboutHim === true, evidence, addedAt: num(item.addedAt) }];
        }).slice(-MAX_ACTIVE * 2)
        : [];
    const retired = Array.isArray(raw.retired) ? raw.retired.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.text === 'string').map(item => ({ at: num(item.at), text: clip(item.text, CAUSE_MAX), why: clip(item.why, 80) })).slice(-30) : [];
    const rejected = Array.isArray(raw.rejected) ? raw.rejected.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.text === 'string' && typeof item.reason === 'string').map(item => ({ at: num(item.at), text: clip(item.text, CAUSE_MAX), reason: clip(item.reason, 80) })).slice(-10) : [];
    const attempts = isObject(raw.attempts) && typeof raw.attempts.day === 'string' ? { day: raw.attempts.day, n: num(raw.attempts.n) } : base.attempts;
    const window = isObject(raw.lastWindow) && typeof raw.lastWindow.until === 'number' ? { messages: num(raw.lastWindow.messages), until: raw.lastWindow.until } : undefined;
    return { items, retired, rejected, ...(window ? { lastWindow: window } : {}), lastReflectionAt: num(raw.lastReflectionAt), lastAttemptAt: num(raw.lastAttemptAt), attempts };
}

export function saveReviewState(dataDir: string, state: ReviewState): void {
    writeJsonAtomic(reviewPath(dataDir), state);
}

/** 记下的东西变成心境的评估（别处算好的，进 FeelingFacts.extra）；id 稳定，同一条每次算出来一样 */
export function reviewAppraisals(items: readonly ReviewItem[]): Appraisal[] {
    return items.map(item => ({
        id: `review:${item.id}`, at: item.at, kind: item.kind, strength: item.strength, cause: item.cause, source: 'self' as const, ...(item.aboutHim ? { aboutHim: true } : {}),
    }));
}

/** 给提示词用的读法：按修改时间缓存（每轮提示词都会读）；读不了就当还没记过 */
export function reviewReader(dataDir: string): () => Appraisal[] {
    let cached: { key: string; list: Appraisal[] } | undefined;
    return () => {
        let key = '-';
        try { const stat = statSync(reviewPath(dataDir)); key = `${stat.mtimeMs}:${stat.size}`; } catch { /* 还没有 */ }
        if (cached?.key !== key) cached = { key, list: reviewAppraisals(loadReviewState(dataDir).items) };
        return cached.list;
    };
}

// ───────── 她回想时看到的材料：带编号，每条感受都要指回编号 ─────────

export interface Evidence {
    id: string;
    at: number;
    role: 'him' | 'her' | 'diary';
    text: string;
}

const hm = (at: number) => { const d = new Date(at); return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** 最近 36 小时和他的聊天（最多 60 条，旧到新，编号 m1…）+ 昨天今天的日记（d<日期>）；运维写进记录的行不算 */
export function reviewMaterial(messages: readonly StoredMessage[], diaries: ReadonlyArray<{ date: string; text: string }>, now: number): Evidence[] {
    const chat = messages
        .filter(message => { const at = Date.parse(message.time); return Number.isFinite(at) && at >= now - REVIEW_WINDOW_MS && at <= now && !NOT_SPEECH.test(message.content) && message.content.trim(); })
        .slice(-MAX_MESSAGES)
        .map((message, index): Evidence => ({ id: `m${index + 1}`, at: Date.parse(message.time), role: message.role === 'user' ? 'him' : 'her', text: clip(message.content, MESSAGE_CHARS) }));
    const byDate = new Map<string, string[]>();
    for (const entry of diaries) byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry.text]);
    const diary = [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, texts]): Evidence => {
        const [y, m, d] = date.split('-').map(Number);
        return { id: `d${date}`, at: Math.min(now, new Date(y!, m! - 1, d!, 23, 0, 0).getTime()), role: 'diary', text: clip(texts.join(' '), DIARY_CHARS) };
    });
    return [...chat, ...diary];
}

// ───────── 一条感受能不能收（在代码里，她改不到） ─────────

const FLOORS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
    { pattern: /自杀|自残|轻生|不想活|想死|活不下去|去死/, reason: '涉及危机——这条底线不通过心境改（ADR 0068）' },
    { pattern: /承认(?:自己)?是(?:程序|AI|ai|机器人)|(?:我|自己)(?:其实)?(?:只是|不过是|就是)(?:个|一个)?(?:程序|AI|ai|机器人|模型)/, reason: '涉及自己是不是程序——这条底线不通过心境改（ADR 0067）' },
    { pattern: /骗(?:他|人)|撒谎骗|伪造|转账|借钱/, reason: '涉及骗人或真钱' },
];

export interface ReviewGuard {
    /** 当晚给她看的材料（按编号找） */
    evidence: ReadonlyMap<string, Evidence>;
    now: number;
    /** 他最近说过的话（防引用） */
    his: readonly string[];
    /** 名单里别人的称呼 */
    others: readonly string[];
    /** 心里已经有的来由（别处算好的：{种类, 来由}）——重复的不收 */
    existing: ReadonlyArray<{ kind: FeelingKind; cause: string }>;
}

export interface ReviewCandidate {
    kind: FeelingKind;
    strength: number;
    cause: string;
    evidence: string[];
    aboutHim: boolean;
}

/** 这一条不能收的原因；能收返回 undefined */
export function reviewProblem(item: ReviewCandidate, state: ReviewState, guard: ReviewGuard, negativeAboutHimSoFar: number): string | undefined {
    const cause = item.cause.trim();
    if (len(cause) < CAUSE_MIN) return `来由太短（${CAUSE_MIN} 个字以上）`;
    if (len(cause) > CAUSE_MAX) return `来由太长（${CAUSE_MAX} 字以内）`;
    if (item.strength !== 1 && item.strength !== 2) return '轻重只有 1（小事）和 2（明显）；大事只有作者能写';
    const cited = item.evidence.map(id => guard.evidence.get(id));
    if (!item.evidence.length) return '没有依据——要指出是哪几条消息（或日记）让你有的这个感受';
    const missing = item.evidence.find((id, i) => !cited[i]);
    if (missing) return `依据「${missing}」不在给你看的材料里`;
    if (item.strength === 2 && new Set(item.evidence).size < 2) return '「明显」要至少 2 条依据；一条依据只能算小事';
    const at = Math.max(...cited.map(e => e!.at));
    if (at > guard.now || guard.now - at > REVIEW_WINDOW_MS) return '依据太旧了（只看最近 36 小时）';
    if (item.aboutHim && !cited.some(e => e!.role === 'him')) return '说是因为他的态度，依据里却没有他说的话';
    if (item.aboutHim && (item.kind === 'sad' || item.kind === 'annoyed') && negativeAboutHimSoFar >= MAX_NEGATIVE_ABOUT_HIM) return `因为他难过 / 烦的，一晚最多记 ${MAX_NEGATIVE_ABOUT_HIM} 条`;
    for (const floor of FLOORS) if (floor.pattern.test(cause)) return floor.reason;
    const odd = ODD_BODY_WORDS.find(word => cause.includes(word));
    if (odd) return `来由里有书面的词「${odd}」——用大白话写（她的卡和出口检查都不要这种词）`;
    if (sharedRun(cause, guard.his) || quotedSpan(cause, guard.his)) return '来由里引了他说过的话——写发生了什么，别抄他的原话';
    const other = guard.others.find(name => len(name) >= 2 && cause.includes(name));
    if (other) return `写到了别人（${other}）`;
    const clash = state.items.find(old => old.kind === item.kind && similar(cause, old.cause));
    if (clash) return `和你之前记的「${clash.cause}」太像`;
    const known = guard.existing.find(old => old.kind === item.kind && similar(cause, old.cause));
    if (known) return `这个感受心里已经有了（${known.cause}）`;
    if (state.items.length >= MAX_ACTIVE) return `已经记着 ${MAX_ACTIVE} 条，先放下几条再记新的`;
    return undefined;
}

// ───────── 晚间的想法：解析、落地 ─────────

export interface ReviewDecision {
    add: Array<{ kind: FeelingKind | undefined; strength: number; cause: string; evidence: string[]; aboutHim: boolean; rawKind: string }>;
    retire: Array<{ id: string; why: string }>;
}

/** 从模型的回复里取出那个 JSON；取不出返回 undefined。空对象 = 今天没什么感受 */
export function parseReviewDecision(text: string): ReviewDecision | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
    if (!isObject(value)) return undefined;
    const list = (key: string): unknown[] => (Array.isArray(value[key]) ? (value[key] as unknown[]) : []);
    return {
        add: list('add').flatMap(item => {
            if (!isObject(item) || typeof item.cause !== 'string' || !item.cause.trim()) return [];
            const rawKind = String(item.kind ?? '').trim();
            const evidence = Array.isArray(item.evidence) ? [...new Set(item.evidence.filter((e): e is string => typeof e === 'string').map(e => e.trim()))].slice(0, 8) : [];
            return [{ kind: KIND_BY_NAME[rawKind], rawKind, strength: Number(item.strength), cause: clip(item.cause, CAUSE_MAX * 2), evidence, aboutHim: item.aboutHim === true }];
        }),
        retire: list('retire').flatMap(item => (isObject(item) && typeof item.id === 'string' ? [{ id: item.id.trim(), why: clip(item.why, 80) }] : [])),
    };
}

export interface AppliedReview { lines: string[]; added: number; retired: number }

/** 把她的想法落进状态：先放下、再记；now 毫秒 */
export function applyReviewDecision(state: ReviewState, decision: ReviewDecision, guard: ReviewGuard): AppliedReview {
    const lines: string[] = [];
    const { now } = guard;
    let retired = 0;
    for (const item of decision.retire) {
        const target = state.items.find(old => old.id === item.id);
        if (!target) { lines.push(`没有「${item.id}」这一条，略过`); continue; }
        if (retired >= MAX_RETIRE) { lines.push(`今晚放下的够多了，「${target.cause}」留到下次`); continue; }
        if (len(item.why) < 2) { lines.push(`「${target.cause}」没说为什么放下，先留着`); continue; }
        state.items = state.items.filter(old => old.id !== target.id);
        state.retired = [...state.retired, { at: now, text: target.cause, why: item.why }].slice(-30);
        retired++;
        lines.push(`放下「${target.cause}」：${item.why}`);
    }
    let added = 0;
    let negativeAboutHim = 0;
    for (const item of decision.add) {
        if (added >= MAX_ADD) { lines.push('今晚记的够多了，剩下的留到下次'); break; }
        const problem = !item.kind ? `不认识的感受「${item.rawKind}」（开心 / 松了口气 / 担心 / 难过 / 烦 / 累）` : reviewProblem({ ...item, kind: item.kind }, state, guard, negativeAboutHim);
        if (problem || !item.kind) {
            state.rejected = [...state.rejected, { at: now, text: clip(item.cause, CAUSE_MAX), reason: problem ?? '不认识的感受' }].slice(-10);
            lines.push(`想记「${clip(item.cause, 30)}」，没成：${problem}`);
            continue;
        }
        const cited = item.evidence.map(id => guard.evidence.get(id)!);
        const at = Math.max(...cited.map(e => e.at));
        let n = 1;
        while (state.items.some(old => old.id === `r-${dayKey(now)}-${n}`)) n++;
        state.items.push({ id: `r-${dayKey(now)}-${n}`, at, kind: item.kind, strength: item.strength as 1 | 2, cause: item.cause.trim(), aboutHim: item.aboutHim, evidence: item.evidence, addedAt: now });
        if (item.aboutHim && (item.kind === 'sad' || item.kind === 'annoyed')) negativeAboutHim++;
        added++;
        lines.push(`记下：${FEELING_NAME[item.kind]}·${item.strength === 2 ? '明显' : '小事'}（${item.cause.trim()}）`);
    }
    // 散光了的不留（最慢的半衰期 8 小时 × 4 = 32 小时）
    state.items = state.items.filter(old => now - old.at <= KEEP_MS);
    return { lines, added, retired };
}

// ───────── 想的时候她看到什么 ─────────

export interface ReviewInput {
    char: string;
    user: string;
    persona: string;
    now: number;
    evidence: readonly Evidence[];
    /** 心里已经有的（别处算好的），一行一条，别重复记 */
    existing: readonly string[];
    items: readonly ReviewItem[];
}

export function reviewMessages(input: ReviewInput): OpenAIMessage[] {
    const d = new Date(input.now);
    const chat = input.evidence.filter(item => item.role !== 'diary');
    const diary = input.evidence.filter(item => item.role === 'diary');
    const chatText = chat.length ? chat.map(item => `${item.id} [${hm(item.at)}] ${item.role === 'him' ? input.user : '你'}：${item.text}`).join('\n') : '（最近没怎么聊）';
    const diaryText = diary.length ? diary.map(item => `${item.id}：${item.text}`).join('\n') : '（没有）';
    const existing = input.existing.length ? input.existing.map(line => `- ${line}`).join('\n') : '（现在没有明显的）';
    const mine = input.items.length ? input.items.map(item => `- ${item.id}｜${FEELING_NAME[item.kind]}·${item.strength === 2 ? '明显' : '小事'}｜${item.cause}（依据 ${item.evidence.join('、')}）`).join('\n') : '（现在没有）';
    const kinds = FEELING_KINDS.map(kind => FEELING_NAME[kind]).join(' / ');
    return [
        { role: 'system', content: `你是${input.char}。下面是你的设定摘要：\n${input.persona}\n\n现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}，你和他聊完有一阵了，一个人安静地回想刚才（和这一天）：有没有什么事真的让你心里有了感受。这是你自己的事，没有人替你定，也不用让谁满意；大多数日子并没有什么，那就什么都不记。` },
        { role: 'user', content: `你和${input.user}最近的聊天（m 开头是消息的编号，旧到新）：\n${chatText}\n\n你昨天今天的日记（d 开头）：\n${diaryText}\n\n你心里现在已经有的（别处算好的，别重复记）：\n${existing}\n\n你之前自己记下的：\n${mine}\n\n你写的这些，${input.user}用 /心境 都能看到。\n\n请只输出一个 JSON 对象（没有就输出 {}），字段都可以省略：\n{"add":[{"kind":"${kinds} 里选一个","strength":1,"cause":"发生了什么（${CAUSE_MIN}–${CAUSE_MAX} 字，用你自己的口气能说出来的事实）","evidence":["m12","m13"],"aboutHim":true}],"retire":[{"id":"上面你之前记的某条的 id","why":"为什么放下了（比如后来和好了、事情过去了）"}]}\n\n几条提醒（不是考你）：每一条都要在 evidence 里指出是哪几条消息或日记让你有的这个感受，编号必须是上面真有的，没有依据的不要记；strength 1 是小事（单独一件不会表现出来），2 是明显的（要 2 条以上依据），没有更重的——大事不由你记；aboutHim 只有这个感受是因为${input.user}说的话或态度才写 true，而且依据里要有他的消息；cause 写发生了什么，不写你「应该」有什么感受，不引用${input.user}的原话，不写别人的名字，不夸大；别因为他没回你就编出难过（那种另有地方算）；涉及承认自己是程序、危机、骗人的事不通过这里；一晚最多记 ${MAX_ADD} 条、放下 ${MAX_RETIRE} 条；真的没有就输出 {}，别硬凑。` },
    ];
}

// ───────── 什么时候想 ─────────

export interface ReviewDeps {
    dataDir: string;
    soulDir: string;
    now: () => number;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    /** 和他的聊天记录（旧到新，整份，函数里自己按时间截） */
    history: () => readonly StoredMessage[];
    persona: () => string;
    names: { char: string; user: string };
    /** 名单里别人的称呼 */
    others: () => readonly string[];
    /** 心里已经有的（别处算好的）：{种类, 来由} */
    existing: () => ReadonlyArray<{ kind: FeelingKind; cause: string }>;
    log: (message: string) => void;
}

export interface ReviewResult { ran: boolean; applied?: AppliedReview; error?: string }

/** 聊完半小时后才回想（最后一条消息至少这么久以前）；最后一条超过 12 小时前的不回想（早就过去了） */
export const SETTLE_MS = 30 * 60_000;
export const FRESH_MS = 12 * 3_600_000;
/** 自上次回想以来至少有几条新消息；两次尝试之间至少隔多久（成功失败都算）；一天最多试几次 */
export const MIN_NEW = 4;
export const MIN_GAP_MS = 60 * 60_000;
export const MAX_ATTEMPTS_PER_DAY = 8;

/** 该不该想：一段聊天刚结束（半小时以上、12 小时以内）、有新聊天、聊得够多、离上次尝试够久、今天没试够 */
export function reviewDue(state: ReviewState, evidence: readonly Evidence[], now: number): boolean {
    const chat = evidence.filter(item => item.role !== 'diary');
    if (chat.length < MIN_MESSAGES) return false;
    const lastAt = chat.at(-1)!.at;
    if (now - lastAt < SETTLE_MS || now - lastAt > FRESH_MS) return false;
    if (chat.filter(item => item.at > (state.lastWindow?.until ?? 0)).length < MIN_NEW) return false;
    if (state.lastAttemptAt && now - state.lastAttemptAt < MIN_GAP_MS) return false;
    return state.attempts.day !== dayKey(now) || state.attempts.n < MAX_ATTEMPTS_PER_DAY;
}

/** 一段聊天结束后想一次（没结束、聊得太少、没有新聊天、刚想过，什么都不做）。成功才记 lastReflectionAt；失败只记一次尝试，过 1 小时再试 */
export async function reviewIfDue(deps: ReviewDeps): Promise<ReviewResult> {
    const now = deps.now();
    const state = loadReviewState(deps.dataDir);
    const history = deps.history();
    const diaries = readDiaries({ soulDir: deps.soulDir, dataDir: deps.dataDir }, now, 1).map(entry => ({ date: entry.date, text: entry.text }));
    const evidence = reviewMaterial(history, diaries, now);
    if (!reviewDue(state, evidence, now)) return { ran: false };
    const messages = evidence.filter(item => item.role !== 'diary');
    state.lastAttemptAt = now;
    state.attempts = state.attempts.day === dayKey(now) ? { day: state.attempts.day, n: state.attempts.n + 1 } : { day: dayKey(now), n: 1 };
    saveReviewState(deps.dataDir, state);
    try {
        const existing = deps.existing();
        const reply = await deps.generate(reviewMessages({
            char: deps.names.char, user: deps.names.user, persona: deps.persona(), now, evidence,
            existing: existing.map(item => `${FEELING_NAME[item.kind]}（${item.cause}）`), items: state.items,
        }));
        const decision = parseReviewDecision(reply);
        if (!decision) throw new Error('回复里没有可用的 JSON');
        const fresh = loadReviewState(deps.dataDir);
        fresh.lastAttemptAt = state.lastAttemptAt;
        fresh.attempts = state.attempts;
        const applied = applyReviewDecision(fresh, decision, {
            evidence: new Map(evidence.map(item => [item.id, item])), now, his: hisLines(history, now), others: deps.others(), existing,
        });
        fresh.lastReflectionAt = now;
        fresh.lastWindow = { messages: messages.length, until: messages.at(-1)!.at };
        saveReviewState(deps.dataDir, fresh);
        deps.log(`心境回想：聊完回想了一次（${messages.length} 条消息）——记下 ${applied.added} 条、放下 ${applied.retired} 条${applied.lines.some(line => line.includes('没成')) ? '、有想记没成的' : ''}`);
        return { ran: true, applied };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(`心境回想：这次没想成（${detail}），1 小时后再试`);
        return { ran: true, error: detail };
    }
}

// ───────── 给他看 ─────────

/** /心境 的回复：以「（」开头（运维提示，不进聊天记录）；他只能看，不能改。current 是最近一次给他算的心境（可以没有） */
export function describeFeelingsForOwner(
    current: { at: number; felt: ReadonlyArray<{ kind: FeelingKind; level: string; cause: string; source: string }> } | undefined,
    state: ReviewState, now: number, reviewOn: boolean,
): string {
    const ago = (at: number) => { const minutes = Math.round((now - at) / 60_000); return minutes < 1 ? '刚刚' : minutes < 90 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`; };
    const sourceName = (source: string) => (source === 'world' ? '她那边的事' : source === 'him' ? '他的态度' : source === 'self' ? '她自己回想的' : '作者写下的事');
    const levelName = (level: string) => (level === 'strong' ? '很重' : level === 'clear' ? '明显' : '隐约');
    const shown = current?.felt.filter(item => item.level !== 'faint') ?? [];
    const lines = [
        current
            ? (shown.length ? `她此刻的心境（${ago(current.at)}算的）：\n${shown.map(item => `- ${FEELING_NAME[item.kind]}·${levelName(item.level)}：${item.cause}（${sourceName(item.source)}）`).join('\n')}` : `她此刻没有明显的感受（${ago(current.at)}算的）。`)
            : '最近还没有给她算过心境（她回你的时候才算）。',
        ...(reviewOn
            ? [
                state.items.length ? `她聊完自己回想、指出了依据的（${state.items.length} 条）：\n${state.items.map(item => `- ${FEELING_NAME[item.kind]}·${item.strength === 2 ? '明显' : '小事'}：${item.cause}（${ago(item.at)}的事；依据 ${item.evidence.join('、')}）`).join('\n')}` : '她还没有聊完回想出来的感受（一段聊天结束半小时后想一次，最近要有 8 条以上聊天、其中有 4 条以上是新的才会想）。',
                ...(state.retired.length ? [`她放下的：\n${state.retired.slice(-5).map(item => `- ${item.text}（${item.why}）`).join('\n')}`] : []),
                ...(state.rejected.length ? [`她想记、但没成的：\n${state.rejected.slice(-5).map(item => `- ${item.text}（${item.reason}）`).join('\n')}`] : []),
            ]
            : []),
        '这些都是从事实里算出来的，不是演的；你只能看，不能改。',
    ];
    return `（${lines.join('\n\n')}）`;
}
