// 被第三方打断（ADR 0115，配置 interruptions，默认关）：聊着聊着她那边发生了一件小事（室友喊她、快递到了、停水了……），真人会当场说一声“等下，室友喊我”。
// 原来这些小事只在“你那边（今天到现在的事实）”里排着，她自己想起来才会提，所以聊到一半从来没有被打断过。
// 做法：不存状态、不加新事实——世界账（ADR 0106 日常小事）里每件小事都有发生的时刻；这一轮如果有一件小事恰好发生在**这场聊天正在进行时**
// （她上一次回话之后、此刻之前的几分钟里），就在提示词里给她一行：“你刚被这件小事岔了一下”。细节只用那一句写的；要花时间的，她可以说“等下”，之后 comeBack（ADR 0112）让她自己回来。
// 不打断：他在难过 / 危机 / 小别扭、她这一轮在想事情、聊天没在进行（她上次回话在 5 分钟之前）、这件小事她已经自己说过了。

const MIN = 60_000;
/** 聊天算“正在进行”：最近一条（任何一方）在这么久之内 */
export const LIVE_CHAT_MS = 5 * MIN;
/** 小事发生在这么久之前还算“刚”（并且要在她上一次回话之后） */
export const INTERRUPT_WINDOW_MS = 6 * MIN;
/** 有符合条件的小事时，这一轮真的打断她的概率（按小事 id 和他最后一句取哈希，同一句每次一样） */
export const INTERRUPT_SHARE = 0.6;

export interface WorldEventLite { id: string; text: string; at: Date }
type Said = { role: 'user' | 'assistant'; content: string; time?: string };

const hash = (text: string): number => {
    let h = 0x811c9dc5;
    for (const char of text) { h ^= char.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13;
    return (h >>> 0) / 0x1_0000_0000;
};

/** 这一轮有没有一件小事打断了她；有就返回（最近的一件） */
export function interruptionNow(events: readonly WorldEventLite[], history: readonly Said[], now: number): { text: string; minutesAgo: number } | undefined {
    const last = history.at(-1);
    if (!last || last.time === undefined || now - Date.parse(last.time) > LIVE_CHAT_MS) return undefined;
    const lastHer = history.findLast(message => message.role === 'assistant' && message.time !== undefined);
    if (!lastHer) return undefined;
    const herAt = Date.parse(lastHer.time!);
    const lastUser = history.findLast(message => message.role === 'user');
    const candidates = events
        .filter(event => event.at.getTime() > herAt && event.at.getTime() <= now && now - event.at.getTime() <= INTERRUPT_WINDOW_MS)
        // 她自己已经说过的不再当“刚发生的”
        .filter(event => !history.some(message => message.role === 'assistant' && message.time !== undefined && Date.parse(message.time) >= event.at.getTime() && message.content.includes(event.text.slice(0, 6))))
        .sort((a, b) => b.at.getTime() - a.at.getTime());
    const event = candidates[0];
    if (!event) return undefined;
    if (hash(`${event.id} ${lastUser?.time ?? ''} ${lastUser?.content ?? ''} interrupt`) >= INTERRUPT_SHARE) return undefined;
    return { text: event.text, minutesAgo: Math.max(0, Math.round((now - event.at.getTime()) / MIN)) };
}

export function describeInterruption(interruption: { text: string; minutesAgo: number }): string {
    const when = interruption.minutesAgo <= 0 ? '刚刚' : `${interruption.minutesAgo} 分钟前`;
    return `[你正聊着，${when}你这边发生了一件小事：${interruption.text}。先接他的话，顺带说一声你刚被这件事岔了一下（像当场说的：“等下，……”）；事情的细节只用这一句写的，没写的别编；要花点时间的可以说一声“等下”再去弄，别写成长段]`;
}
