// 陪玩状态（ADR 0111，配置 together，默认关）：他答应了她的邀约（ADR 0107）或她答应了他的邀约之后，接下来两三个小时她是“正在和他一起玩”。
// 为什么：原来邀约被答应后她“来了来了”，下一条起又是平时的她——回话照常长、照常聊自己的事，甚至玩到一半冒出“你人呢”。真人在一起打游戏时回得短、慢、聊的是局里的事。
// 不存状态：每一轮从聊天记录往回推（lingering 的做法，ADR 0039）：谁邀、谁答应、答应的时刻；这一轮在不在“一起玩”由代码算。
// 窗口：答应之后 TOGETHER_MAX_MS（2.5 小时）；谁说了“下了 / 不玩了 / 睡了 / 晚安 / 散了”就结束。窗口里：时间块多一行（回得短、聊游戏里的事），主动消息（早安之外的）不插进来。

import { ACCEPTS_FIRST, DECLINES_INVITE, HER_INVITE, REFUSAL_WORDS } from './intent.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 答应之后算“一起玩”多久 */
export const TOGETHER_MAX_MS = 2.5 * HOUR;
/** 她邀、他答应：邀约之后多久之内的第一句才算是回这个邀约 */
const HE_ANSWERS_MS = 30 * MIN;
/** 他邀、她答应：他们的聊天节奏快，她的回应一般很快 */
const SHE_ANSWERS_MS = 10 * MIN;

/** 他在邀她：游戏的字眼 + 问句，或者“来不来 / 上不上” */
const HIS_INVITE = /(?:王者|开黑|双排|峡谷|我的世界|联机|上号|打两把|玩两把|来两把|来一把|来一局).{0,12}(?:吗|嘛|不|吧|[？?])|来不来|上不上|玩不玩|打不打/;
const GAME_CONTEXT = /王者|开黑|双排|峡谷|我的世界|联机|上号|打两把|玩两把|来两把|来一把|来一局|一起玩|游戏|排位|\bMC\b/i;
const GAME_SHORT_INVITE = /^(?:来不来|上不上|玩不玩|打不打)[啊呀嘛吗吧？?！!～~\s]*$/;
/** 一起玩结束了 */
const ENDS = /下了|下线|不玩了|不打了|睡了|晚安|散了|先下|打完了|玩够了|我去忙|洗澡去|去睡/;
/** 她答应他：开头是来 / 好 / 行 / 可以 / 走 / 上 / 没问题，并且前面几个字里没有推掉的话 */
const SHE_ACCEPTS = /^(?:来|好|行|可以|走|上|没问题|等我|马上)/;

export type TogetherActivity = 'wzry' | 'minecraft' | 'game';
export interface Together {
    activity: TogetherActivity;
    /** 答应的时刻（毫秒） */
    since: number;
}

type Said = { role: 'user' | 'assistant'; content: string; time?: string };

export function activityOf(text: string): TogetherActivity {
    if (/我的世界|MC|存档|盖|挖矿/i.test(text)) return 'minecraft';
    if (/王者|峡谷|双排|开黑|排位/.test(text)) return 'wzry';
    return 'game';
}

/** 此刻是不是在“一起玩”的窗口里；不是返回 undefined */
export function togetherNow(history: readonly Said[], now: number): Together | undefined {
    const recent = history
        .flatMap(message => (message.time !== undefined ? [{ role: message.role, content: message.content, at: Date.parse(message.time) }] : []))
        .filter(message => !Number.isNaN(message.at) && now - message.at < TOGETHER_MAX_MS + HE_ANSWERS_MS && message.at <= now);
    let found: { since: number; activity: TogetherActivity; answerIndex: number } | undefined;
    for (let i = 0; i < recent.length; i++) {
        const invite = recent[i]!;
        const byHer = invite.role === 'assistant';
        if (!(byHer ? HER_INVITE : HIS_INVITE).test(invite.content)) continue;
        // 泛邀约（喝奶茶、吃饭等）不代表游戏；短邀约只继承紧邻的游戏上下文。
        if (!GAME_CONTEXT.test(invite.content) && !(GAME_SHORT_INVITE.test(invite.content.trim())
            && GAME_CONTEXT.test(recent.slice(Math.max(0, i - 3), i).map(message => message.content).join('\n')))) continue;
        const answerIndex = recent.findIndex((message, j) => j > i && message.role !== invite.role);
        const answer = recent[answerIndex];
        if (!answer || answer.at - invite.at > (byHer ? HE_ANSWERS_MS : SHE_ANSWERS_MS)) continue;
        const text = answer.content.trim();
        const accepted = byHer
            ? ACCEPTS_FIRST.test(text) && !DECLINES_INVITE.test(text.slice(0, 14))
            : SHE_ACCEPTS.test(text) && !REFUSAL_WORDS.test(text.slice(0, 14));
        if (accepted) found = { since: answer.at, activity: activityOf(invite.content), answerIndex };
    }
    if (!found || now - found.since >= TOGETHER_MAX_MS) return undefined;
    // 答应之后有人说了“下了 / 不玩了 / 睡了 / 晚安”：结束
    if (recent.some((message, index) => index > found!.answerIndex && ENDS.test(message.content))) return undefined;
    return { activity: found.activity, since: found.since };
}

const WHAT: Record<TogetherActivity, string> = { wzry: '打王者（双排）', minecraft: '玩我的世界（你们那个存档）', game: '玩游戏' };

/** 时间块里的一行：回得短、聊局里的事；不编你们没一起经历过的以前的事 */
export function describeTogether(together: Together, now: number): string {
    const minutes = Math.max(1, Math.round((now - together.since) / MIN));
    return `[你这会儿正和他一起${WHAT[together.activity]}（已经玩了约 ${minutes} 分钟）：手上在玩，回话短一点、慢一点，聊的是眼前这局 / 你在存档里弄的东西，别说你在忙别的、别另起话题、别写长段；游戏里的具体情形随口说，但别编你们以前没一起经历过的事]`;
}
