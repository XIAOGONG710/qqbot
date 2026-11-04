// 补回漏掉的消息：bot 停着或和 NapCat 断开期间的私聊，连上后从 NapCat 拉最近的记录补进聊天记录。
//
// 对照 vendor/NapCatQQ/packages/napcat-onebot/action/go-cqhttp/GetFriendMsgHistory.ts：
//   - 不带 message_seq 时取最新的 count 条，从旧到新
//   - message_id 是 md5(msgId|chatType|peerUid) 的前 31 位（napcat-common/src/message-unique.ts），
//     NapCat 重启后不变，和事件里、send_private_msg 返回的是同一个，所以按它去重
//   - 小号自己发的消息 post_type 为 message_sent，sender.user_id 是小号自己
//
// 只补比本地最后一条更新的消息：漏掉的只会出现在最后一条之后。
// （bot 运行期间小号在手机上手动发的消息不会推给 bot，也不在这里补，它们比本地最后一条旧。）

import type { StoredMessage } from './history.ts';
import { segmentsToText, type QuoteLookup, type Segment } from '../platform/onebot.ts';
import { OPS_NOTICE_PREFIX } from '.././ops/alert-qq.ts';
import { stateObject, stateTimestamp } from './state-schema.ts';

export const BACKFILL_COUNT = 20;
/** 最后一条没回的消息在这段时间内才回复，更早的只补记录（时间感知在 M3 之前，隔太久再接话会很怪） */
export const CATCH_UP_WINDOW_MS = 3 * 60 * 60 * 1000;

export interface HistoryMessage {
    message_id: number;
    /** 秒 */
    time: number;
    user_id?: number;
    sender?: { user_id?: number };
    message: Segment[] | string;
}

/** QQ历史是外部输入。单条坏记录不能让完整补回在toISOString/map处中断。 */
function validHistoryMessage(value: unknown): value is HistoryMessage {
    if (!stateObject(value) || !Number.isSafeInteger(value.message_id) || Number(value.message_id) < 0 || !Number.isSafeInteger(value.time)) return false;
    const at = new Date(Number(value.time) * 1000);
    if (!Number.isFinite(at.getTime()) || !stateTimestamp(at.toISOString())) return false;
    if (value.user_id !== undefined && (!Number.isSafeInteger(value.user_id) || Number(value.user_id) < 0)) return false;
    if (value.sender !== undefined && (!stateObject(value.sender) || (value.sender.user_id !== undefined && (!Number.isSafeInteger(value.sender.user_id) || Number(value.sender.user_id) < 0)))) return false;
    return typeof value.message === 'string' || (Array.isArray(value.message) && value.message.every(segment => stateObject(segment)
        && typeof segment.type === 'string' && (segment.data === undefined || stateObject(segment.data))));
}

/**
 * NapCat 返回的记录里，本地还没有、且比本地最后一条新的，按时间从旧到新。
 * notBefore：换档的时间（tier-record.ts）。降档后旧记录归档了，本地是空的，不设下限会把 QQ 里换档前的消息又补回来。
 */
export function findMissed(stored: StoredMessage[], fetched: HistoryMessage[], selfId: number, notBefore?: Date): StoredMessage[] {
    return toStored(newerThanStored(stored, fetched, notBefore), selfId);
}

/** findMissed 的前一半：还没转成文字的原始记录（他发的语音、图片先听一听、看一看再转，ADR 0052） */
export function newerThanStored(stored: StoredMessage[], fetched: HistoryMessage[], notBefore?: Date): HistoryMessage[] {
    const known = new Set(stored.map(m => m.messageId).filter(id => id !== undefined));
    const last = stored.at(-1);
    const since = last ? Date.parse(last.time) : -Infinity;
    const fetchedIds = new Set<string>();
    return fetched
        .filter(validHistoryMessage)
        .filter(m => {
            const key = JSON.stringify([m.message_id, m.time, m.sender?.user_id ?? m.user_id]);
            if (fetchedIds.has(key)) return false;
            fetchedIds.add(key); return true;
        })
        .filter(m => !known.has(m.message_id) && m.time * 1000 >= Math.floor(since / 1000) * 1000)
        // 运维提醒（外网断了 / 恢复了，用她的号发给用户，ops/alert-qq.ts）不是她说的话，不补进聊天记录
        .filter(m => !segmentsToText(m.message).trim().startsWith(OPS_NOTICE_PREFIX))
        .filter(m => !notBefore || m.time * 1000 >= notBefore.getTime())
        .sort((a, b) => a.time - b.time);
}

/** findMissed 的后一半：转成聊天记录里的一条（空的不要） */
export function toStored(messages: HistoryMessage[], selfId: number, quoted?: QuoteLookup): StoredMessage[] {
    return messages
        .filter(validHistoryMessage)
        .map((m): StoredMessage => ({
            time: new Date(m.time * 1000).toISOString(),
            role: (m.sender?.user_id ?? m.user_id) === selfId ? 'assistant' : 'user',
            content: segmentsToText(m.message, quoted).trim(),
            messageId: m.message_id,
        }))
        .filter(m => m.content);
}

/** 最后一条她说的话之后还有对方的消息，且其中最新一条在窗口内 */
export function shouldCatchUp(stored: StoredMessage[], now: Date, windowMs = CATCH_UP_WINDOW_MS): boolean {
    const lastReply = stored.findLastIndex(m => m.role === 'assistant');
    const unanswered = stored.slice(lastReply + 1).filter(m => m.role === 'user');
    const latest = unanswered.at(-1);
    const age = latest ? now.getTime() - Date.parse(latest.time) : NaN;
    return age >= 0 && age <= windowMs;
}
