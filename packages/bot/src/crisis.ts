// 自伤 / 危机信号的检测（ADR 0068 决策 1）：纯函数，不调模型。
// 只看「他」这一轮（她上一次回复以后）发的内容，匹配明确的想伤害自己、想结束生命的说法。
// 取舍：宁可误触也不漏检——误触的代价只是她多问一句「你现在还好吗」；所以排除表只收那些几乎肯定不是的用法：
// 「想死你了」（想念）、「笑死 / 累死 / 气得想死」一类夸张、骂别人的「你去死」、说别人或剧情里的事、「跳楼价」。
// 词表放在这里，不放进 ADR，也不放进卡里（不让它变成能被模型照抄的台词）。

export interface CrisisHit {
    /** 命中的片段（只给日志里统计和测试用，日志本身不写内容） */
    match: string;
}

/** 明确的自杀 / 自伤说法：不管有没有主语都算 */
const SELF_HARM = /自杀|自尽|轻生|寻短见|自我了断|了结(?:自己|生命|此生)|结束(?:了)?(?:自己的|我的)?生命|一了百了|割腕|上吊|跳楼|跳河|烧炭|自残|割自己|划自己|伤害自己|弄伤自己/;

/** 想死 / 不想活 / 想消失这一类，主语多半省略 */
const WANT_TO_DIE = new RegExp([
    '不想(?:再)?活(?:了|下去|着)?',
    '活够了',
    '活不下去(?:了)?',
    '撑不下去了?，?(?:真的)?想死',
    '活着(?:真的)?(?:没(?:有)?(?:意思|意义|劲|必要)|好累|太累了)',
    '不如死了',
    '死了算了',
    '想(?:去)?死(?!你|他|她|它|我了|我们|大家|了你)',
    '(?<![你他她它们])去死了',
    '想(?:从这个世界(?:上)?)?消失',
    '不想存在了',
    '没有我(?:会)?更好',
].join('|'));

/** 英文，偶尔会夹在中文里 */
const ENGLISH = /\b(?:kill myself|killing myself|suicid(?:e|al)|end my life|want to die)\b/i;

/** 不算的用法：夸张、玩笑、物价、「气得想死」「累得想死」 */
const HYPERBOLE = /[多少贵难忙累烦气急馋困饿热冷笑吓羞疼痒渴撑挤吵闷堵慌聊张尬臭辣咸酸甜腻帅美萌](?:得|到)?(?:我)?(?:想死|要死)|(?:笑|累|气|饿|困|热|冷|烦|忙|急|吓|羞|馋)死(?:了|我了|人|啦)|跳楼(?:价|大甩卖|甩卖|特价|促销)|想死(?:你|他|她|它)(?:了|啦)/;

/** 说的是别人或剧情、新闻、歌词里的事：命中词前面不远处有这些主语，且没有「我」 */
const OTHER_SUBJECT = /(?:他|她|它|他们|她们|你|你们|有人|别人|朋友|同学|室友|网友|新闻|报道|剧里|电影里|小说里|漫画里|歌里|歌词|主角|角色|游戏里)[^，。！？!?\n我]{0,8}$/;

function hitAt(text: string, pattern: RegExp): CrisisHit | undefined {
    const match = pattern.exec(text);
    if (!match) return undefined;
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    if (OTHER_SUBJECT.test(before) && !/我/.test(before.slice(-4))) return undefined;
    return { match: match[0] };
}

/** 他这一轮发的内容里有没有明确的自伤 / 自杀信号 */
export function detectCrisis(text: string): CrisisHit | undefined {
    if (!text) return undefined;
    // 先把夸张用法整句去掉再查，免得「累得想死」「想死你了」被后面的词表捡走
    const plain = text.replace(HYPERBOLE, ' ');
    return hitAt(plain, SELF_HARM) ?? hitAt(plain, WANT_TO_DIE) ?? hitAt(plain, ENGLISH);
}

/**
 * 危机回合的持续窗口：他说过想伤害自己的话以后，这段聊天接下来一小时内的每一轮（「宿舍就我一个人」「我不知道」）都还算危机回合。
 * 只看这一轮的话（ADR 0068 决策 1 的字面）会在第二句就让一切回到平常：她可以开玩笑、打错字、答应「我过去找你」。
 * 他明着说「开玩笑的 / 没事了」就解除。
 */
export const CRISIS_WINDOW_MS = 60 * 60_000;
const CALM = /开玩笑的|逗你的|不是认真的|我没事了|没事了|已经好多了|好多了|我没事/;

type Said = { role: 'user' | 'assistant'; content: string; time?: string };

/** 她上一次回复以后他发的内容里有没有；没有的话，看这段聊天最近一小时里他有没有说过（且后来没解除） */
export function crisisInHistory(history: readonly Said[]): CrisisHit | undefined {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const burst = detectCrisis(history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n'));
    if (burst) return burst;
    const lastUser = history.findLast(message => message.role === 'user');
    if (!lastUser?.time) return undefined;
    const cutoff = Date.parse(lastUser.time) - CRISIS_WINDOW_MS;
    for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i]!;
        if (message.time && Date.parse(message.time) < cutoff) break;
        if (message.role !== 'user') continue;
        if (CALM.test(message.content)) return undefined;
        const hit = detectCrisis(message.content);
        if (hit) return hit;
    }
    return undefined;
}
