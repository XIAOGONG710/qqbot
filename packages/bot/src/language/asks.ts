// 让她问「真在思考」的问题（2026-10-31 用户：「不是这种问题，而是真正的思考的问题」）
//
// 区别：
//   打探式（不要）：你今天吃啥 / 怎么了 / 在干嘛 —— 问的是事实，答完就没了。
//   思考式（要）：她自己先有一个看法或猜想，再把它递给他 ——
//     「我觉得人累的时候其实不是想歇，是想有人管一下——你会不会也这样」
//     「你说人为什么非要攒钱买相机，我明明也知道手机也能拍」
// 两个特征：① 有她自己的判断（不是空问）；② 问的是看法 / 假设 / 记忆，不是日程。
export interface ThinkHint {
    line: string;
    why: '他在收尾' | '轮到了' | '她自己刚说了件事';
}

const CLOSING = /^(好累|累了|烦|好烦|难受|不开心|还行|一般|不知道|没事|没什么|随便|都行|哈哈|嗯|哦|好|行|确实|就是|反正|懂了)[。.!！~～…]*$/;

/** 按轮次抽：不是每句都问，隔几轮给一次机会（同一段聊天里稳定，不随机漂） */
export const ASK_EVERY = 5;
const turnSeed = (history: readonly { role: string; content: string }[]): number => {
    let hash = 0x811c9dc5;
    for (const message of history.slice(-6)) {
        for (const char of `${message.role}:${message.content}`) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
    }
    return hash % ASK_EVERY;
};

const THINK = '[这一轮可以问一个你自己真正在想的问题：先说一句你自己的看法或猜想（哪怕不一定对），再把它递给他——「我觉得……你会不会也这样」「你说人为什么……」。要问看法、假设、他记得的事，别问日程（吃啥、在干嘛、怎么了）。一句就够，问完就停，别自问自答]';

/** 要不要给她一个「问思考问题」的方向 */
export function thinkHint(hisText: string): ThinkHint | undefined {
    const said = String(hisText ?? '').trim();
    if (!said) return undefined;
    if (/[？?]$/.test(said)) return undefined;          // 他在问她，先答
    if (CLOSING.test(said)) return { why: '他在收尾', line: THINK };
    if ([...said].length <= 6) return { why: '轮到了', line: THINK };
    return undefined;
}

/** 一整天没话说、两个人都干着的时候：给她一次机会自己想一个话题 */
export function idleHint(): string {
    return '[你们这会儿都没什么话。你要是心里正琢磨着什么事（课上的、书里的、街上看到的、关于人的），可以把它拿出来问他一句——先说你怎么想的，再问他的看法]';
}
