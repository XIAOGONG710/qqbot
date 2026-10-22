// 关系阶段（ADR 0113，配置 relationship，默认关）：角色卡【会变】写着“相处越久越敢说心里话；一开始嘴硬、要面子，慢慢的会主动说想他；变化要慢”。原来卡是静态的。
// 做法：不存分数，每一轮从聊天记录往回推（ADR 0039 的 lingering）：最近 30 天里“真聊过”的天数（他那天至少说了 3 条）。
// 只做向上的变化：卡的基线已经是“在一起一年多”，聊得少时保持现在的样子（不让她因为他忙而变冷、变生分——那会和用户调过的亲密回应冲突，也像在惩罚他不来）；
// 连着聊了 CLOSE_DAYS 天以上，她更放得开一点（想他直接说、心里的事愿意往外倒一点），仍然是她，不变得黏人。
// 窗口是滑动的：断了两个星期没聊，自然回到基线；一天之内不会变个人（要攒够 14 个“真聊过”的天）。

const DAY_MS = 86_400_000;
/** 看最近多少天 */
export const CLOSE_WINDOW_DAYS = 30;
/** 窗口里有这么多天“真聊过”才更放得开 */
export const CLOSE_DAYS = 14;
/** 一天里他至少说了几条才算“真聊过”（一句“在吗”不算） */
export const TALK_DAY_MIN_MESSAGES = 3;

type Said = { role: 'user' | 'assistant'; time?: string };

const localDay = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** 截至 at 的最近 30 天里“真聊过”的天数 */
export function talkDays(history: readonly Said[], at: number): number {
    const perDay = new Map<string, number>();
    for (const message of history) {
        if (message.role !== 'user' || message.time === undefined) continue;
        const time = Date.parse(message.time);
        if (Number.isNaN(time) || time > at || at - time >= CLOSE_WINDOW_DAYS * DAY_MS) continue;
        const day = localDay(time);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    return [...perDay.values()].filter(count => count >= TALK_DAY_MIN_MESSAGES).length;
}

/** 此刻她对他放得有多开：基线（undefined，不加一行）或更放得开 */
export function describeCloseness(history: readonly Said[], at: number): string | undefined {
    const days = talkDays(history, at);
    if (days < CLOSE_DAYS) return undefined;
    return `[你们最近几乎天天都在聊（这个月已经聊了 ${days} 天），你对他比平时更放得开一点：想他了直接说，心里的事（担心以后、怕他不理你、数学又被卡住）愿意往外倒一点点，嘴硬更多是逗他的玩笑；别突然变得黏人腻歪，该是你的口气还是你的口气]`;
}
