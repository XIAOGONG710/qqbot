// 风险转私信（ADR 0090，用户 2026-10-21：「如果出现风险消息，立刻转为私信@」）：
// 公开发言（评论、回复）一旦出现风险信号——发评论被 B 站拦了（验证码、风控、账号受限……）、评论发出去公开看不到（可能在审核）、
// 她的号收到了违规 / 警告类的系统通知——立刻停掉公开发言一段时间，并把她本来想说的话改成私信发给他（他的 B 站，bilibiliAtUid），
// 之后的话只走私信。这条私信是运维性质的提醒，不受 bilibiliDm 的试运行开关管（试运行是「别把她写的话发出去」，这里是告诉他出事了）。
// 系统通知的字段没拿真数据核对过（现在是 0 条）；未读数的接口核对过。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BiliApiError, DM_MAX_CHARS, type BiliAccount } from './bilibili-account.ts';
import { fileOps, readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { stateObject } from '../memory/state-schema.ts';

/** 停多久：风险信号出现后公开发言停这么久（可以被单次事件覆盖） */
export const RISK_HALT_DAYS = 7;
/** 同一段时间内最多提醒一次，免得连着失败时刷屏 */
export const RISK_ALERT_GAP_MS = 30 * 60_000;
/** 多久看一次系统通知的未读数 */
export const RISK_POLL_MS = 15 * 60_000;

export interface RiskEvent {
    /** 出了什么事（一句话，进私信） */
    why: string;
    /** 她本来想发的话（评论 / 回复的正文），改成私信带给他 */
    wanted?: string;
    link?: string;
    days?: number;
}

/** 评论、回复模块用的：停着就别发；出事了告诉它 */
export interface RiskGate {
    halted(): boolean;
    trip(event: RiskEvent): Promise<void>;
    /** Persist a risk already observed from an issued mutation; never start an alert. */
    record?(event: RiskEvent): Promise<void>;
}

/**
 * 发评论 / 回复时 B 站返回的错误里，哪些是「风险」：验证码、风控、账号受限……
 * 不算风险的：评论区关了（12002，是视频的事）、重复评论（12051）、太长（12009 / 12025，是我们的事）
 */
export const NOT_RISK_CODES: ReadonlySet<number> = new Set([12002, 12051, 12009, 12025]);
export const isRiskError = (error: unknown): error is BiliApiError => error instanceof BiliApiError && !NOT_RISK_CODES.has(error.code) && error.code !== -101 && error.code !== -111;

/** 系统通知里哪些像是风险：违规、警告、处罚、限制、评论被删…… */
export const RISK_NOTICE = /违规|警告|处罚|封禁|封号|禁言|限制|风控|异常|冻结|删除|不当|审核|举报|账号安全|屏蔽|限流|不予展示/;

interface RiskFile {
    version: 1;
    /** 公开发言停到这个时间 */
    until?: number;
    seen: string[];
    lastUnread?: number;
    lastAlertAt?: number;
    /** 读不出内容时已经为这个未读数私信提醒过；读取照样每轮重试，提醒不重复 */
    alertedUnread?: number;
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
const validFile = (value: unknown): value is RiskFile => stateObject(value) && value.version === 1
    && Array.isArray(value.seen) && value.seen.every(id => typeof id === 'string' && id.length > 0)
    && (value.until === undefined || timestamp(value.until)) && (value.lastAlertAt === undefined || timestamp(value.lastAlertAt))
    && (value.lastUnread === undefined || count(value.lastUnread))
    && (value.alertedUnread === undefined || count(value.alertedUnread));

export interface RiskOptions {
    account: BiliAccount | (() => Promise<BiliAccount | undefined>);
    /** 他的 B 站 uid：提醒私信发到这里 */
    uid: number;
    dir: string;
    now: () => number;
    log: (message: string) => void;
}

export interface RiskMonitor extends RiskGate {
    tick(): Promise<void>;
    start(): void;
    stop(): Promise<void>;
}

export function createRiskMonitor(options: RiskOptions): RiskMonitor {
    const { log } = options;
    mkdirSync(options.dir, { recursive: true });
    const statePath = join(options.dir, 'bilibili-risk.json');
    let state = readJsonOr<RiskFile>(statePath, { version: 1, seen: [] }, log, { validate: validFile, invalid: 'throw', label: 'B 站风险状态' });
    // A failed publication cannot erase a risk already observed by this process.
    // Keep its entire candidate (including seen and until) for local retry. This
    // is not a durable outbox or a promise of recovery after process death.
    let pending: RiskFile | undefined;
    const flush = () => {
        if (!pending) return;
        const next = pending, bytes = `${JSON.stringify(next, null, 2)}\n`;
        try { writeJsonAtomic(statePath, next); }
        catch (error) {
            try { if (fileOps.readFileSync(statePath, 'utf8') !== bytes) throw error; }
            catch { throw error; }
        }
        state = next; pending = undefined;
    };
    const commit = (change: (next: RiskFile) => void) => {
        const next = structuredClone(pending ?? state); change(next); next.seen = next.seen.slice(-200);
        if (!validFile(next)) throw new Error('B 站风险状态更新无效；保留已确认状态');
        pending = next; flush();
    };
    const clock = () => { const t = options.now(); if (!timestamp(t)) throw new Error('B 站风险时钟无效'); return t; };
    let timer: ReturnType<typeof setInterval> | undefined;
    let busy = false;
    let nextPollAt: number | undefined;
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
    let stopped = false, drain: Promise<void> | undefined;
    const cancellation = new AbortController(), stoppedError = new Error('B 站风险监控已停止');
    const jobs = new Set<Promise<void>>();
    const active = () => cancellation.signal.throwIfAborted();
    const note = (message: string, confirmed = false) => { if (!stopped || confirmed) { try { log(message); } catch { /* Diagnostics do not change observed risk or ACK facts. */ } } };
    const owned = (run: () => Promise<void>): Promise<void> => {
        if (stopped) return Promise.resolve();
        let settled!: () => void;
        const done = new Promise<void>(resolve => { settled = resolve; }); jobs.add(done);
        const finish = () => { jobs.delete(done); settled(); };
        let task: Promise<void>;
        try { task = run(); } catch (error) { task = Promise.reject(error); }
        return task.catch(error => { if (error !== stoppedError) throw error; }).finally(finish);
    };
    const read = async <T,>(run: () => Promise<T>): Promise<T> => {
        active();
        let abort!: () => void;
        const cancelled = new Promise<never>((_, reject) => { abort = () => reject(stoppedError); cancellation.signal.addEventListener('abort', abort, { once: true }); });
        try {
            const task = Promise.resolve().then(() => { active(); return run(); });
            const result = await Promise.race([task, cancelled]); active(); return result;
        } finally { cancellation.signal.removeEventListener('abort', abort); }
    };

    async function getAccount(): Promise<BiliAccount | undefined> {
        return typeof options.account === 'function' ? options.account() : options.account;
    }

    /** 私信告诉他；发不出去（风控、没关注……）只记日志 */
    async function alert(text: string, t: number): Promise<void> {
        active();
        flush();
        const recentlyAlerted = () => state.lastAlertAt !== undefined && t - state.lastAlertAt < RISK_ALERT_GAP_MS;
        if (recentlyAlerted()) { note('B 站风险：刚提醒过他，这次的私信先不重复发'); return; }
        const account = await read(getAccount);
        if (!account) { note('B 站风险：账号用不了，没法私信提醒他'); return; }
        flush();
        // Another trip may have reserved the shared cooldown while account
        // lookup was pending. Recheck at the synchronous commit point.
        if (recentlyAlerted()) { note('B 站风险：刚提醒过他，这次的私信先不重复发'); return; }
        commit(next => { next.lastAlertAt = t; });
        active();
        try {
            await account.sendDm({ uid: options.uid, text: text.slice(0, DM_MAX_CHARS) });
            note('B 站风险：已私信提醒他', true);
        } catch (error) {
            note(`B 站风险：私信提醒也没发出去（${reason(error)}）`, true);
        }
    }

    function recordAt(event: RiskEvent, t: number): void {
        const days = event.days ?? RISK_HALT_DAYS;
        const until = t + days * 86_400_000;
        if (!Number.isFinite(days) || days < 0 || !timestamp(until)) throw new Error('B 站风险暂停时间无效');
        commit(next => { next.until = Math.max(next.until ?? until, until); });
        note(`B 站风险：${event.why}；公开评论和回复停 ${days} 天，之后的话只走私信`);
    }
    async function record(event: RiskEvent): Promise<void> { recordAt(event, clock()); }
    const alertText = (event: RiskEvent) => [
        `【B 站风险提醒】${event.why}`,
        ...(event.wanted ? [`她本来想发的：${event.wanted}`] : []),
        ...(event.link ? [event.link] : []),
        `公开评论和回复先停 ${event.days ?? RISK_HALT_DAYS} 天，之后的话只走私信。`,
    ].join('\n');

    async function tripWork(event: RiskEvent): Promise<void> {
        active();
        const t = clock(); active();
        recordAt(event, t); active();
        await alert(alertText(event), t);
    }

    const trip = (event: RiskEvent) => owned(() => tripWork(event));

    async function tickWork(): Promise<void> {
        if (busy) return;
        busy = true;
        try {
            flush();
            const t = clock();
            active();
            if (nextPollAt !== undefined && t < nextPollAt) return;
            const account = await read(getAccount);
            if (!account) return;
            nextPollAt = t + RISK_POLL_MS;
            let unread: number;
            try {
                unread = await read(() => account.systemNoticeUnread(cancellation.signal));
            } catch (error) {
                active(); note(`B 站风险：看系统通知的未读数失败（过 15 分钟再试）：${reason(error)}`);
                return;
            }
            if (!count(unread)) { note('B 站风险：系统通知未读数无效；保留进度后续重试'); return; }
            if (unread === 0) {
                if (state.lastUnread || state.alertedUnread !== undefined) commit(next => { next.lastUnread = 0; delete next.alertedUnread; });
                return;
            }
            let notices: Awaited<ReturnType<BiliAccount['systemNotices']>> = [];
            try {
                notices = await read(() => account.systemNotices(cancellation.signal));
                if (!Array.isArray(notices) || !notices.every(notice => stateObject(notice) && typeof notice.id === 'string' && notice.id.length > 0 && typeof notice.title === 'string' && typeof notice.content === 'string' && timestamp(notice.at))) throw new Error('系统通知列表形状无效');
            } catch (error) { active(); note(`B 站风险：读系统通知失败：${reason(error)}`); notices = []; }
            const fresh = notices.filter(notice => !state.seen.includes(notice.id));
            const risky = fresh.filter(notice => RISK_NOTICE.test(`${notice.title}${notice.content}`));
            const observedAt = risky.length ? clock() : t; active();
            if (notices.length) commit(next => {
                next.lastUnread = unread;
                next.seen = [...new Set([...next.seen, ...fresh.map(notice => notice.id)])];
                if (risky.length) {
                    const until = observedAt + RISK_HALT_DAYS * 86_400_000;
                    if (!timestamp(until)) throw new Error('B 站风险暂停时间无效');
                    next.until = Math.max(next.until ?? until, until);
                }
            });
            if (risky.length) {
                const first = risky[0]!;
                const event = { why: `她的号收到了 B 站的系统通知「${first.title.slice(0, 40)}」${first.content ? `：${first.content.slice(0, 160)}` : ''}${risky.length > 1 ? `（另有 ${risky.length - 1} 条）` : ''}` };
                note(`B 站风险：${event.why}；公开评论和回复停 ${RISK_HALT_DAYS} 天，之后的话只走私信`);
                await alert(alertText(event), observedAt);
            } else if (fresh.length) {
                note(`B 站风险：系统通知 ${fresh.length} 条，没有违规 / 警告一类的字眼（${fresh.map(notice => notice.title.slice(0, 20)).join('、')}）`);
            } else if (notices.length === 0) {
                // 未读数涨了但读不出内容：不知道是什么，不停发言，只让他去看一眼（读得出、只是都见过了的不用提醒）。
                // 读取每轮都重试（ADR 0090 2026-11-05），但同一个未读数只提醒一次。
                if ((pending ?? state).alertedUnread === unread) { note(`B 站风险：${unread} 条未读的系统通知还是读不出内容，已经提醒过，过 15 分钟再试`); return; }
                await alert(`【B 站风险提醒】她的号有 ${unread} 条未读的系统通知，我没能读出内容；请你登录她的号看一眼是不是违规或风控提醒。`, t);
                if ((pending ?? state).lastAlertAt === t) commit(next => { next.alertedUnread = unread; });
            }
        } finally {
            busy = false;
        }
    }
    const tick = () => owned(tickWork);
    const backgroundTick = () => { void tick().catch(error => note(`B 站风险：监控失败（${reason(error)}）`)); };

    return {
        halted: () => clock() < ((pending ?? state).until ?? -Infinity),
        trip, tick, record,
        start() {
            if (stopped || timer) return;
            backgroundTick();
            if (stopped) return;
            timer = setInterval(backgroundTick, 60_000);
            timer.unref?.();
        },
        stop() {
            if (drain) return drain;
            stopped = true; cancellation.abort(stoppedError);
            if (timer) clearInterval(timer);
            timer = undefined;
            drain = Promise.allSettled([...jobs]).then(() => { flush(); });
            return drain;
        },
    };
}
