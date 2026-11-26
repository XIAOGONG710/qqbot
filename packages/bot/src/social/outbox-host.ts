import { join } from 'node:path';
import { ODD_BODY_WORDS, STILTED_WORDS } from '../language/expression.ts';
import { inspectReply, summarizeIssues, type ExitIssue } from '../language/exit-check.ts';
import { asleepSince } from '../life/bedtime.ts';
import { outboxDesktopBlock, type DesktopNowSource } from '../life/desktop-now.ts';
import type { Schedule } from '../life/schedule.ts';
import type { HistoryMessage } from '../memory/backfill.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { AppConfig, Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import { OneBotNotDispatched, segmentsToText } from '../platform/onebot.ts';
import type { Character } from '../st/card.ts';
import { drainOutbox, type OutboxReconciliation } from './outbox.ts';

// 她自己想让他知道的事（ADR 0174）：常驻进程 / 她写进 OUTBOX.jsonl，这里发出去，和别的主动消息守同一套规矩
// （危机暂停、休眠、她睡了、他就在电脑前都先留着；出口检查里会出事的几类挡下）。
// 原来在 app.ts 里（outboxTick），ADR 0336 收尾（docs/plans/2026-11-24-0336-finish.md）原样搬到这里；
// 每 30 秒一拍仍由 outbox 模块声明（App 搭好时开）。

const OUTBOX_BLOCKING = new Set<ExitIssue['kind']>(['banned', 'promise', 'media', 'script', 'text-intimacy']);
const OUTBOX_HISTORY_COUNT = 100;
const DELIVERY_WINDOW_MS = 60_000;

export function reconcileOutboxHistory(rows: readonly HistoryMessage[], account: number, text: string, startedAt: number): OutboxReconciliation {
    // 普通私聊历史只能提供正向证据。空页、未同步、撤回和分页遗漏都不能证明没发。
    const matches = rows.filter(row => row && (row.sender?.user_id ?? row.user_id) === account
        && Number.isSafeInteger(row.message_id) && row.message_id > 0 && Number.isSafeInteger(row.time)
        && row.time * 1000 >= Math.floor(startedAt / 1000) * 1000 && row.time * 1000 <= startedAt + DELIVERY_WINDOW_MS
        && (typeof row.message === 'string' || Array.isArray(row.message) && row.message.every(segment => segment?.type === 'text' || segment?.type === 'face'))
        && segmentsToText(row.message) === text);
    const match = matches.length === 1 ? matches[0] : undefined;
    return match ? { kind: 'delivered', messageId: match.message_id, at: match.time * 1000 } : { kind: 'unknown' };
}

export interface OutboxHostDeps {
    config: Pick<AppConfig, 'dataDir'>;
    /** 名单里第一个男朋友档（deviceOwner）：只发给他 */
    owner: Contact | undefined;
    /** OUTBOX.jsonl（QQBOT_OUTBOX 或灵魂目录下的） */
    file: string;
    cardFor: (tier: string) => { character: Pick<Character, 'schedule' | 'banned'> };
    now: () => number;
    crisisPaused: (qq: number, now: number) => boolean;
    dormant: () => boolean;
    bedtimes: (schedule: Schedule, now: number) => number[];
    desktopSource: DesktopNowSource | undefined;
    send: (qq: number, text: string) => Promise<number>;
    selfId: () => number;
    friendHistory: (qq: number, count: number) => Promise<HistoryMessage[]>;
    record: (qq: number, message: StoredMessage) => void;
    log: Log;
}

export function outboxHost({ config, owner: deviceOwner, file: outboxFile, cardFor, now: clock, crisisPaused, dormant, bedtimes, desktopSource, send, selfId, friendHistory, record, log }: OutboxHostDeps): { tick(): void } {
    let outboxBusy = false;
    let outboxBlockedBy: string | undefined;
    const outboxTick = (): void => {
        const owner = deviceOwner;
        const account = selfId();
        if (!owner || !account || outboxBusy) return;
        const { character } = cardFor(owner.tier);
        outboxBusy = true;
        void drainOutbox({
            file: outboxFile,
            stateFile: join(config.dataDir, 'outbox-state.json'),
            now: () => clock(),
            blocked: now => crisisPaused(owner.qq, now) ? '他最近说过想伤害自己的话，普通主动消息暂停 48 小时'
                : dormant() ? '休眠中'
                : character.schedule && asleepSince(character.schedule, bedtimes(character.schedule, now), new Date(now)) ? '她睡了'
                // 他就在电脑前（desktopDay）：先留着，走了 10 分钟以上再发
                : desktopSource ? outboxDesktopBlock(desktopSource, now)
                : undefined,
            inspect: text => {
                const issues = inspectReply(text, [...character.banned, ...ODD_BODY_WORDS, ...STILTED_WORDS]).filter(issue => OUTBOX_BLOCKING.has(issue.kind));
                return issues.length ? summarizeIssues(issues) : undefined;
            },
            scope: `${account}:${owner.qq}`,
            reconcile: async (text, startedAt) => {
                const rows = await friendHistory(owner.qq, OUTBOX_HISTORY_COUNT);
                return selfId() === account ? reconcileOutboxHistory(rows, account, text, startedAt) : { kind: 'unknown' };
            },
            send: text => {
                if (selfId() !== account) throw new OneBotNotDispatched('留话投递账号已变更');
                return send(owner.qq, text);
            },
            record: (text, messageId, at) => record(owner.qq, { time: new Date(at).toISOString(), role: 'assistant', content: text, messageId }),
            log,
        }).then(result => {
            if (result.blockedBy !== outboxBlockedBy) {
                outboxBlockedBy = result.blockedBy;
                if (result.blockedBy) log(`主动留话：先留着不发（${result.blockedBy}）`);
            }
        }).catch(error => log(`主动留话出错：${error instanceof Error ? error.message : String(error)}`)).finally(() => { outboxBusy = false; });
    };
    return { tick: outboxTick };
}
