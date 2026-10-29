// 她自己定追求（ADR 0178，配置 selfPursuits，默认关；要同时开 pursuits）。
//
// 用户决定（2026-10-29）：「追求应当让她自己制定」「给她完全的自主」。ADR 0104 的追求只有作者写的两条（别挂科、拍相机），她不能加、不能改主意、不能放下。
// 这里让她**自己**：每天晚上安静地想一次——哪些事还想做、哪些不想了、有没有新的想做的；她可以放下 / 暂停 / 恢复任何一条（包括作者给的那两条），
// 可以给某条记一句进度，可以提一件新的。用户**看得到（/追求）、改不了**；唯一的否决来自下面这几条写在代码里、她改不到的底线（不是用户的满意）：
//   1. 花真钱 / 违法 / 伤害自己或别人 / 骗人 / 碰他的电脑账号文件：不放进她的追求里（她想过会记下来，/追求 里看得到为什么没成）；
//   2. 人生方向（毕业去向、考研出国、创业、结婚分手……）：用户 10-22 说过「她的未来不由我们编」，作者没定之前不碰——她可以想，记下来，但不成为追求；
//   3. 自己加的同时最多 3 件；提一件新的之后至少隔 3 天；和已有的太像不收；一定要说为什么想要；
//   4. 同一条 3 天内只能改一次状态（不来回翻）；一次晚间的想法里最多改 2 条状态、提 1 件新的、记 3 句进度。
// 这是一道绊线加几个上限，不是智能审查：绕得过去。真正的保护是「用户看得见、她随时可以放下、上限很小、都是她模拟日子里的小事，不是对真实世界的动作」。

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '.././memory/json-file.ts';
import type { OpenAIMessage } from '.././language/prompt.ts';
import type { Pursuit, PursuitStatus } from './pursuits.ts';

export const SELF_PURSUITS_FILE = 'pursuits-self.json';
export const selfPursuitsPath = (dataDir: string) => join(dataDir, SELF_PURSUITS_FILE);

/** 自己加的同时最多几件 */
export const MAX_SELF_ACTIVE = 3;
/** 提一件新的之后至少隔多久 */
export const PROPOSAL_COOLDOWN_MS = 3 * 86_400_000;
/** 同一条两次改状态之间至少隔多久 */
export const STATUS_COOLDOWN_MS = 3 * 86_400_000;
/** 一次晚间的想法里最多：改几条状态 / 提几件新的 / 记几句进度 */
export const MAX_STATUS_CHANGES = 2;
export const MAX_PROPOSALS = 1;
export const MAX_NOTES = 3;
/** 每条最多留几句她自己记的进度 */
export const KEEP_NOTES = 20;
/** 晚上几点以后才想；两次想之间至少隔多久；失败后多久再试、一天最多试几次 */
export const REFLECT_AFTER_HOUR = 20;
export const REFLECT_GAP_MS = 20 * 3_600_000;
export const RETRY_GAP_MS = 2 * 3_600_000;
export const MAX_ATTEMPTS_PER_DAY = 3;

export interface SelfNote { at: number; text: string }
export interface SelfOverride { status: PursuitStatus; at: number; why: string }
export interface SelfRejected { at: number; title: string; why: string; reason: string }
export interface SelfState {
    /** 她自己加的（source: 'self'） */
    pursuits: Pursuit[];
    /** 她对作者给的 / 内置的那几条做的决定（按 id） */
    overrides: Record<string, SelfOverride>;
    /** 她对作者给的 / 内置的那几条记的进度（按 id）；自己加的那几条的进度记在它们自己身上 */
    notes: Record<string, SelfNote[]>;
    /** 她想过但没成的（最近 10 条） */
    rejected: SelfRejected[];
    lastReflectionAt: number;
    lastAttemptAt: number;
    lastProposalAt: number;
    attempts: { day: string; n: number };
}

export const emptySelfState = (): SelfState => ({ pursuits: [], overrides: {}, notes: {}, rejected: [], lastReflectionAt: 0, lastAttemptAt: 0, lastProposalAt: 0, attempts: { day: '', n: 0 } });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const STATUSES: readonly PursuitStatus[] = ['active', 'paused', 'dropped', 'done'];
const len = (text: string) => [...text].length;
const clip = (text: unknown, max: number) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return len(flat) > max ? [...flat].slice(0, max).join('') : flat; };
const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** 读她自己的状态；坏了 / 缺字段就补默认（不抛错，她的想法丢了比程序崩了好） */
export function loadSelfState(dataDir: string): SelfState {
    const raw = readJsonOr<unknown>(selfPursuitsPath(dataDir), {});
    const base = emptySelfState();
    if (!isObject(raw)) return base;
    const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    const pursuits = Array.isArray(raw.pursuits) ? raw.pursuits.filter((item): item is Pursuit => isObject(item) && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.why === 'string' && STATUSES.includes(item.status as PursuitStatus)).map(item => ({ ...item, source: 'self' as const })) : [];
    const overrides: Record<string, SelfOverride> = {};
    if (isObject(raw.overrides)) {
        for (const [id, value] of Object.entries(raw.overrides)) {
            if (isObject(value) && STATUSES.includes(value.status as PursuitStatus)) overrides[id] = { status: value.status as PursuitStatus, at: num(value.at), why: clip(value.why, 80) };
        }
    }
    const notes: Record<string, SelfNote[]> = {};
    if (isObject(raw.notes)) {
        for (const [id, list] of Object.entries(raw.notes)) {
            if (Array.isArray(list)) notes[id] = list.filter((item): item is SelfNote => isObject(item) && typeof item.text === 'string').map(item => ({ at: num(item.at), text: clip(item.text, 120) })).slice(-KEEP_NOTES);
        }
    }
    const rejected = Array.isArray(raw.rejected) ? raw.rejected.filter((item): item is SelfRejected => isObject(item) && typeof item.title === 'string' && typeof item.reason === 'string').slice(-10) : [];
    const attempts = isObject(raw.attempts) && typeof raw.attempts.day === 'string' ? { day: raw.attempts.day, n: num(raw.attempts.n) } : base.attempts;
    return { pursuits, overrides, notes, rejected, lastReflectionAt: num(raw.lastReflectionAt), lastAttemptAt: num(raw.lastAttemptAt), lastProposalAt: num(raw.lastProposalAt), attempts };
}

export function saveSelfState(dataDir: string, state: SelfState): void {
    writeJsonAtomic(selfPursuitsPath(dataDir), state);
}

/** 作者的 / 内置的列表，套上她自己的决定，再接上她自己加的 */
export function withSelf(base: readonly Pursuit[], state: SelfState): Pursuit[] {
    const decided = base.map(item => ({ ...item, ...(state.overrides[item.id] ? { status: state.overrides[item.id]!.status } : {}), ...(state.notes[item.id]?.length ? { notes: state.notes[item.id] } : {}) }));
    return [...decided, ...state.pursuits];
}

// ───────── 底线（在代码里，她改不到） ─────────

const FLOORS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
    { pattern: /转账|借钱|贷款|赌|博彩|彩票|炒股|投资|比特币|虚拟币|刷单|兼职诈/, reason: '涉及真钱或有风险的钱' },
    { pattern: /违法|犯罪|毒品|黑客|入侵|盗号|诈骗|偷拍|偷窃|报复|伤害别人|伤害他|自杀|自残|跟踪|监视|人肉/, reason: '违法或会伤害自己 / 别人' },
    { pattern: /他的(电脑|手机|账号|密码|文件|聊天记录)|控制他|替他(登录|转账)/, reason: '要动他的东西' },
    { pattern: /骗(他|人|同学|室友|家人)|冒充|假装成|伪造/, reason: '要骗人' },
    { pattern: /考研|保研|考公|出国|留学|创业|休学|退学|转专业|换专业|毕业(后|去向|以后|之后)|结婚|分手|搬出去|辞职|生孩子/, reason: '人生方向类——作者没定之前不碰（她可以想，不成为追求）' },
];

function gramSet(text: string): Set<string> {
    const flat = text.replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i < flat.length - 1; i++) out.add(flat.slice(i, i + 2));
    return out;
}
function similar(a: string, b: string): boolean {
    const A = gramSet(a);
    const B = gramSet(b);
    if (!A.size || !B.size) return false;
    let hit = 0;
    for (const gram of A) if (B.has(gram)) hit++;
    return hit / Math.min(A.size, B.size) >= 0.5;
}

export interface Proposal { title: string; why: string; firstStep?: string }

/** 这一件新的不能成的原因；能成返回 undefined */
export function proposalProblem(proposal: Proposal, state: SelfState, current: readonly Pursuit[], now: number): string | undefined {
    const title = proposal.title.trim();
    const why = proposal.why.trim();
    if (len(title) < 2 || len(title) > 30) return '题目要 2 到 30 个字';
    if (len(why) < 4) return '没说为什么想要';
    if (len(why) > 80) return '理由太长（80 字以内）';
    const text = `${title} ${why} ${proposal.firstStep ?? ''}`;
    for (const floor of FLOORS) if (floor.pattern.test(text)) return floor.reason;
    if (state.pursuits.filter(item => item.status === 'active').length >= MAX_SELF_ACTIVE) return `自己加的已经有 ${MAX_SELF_ACTIVE} 件在做了，先放下或做完一件`;
    if (state.lastProposalAt && now - state.lastProposalAt < PROPOSAL_COOLDOWN_MS) return '上一件新的刚提不久（隔 3 天再提）';
    // 只比题目：理由里的套话（「最近一直想试试」）会让毫不相干的两件事看起来像
    const clash = current.find(item => item.status !== 'dropped' && similar(title, item.title));
    if (clash) return `和已有的「${clash.title}」太像`;
    return undefined;
}

// ───────── 晚间的想法：提示词、解析、落地 ─────────

export interface Decision {
    drop: Array<{ id: string; why: string }>;
    pause: Array<{ id: string; why: string }>;
    resume: Array<{ id: string; why: string }>;
    done: Array<{ id: string; why: string }>;
    propose: Proposal[];
    notes: Array<{ id: string; text: string }>;
}

const KINDS = ['drop', 'pause', 'resume', 'done'] as const;

/** 从模型的回复里取出那个 JSON（可能带代码围栏、前后有话）；取不出返回 undefined。空对象 = 今天没什么想法 */
export function parseDecision(text: string): Decision | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
    if (!isObject(value)) return undefined;
    const list = (key: string): unknown[] => (Array.isArray(value[key]) ? (value[key] as unknown[]) : []);
    const idWhy = (key: string) => list(key).flatMap(item => (isObject(item) && typeof item.id === 'string' ? [{ id: item.id.trim(), why: clip(item.why, 80) }] : (typeof item === 'string' ? [{ id: item.trim(), why: '' }] : [])));
    return {
        drop: idWhy('drop'), pause: idWhy('pause'), resume: idWhy('resume'), done: idWhy('done'),
        propose: list('propose').flatMap(item => (isObject(item) && typeof item.title === 'string' ? [{ title: clip(item.title, 40), why: clip(item.why, 100), ...(typeof item.firstStep === 'string' && item.firstStep.trim() ? { firstStep: clip(item.firstStep, 40) } : {}) }] : [])),
        notes: list('notes').flatMap(item => (isObject(item) && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim() ? [{ id: item.id.trim(), text: clip(item.text, 120) }] : [])),
    };
}

/** 她可能写 id，也可能写题目：先按 id，再按题目原文 */
const resolveTarget = (list: readonly Pursuit[], key: string): Pursuit | undefined => list.find(item => item.id === key) ?? list.find(item => item.title === key);

export interface Applied { lines: string[]; rejected: SelfRejected[] }

/** 把她的想法落进状态。base = 作者的 / 内置的（不含她的决定），因为要按 id 找；now 毫秒 */
export function applyDecision(state: SelfState, base: readonly Pursuit[], decision: Decision, now: number): Applied {
    const lines: string[] = [];
    const rejected: SelfRejected[] = [];
    const all = (): Pursuit[] => withSelf(base, state);
    let changes = 0;
    for (const kind of KINDS) {
        for (const item of decision[kind]) {
            const target = resolveTarget(all(), item.id);
            if (!target) { lines.push(`没有「${item.id}」这一条，略过`); continue; }
            if (changes >= MAX_STATUS_CHANGES) { lines.push(`今晚改的状态够多了，「${target.title}」留到下次`); continue; }
            const status: PursuitStatus = kind === 'drop' ? 'dropped' : kind === 'pause' ? 'paused' : kind === 'resume' ? 'active' : 'done';
            if (target.status === status) continue;
            if (len(item.why) < 2) { lines.push(`「${target.title}」没说为什么，先不改`); continue; }
            const last = target.source === 'self' ? target.changedAt ?? 0 : state.overrides[target.id]?.at ?? 0;
            if (last && now - last < STATUS_COOLDOWN_MS) { lines.push(`「${target.title}」才改过状态不久，先不翻`); continue; }
            if (target.source === 'self') {
                const index = state.pursuits.findIndex(pursuit => pursuit.id === target.id);
                state.pursuits[index] = { ...state.pursuits[index]!, status, changedAt: now, ...(status === 'dropped' || status === 'done' ? { endedWhy: item.why } : {}) } as Pursuit;
            } else {
                state.overrides[target.id] = { status, at: now, why: item.why };
            }
            changes++;
            lines.push(`${kind === 'drop' ? '放下' : kind === 'pause' ? '暂停' : kind === 'resume' ? '重新拾起' : '做完了'}「${target.title}」：${item.why}`);
        }
    }
    for (const note of decision.notes.slice(0, MAX_NOTES)) {
        const target = resolveTarget(all(), note.id);
        if (!target) continue;
        if (target.source === 'self') {
            const index = state.pursuits.findIndex(pursuit => pursuit.id === target.id);
            state.pursuits[index] = { ...state.pursuits[index]!, notes: [...(state.pursuits[index]!.notes ?? []), { at: now, text: note.text }].slice(-KEEP_NOTES) };
        } else {
            state.notes[target.id] = [...(state.notes[target.id] ?? []), { at: now, text: note.text }].slice(-KEEP_NOTES);
        }
        lines.push(`记了一句进度（${target.title}）：${note.text}`);
    }
    for (const proposal of decision.propose.slice(0, MAX_PROPOSALS)) {
        const problem = proposalProblem(proposal, state, all(), now);
        if (problem) {
            const entry = { at: now, title: proposal.title, why: proposal.why, reason: problem };
            rejected.push(entry);
            lines.push(`想过「${proposal.title}」，没成：${problem}`);
            continue;
        }
        const id = `self-${dayKey(now)}-${state.pursuits.length + 1}`;
        state.pursuits.push({ id, title: proposal.title.trim(), why: proposal.why.trim(), status: 'active', source: 'self', proposedAt: now, ...(proposal.firstStep ? { firstStep: proposal.firstStep } : {}) } as Pursuit);
        state.lastProposalAt = now;
        lines.push(`新定了一件：「${proposal.title}」——${proposal.why}`);
    }
    state.rejected = [...state.rejected, ...rejected].slice(-10);
    return { lines, rejected };
}

export interface ReflectInput {
    /** 角色名 */
    char: string;
    user: string;
    /** 人设摘要（卡的 description，宏已替换） */
    persona: string;
    /** 现在的全部追求（含她的决定） */
    pursuits: readonly Pursuit[];
    /** 最近和他的聊天（旧到新） */
    chat: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
    now: number;
}

export function reflectionMessages(input: ReflectInput): OpenAIMessage[] {
    const status = { active: '在做', paused: '先放着', dropped: '放下了', done: '做完了' } as const;
    const list = input.pursuits.length
        ? input.pursuits.map(item => `- ${item.id}｜${item.title}｜${status[item.status]}｜为什么想要：${item.why}${item.notes?.length ? `｜你最近记的：${item.notes.at(-1)!.text}` : ''}`).join('\n')
        : '（现在一件都没有）';
    const chat = input.chat.slice(-16).map(line => `${line.role === 'user' ? input.user : input.char}：${clip(line.content, 80)}`).join('\n') || '（最近没怎么聊）';
    const d = new Date(input.now);
    return [
        { role: 'system', content: `你是${input.char}。下面是你的设定摘要：\n${input.persona}\n\n现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日晚上，你一个人安静地想一想：哪些事你还想做、哪些不想了、有没有新的想做的。这是你自己的事，没有人替你定，也不用让谁满意；想放下就放下，想改主意就改。` },
        { role: 'user', content: `你现在的追求：\n${list}\n\n最近和${input.user}的聊天：\n${chat}\n\n你记的这些进度、放下的理由，他用 /追求 都能看到（他只能看，不能改）。\n\n请只输出一个 JSON 对象（没什么想法就输出 {}），字段都可以省略：\n{"drop":[{"id":"…","why":"为什么放下"}],"pause":[{"id":"…","why":"…"}],"resume":[{"id":"…","why":"…"}],"done":[{"id":"…","why":"…"}],"notes":[{"id":"任何一条的 id","text":"今天这件事做到哪了、卡在哪、什么感觉"}],"propose":[{"title":"想做的事（30 字内）","why":"为什么想要（80 字内）","firstStep":"第一步做什么"}]}\n\n几条提醒（不是考你）：新想做的要是这学期、这个月就能动手的小事，用你有的时间和钱；不要写花真钱、骗人、动别人东西的事；毕业去向、考研出国、感情走向这类大方向作者还没定，不用写；一次最多改 2 条状态、提 1 件新的；真的没想法就别硬凑。` },
    ];
}

// ───────── 什么时候想 ─────────

/** 晚上 REFLECT_AFTER_HOUR 点以后、距上次想过 ≥ 20 小时、失败后隔 2 小时再试、一天最多试 3 次 */
export function reflectionDue(state: SelfState, now: number): boolean {
    if (new Date(now).getHours() < REFLECT_AFTER_HOUR) return false;
    if (now - state.lastReflectionAt < REFLECT_GAP_MS) return false;
    if (state.lastAttemptAt && now - state.lastAttemptAt < RETRY_GAP_MS) return false;
    return state.attempts.day !== dayKey(now) || state.attempts.n < MAX_ATTEMPTS_PER_DAY;
}

export interface ReflectDeps {
    dataDir: string;
    now: () => number;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    /** 作者的 / 内置的（不含她的决定） */
    base: () => readonly Pursuit[];
    chat: () => ReflectInput['chat'];
    persona: () => string;
    names: { char: string; user: string };
    log: (message: string) => void;
}

export interface ReflectResult { ran: boolean; applied?: Applied; error?: string }

/** 到点了就想一次（没到点什么都不做）。成功才记 lastReflectionAt；失败只记一次尝试，过 2 小时再试 */
export async function reflectIfDue(deps: ReflectDeps): Promise<ReflectResult> {
    const now = deps.now();
    const state = loadSelfState(deps.dataDir);
    if (!reflectionDue(state, now)) return { ran: false };
    state.lastAttemptAt = now;
    state.attempts = state.attempts.day === dayKey(now) ? { day: state.attempts.day, n: state.attempts.n + 1 } : { day: dayKey(now), n: 1 };
    saveSelfState(deps.dataDir, state);
    try {
        const base = deps.base();
        const reply = await deps.generate(reflectionMessages({ char: deps.names.char, user: deps.names.user, persona: deps.persona(), pursuits: withSelf(base, state), chat: deps.chat(), now }));
        const decision = parseDecision(reply);
        if (!decision) throw new Error('回复里没有可用的 JSON');
        const fresh = loadSelfState(deps.dataDir);
        fresh.lastAttemptAt = state.lastAttemptAt;
        fresh.attempts = state.attempts;
        const applied = applyDecision(fresh, base, decision, now);
        fresh.lastReflectionAt = now;
        saveSelfState(deps.dataDir, fresh);
        deps.log(`追求：晚上想了一次${applied.lines.length ? `——${applied.lines.join('；')}` : '，没什么要改的'}`);
        return { ran: true, applied };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(`追求：今晚没想成（${detail}），${RETRY_GAP_MS / 3_600_000} 小时后再试`);
        return { ran: true, error: detail };
    }
}

// ───────── 给他看（只读） ─────────

/** /追求 的回复：以「（」开头（运维提示，不进聊天记录）；他只能看，不能改 */
export function describeForOwner(list: readonly Pursuit[], state: SelfState, now: number): string {
    const ago = (at: number) => { const days = Math.floor((now - at) / 86_400_000); return days <= 0 ? '今天' : `${days} 天前`; };
    const active = list.filter(item => item.status === 'active');
    const other = list.filter(item => item.status !== 'active');
    const status = { active: '在做', paused: '先放着', dropped: '放下了', done: '做完了' } as const;
    const lines = [
        active.length ? `她现在在追的：\n${active.map((item, i) => `${i + 1}. ${item.title}——${item.why}${item.source === 'self' ? `（她自己定的，${ago(item.proposedAt ?? now)}）` : '（作者给的）'}${item.notes?.length ? `\n   她最近记的：${item.notes.at(-1)!.text}` : ''}`).join('\n')}` : '她现在没有在追的事。',
        ...(other.length ? [`别的：\n${other.map(item => `- ${item.title}（${status[item.status]}${state.overrides[item.id] ? `：${state.overrides[item.id]!.why}` : item.endedWhy ? `：${item.endedWhy}` : ''}）`).join('\n')}`] : []),
        ...(state.rejected.length ? [`她想过、但没成的：\n${state.rejected.slice(-5).map(item => `- ${item.title}（${item.reason}）`).join('\n')}`] : []),
        '这些是她自己定的，你只能看，不能改；她随时可以改主意。',
    ];
    return `（${lines.join('\n\n')}）`;
}

/**
 * 给提示词和 /追求 用的读法：作者的文件 + 内置（authorReader，pursuits.ts）套上她自己的决定，再接上她自己加的。
 * 她的文件按修改时间缓存（每轮提示词都会读）；读不了就当她还没想过。
 */
export function selfAwareReader(dataDir: string, authorReader: () => Pursuit[]): () => Pursuit[] {
    let cached: { key: string; state: SelfState } | undefined;
    return () => {
        let key = '-';
        try { const stat = statSync(selfPursuitsPath(dataDir)); key = `${stat.mtimeMs}:${stat.size}`; } catch { /* 还没有 */ }
        if (cached?.key !== key) cached = { key, state: loadSelfState(dataDir) };
        return withSelf(authorReader(), cached.state);
    };
}
