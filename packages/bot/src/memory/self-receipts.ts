// 桌面回执的消费（ADR 0347 第 2 层，方案 docs/plans/2026-11-22-same-her-layer2-self.md 二、5）：
// DSH 插件在一个桌面回合结束时往灵魂目录的 self-receipts.jsonl 追加一行（life/self-types.ts 的 SelfReceipt）：
// 这一轮放给她看过哪几件「攒着想跟他说的」（shown）、她这一轮回了什么（said，前 600 字）。QQ 这边按件认「说过了」，经计划器的方法落地
// （主动消息状态归计划器所有，外部直接改文件会被下一次 save 覆盖）：
// - 念头：said 逐句和念头比 similarity（inner.ts），过门槛才算——宁可漏判（漏了最多和现在一样，QQ 6 小时内可能再说一次），门槛偏严；
// - 待跟进：mentions（follow-ups.ts，和主动消息问过之后的判断同一个函数）；
// - 她那边的事：放给她看过、他在、她回了话就算（用户 2026-11-22 定，和 QQ「那之后聊过了」的规矩一致）。
// 只认 shown 里的 id（没放给她看的碰巧说到了也不算）；id 已经不在计划器当前的待说清单里（说过了、过期了、危机暂停）就跳过。
// 行游标、id 去重、坏行、未来时间停在原行都复用 dsh-inbox.ts 的 consumeInbox。日志只记件数，不记内容。
// 只有主会话接上（开关 selfReceipts）才会调用；不调用时什么都不读、什么都不改。

import { consumeInbox, INBOX_ID_RE, inboxTimeInWindow } from './dsh-inbox.ts';
import { mentions } from '../proactive/follow-ups.ts';
import { similarity } from '../proactive/inner.ts';
import type { SelfPending, SelfReceipt } from '../life/self-types.ts';

/** 计划器上回执要用的那几个方法（proactive-planner.ts 的 Planner） */
export interface SelfReceiptPlanner {
    pendingForSelf(now: number, limit?: number): SelfPending[];
    selfReady(): boolean;
    markTold(thoughtId: string): boolean;
    markAskedElsewhere(followUpId: string): boolean;
    markNewsElsewhere(newsId: string, at: Date): boolean;
}

export interface SelfReceiptCounts {
    /** 这一次消费了几行回执 */
    receipts: number;
    inner: number;
    followUp: number;
    news: number;
}

/**
 * 念头算「说出口了」的门槛：她回的某一句和念头的 similarity（二字组合重合 / 较短那句的组合数）。
 * 方案先给 0.3；拿合成样例试下来，没说到的句子能到 0.33–0.5（「最近好冷啊」对「他最近好像很累的样子」0.5，「今天食堂人好多，挤死了」对「今天食堂的饭好难吃」0.38），
 * 换个说法说出口的在 0.69 以上，所以取 0.6；「你最近是不是很累啊」（0.25）这种会漏，按「宁可漏判」接受（样例在 test/self-receipts.test.ts）
 */
export const THOUGHT_TOLD_MIN = 0.6;
/** 一句话（和念头）至少要有这么多个不同的二字组合才比：太短的句子随便撞上一两个字就是满分 */
export const THOUGHT_MIN_PAIRS = 4;

const MAX_SHOWN = 20;
const MAX_SAID = 600;
const PENDING_ID_RE = /^(?:inner|news|followUp):[^\x00-\x1f\x7f]{1,200}$/;

/** 和 inner.ts 的 similarity 同样去掉标点空白后的二字组合（只用来数够不够长） */
function pairCount(text: string): number {
    const list = [...text.replace(/[\s，。！？、…～~,.!?「」“”"'（）()]/g, '')];
    return new Set(list.slice(0, -1).map((c, i) => c + list[i + 1])).size;
}

/** 她这一轮的回复里有没有一句说的就是这个念头 */
export function thoughtSaid(said: string, thought: string): boolean {
    if (pairCount(thought) < THOUGHT_MIN_PAIRS) return false;
    return said.split(/[。！？!?；;…～~\n]+|\s+/)
        .filter(sentence => pairCount(sentence) >= THOUGHT_MIN_PAIRS)
        .some(sentence => similarity(sentence, thought) >= THOUGHT_TOLD_MIN);
}

/** 一行回执 → 校验过的回执；不合格返回 undefined（跳过这一行） */
export function parseSelfReceipt(value: unknown, now: number): SelfReceipt | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const row = value as Partial<Record<keyof SelfReceipt, unknown>>;
    if (row.v !== 1 || typeof row.id !== 'string' || !INBOX_ID_RE.test(row.id) || !inboxTimeInWindow(row.at, now)) return undefined;
    if (typeof row.selfAt !== 'string' || !Number.isFinite(Date.parse(row.selfAt)) || Date.parse(row.selfAt) > Date.parse(row.at)) return undefined;
    if (!Array.isArray(row.shown) || !row.shown.length || row.shown.length > MAX_SHOWN || !row.shown.every(id => typeof id === 'string' && PENDING_ID_RE.test(id))) return undefined;
    if (typeof row.said !== 'string') return undefined;
    const said = [...row.said.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')].slice(0, MAX_SAID).join('').trim();
    if (!said) return undefined;
    return { v: 1, id: row.id, at: row.at, selfAt: row.selfAt, shown: [...new Set(row.shown as string[])], said };
}

/**
 * 消费灵魂目录的 self-receipts.jsonl：file 是回执文件，stateFile 是游标和去重 id（<数据目录>/memory/self-receipts-state.json）。
 * 计划器状态读不到 / 已暂停时这一轮不读（不然回执被消费掉却落不了地）；某件落地出错时停在这一行，下轮重来（落过的件再来一次不会重复改）。
 */
export function consumeSelfReceipts(options: {
    file: string;
    stateFile: string;
    planner: SelfReceiptPlanner;
    now: Date;
    log: (message: string) => void;
}): SelfReceiptCounts {
    const { planner, log } = options;
    const counts: SelfReceiptCounts = { receipts: 0, inner: 0, followUp: 0, news: 0 };
    if (!planner.selfReady()) return counts;
    const now = options.now.getTime();
    counts.receipts = consumeInbox(options.file, options.stateFile, parseSelfReceipt, receipt => {
        const pending = new Map(planner.pendingForSelf(now, Infinity).map(item => [item.id, item]));
        for (const id of receipt.shown) {
            const item = pending.get(id);
            if (!item) continue;
            const raw = id.slice(id.indexOf(':') + 1);
            if (item.kind === 'inner') {
                if (thoughtSaid(receipt.said, item.text) && planner.markTold(raw)) counts.inner++;
            } else if (item.kind === 'followUp') {
                if (mentions({ what: item.text }, [receipt.said]) && planner.markAskedElsewhere(raw)) counts.followUp++;
            } else if (planner.markNewsElsewhere(raw, new Date(receipt.at))) {
                counts.news++;
            }
        }
    }, now, log, '桌面回执');
    const told = counts.inner + counts.followUp + counts.news;
    if (counts.receipts) log(`回执：读了 ${counts.receipts} 行，桌面上说过了 ${told} 件（念头 ${counts.inner} / 待跟进 ${counts.followUp} / 她那边的事 ${counts.news}；不记内容）`);
    return counts;
}
