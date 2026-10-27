// 说别人的事的分寸（ADR 0020）：记得什么和愿意说什么分开。
// 召回不收紧（ADR 0016 的既有决定）；这里给每条来源标披露上限，再告诉模型如何自然地说或不说。

import type { ChatMessage } from '../language/prompt.ts';
import { EPISODE_GAP_MS } from '.././memory/episodes.ts';
import { herDay, type Schedule } from '../life/schedule.ts';

/** 明说：被问可以说大面事实；含糊：被问只能承认个大概；不说：不能透露、确认或暗示。 */
export type DisclosureMode = 'open' | 'vague' | 'sealed';

/** 知道她和男朋友关系、能听她聊日常社交的档位。 */
const CLOSE_TIERS: readonly string[] = ['boyfriend', 'bestie'];

export function isClose(tier: string): boolean {
    return CLOSE_TIERS.includes(tier);
}

/**
 * 某个人告诉她的事，对眼前听众最多能说到哪一档。
 * 低档位不能得知男朋友/闺蜜一侧的内容；其余第三方内容也最多含糊带过。
 */
export function disclosureMode(owner: { tier: string }, listener: { tier: string }): DisclosureMode {
    if (isClose(listener.tier)) return 'open';
    return isClose(owner.tier) ? 'sealed' : 'vague';
}

const MODE_LABEL: Record<DisclosureMode, string> = {
    open: '可明说',
    vague: '只能含糊',
    sealed: '不能说',
};

/** 别人的事放进提示词时的出处标签；sealed 不写是谁，避免标签本身泄露关系。 */
export function sourceLabel(owner: { name: string; tier: string }, listener: { tier: string }): string {
    const mode = disclosureMode(owner, listener);
    return `${MODE_LABEL[mode]}·${mode === 'sealed' ? '私下聊的' : `和${owner.name}聊的`}`;
}

/** 日记、周记和阶段总结属于她自己的经历，但低档位若牵涉别人也只能含糊。 */
export function ownSourceLabel(source: string, listener: { tier: string }): string {
    const mode: DisclosureMode = isClose(listener.tier) ? 'open' : 'vague';
    return `${MODE_LABEL[mode]}·${source}`;
}

/** 提示词里有别人的事时接在后面的统一规则。 */
export function disclosureRules(listener: { name: string; tier: string }): string {
    const opening = `[说别人的事的分寸：上面的每条别人的事都标了披露上限。`;
    const levels = '「可明说」只表示被问时可以讲大面事实，别人的家事、难处、心事等私事仍然最多说个大概；'
        + '「只能含糊」只在对方直接问起时说「好像听谁提过」「不太清楚」这一类，不给名字和细节；'
        + '「不能说」的不能透露、确认或暗示，但要顺着当前话题自然回应，不能因为不能说就突然截断整句。';
    const promised = '你和某个人之间说好、让你别说的事只跟那个人说；';
    // 她对别人的看法（ADR 0020 第二批）：DSH 方案只管「永远不主动」；被最亲的人直接问起时说句实在话才像人，对普通听众只说客气话
    if (isClose(listener.tier)) {
        return opening + levels
            + `主动向${listener.name}提别人时比标签再保守一级：只有「可明说」的能挑一件大面上的事，带着自然由头、含糊地随口提；其余不主动提。`
            + promised
            + `你心里对谁的看法（喜欢、嫌弃、觉得他怎样）不主动说；${listener.name}直接问你觉得某人怎么样时，可以用自己的话说句实在的，不刻薄、不添油加醋，也不借机翻那个人的私事。]`;
    }
    return opening + levels
        + `不要主动向${listener.name}提任何别人的事。`
        + promised
        + '你心里对谁的看法（喜欢、嫌弃、觉得他怎样）不主动说；被问起某人怎么样，只说当着他的面也能说的客气话（「人挺好的」「不太熟」），不背后议论、不说他出过的糗事。]';
}

/** 这段聊天她还没回过：对方刚来，或隔了 EPISODE_GAP_MS 以上又开启一段。 */
export function startsConversation(chat: readonly Pick<ChatMessage, 'role' | 'time'>[]): boolean {
    if (chat.length === 0) return false;
    let start = chat.length - 1;
    while (start > 0) {
        const here = Date.parse(chat[start]!.time ?? '');
        const before = Date.parse(chat[start - 1]!.time ?? '');
        if (!Number.isNaN(here) && !Number.isNaN(before) && here - before >= EPISODE_GAP_MS) break;
        start--;
    }
    return !chat.slice(start).some(message => message.role === 'assistant');
}

/** 她今天从睡觉分界算起；没作息时从本地 00:00 算。 */
export function todayStart(schedule: Schedule | undefined, now: Date): Date {
    if (!schedule) return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = herDay(schedule, now);
    const [hour, minute] = schedule.sleep.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
}
