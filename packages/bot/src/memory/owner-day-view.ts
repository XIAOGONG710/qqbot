// 他这一天和她说过的话：QQ 聊天记录加上桌面回合，按时间排成一份（ADR 0347 第 3 层，方案 docs/plans/2026-11-22-same-her-layer3-writeback.md §2.4）。
// 给男朋友档的 promiseKeeper 当聊天来源，桌面上说的「明天帮你看完」才进承诺账（开关 desktopPromises，要 desktopDay 和长期记忆；接线由 App 做）。
// 只是纯函数，不读文件、不落盘、不记日志。
//
// - 桌面回合转成 StoredMessage：内容前加「（电脑上）」，没有 messageId / messageSeq / sourceTime，recalled 永远不设（撤回只在 QQ 上有）。
//   他那句的时刻用 userAt；旧格式没有时取 at 往前推 TURN_LEAD_MS（和 desktop-presence 切会话同一个回退），但不早于上一轮结束，
//   这样桌面那几句自己的先后不会乱；她那句用 at。哪边是空的就不出那一条。
// - 合并是稳定的：QQ 记录原来的先后一条不动，桌面那几条插在第一条比它晚的 QQ 消息前面（同一秒的 QQ 在前）。
//   时刻都截到秒（localIso），同一份输入每次给出同一份视图，片段 id（ep-<第一条毫秒>）和来源摘要就稳定。
// - 没有桌面回合时原样给回 QQ 记录（同一份内容），开关关着和开着但桌面上没说话时承诺账一模一样。
// - 只给男朋友档：ownerDayHistory 只换 ownerQq 那一位的 load，其他人照旧、也不去读桌面回合（§2.8：桌面原文只进男朋友档的承诺抽取）。
//   桌面回合读不了时让它抛出去：promiseKeeper 会当「来源暂不可确认」暂停，而不是悄悄少了桌面那几句、把已抽的片段当成被改过。
// - ownerDayKeeper 把时间块的 describe / openLoops 也换成看合并视图判「这一段」，和承诺记下的片段 id 对得上（只用 role / time）。

import type { StoredMessage } from './history.ts';
import { localIso } from './episodes.ts';
import { TURN_LEAD_MS, type PresenceTurn } from '../life/desktop-presence.ts';
import type { PromiseKeeper } from '../life/promises.ts';
import type { Contact } from '../platform/config.ts';
import type { TimedMessage } from '../st/time-macros.ts';

/** 桌面回合在合并视图里的前缀 */
export const DESKTOP_PREFIX = '（电脑上）';

/** 一轮桌面对话（desktop-log.ts 的 desktopTurns 给的就是这个） */
export interface OwnerDayTurn extends PresenceTurn {
    at: number;
    userAt?: number;
    user: string;
    assistant: string;
}

const PROMISE_CHOICE = /【(?:我答应并记下|我改主意了)[：:][^【】\r\n]+】/g;

/** 承诺账只看她自己说出口的记账句和改口句。聊天正文不能代替这些句子。 */
export function desktopPromiseTurns(turns: readonly OwnerDayTurn[]): OwnerDayTurn[] {
    return turns.flatMap(turn => {
        const assistant = [...turn.assistant.matchAll(PROMISE_CHOICE)]
            .map(match => match[0]).join('\n');
        return assistant ? [{ ...turn, assistant }] : [];
    });
}

interface Timed { message: StoredMessage; ms: number }

const stamp = (ms: number): { time: string; ms: number } => {
    const time = localIso(new Date(ms));
    return { time, ms: Date.parse(time) };
};

/** 桌面回合 → 按时间排好的消息（他、她各一条，空的那边不出） */
export function desktopMessages(turns: readonly OwnerDayTurn[]): StoredMessage[] {
    return desktopTimed(turns).map(item => item.message);
}

function desktopTimed(turns: readonly OwnerDayTurn[]): Timed[] {
    const sorted = turns.map((turn, index) => ({ turn, index })).sort((a, b) => a.turn.at - b.turn.at || a.index - b.index).map(item => item.turn);
    const out: Timed[] = [];
    for (const turn of sorted) {
        const start = turn.userAt ?? turn.at - TURN_LEAD_MS;
        // 他开口不晚于这一轮结束、不早于前面已经排出去的那条（上一轮她的回答）
        const lastMs = out.at(-1)?.ms ?? -Infinity;
        if (turn.user.trim()) {
            const { time, ms } = stamp(Math.max(Math.min(start, turn.at), lastMs));
            out.push({ message: { time, role: 'user', content: `${DESKTOP_PREFIX}${turn.user}` }, ms });
        }
        if (turn.assistant.trim()) {
            const { time, ms } = stamp(Math.max(turn.at, out.at(-1)?.ms ?? -Infinity));
            out.push({ message: { time, role: 'assistant', content: `${DESKTOP_PREFIX}${turn.assistant}` }, ms });
        }
    }
    return out;
}

/**
 * QQ 记录 + 桌面回合，按时间合成一份。QQ 那边的先后不动；桌面那几条插在第一条比它晚的 QQ 消息前面。
 * 没有桌面回合时给回 QQ 记录的副本。也收只带 role / time 的聊天（时间块判「这一段」用，见 ownerDayKeeper）。
 */
export function ownerDayView<T extends { role: 'user' | 'assistant'; time?: string }>(history: readonly T[], desktop: readonly OwnerDayTurn[]): (T | StoredMessage)[] {
    const extra = desktopTimed(desktop);
    if (!extra.length) return [...history];
    const merged: (T | StoredMessage)[] = [];
    let j = 0;
    for (const message of history) {
        const ms = Date.parse(message.time ?? '');
        // 时刻读不懂（或没有）的 QQ 消息不挪动它，让后面切片段时照旧报错（和没开开关时一样）
        while (j < extra.length && Number.isFinite(ms) && extra[j]!.ms < ms) merged.push(extra[j++]!.message);
        merged.push(message);
    }
    while (j < extra.length) merged.push(extra[j++]!.message);
    return merged;
}

/** promiseKeeper 要的聊天来源 */
export interface HistorySource { load(qq: number): StoredMessage[] }

export interface OwnerDayHistoryOptions {
    /** 男朋友档那一位；没有就谁都不换 */
    ownerQq: number | undefined;
    /** 他的桌面回合（App 给 () => desktopTurns(dataDir, now)）；只在读他的记录时调用 */
    desktop: () => readonly OwnerDayTurn[];
}

/** 只把男朋友档那一位的记录换成合并视图，其他人原样转交 */
export function ownerDayHistory(base: HistorySource, options: OwnerDayHistoryOptions): HistorySource {
    const { ownerQq } = options;
    if (ownerQq === undefined) return base;
    return {
        load: qq => {
            const history = base.load(qq);
            return qq === ownerQq ? ownerDayView(history, options.desktop()) : history;
        },
    };
}

/**
 * 时间块里「这一段聊天里刚说的不再提醒」（duePromises / dueLoops 按聊天的最后一个片段判）也要看合并视图：
 * 不然在电脑上先说好「明天六点东门见」、接着在 QQ 上聊，QQ 那段的片段 id 和承诺记下的片段 id 对不上，刚说完就又提醒一遍。
 * 只换男朋友档那一位的 chat；这里只用到 role / time，桌面原文不会因此多去哪儿。
 * 这条在回话路上，桌面回合读不了就照旧用 QQ 的 chat（顶多多提醒一次），不让回话失败。
 */
export function ownerDayKeeper<K extends Pick<PromiseKeeper, 'describe' | 'openLoops'>>(keeper: K, options: OwnerDayHistoryOptions): K {
    const { ownerQq } = options;
    if (ownerQq === undefined) return keeper;
    const chatOf = (contact: Contact, chat: readonly TimedMessage[]): readonly TimedMessage[] => {
        if (contact.qq !== ownerQq) return chat;
        try { return ownerDayView(chat, options.desktop()); } catch { return chat; }
    };
    return {
        ...keeper,
        describe: (contact: Contact, chat: readonly TimedMessage[], now: Date) => keeper.describe(contact, chatOf(contact, chat), now),
        openLoops: (contact: Contact, chat: readonly TimedMessage[], now: Date) => keeper.openLoops(contact, chatOf(contact, chat), now),
    };
}
