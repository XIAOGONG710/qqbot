// 提示词槽位表（ADR 0336 第 3 节）：模块只说自己的段落放进哪个槽，先后由这张表决定。
// 顺序照搬迁移前 contact.ts 手写的 afterMain / afterHistory（DSH 线的版本，行为基线逐字核对）：改顺序就是改行为，要单独提交并更新基线。
//
// 两级：
// - 消息槽：每段是一条独立的 system 消息，放在聊天记录之后（afterHistory），或 main 之后（afterMain）。
// - 「此刻」块的行槽：这些行按顺序用换行拼成一条消息，放在 afterHistory 的最后（时间、状态、心情、意图、形状……）。
// 同一个槽里有几段时，按模块注册顺序、同一模块按给出的顺序排。

/** main 之后、不常变的（长期记忆里的关系概况）；同 ST 的 After Main Prompt */
export const AFTER_MAIN_SLOTS = ['relationship'] as const;

/** 聊天记录之后的独立消息，按这个顺序；最后固定是「此刻」块（NOW_SLOTS 拼成的一条） */
export const AFTER_HISTORY_SLOTS = [
    'summary', // 更早聊天的要点（ADR 0043）
    'recalled', // 他的私人记忆
    'work', // 她在电脑上做的事（DSH 工作模式）
    'desktop', // 桌面上的她（DSH）
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

export type AfterMainSlot = (typeof AFTER_MAIN_SLOTS)[number];
export type AfterHistorySlot = (typeof AFTER_HISTORY_SLOTS)[number];
export type NowSlot = (typeof NOW_SLOTS)[number];
export type Slot = AfterMainSlot | AfterHistorySlot | NowSlot;

/** 一段提示词：放进哪个槽、什么内容 */
export interface Piece { slot: Slot; text: string }

const where = new Map<string, { list: 'main' | 'history' | 'now'; index: number }>([
    ...AFTER_MAIN_SLOTS.map((slot, index) => [slot, { list: 'main' as const, index }] as const),
    ...AFTER_HISTORY_SLOTS.map((slot, index) => [slot, { list: 'history' as const, index }] as const),
    ...NOW_SLOTS.map((slot, index) => [slot, { list: 'now' as const, index }] as const),
]);

/** 槽名只能出现在一处（slots.test.ts 也核对） */
export const ALL_SLOTS: readonly Slot[] = [...AFTER_MAIN_SLOTS, ...AFTER_HISTORY_SLOTS, ...NOW_SLOTS];

/** 按槽位表把段落排好、拼成 buildPrompt 要的 afterMain / afterHistory；没有「此刻」行时不加那条消息 */
export function assemblePrompt(pieces: readonly Piece[]): { afterMain: string[]; afterHistory: string[] } {
    type Placed = { index: number; order: number; text: string };
    const byList: Record<'main' | 'history' | 'now', Placed[]> = { main: [], history: [], now: [] };
    pieces.forEach((piece, order) => {
        const at = where.get(piece.slot);
        if (!at) throw new Error(`没有这个提示词槽：${piece.slot}`);
        byList[at.list].push({ index: at.index, order, text: piece.text });
    });
    const sorted = (list: Placed[]) => [...list].sort((a, b) => a.index - b.index || a.order - b.order).map(item => item.text);
    const now = sorted(byList.now);
    return { afterMain: sorted(byList.main), afterHistory: [...sorted(byList.history), ...(now.length ? [now.join('\n')] : [])] };
}
