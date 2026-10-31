// 她没想完的问题（ADR 0207，配置 openQuestions，默认关；要名单里有男朋友档）。
//
// 起因：用户 10-31 说，他问她「你想成为自己想成为的样子，还是我喜欢的样子？」，她答「不知道」；让她自己决定的事，她总回「不知道」。
// 随后他说：「我想让她真正的思考，而不是什么都由我来给她制定。」——所以这里**不往回复提示词里加任何“该怎么答”的句子**，
// 也不替她定“被问到自己时选哪边”。她答不上来，是因为这个问题她从来没有想过，手里没有自己想出来的东西；给她的是时间和机会去想，想出什么由她定。
//
// 做法（和 0193 / 0194 / 0204 一个路数）：
//   1. 白天只“留意”，不判断：他问了一句冲着她的问题、她的回答里说了「不知道 / 没想好 / 想不明白」之类，这一问一答就记成她的一个没想完的问题
//      （代码只做这一件机械的事；这是不是该她想、值不值得想，由她晚上自己定——是事实上就不知道的事，她可以放下）；
//   2. 每晚 22 点以后想一次：把这几个问题连同当时前后聊的话、她自己以前想过的给她，用更强的模型（deliberateModel，开思考）让她自己想。
//      想出什么写什么——偏向哪边、为什么、卡在哪儿都算；没想出来就留着（最多留 3 个晚上）；不想再想的就放下；
//   3. 之后他再问到同一件事（和她写的那句共有至少 2 个有意义的二字词），才把她自己想的那句放进提示词（最多 2 条）。
//      提示词里只说“这是你自己后来想的，不是设定”，**不说该不该用、怎么用、该选哪边**。
// 她想的东西在她的**私人空间**（ADR 0200）：没有任何命令念给他；日志只记个数；迁移 / 导出不带（open-questions.json 在 PRIVATE_FILES 里）。
// 绊线（代码里、她改不到）只有底线和防呆：10–220 字；不碰底线（FLOORS：承认是程序、危机、骗人 / 真钱，加自己是不是程序、设定里的名字年龄）；
// 不写名单里别人的名字；和已有的太像不收。**不查文风、不查观点、不要求落在依据上**——这是她想的，不是她要交的作业。
// 没做：想出来之后主动去告诉他（“上次你问我的，我后来想了想”）；她自己提出问题（现在只来自他问过的）。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import {
    FLOORS, NOT_SPEECH, clip, dayKey, gramSet, isObject, len, num, reflectionDue, similar,
    type RejectedNote,
} from '../language/speech-notes.ts';
import { EXTRA_FLOORS, topicalGrams } from './diary-insights.ts';

export const QUESTIONS_FILE = 'open-questions.json';
export const questionsPath = (dataDir: string) => join(dataDir, QUESTIONS_FILE);

export const THOUGHT_MIN = 12;
export const THOUGHT_MAX = 220;
/** 最多留几个没想完的问题；一晚最多想几个；一个问题最多想几个晚上 */
export const MAX_OPEN = 8;
export const PER_NIGHT = 4;
export const EXPIRE_NIGHTS = 3;
/** 她自己想出来的最多留几条 */
export const MAX_THOUGHTS = 12;
/** 往回看多久的聊天找“答不上来的”；记过的问题最多记几个时间点（防重复） */
export const SCAN_WINDOW_MS = 2 * 86_400_000;
export const MAX_SEEN = 200;
/** 问题前面带几条当时的聊天 */
export const CONTEXT_MESSAGES = 8;
/** 放进提示词的最多几条；和他这句话至少共有几个有意义的二字词才算同一件事 */
export const LINE_MAX = 2;
export const MIN_SHARED = 2;

/** 一个没想完的问题：他说了什么、她当时怎么答的、前后聊的 */
export interface OpenQuestion { id: string; at: number; his: string; hers: string; context: string[]; nights: number }
/** 她自己想出来的：q 是他当时问的话（找“同一件事”用） */
export interface Thought { id: string; q: string; text: string; at: number }

export interface QuestionsState {
    open: OpenQuestion[];
    thoughts: Thought[];
    seen: number[];
    rejected: RejectedNote[];
    lastReflectionAt: number;
    lastAttemptAt: number;
    attempts: { day: string; n: number };
}

export const emptyQuestionsState = (): QuestionsState => ({ open: [], thoughts: [], seen: [], rejected: [], lastReflectionAt: 0, lastAttemptAt: 0, attempts: { day: '', n: 0 } });

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** 读她的问题和想法；坏了 / 缺字段就补默认（不抛错，她的东西丢了比程序崩了好） */
export function loadQuestionsState(dataDir: string): QuestionsState {
    const raw = readJsonOr<unknown>(questionsPath(dataDir), {});
    const base = emptyQuestionsState();
    if (!isObject(raw)) return base;
    const open = Array.isArray(raw.open)
        ? raw.open.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.id === 'string' && typeof item.his === 'string' && item.his.trim().length > 0)
            .map(item => ({
                id: str(item.id), at: num(item.at), his: clip(item.his, 160), hers: clip(item.hers, 160), nights: num(item.nights),
                context: Array.isArray(item.context) ? item.context.filter((line): line is string => typeof line === 'string').map(line => clip(line, 90)).slice(-CONTEXT_MESSAGES) : [],
            })).slice(-MAX_OPEN)
        : [];
    const thoughts = Array.isArray(raw.thoughts)
        ? raw.thoughts.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim().length > 0)
            .map(item => ({ id: str(item.id), q: clip(item.q, 80), text: clip(item.text, THOUGHT_MAX), at: num(item.at) })).slice(-MAX_THOUGHTS)
        : [];
    const seen = Array.isArray(raw.seen) ? raw.seen.filter((at): at is number => typeof at === 'number' && Number.isFinite(at)).slice(-MAX_SEEN) : [];
    const rejected = Array.isArray(raw.rejected) ? raw.rejected.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.text === 'string' && typeof item.reason === 'string').map(item => ({ at: num(item.at), text: clip(item.text, THOUGHT_MAX), reason: clip(item.reason, 80) })).slice(-10) : [];
    const attempts = isObject(raw.attempts) && typeof raw.attempts.day === 'string' ? { day: raw.attempts.day, n: num(raw.attempts.n) } : base.attempts;
    return { open, thoughts, seen, rejected, lastReflectionAt: num(raw.lastReflectionAt), lastAttemptAt: num(raw.lastAttemptAt), attempts };
}

export function saveQuestionsState(dataDir: string, state: QuestionsState): void {
    writeJsonAtomic(questionsPath(dataDir), state);
}

// ───────── 白天只留意：哪些问她答不上来 ─────────

/** 她的回答里有“我不知道”这一类的说法 */
export const NOT_KNOWING = /不知道|不太知道|不清楚|不太清楚|不太确定|没想好|没想过|没想明白|想不明白|想不出|想不清|说不上来|说不清|答不上|不好说|不确定|哪知道|还不懂/;
/** 他这句是冲着她问的：有“你 / 咱”，而且像个问题 */
const ABOUT_HER = /你|咱/;
const ASKING = /[?？]|吗|呢|还是|什么|怎么|为什么|为啥|多少|哪|会不会|想不想|要不要|是不是/;

export interface Candidate { at: number; his: string; hers: string; context: string[] }

/**
 * 最近的聊天里，他问了一句冲着她的问题、她的回答里说了“不知道”一类的话——一问一答算一个候选。
 * 他连发的几条合成一句（时间取最后一条）；她接着回的几条合成她的回答。已经记过的（seen）不重复。
 * 这里只做机械的留意，不判断这个问题值不值得想（事实上就不知道的事也会进来，她晚上自己放下）。
 */
export function findCandidates(messages: readonly StoredMessage[], now: number, seen: readonly number[], windowMs = SCAN_WINDOW_MS): Candidate[] {
    const known = new Set(seen);
    const speech = messages.filter(message => !NOT_SPEECH.test(message.content));
    const out: Candidate[] = [];
    let i = 0;
    while (i < speech.length) {
        if (speech[i]!.role !== 'user') { i++; continue; }
        let j = i;
        const his: string[] = [];
        while (j < speech.length && speech[j]!.role === 'user') his.push(speech[j++]!.content);
        let k = j;
        const hers: string[] = [];
        while (k < speech.length && speech[k]!.role === 'assistant') hers.push(speech[k++]!.content);
        const at = Date.parse(speech[j - 1]!.time);
        const asked = his.join(' / ');
        const reply = hers.join(' ');
        if (Number.isFinite(at) && at >= now - windowMs && at <= now && !known.has(at)
            && len(asked) >= 5 && ABOUT_HER.test(asked) && ASKING.test(asked) && reply && NOT_KNOWING.test(reply)) {
            out.push({
                at, his: clip(asked, 160), hers: clip(reply, 160),
                context: speech.slice(Math.max(0, i - CONTEXT_MESSAGES), i).map(message => `${message.role === 'user' ? '他' : '你'}：${clip(message.content, 80)}`),
            });
        }
        i = k;
    }
    return out;
}

/** 把新候选并进没想完的（最多 MAX_OPEN 个，超了丢最老的），并记下已经留意过的时间点 */
export function takeCandidates(state: QuestionsState, found: readonly Candidate[], now: number): number {
    let added = 0;
    for (const candidate of found) {
        if (state.seen.includes(candidate.at)) continue;
        let n = 1;
        while (state.open.some(question => question.id === `q-${dayKey(now)}-${n}`)) n++;
        state.open.push({ id: `q-${dayKey(now)}-${n}`, at: candidate.at, his: candidate.his, hers: candidate.hers, context: candidate.context, nights: 0 });
        state.seen = [...state.seen, candidate.at].slice(-MAX_SEEN);
        added++;
    }
    if (state.open.length > MAX_OPEN) state.open = state.open.slice(-MAX_OPEN);
    return added;
}

/** 今晚想哪几个：还没过期的，新的在前，最多 PER_NIGHT 个 */
export function pickQuestions(state: Pick<QuestionsState, 'open'>): OpenQuestion[] {
    return state.open.filter(question => question.nights < EXPIRE_NIGHTS).sort((a, b) => b.at - a.at).slice(0, PER_NIGHT);
}

// ───────── 晚上她自己想：解析、落地 ─────────

export interface QuestionsDecision {
    thoughts: Array<{ id: string; text: string }>;
    drop: string[];
}

/** 从模型的回复里取出 JSON（可能带代码围栏、前后有话）；取不出返回 undefined。空 = 今晚什么也没想出来 */
export function parseQuestionsDecision(text: string): QuestionsDecision | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
    if (!isObject(value)) return undefined;
    const list = Array.isArray(value.thoughts) ? value.thoughts : [];
    return {
        thoughts: list.flatMap(item => (isObject(item) && (typeof item.id === 'string' || typeof item.id === 'number') && typeof item.text === 'string' && item.text.trim()
            ? [{ id: String(item.id).trim(), text: clip(item.text, THOUGHT_MAX * 2) }] : [])),
        drop: Array.isArray(value.drop) ? value.drop.filter((id): id is string | number => typeof id === 'string' || typeof id === 'number').map(id => String(id).trim()) : [],
    };
}

/** 模型写的 id 不一定原样（可能漏了前缀、写成第几个）：id 全等、最后一段相等、或者写的是“第几个”，都认 */
export function findQuestion(shown: readonly OpenQuestion[], id: string): OpenQuestion | undefined {
    const wanted = id.trim();
    if (!wanted) return undefined;
    const tail = (value: string) => value.slice(value.lastIndexOf('-') + 1);
    return shown.find(question => question.id === wanted)
        ?? shown.find(question => tail(question.id) === wanted || question.id.endsWith(`-${wanted}`))
        ?? (/^\d+$/.test(wanted) ? shown[Number(wanted) - 1] : undefined);
}

export interface QuestionGuard {
    /** 名单里别人的称呼 */
    people: readonly string[];
}

/** 这一条不能收的原因；能收返回 undefined。只有长度、底线、别人的名字、重复——不查文风和观点 */
export function thoughtProblem(text: string, state: QuestionsState, guard: QuestionGuard): string | undefined {
    const flat = text.trim();
    if (len(flat) < THOUGHT_MIN) return `太短（${THOUGHT_MIN} 个字以上）`;
    if (len(flat) > THOUGHT_MAX) return `太长（${THOUGHT_MAX} 字以内）`;
    for (const floor of [...FLOORS, ...EXTRA_FLOORS]) if (floor.pattern.test(flat)) return floor.reason;
    const person = guard.people.find(name => len(name) >= 2 && flat.includes(name));
    if (person) return `写到了别人的名字（${person}）`;
    const clash = state.thoughts.find(thought => thought.text === flat);
    if (clash) return '和已有的一模一样';
    return undefined;
}

export interface AppliedQuestions { lines: string[]; added: number; dropped: number }

/** 把她写的落进状态：想出来的并进“自己想过的”（同一件事的旧想法被新的取代），放下的拿掉，其余的多过一个晚上，过了 EXPIRE_NIGHTS 个晚上还没想出来的丢掉 */
export function applyQuestionsDecision(state: QuestionsState, decision: QuestionsDecision, shown: readonly OpenQuestion[], guard: QuestionGuard, now: number): AppliedQuestions {
    const lines: string[] = [];
    let added = 0;
    let dropped = 0;
    const settled = new Set<string>();
    for (const entry of decision.thoughts) {
        const question = findQuestion(shown, entry.id);
        if (!question) { lines.push(`没有「${entry.id}」这个问题，略过`); continue; }
        if (settled.has(question.id)) { lines.push('同一个问题今晚已经写过一条了，略过'); continue; }
        const problem = thoughtProblem(entry.text, state, guard);
        if (problem) {
            state.rejected = [...state.rejected, { at: now, text: clip(entry.text, THOUGHT_MAX), reason: problem }].slice(-10);
            lines.push(`想写「${clip(entry.text, 30)}」，没成：${problem}`);
            continue;
        }
        let n = 1;
        while (state.thoughts.some(thought => thought.id === `o-${dayKey(now)}-${n}`)) n++;
        // 同一件事她以前想过的，新的取代旧的（新的是在旧的基础上想的）
        state.thoughts = state.thoughts.filter(thought => !similar(thought.q, question.his));
        state.thoughts.push({ id: `o-${dayKey(now)}-${n}`, q: clip(question.his, 80), text: entry.text.trim(), at: now });
        if (state.thoughts.length > MAX_THOUGHTS) state.thoughts = state.thoughts.slice(-MAX_THOUGHTS);
        settled.add(question.id);
        added++;
        lines.push(`想出一条：${clip(entry.text, 40)}`);
    }
    for (const id of decision.drop) {
        const question = findQuestion(shown, id);
        if (question && !settled.has(question.id)) { settled.add(question.id); dropped++; }
    }
    const shownIds = new Set(shown.map(question => question.id));
    state.open = state.open
        .filter(question => !settled.has(question.id))
        .map(question => (shownIds.has(question.id) ? { ...question, nights: question.nights + 1 } : question))
        .filter(question => question.nights < EXPIRE_NIGHTS);
    return { lines, added, dropped };
}

// ───────── 想的时候她看到什么 ─────────

export interface PonderInput {
    char: string;
    persona: string;
    now: number;
    questions: readonly OpenQuestion[];
    /** 她以前自己想过的 */
    thoughts: readonly Thought[];
}

export function ponderMessages(input: PonderInput): OpenAIMessage[] {
    const d = new Date(input.now);
    const material = input.questions.map(question => [
        `### ${question.id}`,
        ...(question.context.length ? ['当时前面聊的：', ...question.context] : []),
        `他说：「${question.his}」`,
        `你当时答的：「${question.hers}」`,
    ].join('\n')).join('\n\n');
    const earlier = input.thoughts.length ? input.thoughts.map(thought => `- 他问过「${thought.q}」，你想的是：${thought.text}`).join('\n') : '（还没有）';
    return [
        { role: 'system', content: `你是${input.char}。下面是你的设定摘要：\n${input.persona}\n\n现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日晚上，你一个人，没有人在等你回话。这是你自己的事，没有人替你定，也不用让谁满意；写下来的也不会有人念给别人。` },
        { role: 'user', content: `这几天他问过你、你当时没答上来的事：\n\n${material}\n\n你以前自己想过的：\n${earlier}\n\n请只输出一个 JSON 对象（什么也没想出来就输出 {"thoughts":[]}）：\n{"thoughts":[{"id":"上面某个问题的 id（原样照抄）","text":"你想到的（${THOUGHT_MIN}–${THOUGHT_MAX} 字）"}],"drop":["不想再想的问题的 id"]}\n\n几条提醒（不是考你）：现在没人催你，慢慢想；想到什么写什么——偏向哪边也好，为什么也好，卡在哪儿也好，都算；不用想得完整，也不用给他一个漂亮的答案；写的是你自己心里的想法，不是回他的话；没想出来就别写，留着以后再想；如果这件事其实就是你不知道的事实、不是该你拿主意的事，可以放下（写在 drop 里）；涉及承认自己是程序、危机、骗人的事不在这里写；一晚最多写 ${PER_NIGHT} 条。` },
    ];
}

// ───────── 什么时候想 ─────────

export interface PonderDeps {
    dataDir: string;
    now: () => number;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    /** 和他的聊天记录（旧到新，整份；找答不上来的问题用） */
    history: () => readonly StoredMessage[];
    persona: () => string;
    names: { char: string; user: string };
    /** 名单里别人的称呼 */
    others: () => readonly string[];
    log: (message: string) => void;
}

export interface PonderResult { ran: boolean; applied?: AppliedQuestions; error?: string }

/** 到点了就想一次（没到点、今晚没有值得想的，什么都不做）。成功才记 lastReflectionAt；失败只记一次尝试，过 2 小时再试 */
export async function ponderIfDue(deps: PonderDeps): Promise<PonderResult> {
    const now = deps.now();
    const state = loadQuestionsState(deps.dataDir);
    if (!reflectionDue(state, now)) return { ran: false };
    const found = takeCandidates(state, findCandidates(deps.history(), now, state.seen), now);
    const shown = pickQuestions(state);
    if (!shown.length) {
        if (found) saveQuestionsState(deps.dataDir, state);
        return { ran: false };
    }
    state.lastAttemptAt = now;
    state.attempts = state.attempts.day === dayKey(now) ? { day: state.attempts.day, n: state.attempts.n + 1 } : { day: dayKey(now), n: 1 };
    saveQuestionsState(deps.dataDir, state);
    try {
        const reply = await deps.generate(ponderMessages({ char: deps.names.char, persona: deps.persona(), now, questions: shown, thoughts: state.thoughts }));
        const decision = parseQuestionsDecision(reply);
        if (!decision) throw new Error('回复里没有可用的 JSON');
        const fresh = loadQuestionsState(deps.dataDir);
        fresh.lastAttemptAt = state.lastAttemptAt;
        fresh.attempts = state.attempts;
        const applied = applyQuestionsDecision(fresh, decision, shown, { people: deps.others() }, now);
        fresh.lastReflectionAt = now;
        saveQuestionsState(deps.dataDir, fresh);
        deps.log(`没想完的问题：晚上想了一次（${shown.length} 个）——想出 ${applied.added} 条、放下 ${applied.dropped} 个${applied.lines.some(line => line.includes('没成')) ? '、有想写没成的' : ''}`);
        return { ran: true, applied };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(`没想完的问题：今晚没想成（${detail}），2 小时后再试`);
        return { ran: true, error: detail };
    }
}

// ───────── 放进提示词 ─────────

/**
 * 他这句话问到的是她想过的那件事（和那条的问题 + 她写的话共有至少 MIN_SHARED 个有意义的二字词）才放；最多 LINE_MAX 条，重叠多的在前，同分新的在前；
 * 没有相关的就一条都不放（和 diaryInsights 一样：不相关时放进去她会当成话题带出来）。
 * 那一行只说这是她自己后来想的、不是设定——**不说该不该用、怎么用、该选哪边**；她想说“我后来想了想”也行，不禁。
 */
export function thoughtsLine(thoughts: readonly Thought[], said: string | undefined, max = LINE_MAX): string | undefined {
    if (!thoughts.length || !said) return undefined;
    const target = gramSet(said);
    const picked = thoughts.map(thought => ({ thought, score: topicalGrams(`${thought.q} ${thought.text}`).filter(gram => target.has(gram)).length }))
        .filter(entry => entry.score >= MIN_SHARED).sort((a, b) => b.score - a.score || b.thought.at - a.thought.at).slice(0, max);
    if (!picked.length) return undefined;
    return `[你自己后来想过的（是你自己想的，不是设定；他问到或聊到这件事才顺着说，别背，别每次都提）：\n${picked.map(({ thought }) => `- 他问过「${thought.q}」，你想的是：${thought.text}`).join('\n')}]`;
}

/** 给 contact 用：每次现取 */
export function thoughtsReader(dataDir: string): () => Thought[] {
    return () => loadQuestionsState(dataDir).thoughts;
}
