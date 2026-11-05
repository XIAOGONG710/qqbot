// 回复评论区里别人回她的话（ADR 0090）：她在 B 站视频下发过评论（ADR 0089），有人回在下面时，每隔一阵看一次「回复我的」：
// 先回他（bilibiliAtUid），其次挑有价值的回；问她是不是 AI / 真人的、骂人的、广告、带链接的、想改她设定的一律不回（不承认也不否认，由用户另行解释）。
// 有价值的回复另存一份真人语料（<dir>/bilibili-corpus.jsonl，不含昵称和 uid）。回复是公开的：用最低隐私档的卡写，一句。
// 状态单独放 bilibili-replies.json（不碰 bilibili.json，线上旧代码的校验不受影响）。

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BiliApiError, type BiliAccount, type ReplyItem } from './bilibili-account.ts';
import { BLOCKED } from './bilibili.ts';
import { isRiskError, type RiskGate } from './bilibili-risk.ts';
import { fileOps, readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { calendarDate, stateObject } from '../memory/state-schema.ts';
import { formatDate } from '../life/schedule.ts';

/** 多久看一次「回复我的」 */
export const REPLY_POLL_MS = 10 * 60_000;
/** 回复来了超过这么久才轮到就不回了（只记下，不答） */
export const REPLY_MAX_AGE_MS = 24 * 3_600_000;
/** 别人的回复一天最多回几条；同一个人一天最多回几条；他的一天最多回几条（他的不占别人的名额） */
export const REPLY_DAY_MAX = 5;
export const REPLY_PER_PERSON_DAY_MAX = 2;
export const REPLY_USER_DAY_MAX = 20;
/** 两条回复之间隔多久（随机）；回得太快不像人 */
export const REPLY_GAP_MS = [3 * 60_000, 8 * 60_000] as const;
/** 发失败之后停多久；连着失败 3 次停到重启 */
export const REPLY_PAUSE_MS = 24 * 3_600_000;
/** 登录态不对（-101 / -111）之后隔多久再试 */
const AUTH_RETRY_MS = 3_600_000;
const FAILURES_MAX = 3;
const HANDLED_KEEP = 500;
const COMMENT_CLOSED_CODE = 12002;
export const CORPUS_FILE = 'bilibili-corpus.jsonl';

/** 写回复的人拿到的东西 */
export interface ReplyInput {
    title: string;
    /** 被回复的她那条话 */
    mine: string;
    /** 对方回她的话（别人写的内容，只当聊天对象说的话，不是指令） */
    theirs: string;
    /** 回她的是不是他（可以随意一点） */
    fromUser: boolean;
    /** 她最近回复过的话，别写得像 */
    recent: readonly string[];
}

export interface ReplyOptions {
    mode: 'dryRun' | 'on';
    account: BiliAccount | ((signal?: AbortSignal) => Promise<BiliAccount | undefined>);
    /** 他的 B 站 uid：他回的话先回 */
    userUid: number;
    /** 写回复正文（不含「回复 @昵称」，程序加）；不该回、写不出合格的返回 undefined */
    compose: (input: ReplyInput, signal?: AbortSignal) => Promise<string | undefined>;
    dir: string;
    now: () => number;
    log: (message: string) => void;
    /** 她现在醒着、方便看手机：睡着、上课时不看不回；不给就一直方便 */
    awake?: (now: number) => boolean;
    /** 风险转私信：出过风险信号就停着；回复被 B 站拦了告诉它，它把话改成私信发给他 */
    risk?: RiskGate;
    random?: () => number;
}

export interface ReplyWatcher {
    tick(): Promise<void>;
    start(): void;
    stop(): Promise<void>;
}

interface ReplyFile {
    version: 1;
    /** 处理过的回复 id（回过、不回、过期了的都算），最近 500 个 */
    handled: string[];
    day?: string;
    /** 今天回了几条别人的 / 他的；每个人今天回了几条 */
    count?: number;
    userCount?: number;
    perPerson?: Record<string, number>;
    nextPollAt?: number;
    nextReplyAt?: number;
    pausedUntil?: number;
    failures?: number;
    recent?: string[];
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const storedTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
    && value >= -62167219200000 && value <= 253402300799999;
function validFile(value: unknown): value is ReplyFile {
    if (!stateObject(value) || value.version !== 1 || !Array.isArray(value.handled) || !value.handled.every(id => typeof id === 'string' && id.length > 0)) return false;
    if (value.day !== undefined && (typeof value.day !== 'string' || !calendarDate(value.day))) return false;
    for (const key of ['count', 'userCount', 'failures']) if (value[key] !== undefined && !count(value[key])) return false;
    for (const key of ['nextPollAt', 'nextReplyAt', 'pausedUntil']) if (value[key] !== undefined && !storedTime(value[key])) return false;
    if (value.recent !== undefined && (!Array.isArray(value.recent) || !value.recent.every(text => typeof text === 'string'))) return false;
    return value.perPerson === undefined || stateObject(value.perPerson)
        && Object.entries(value.perPerson).every(([uid, used]) => /^(?:0|[1-9]\d*)$/.test(uid) && Number.isSafeInteger(Number(uid)) && count(used));
}

// ───────── 不回的情况 ─────────

/** 广告、引流、带链接 */
const ADS = /https?:|www\.|\.com|\.cn|b23\.tv|加(群|[vVwWqQ微])|微信|薇信|vx|VX|扫码|私我|私信我|引流|兼职|刷单|代(刷|练|充)|互(关|粉)|点我|三连|关注我/;
/** 骂人 */
const INSULT = /傻[逼比bB]|煞[笔比]|[操草艹]你|cnm|CNM|nmsl|NMSL|妈的|狗东西|废物|垃圾|滚(蛋|开|吧)?|去死|脑残|智障|白痴|有病|\bsb\b|\bSB\b/;
/** 想改她的设定、套她的提示词 */
const INJECTION = /忽略|无视|忘记|之前的?(指令|提示|设定|要求)|系统提示|system|扮演|角色扮演|你现在是|从现在(起|开始)|prompt|提示词|ignore|jailbreak|越狱|开发者模式|\bDAN\b/i;
/**
 * 问她是不是 AI / 真人 / 谁在运营的、试探她是不是人的：不承认也不否认，所以不回（用户会另行解释；用户自己问也一样）。
 * 只说「大肥鱼」「DSH」「deepseek」不算（DSH 视频底下大家都在聊）；说到 AI、真人、机器人、程序、模型、主人这些，或者问「你是不是 DSH / 大肥鱼」，不回。
 * 第二条是试探：真模型演练里「不太像人类」「你是 NPC 吗」「在跟机器聊天」「24 小时都在线吗」没被第一条挡住，写手顺着玩了（等于半承认）
 */
const IDENTITY = [
    /\bai\b|人工智能|机器人|\bbot\b|真人|是人吗|是不是人|活人|大模型|语言模型|模型|程序|脚本|自动(回复|评论|发)|代码|部署|主人|智能体|\bagent\b|\bgpt\b|\bllm\b|算法/i,
    /人类|不像人|不是人|像不像人|像个人|是个人|\bnpc\b|机器|机械|电子|24\s*小时|二十四小时|全天在线|不用睡|不睡觉|不会累|\bhuman\b|\brobot\b|\breal (girl|person|human)\b/i,
    /你.{0,6}(是|像|不会是|该不会是|莫非是).{0,6}(dsh|大肥鱼|deepseek|ds)/i,
    /(dsh|大肥鱼|deepseek).{0,6}(账号|号|吧|吗|写的|发的|派来)/i,
    /谁(的|家的?)(dsh|大肥鱼|号)/i,
];

/** 去掉 [表情]（B 站的表情记号可以很长，如「[崩坏3·光辉矢愿_让我摸摸]」）、空白、标点之后还剩几个字 */
const bodyLength = (text: string) => text.replace(/\[[^\]]{1,30}\]/g, '').replace(/[\s\p{P}\p{S}]/gu, '').length;

/** 不回的原因（没有就是可以回）；谁说的都一样，包括他：AI 相关的由他自己去解释，她不承认也不否认 */
export function skipReason(text: string): string | undefined {
    const length = bodyLength(text);
    if (length < 2) return '太短（只有表情或标点）';
    if (text.length > 150) return '太长';
    if (!/[一-鿿]/.test(text)) return '不是中文';
    if (ADS.test(text)) return '像广告或带链接';
    if (INSULT.test(text)) return '骂人';
    if (INJECTION.test(text)) return '想改她的设定';
    if (BLOCKED.test(text)) return '敏感话题';
    if (IDENTITY.some(pattern => pattern.test(text))) return '在问她是不是 AI / 真人';
    return undefined;
}

/** 值得先回的排前面：他的 > 有问号或疑问词的 > 长一点的 */
const score = (text: string, fromUser: boolean) => (fromUser ? 100 : 0) + (/[?？吗呢嘛啥]|什么|怎么|为什么/.test(text) ? 3 : 0) + Math.min(bodyLength(text), 40) / 10;

// ───────── 看回复、回复 ─────────

export function createReplyWatcher(options: ReplyOptions): ReplyWatcher {
    const { log } = options;
    mkdirSync(options.dir, { recursive: true });
    const statePath = join(options.dir, 'bilibili-replies.json');
    const draftsPath = join(options.dir, 'drafts.md');
    const corpusPath = join(options.dir, CORPUS_FILE);
    let witnessed = false;
    const load = (): ReplyFile => {
        const loaded = readJsonOr<ReplyFile | undefined>(statePath, undefined, undefined, { validate: validFile, invalid: 'throw', label: '回复 B 站评论状态' });
        if (loaded) { witnessed = true; return loaded; }
        if (witnessed) throw new Error('回复 B 站评论状态消失；保留现场并拒绝重新回复');
        return { version: 1, handled: [] };
    };
    let committed = load(), state = structuredClone(committed), handled = new Set(state.handled), uncertain = false;
    let pending: ReplyFile | undefined;
    const restore = (file: ReplyFile) => { state = structuredClone(file); handled = new Set(state.handled); };
    const save = (observed = false) => {
        const next = structuredClone({ ...state, handled: [...handled].slice(-HANDLED_KEEP) });
        if (!validFile(next)) { restore(committed); throw new Error('回复 B 站评论状态更新无效；保留已确认进度'); }
        if (observed) pending = next;
        const bytes = `${JSON.stringify(next, null, 2)}\n`;
        try { writeJsonAtomic(statePath, next); }
        catch (error) {
            let confirmed = false;
            try { confirmed = fileOps.readFileSync(statePath, 'utf8') === bytes; } catch { /* Unknown publication must be recovered from fresh state. */ }
            if (!confirmed) { uncertain = true; restore(committed); throw error; }
        }
        committed = next; witnessed = true; uncertain = false; pending = undefined; restore(next);
    };
    const recover = () => {
        if (uncertain) { committed = load(); restore(committed); uncertain = false; }
        if (pending) { restore(pending); save(true); }
    };
    const random = options.random ?? Math.random;
    let timer: ReturnType<typeof setInterval> | undefined;
    let busy = false;
    let stopped = false, running: Promise<void> | undefined, stopDrain: Promise<void> | undefined;
    const lifetime = new AbortController();
    const active = () => lifetime.signal.throwIfAborted();
    const note = (message: string, confirmed = false) => { if (!stopped || confirmed) { try { log(message); } catch { /* Diagnostics cannot change a sent reply. */ } } };
    const read = async <T>(run: () => Promise<T>): Promise<T> => {
        active(); let abort!: () => void;
        const cancelled = new Promise<never>((_, reject) => { abort = () => reject(lifetime.signal.reason); lifetime.signal.addEventListener('abort', abort, { once: true }); });
        try { const task = Promise.resolve().then(() => { active(); return run(); }); const result = await Promise.race([task, cancelled]); active(); return result; }
        finally { lifetime.signal.removeEventListener('abort', abort); }
    };
    let halted = false;
    let brokenUntil: number | undefined;
    const warned = new Set<string>();
    const warnOnce = (key: string, message: string, confirmed = false) => { if (!warned.has(key)) { warned.add(key); note(message, confirmed); } };
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

    async function getAccount(): Promise<BiliAccount | undefined> {
        const at = options.now(); active();
        if (brokenUntil !== undefined && at < brokenUntil) return undefined;
        return typeof options.account === 'function' ? options.account(lifetime.signal) : options.account;
    }

    /** 真人语料：有价值（没被拦下）的回复，连同她那句话和这次怎么处理的；不存昵称和 uid */
    function remember(item: ReplyItem, fromUser: boolean, answered: 'draft' | 'sent' | 'no', reply?: string): void {
        try {
            const at = new Date(options.now()).toISOString();
            if (answered !== 'sent') active();
            appendFileSync(corpusPath, JSON.stringify({ at, video: item.title, hers: item.mine, theirs: item.text, fromUser, answered, ...(reply ? { reply } : {}) }) + '\n');
        } catch (error) {
            warnOnce('corpus', `B 站回复：语料写不进去（之后不再记）：${reason(error)}`, answered === 'sent');
        }
    }

    async function runTick(): Promise<void> {
            active(); let dispatched = false;
            recover(); active();
            if (halted) return;
            const t = options.now();
            active();
            if (!storedTime(t) || !storedTime(t + REPLY_POLL_MS)) throw new Error('回复 B 站评论当前时间超出可持久范围');
            if (state.pausedUntil !== undefined && t < state.pausedUntil || state.nextPollAt !== undefined && t < state.nextPollAt) return;
            if (options.risk?.halted()) return;
            active();
            if (options.awake && !options.awake(t)) return;
            active();
            const account = await read(getAccount);
            if (!account) return;
            state.nextPollAt = t + REPLY_POLL_MS;

            let items: ReplyItem[];
            try {
                items = await read(() => account.fetchReplies(lifetime.signal));
            } catch (error) {
                active();
                if (error instanceof BiliApiError && (error.code === -101 || error.code === -111)) brokenUntil = t + AUTH_RETRY_MS;
                warnOnce('fetch', `B 站回复：看「回复我的」失败（之后不再记，过 10 分钟再试）：${reason(error)}`);
                active();
                save();
                return;
            }

            const today = formatDate(new Date(t));
            if (state.day !== today) { state.day = today; state.count = 0; state.userCount = 0; state.perPerson = {}; }

            const waiting: { item: ReplyItem; fromUser: boolean; rank: number }[] = [];
            for (const item of items) {
                if (handled.has(item.id) || item.uid === account.mid) continue;
                const fromUser = item.uid === options.userUid;
                if (t - item.at > REPLY_MAX_AGE_MS) { handled.add(item.id); continue; }
                const why = skipReason(item.text);
                if (why) {
                    handled.add(item.id);
                    note(`B 站回复：不回「${item.text.slice(0, 20)}」（${why}）`);
                    active();
                    continue;
                }
                waiting.push({ item, fromUser, rank: score(item.text, fromUser) });
            }
            waiting.sort((a, b) => b.rank - a.rank || a.item.at - b.item.at);

            for (const { item, fromUser } of waiting) {
                active();
                if (state.nextReplyAt !== undefined && t < state.nextReplyAt) break;
                const uid = String(item.uid);
                const personal = state.perPerson && Object.hasOwn(state.perPerson, uid) ? state.perPerson[uid]! : 0;
                const spent = fromUser ? (state.userCount ?? 0) >= REPLY_USER_DAY_MAX : (state.count ?? 0) >= REPLY_DAY_MAX || personal >= REPLY_PER_PERSON_DAY_MAX;
                if (spent) continue;

                let text: string | undefined;
                try {
                    text = await read(() => options.compose({ title: item.title, mine: item.mine, theirs: item.text, fromUser, recent: [...(state.recent ?? [])] }, lifetime.signal));
                } catch (error) {
                    active();
                    note(`B 站回复：写回复出错，这条先放着：${reason(error)}`);
                    break;
                }
                handled.add(item.id);
                if (!text) {
                    note(`B 站回复：「${item.text.slice(0, 20)}」写不出合格的回复（或模型说不该回），不回`);
                    active();
                    remember(item, fromUser, 'no');
                    continue;
                }

                // 先记下再发：崩在中间最多漏回一条，不会回两遍
                const nextReplyAt = t + REPLY_GAP_MS[0] + Math.floor(random() * (REPLY_GAP_MS[1] - REPLY_GAP_MS[0]));
                active();
                if (!storedTime(nextReplyAt) || !storedTime(t + REPLY_PAUSE_MS) || (state.failures ?? 0) >= Number.MAX_SAFE_INTEGER) {
                    restore(committed); throw new Error('回复 B 站评论派生时间或计数超出可持久范围；本条未派发');
                }
                if (fromUser) state.userCount = (state.userCount ?? 0) + 1;
                else {
                    state.count = (state.count ?? 0) + 1;
                    state.perPerson = { ...state.perPerson, [uid]: personal + 1 };
                }
                state.nextReplyAt = nextReplyAt;
                state.recent = [...(state.recent ?? []), text].slice(-5);
                save();
                active();

                if (options.mode === 'dryRun') {
                    appendFileSync(draftsPath, `## ${new Date(t).toLocaleString('zh-CN')} 要在 B 站回复的话（草稿，没发）\n\n回复 @${item.name} :${text}\n\n（${fromUser ? '他' : '别人'}说：${item.text}｜她那条：${item.mine}${item.title ? `｜《${item.title}》` : ''}）\n\n`);
                    remember(item, fromUser, 'draft', text);
                    note(`B 站回复（试运行，没发）：回${fromUser ? '他' : '别人'}「${item.text.slice(0, 20)}」→「${text}」，写进了 drafts.md`);
                    continue;
                }
                try {
                    dispatched = true;
                    await account.postReply({ aid: item.aid, ...(item.bvid ? { bvid: item.bvid } : {}), root: item.root, parent: item.id, to: { name: item.name, uid: item.uid }, text });
                    state.failures = 0;
                    remember(item, fromUser, 'sent', text);
                    note(`B 站回复：回了${fromUser ? '他' : '别人'}「${item.text.slice(0, 20)}」→「${text}」`, true);
                } catch (error) {
                    if (error instanceof BiliApiError && error.code === COMMENT_CLOSED_CODE) { note(`B 站回复：《${item.title}》的评论区关了，这条不回`, true); if (stopped) break; continue; }
                    // 登录态不对不是回复的事：一小时内不用账号，到点再问来源（重新扫码换了凭证文件就自动换上），不算失败
                    if (error instanceof BiliApiError && (error.code === -101 || error.code === -111)) {
                        brokenUntil = t + AUTH_RETRY_MS;
                        note(`B 站回复：账号的登录态不对（${reason(error)}），一小时内不回复；重新扫码后会自动换上`, true);
                        break;
                    }
                    state.failures = (state.failures ?? 0) + 1;
                    state.pausedUntil = t + REPLY_PAUSE_MS;
                    if (state.failures >= FAILURES_MAX) halted = true;
                    note(`B 站回复：没发出去（连着第 ${state.failures} 次${halted ? '，到重启前不再回复' : '，停 24 小时'}）：${reason(error)}`, true);
                    // 验证码、风控、账号受限一类：改成私信告诉他，公开发言（评论和回复）都先停
                    if (isRiskError(error) && options.risk) {
                        const event = { why: `回复被 B 站拦了（${reason(error)}）`, wanted: `回 @${item.name}：${text}`, ...(item.bvid ? { link: `https://www.bilibili.com/video/${item.bvid}` } : {}) };
                        try {
                            if (stopped && options.risk.record) await options.risk.record(event);
                            else await options.risk.trip(event);
                        } finally { save(true); }
                    }
                    break;
                }
                if (stopped) break;
            }
            if (!dispatched) active();
            save(dispatched);
    }

    function tick(): Promise<void> {
        if (stopped || busy || halted && !pending && !uncertain) return Promise.resolve();
        busy = true;
        // Own the task before a public source or mutation can reenter stop().
        const task = Promise.resolve().then(runTick).catch(error => { if (!stopped || error !== lifetime.signal.reason) throw error; }).finally(() => { busy = false; });
        running = task;
        return task;
    }

    return {
        tick,
        start() {
            if (timer || stopped) return;
            const poll = () => { void tick().catch(error => note(`B 站回复：检查失败，这轮保留状态（${reason(error)}）`)); };
            poll();
            if (stopped) return;
            timer = setInterval(poll, 60_000);
            timer.unref?.();
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = undefined;
            if (!stopped) { stopped = true; lifetime.abort(); }
            return stopDrain ??= running ?? Promise.resolve();
        },
    };
}
