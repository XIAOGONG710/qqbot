// 提示词槽位表（ADR 0336 第 3 节）：模块只说自己的段落放进哪个槽，先后由这张表决定。
// 顺序照搬迁移前 contact.ts 手写的 afterMain / afterHistory（DSH 线的版本，行为基线逐字核对）：改顺序就是改行为，要单独提交并更新基线。
//
// 两级：
// - 消息槽：每段是一条独立的 system 消息，放在聊天记录之后（afterHistory），或 main 之后（afterMain）。
// - 「此刻」块的行槽：这些行按顺序用换行拼成一条消息，放在 afterHistory 的最后（时间、状态、心情、意图、形状……）。
// 同一个槽里有几段时，按模块注册顺序、同一模块按给出的顺序排。

import { fewerRules, RULE_SLOTS } from '../language/fewer-rules.ts';

/** main 之后、不常变的（长期记忆里的关系概况）；同 ST 的 After Main Prompt */
export const AFTER_MAIN_SLOTS = [
    'relationship',
    'portrait', // 她自己写的「我现在的样子」（ADR 0340）：会变的那部分，紧跟在卡和关系概况后面
] as const;

/** 聊天记录之后的独立消息，按这个顺序；最后固定是「此刻」块（NOW_SLOTS 拼成的一条） */
export const AFTER_HISTORY_SLOTS = [
    'summary', // 更早聊天的要点（ADR 0043）
    'recalled', // 他的私人记忆
    'work', // 她在电脑上做的事（DSH 工作模式）
    'desktop', // 桌面上的她（DSH）
    'group', // QQ 群里最近的事（2026-11-14：群里的事私下问她，她得知道）
    'common', // 公共记忆（那天的流水账放在它后面，ADR 0032 调整 3）
    'recap', // 他问到的那一天她那边的事
    'today', // 她今天和别人聊过的
    'past', // 她的过去（ADR 0022）
    'npcs', // 她身边的人最近两周（ADR 0033）
    'people', // 提到的名单里的人（ADR 0016）
    'disclosure', // 对别人说起时的分寸（ADR 0020）
] as const;

/** 「此刻」块里的行，按这个顺序拼成一条消息 */
export const NOW_SLOTS = [
    'time', 'days', 'state',
    'groundNote', // 「你现在」和身体那几行是底子不是话题（DSH 10-30）
    // 按日期抽的心情、她的追求不再注入（DSH 10-30 用户：替她表态的都清掉），没有槽
    'body', 'humanState', 'development', 'unsettled', 'warm', 'feeling', 'pace', 'books', 'world', 'practice',
    'selfNote', 'plans', 'promised', 'obstacle',
    'partnerBack', // 放在事实的最后、离他最新的话最近（ADR 0007 调整）
    'together', 'closeness', 'joke', 'idiom', 'meme',
    'memeDict', 'exemplar', 'register', 'selfThread', 'shell', 'scene', 'askHint', 'voice', 'question', 'opinion', 'unsure', 'dreams',
    'shellIntent', 'reading', 'speechNote', 'review', 'insight', 'takes', 'thoughts', 'guesses',
    'watched', 'continuity', 'interrupt', 'devices', 'sticker', 'photo',
    'intent', 'lastUser', 'understanding', 'traces', 'person', 'directAnswer', 'noOverthink', 'selfMemory', 'refusal', 'rating', 'life', 'wake', 'herAsk',
    'workRequest', 'workJudge', 'workMode',
    'deliberate', 'routedHint', 'length', 'shape', 'quote', 'crutch', 'told', 'opener', 'inner', 'intimate', 'transcript', 'solveFrame', 'initiateNote',
] as const;

/**
 * 「此刻的她」（SELF.json，ADR 0347 第 2 层，方案 docs/plans/2026-11-22-same-her-layer2-self.md 二、1）导出哪几个「此刻」行槽：
 * 关于她此刻的事实（在干嘛、身体、她那边、今天的打算、答应的、没了结的、心境、梦、最近的念头），不跟着他这一句话走、不教她怎么说话。
 * 每个都必须在 NOW_SLOTS 里（测试钉住）；先后照 NOW_SLOTS，不照这里。
 * 「这两天自己在做的」（selfThread：日记那句 + ownDays 那行）由 soul 模块在快照里给，和 QQ 提示词同一段（见 platform/contact.ts 的 snapshot）。
 */
export const SELF_SLOTS = ['days', 'state', 'groundNote', 'body', 'unsettled', 'feeling', 'world', 'plans', 'promised', 'partnerBack', 'selfThread', 'dreams', 'inner'] as const satisfies readonly NowSlot[];

/**
 * SELF 要的段落：只留 SELF_SLOTS 里的，按 NOW_SLOTS 的先后排（同一槽按给出的顺序，同 assemblePrompt）。
 * 少规矩开着时丢掉 RULE_SLOTS 里的槽，和 assemblePrompt 同一个开关、同一张表（快照不是危机回合），保证和 QQ「此刻」块一致
 */
export function selfPieces(pieces: readonly Piece[]): Piece[] {
    const wanted = new Set<string>(SELF_SLOTS);
    const index = (slot: Slot) => (NOW_SLOTS as readonly string[]).indexOf(slot);
    return pieces
        .map((piece, order) => ({ piece, order }))
        .filter(({ piece }) => wanted.has(piece.slot) && !(fewerRules() && RULE_SLOTS.has(piece.slot)))
        .sort((a, b) => index(a.piece.slot) - index(b.piece.slot) || a.order - b.order)
        .map(({ piece }) => piece);
}

export type AfterMainSlot = (typeof AFTER_MAIN_SLOTS)[number];
export type AfterHistorySlot = (typeof AFTER_HISTORY_SLOTS)[number];
export type NowSlot = (typeof NOW_SLOTS)[number];
export type Slot = AfterMainSlot | AfterHistorySlot | NowSlot;

/**
 * 一段提示词：放进哪个槽、什么内容。
 * module 是产出它的模块（解释器 contributeTurn 收段落时标上，提示词指纹清单 platform/prompt-manifest.ts 用）：不进提示词，拼的时候只看 slot 和 text
 */
export interface Piece { slot: Slot; text: string; module?: string }

const where = new Map<string, { list: 'main' | 'history' | 'now'; index: number }>([
    ...AFTER_MAIN_SLOTS.map((slot, index) => [slot, { list: 'main' as const, index }] as const),
    ...AFTER_HISTORY_SLOTS.map((slot, index) => [slot, { list: 'history' as const, index }] as const),
    ...NOW_SLOTS.map((slot, index) => [slot, { list: 'now' as const, index }] as const),
]);

type PromptList = 'main' | 'history' | 'now';

/** 真正放进去的段落，按三张表分好、各自排好（assemblePrompt 和 placedPieces 共用，清单和提示词是同一次筛、同一次排） */
function place(pieces: readonly Piece[], options: { crisis?: boolean }): Record<PromptList, Piece[]> {
    type Placed = { index: number; order: number; piece: Piece };
    const byList: Record<PromptList, Placed[]> = { main: [], history: [], now: [] };
    pieces.forEach((piece, order) => {
        const at = where.get(piece.slot);
        if (!at) throw new Error(`没有这个提示词槽：${piece.slot}`);
        // 少规矩（ADR 0342，默认关）：教她怎么说话的槽不放；危机回合整套照放
        if (fewerRules() && !options.crisis && RULE_SLOTS.has(piece.slot)) return;
        byList[at.list].push({ index: at.index, order, piece });
    });
    const sorted = (list: Placed[]) => [...list].sort((a, b) => a.index - b.index || a.order - b.order).map(item => item.piece);
    return { main: sorted(byList.main), history: sorted(byList.history), now: sorted(byList.now) };
}

/** 按槽位表把段落排好、拼成 buildPrompt 要的 afterMain / afterHistory；没有「此刻」行时不加那条消息 */
export function assemblePrompt(pieces: readonly Piece[], options: { crisis?: boolean } = {}): { afterMain: string[]; afterHistory: string[] } {
    const placed = place(pieces, options);
    const texts = (list: readonly Piece[]) => list.map(piece => piece.text);
    const now = texts(placed.now);
    return { afterMain: texts(placed.main), afterHistory: [...texts(placed.history), ...(now.length ? [now.join('\n')] : [])] };
}

/** 一段真正放进提示词的段落：在哪张表里（main 之后 / 聊天记录之后 / 「此刻」块） */
export interface PlacedPiece { list: PromptList; piece: Piece }

/**
 * 真正放进提示词的段落（和 assemblePrompt 同一个筛法、同一个先后）：先 main 的，再聊天记录之后的，最后「此刻」块的行。
 * 提示词指纹清单（platform/prompt-manifest.ts）按它记每段的槽、模块和哈希
 */
export function placedPieces(pieces: readonly Piece[], options: { crisis?: boolean } = {}): PlacedPiece[] {
    const placed = place(pieces, options);
    return (['main', 'history', 'now'] as const).flatMap(list => placed[list].map(piece => ({ list, piece })));
}
