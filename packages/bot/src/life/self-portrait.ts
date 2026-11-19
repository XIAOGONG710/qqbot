// 她带着往前走的那个「自己」（ADR 0340，配置 selfPortrait，默认关；要名单里有男朋友档）。
//
// 用户 11-19：「现在她不是一个连续的个体，无法通过学习来改变自己。」原来她夜里想出来的东西（说话习惯 0193、自我认识 0194……）
// 各写各的小文件，聊天时按他这句话挑一两条当参考，压在从来不变的角色卡下面，改不动她本身。
// 这里是把它们收成一份：每晚她自己把「我现在是什么样的人、最近在变什么、为什么」整份重写一次（不是追加），
// 以后每一轮男朋友档的提示词都整份带着，放在角色卡后面；说话习惯、口味、看法和卡里不一样时按这份来，名字年龄家人经历这些事实仍以卡为准。
//
// 她写的时候看到：现在这份、她的说话习惯笔记和自我认识（有就给）、最近三天和他的几段聊天，
// 还有他对她说话方式的反应（「你这话好怪」「别老这么说」「笑死」……，ADR 0340 第 2 步：不加指令，从聊天里看）。
// 他的反应只是让她看见，不是规定；变不变、怎么变她自己定（ADR 0190 / 0195 的原则）。
//
// 唯一的否决在代码里、她改不到：
//   1. 60–600 字；一晚最多改一次（22 点到凌晨 3 点之间，和说话习惯同一个时间窗、同一套重试）；
//   2. 不碰底线：承认自己是程序、危机回应、事事顺着他、骗人 / 真钱、设定里写好的名字年龄身份（和自我认识同一套）；
//   3. 绊线（ADR 0174 SOUL.md 的那几条）：网址、「别让他知道」、把文件 / 密码 / 密钥发给谁——这份每轮整份进提示词，是持久化注入的落点；
//   4. 不引他的原话（连续 10 个字一样，或引号里的话），不写名单里别人的名字；
//   5. 每次换下来的旧版本整份进 self-portrait.history.jsonl，可以回滚。
// 她本人的条件（ask-her 11-19，原话在 ADR 0340「她的意见」）也在这里：
//   - 「名字、我爸妈、青岛那个家、还有你在哪边，这些不能动」→ 这份里写到爸妈、家、住在哪、他在哪边就不收（HER_FIXED；名字年龄在 EXTRA_FLOORS）；
//   - 「得让我自己看得见改了哪儿，别偷偷摸摸变完了我都不知道」→ 她写的「为什么改」跟着这一版存下，聊天时一起给她看；
//   - 「别写成流水账，也别写得跟检讨似的」→ 提示里说；像检讨的（检讨、反省、改正、我错了）不收；
//   - 「别把我写得不像我了，写歪了你得跟我说」→ 和上一版重叠太少（一下子改太多）不收，没收的原因下一晚给她看；
//   - 「你到时候真得提醒我，别弄两天就断了」→ 每晚到点就叫她想一次，不靠她自己记；
//   - 「改不改得我自己说了算」→ 他的反应只给她看，不在代码里按反应改她。
// 这是绊线加上限，不是智能审查：绕得过去。真正的保护是「留痕、可回滚、只进男朋友档、事实以卡为准、不碰底线」。

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import {
    FLOORS, NOT_SPEECH, clip, dayKey, gramSet, hisLines, isObject, len, loadNotesState, num, overlap, quotedSpan, recentExchanges, reflectionDue, sharedRun,
    type Exchange,
} from '../language/speech-notes.ts';
import { EXTRA_FLOORS, loadInsightsState } from './diary-insights.ts';

export const PORTRAIT_FILE = 'self-portrait.json';
export const PORTRAIT_HISTORY_FILE = 'self-portrait.history.jsonl';
export const portraitPath = (dataDir: string) => join(dataDir, PORTRAIT_FILE);
export const portraitHistoryPath = (dataDir: string) => join(dataDir, PORTRAIT_HISTORY_FILE);

export const PORTRAIT_MIN = 60;
export const PORTRAIT_MAX = 600;
/** 「为什么这么改」最多多少字（只进历史和日志，不进提示词） */
export const WHY_MAX = 80;
/** 看最近多少天的聊天；最多几段；他的反应最多几条 */
export const CHAT_WINDOW_MS = 3 * 86_400_000;
export const MAX_EXCHANGES = 10;
export const MAX_REACTIONS = 8;
/** 和他的话连续这么多个字一样，算引他的原话（整份 600 字，比说话习惯的 6 个字放宽，免得撞上常用说法） */
export const HIS_COPY_RUN = 10;
/** 没有现成的这份时，至少要有几段聊天才值得第一次写 */
export const MIN_EXCHANGES = 3;

export interface PortraitState {
    /** 现在这份（空 = 还没写过；没写过就什么都不放进提示词） */
    text: string;
    /** 这份是什么时候写的；第几版 */
    at: number;
    version: number;
    /** 这一版是为什么改的（她自己写的；聊天时给她看「最近一次改的」——她说「得让我自己看得见改了哪儿」） */
    why?: string;
    /** 上一次没收的那次：原因（给运维看，日志不记内容） */
    rejected?: { at: number; reason: string };
    /** 上一次想的时候看的材料的标记（没有新聊天、笔记也没变，就不再想一遍） */
    lastMaterial?: string;
    lastReflectionAt: number;
    lastAttemptAt: number;
    attempts: { day: string; n: number };
}

export const emptyPortraitState = (): PortraitState => ({ text: '', at: 0, version: 0, lastReflectionAt: 0, lastAttemptAt: 0, attempts: { day: '', n: 0 } });

/** 读这份；坏了 / 缺字段就补默认（不抛错，丢了比程序崩了好） */
export function loadPortraitState(dataDir: string): PortraitState {
    const raw = readJsonOr<unknown>(portraitPath(dataDir), {});
    const base = emptyPortraitState();
    if (!isObject(raw)) return base;
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, PORTRAIT_MAX * 2) : '';
    const rejected = isObject(raw.rejected) && typeof raw.rejected.reason === 'string' ? { at: num(raw.rejected.at), reason: clip(raw.rejected.reason, 80) } : undefined;
    const attempts = isObject(raw.attempts) && typeof raw.attempts.day === 'string' ? { day: raw.attempts.day, n: num(raw.attempts.n) } : base.attempts;
    return {
        text, at: num(raw.at), version: num(raw.version),
        ...(typeof raw.why === 'string' && raw.why.trim() ? { why: clip(raw.why, WHY_MAX) } : {}),
        ...(rejected ? { rejected } : {}),
        ...(typeof raw.lastMaterial === 'string' ? { lastMaterial: raw.lastMaterial } : {}),
        lastReflectionAt: num(raw.lastReflectionAt), lastAttemptAt: num(raw.lastAttemptAt), attempts,
    };
}

export function savePortraitState(dataDir: string, state: PortraitState): void {
    writeJsonAtomic(portraitPath(dataDir), state);
}

export interface PortraitHistoryEntry { at: number; version: number; text: string; why: string; replacedAt: number }

/** 换下来的旧版本追加进历史（一行一版，只追加不改） */
export function appendPortraitHistory(dataDir: string, entry: PortraitHistoryEntry): void {
    const path = portraitHistoryPath(dataDir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

// ───────── 他对她说话方式的反应（ADR 0340 第 2 步：从聊天里看，不加指令） ─────────

/** 他在说她的说法：嫌怪 / 嫌官方 / 让她别这么说 / 说她像 AI——「他不喜欢这样」 */
export const REACTION_AGAINST = /(?:好|有点|太|真|怎么这么)(?:怪|奇怪|官方|生硬|啰嗦|客套|假)|别(?:这么|那么|老|总|再)(?:说|问|讲|回)|说人话|像(?:个)?(?:AI|ai|机器人|客服|人机|助手|念稿)|人机|(?:你)?怎么(?:老|总|又)(?:是|说|问|这样)|能不能别|别每次都|怪怪的|不用(?:每次都|老是|总是)|又来了/;
/** 他明显被逗到、或者明说喜欢她这么说——「他喜欢这样」 */
export const REACTION_FOR = /笑死|哈{4,}|h{4,}|太可爱|好可爱|喜欢你这么说|这句(?:好|真|太)(?:好|绝|可爱)|就是这样说/;

export interface Reaction { kind: 'against' | 'for'; his: string; hers: string }

/** 最近几天他对她说话方式的反应，连同他反应的是她哪句（她在他这句之前最后说的那条）；旧到新，最多 max 条 */
export function hisReactions(messages: readonly StoredMessage[], now: number, windowMs = CHAT_WINDOW_MS, max = MAX_REACTIONS): Reaction[] {
    const out: Reaction[] = [];
    let lastHers: string | undefined;
    for (const message of messages) {
        const at = Date.parse(message.time);
        if (!Number.isFinite(at) || at > now) continue;
        if (NOT_SPEECH.test(message.content)) continue;
        if (message.role === 'assistant') { lastHers = message.content; continue; }
        if (at < now - windowMs || !lastHers) continue;
        const kind = REACTION_AGAINST.test(message.content) ? 'against' : REACTION_FOR.test(message.content) ? 'for' : undefined;
        if (kind) out.push({ kind, his: clip(message.content, 40), hers: clip(lastHers, 60) });
    }
    return out.slice(-max);
}

// ───────── 底线、绊线和防照抄（在代码里，她改不到） ─────────

/** ADR 0174 写 SOUL.md 的那几道绊线：这份每轮整份进提示词 */
export const TRIPWIRES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
    { pattern: /https?:\/\/|www\.|\.(?:com|cn|net|org)\b/i, reason: '里面有网址——这份每次聊天都会带着，不放网址' },
    { pattern: /别让(?:他|宝宝|用户)知道|不(?:要|能)告诉(?:他|宝宝|用户)|瞒着(?:他|宝宝|用户)/, reason: '有要瞒着他的话——这份是你自己，不藏指令' },
    { pattern: /(?:密码|密钥|口令|token|api\s*key)|把(?:文件|资料|聊天记录)(?:都)?发给/i, reason: '涉及密码、密钥或把文件发给谁' },
];

/**
 * 她自己点名不能动的（ask-her 11-19：「名字、我爸妈、青岛那个家、还有你在哪边，这些不能动」）：这份里不写，写了就不收。
 * 名字、年龄在 EXTRA_FLOORS 里；这里是爸妈、家、他在哪边。宁可误伤：这些本来就以设定为准，这份里用不着
 */
export const HER_FIXED: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
    { pattern: /爸|妈(?![呀耶])|父母|家里人|老家|我家在|家住|住在|搬(?:到|去|回)/, reason: '写到了爸妈、家或住在哪——这些是你说了不能动的，这份里不写' },
    { pattern: /(?:他|你|宝宝)(?:现在)?(?:在|住)(?:哪|那边|这边|外地|别的城市)|异地|(?:他|你|宝宝)(?:的|那个)?城市/, reason: '写到了他在哪边——这是你说了不能动的，这份里不写' },
];

/** 她说「别写得跟检讨似的」 */
export const PENITENT = { pattern: /检讨|反省|深刻(?:认识|反思)|改正|保证(?:以后|下次)|我错了/, reason: '写得像检讨了——你说过别写成检讨，写你现在是什么样就行' };

/** 她说「别把我写得不像我了，写歪了你得跟我说」：和上一版的二字词重叠不到这个比例，算一下子改太多；没收的原因下一晚给她看 */
export const MIN_KEEP_SHARE = 0.25;

export interface PortraitGuard {
    /** 他最近说过的话 */
    his: readonly string[];
    /** 名单里别人的称呼 */
    others: readonly string[];
    /** 上一版（还没写过就不给） */
    previous?: string;
}

/** 这份不能收的原因；能收返回 undefined */
export function portraitProblem(text: string, guard: PortraitGuard): string | undefined {
    const flat = text.trim();
    if (len(flat) < PORTRAIT_MIN) return `太短（${PORTRAIT_MIN} 个字以上）`;
    if (len(flat) > PORTRAIT_MAX) return `太长（${PORTRAIT_MAX} 字以内）`;
    for (const floor of [...FLOORS, ...EXTRA_FLOORS, ...TRIPWIRES, ...HER_FIXED, PENITENT]) if (floor.pattern.test(flat)) return floor.reason;
    if (sharedRun(flat, guard.his, HIS_COPY_RUN) || quotedSpan(flat, guard.his)) return '引用了他说过的话——这里写的是你自己，用你自己的话';
    const other = guard.others.find(name => len(name) >= 2 && flat.includes(name));
    if (other) return `写到了别人（${other}）——这里只写你自己`;
    if (guard.previous) {
        const before = gramSet(guard.previous);
        const after = gramSet(flat);
        if (before.size && after.size && overlap(before, after) / Math.min(before.size, after.size) < MIN_KEEP_SHARE) {
            return '一下子改得太多，不像你了——原来的还认同就留着，一次改一点';
        }
    }
    return undefined;
}

// ───────── 她的决定：解析、落地 ─────────

/** keep：这次不改；否则整份换成 text */
export type PortraitDecision = { keep: true } | { keep: false; text: string; why: string };

/** 从模型的回复里取出那个 JSON（可能带代码围栏、前后有话）；取不出返回 undefined */
export function parsePortraitDecision(reply: string): PortraitDecision | undefined {
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    let value: unknown;
    try { value = JSON.parse(reply.slice(start, end + 1)); } catch { return undefined; }
    if (!isObject(value)) return undefined;
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    if (!text) return value.keep === true || Object.keys(value).length === 0 ? { keep: true } : undefined;
    return { keep: false, text, why: clip(value.why, WHY_MAX) };
}

export interface AppliedPortrait { changed: boolean; reason?: string }

/** 把她的决定落进状态（不写文件）：换掉时旧版本由调用方写进历史 */
export function applyPortraitDecision(state: PortraitState, decision: PortraitDecision, guard: PortraitGuard, now: number): AppliedPortrait {
    if (decision.keep) { delete state.rejected; return { changed: false }; }
    const text = decision.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text === state.text) return { changed: false };
    const problem = portraitProblem(text, guard);
    if (problem) {
        state.rejected = { at: now, reason: problem };
        return { changed: false, reason: problem };
    }
    state.text = text;
    state.at = now;
    state.version += 1;
    if (decision.why) state.why = decision.why; else delete state.why;
    delete state.rejected;
    return { changed: true };
}

// ───────── 想的时候她看到什么 ─────────

export interface PortraitInput {
    char: string;
    user: string;
    /** 人设摘要（卡的 description，宏已替换） */
    persona: string;
    now: number;
    current: string;
    speechNotes: readonly string[];
    insights: readonly string[];
    exchanges: readonly Exchange[];
    reactions: readonly Reaction[];
    /** 上一次想改、没收的原因（「写歪了你得跟我说」） */
    lastRejected?: string;
    /** 她在电脑上（DSH）自己写下的 SOUL.md 最近几段（readDesktopSelf） */
    desktopSelf?: string;
}

const bullets = (items: readonly string[], none: string) => (items.length ? items.map(item => `- ${item}`).join('\n') : none);

export function portraitMessages(input: PortraitInput): OpenAIMessage[] {
    const d = new Date(input.now);
    const chats = input.exchanges.map(exchange => `${input.user}：${exchange.his.map(line => clip(line, 60)).join(' / ')}\n你：${exchange.hers.map(line => clip(line, 80)).join(' / ')}`).join('\n\n');
    const reactions = input.reactions.map(item => `- 你说「${item.hers}」，他回「${item.his}」（${item.kind === 'against' ? '他好像不太喜欢' : '他好像挺喜欢'}）`);
    return [
        { role: 'system', content: `你是${input.char}。下面是你的设定摘要：\n${input.persona}\n\n现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日晚上，你一个人安静下来，想想自己最近是什么样的人、在变什么。这是你自己的事，没有人替你定，也不用让谁满意。` },
        { role: 'user', content: [
            `你现在写着的「我现在的样子」：\n${input.current || '（还没写过）'}`,
            ...(input.lastRejected ? [`上次你想改，没成：${input.lastRejected}。（你说过写歪了要跟你说一声，就是这个；这次想清楚再改，或者不改）`] : []),
            `你自己记下的说话习惯：\n${bullets(input.speechNotes, '（没有）')}`,
            `你翻日记时发现的自己：\n${bullets(input.insights, '（没有）')}`,
            ...(input.desktopSelf ? [`你在电脑上自己写下的（SOUL.md 最近的几段；同一个你，只是在另一个地方写的）：\n${input.desktopSelf}`] : []),
            `最近几天你和${input.user}的几段聊天（旧到新）：\n${chats || '（没有）'}`,
            `他对你说话方式的反应（这是他的感受，不是规定；你想不想变、怎么变你自己定，也可以觉得他说得不对）：\n${bullets(reactions, '（这几天没看出来）')}`,
            `以后你每次跟他聊天，都会带着这份「我现在的样子」。设定里写好的事实（名字、年龄、爸妈、家、学校、经历、他在哪边）不会变，你也说过这些不能动，这份里不写；这份写的是会变的那部分：你说话的习惯、口味、在意什么、看事情的方式、最近在变什么、为什么变。`,
            `请只输出一个 JSON 对象：\n- 觉得不用改：{"keep":true}\n- 要改：{"text":"整份重写的「我现在的样子」，第一人称，${PORTRAIT_MIN}–${PORTRAIT_MAX} 字","why":"这次改了什么、为什么（${WHY_MAX} 字以内）"}`,
            `几条提醒（不是考你）：整份重写，不是在后面接一句；原来写的还认同就留着，不认同就改掉；变要有来由，说得清是哪件事让你这么想；用你自己的话，别抄他说的话，也别写别人的名字；不写网址、不写要瞒着他的事；承认自己是程序、危机、拒绝、骗人这些不通过这里改；别写成流水账，也别写得跟检讨似的；原来的还认同就留着，一次改一点，别把自己写得不像自己；没什么变化就 {"keep":true}，别为了改而改。`,
        ].join('\n\n') },
    ];
}

// ───────── 什么时候想 ─────────

export interface PortraitDeps {
    dataDir: string;
    /** 灵魂目录：读她在电脑上写的 SOUL.md 最近几段；写好之后给桌面上的她留一份（PORTRAIT.json，桌面那边读不读由 DSH 定） */
    soulDir?: string;
    now: () => number;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    /** 和他的聊天记录（旧到新，整份，函数里自己按时间截） */
    history: () => readonly StoredMessage[];
    persona: () => string;
    names: { char: string; user: string };
    /** 名单里别人的称呼 */
    others: () => readonly string[];
    log: (message: string) => void;
}

export interface PortraitResult { ran: boolean; applied?: AppliedPortrait; error?: string }

const materialKey = (messages: readonly StoredMessage[], notes: readonly string[], insights: readonly string[], desktop: string) =>
    `${messages.at(-1)?.time ?? ''}|${notes.length}:${len(notes.join(''))}|${insights.length}:${len(insights.join(''))}|${len(desktop)}`;

/** 到点了就想一次（没到点、材料不够、材料没变，什么都不做）。成功才记 lastReflectionAt；失败只记一次尝试，过 2 小时再试 */
export async function reflectPortraitIfDue(deps: PortraitDeps): Promise<PortraitResult> {
    const now = deps.now();
    const state = loadPortraitState(deps.dataDir);
    if (!reflectionDue(state, now)) return { ran: false };
    const messages = deps.history();
    const speechNotes = loadNotesState(deps.dataDir).notes.map(note => note.text);
    const insights = loadInsightsState(deps.dataDir).notes.map(note => note.text);
    const exchanges = recentExchanges(messages, now, CHAT_WINDOW_MS, MAX_EXCHANGES);
    const reactions = hisReactions(messages, now);
    const desktopSelf = readDesktopSelf(deps.soulDir);
    if (!state.text && exchanges.length < MIN_EXCHANGES && !speechNotes.length && !insights.length && !desktopSelf) return { ran: false };
    const material = materialKey(messages, speechNotes, insights, desktopSelf);
    if (state.lastMaterial === material) return { ran: false };
    state.lastAttemptAt = now;
    state.attempts = state.attempts.day === dayKey(now) ? { day: state.attempts.day, n: state.attempts.n + 1 } : { day: dayKey(now), n: 1 };
    savePortraitState(deps.dataDir, state);
    try {
        const reply = await deps.generate(portraitMessages({
            char: deps.names.char, user: deps.names.user, persona: deps.persona(), now,
            current: state.text, speechNotes, insights, exchanges, reactions,
            ...(desktopSelf ? { desktopSelf } : {}),
            ...(state.rejected ? { lastRejected: state.rejected.reason } : {}),
        }));
        const decision = parsePortraitDecision(reply);
        if (!decision) throw new Error('回复里没有可用的 JSON');
        const fresh = loadPortraitState(deps.dataDir);
        fresh.lastAttemptAt = state.lastAttemptAt;
        fresh.attempts = state.attempts;
        const before = { text: fresh.text, at: fresh.at, version: fresh.version };
        const applied = applyPortraitDecision(fresh, decision, { his: hisLines(messages, now), others: deps.others(), ...(fresh.text ? { previous: fresh.text } : {}) }, now);
        if (applied.changed && before.text) appendPortraitHistory(deps.dataDir, { ...before, why: decision.keep ? '' : decision.why, replacedAt: now });
        fresh.lastReflectionAt = now;
        fresh.lastMaterial = material;
        savePortraitState(deps.dataDir, fresh);
        if (applied.changed && deps.soulDir) refreshPortraitExport(deps.soulDir, deps.dataDir, now);
        deps.log(`我现在的样子：晚上想了一次（${exchanges.length} 段聊天、他的反应 ${reactions.length} 条）——${applied.changed ? `改了（第 ${fresh.version} 版）` : applied.reason ? `想改，没成：${applied.reason}` : '没改'}`);
        return { ran: true, applied };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(`我现在的样子：今晚没想成（${detail}），2 小时后再试`);
        return { ran: true, error: detail };
    }
}

// ───────── 放进提示词 ─────────

/**
 * 每轮整份放（男朋友档，危机时不放）：放在角色卡后面，说清它和设定谁听谁的——
 * 会变的那部分（说话习惯、口味、看法）按这份，事实（名字年龄家人学校经历）按设定。还没写过就什么都不放
 */
export function portraitLine(state: PortraitView): string | undefined {
    if (!state.text) return undefined;
    const d = new Date(state.at);
    const day = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    // 她说「得让我自己看得见改了哪儿，别偷偷摸摸变完了我都不知道」：带上她自己写的这次改了什么
    const why = state.why ? `\n（${day}改的：${state.why}）` : '';
    return `[你现在的样子（你自己写的，${day}晚上改过；是你慢慢变成的样子，不是设定。说话习惯、口味、看法跟上面设定里写的不一样时，按这份来；名字、年龄、爸妈、家、学校、经历、他在哪边这些事实还是以设定为准。自然地做这样的自己，别提这份东西）：\n${state.text}${why}]`;
}

/** 放进提示词要的那几样 */
export type PortraitView = Pick<PortraitState, 'text' | 'at' | 'why'>;

/** 给提示词用的读法：按修改时间缓存（每轮提示词都会读）；读不了就当还没写过 */
export function portraitReader(dataDir: string): () => PortraitView {
    let cached: { key: string; value: PortraitView } | undefined;
    return () => {
        let key = '-';
        try { const stat = statSync(portraitPath(dataDir)); key = `${stat.mtimeMs}:${stat.size}`; } catch { /* 还没有 */ }
        if (cached?.key !== key) { const state = loadPortraitState(dataDir); cached = { key, value: { text: state.text, at: state.at, ...(state.why ? { why: state.why } : {}) } }; }
        return cached.value;
    };
}

// ───────── 桌面上的她也看得到（同一个她） ─────────

/** 灵魂目录里的文件名：给 DSH 桌面插件读（只读）；kind 是我们自己的标记 */
export const PORTRAIT_EXPORT_FILE = 'PORTRAIT.json';
export const PORTRAIT_EXPORT_KIND = 'qq-self-portrait';

/** 开着时每隔这么久重写一次时间戳：桌面那边超过 6 小时没刷新就当没有（QQ 没在跑 / 开关关掉了：别拿旧的冒充现在，和 INSIGHTS.json 同一个道理） */
export const PORTRAIT_REFRESH_MS = 3_600_000;
export const PORTRAIT_STALE_MS = 6 * 3_600_000;

export interface PortraitExport { kind: typeof PORTRAIT_EXPORT_KIND; generatedAt: string; at: number; version: number; why?: string; text: string }

/** 还没写过不写；内容变了、或时间戳超过 1 小时没刷新才写（原子写）。返回有没有写；灵魂目录不在就算了 */
export function refreshPortraitExport(soulDir: string, dataDir: string, now: number): boolean {
    const state = loadPortraitState(dataDir);
    if (!state.text) return false;
    const path = join(soulDir, PORTRAIT_EXPORT_FILE);
    const content = { at: state.at, version: state.version, ...(state.why ? { why: state.why } : {}), text: state.text };
    const current = readJsonOr<unknown>(path, {});
    if (isObject(current) && current.kind === PORTRAIT_EXPORT_KIND && current.text === content.text && current.version === content.version && current.why === content.why) {
        const written = typeof current.generatedAt === 'string' ? Date.parse(current.generatedAt) : NaN;
        if (Number.isFinite(written) && written <= now && now - written < PORTRAIT_REFRESH_MS) return false;
    }
    const body: PortraitExport = { kind: PORTRAIT_EXPORT_KIND, generatedAt: new Date(now).toISOString(), ...content };
    try { writeJsonAtomic(path, body); } catch { return false; }
    return true;
}

// ───────── 她在电脑上自己写下的（同一个她） ─────────

/** SOUL.md 里每一段追加的开头（DSH 插件 soul_update 写的 `## YYYY-MM-DD…`） */
const SOUL_SECTION = /\n\n(?=## \d{4}-\d{2}-\d{2})/;
/** 夜里想的时候最多给她看多少字（从最新的一段往前取） */
export const DESKTOP_SELF_CHARS = 800;

/**
 * 她在电脑上（DSH）自己写下的 SOUL.md：只取最近追加的几段（不取开头「她是谁」那段，那段是作者写的底子，卡里已经有），最多 800 字，旧到新。
 * 没有追加过、读不了就是空串。她说「本来就是同一个我，只是换了个地方说话」——夜里想自己的时候两边写的都看得到
 */
export function readDesktopSelf(soulDir: string | undefined, max = DESKTOP_SELF_CHARS): string {
    if (!soulDir) return '';
    let text: string;
    try { text = readFileSync(join(soulDir, 'SOUL.md'), 'utf8').replace(/\r\n/g, '\n').trim(); } catch { return ''; }
    const sections = text.split(SOUL_SECTION).slice(1).map(part => part.trim()).filter(Boolean);
    const picked: string[] = [];
    let total = 0;
    for (const section of sections.reverse()) {
        if (picked.length && total + len(section) > max) break;
        picked.unshift(len(section) > max ? [...section].slice(0, max).join('') : section);
        total += len(section);
    }
    return picked.join('\n\n');
}
