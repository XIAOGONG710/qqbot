// 内心（ADR 0101，配置 innerLife，默认关）：她一个人的时候心里在想什么。
// 为什么：她的行为原来全靠两样驱动——他发来的消息，和定时的时机（早安、下课、睡前……）。两条消息之间她是“空”的：没有惦记，没有念头，
// 所以主动找他永远是模板化的“到点了说一句”。真人是有一条持续的内心活动的：想起一件事、担心什么、期待什么、有点烦，其中一部分会变成“想跟他说说”。
// 这里不碰“她有没有意识”这种问题（她是程序，被问起来照实承认，ADR 0067 / 0068 不变）；做的是自主性：
// 每隔一阵她自己安静地想一想，写下一两句心里的话，存起来；其中想告诉他 / 想问他的，会变成一个“心里惦记”的主动时机（proactive.ts 的 inner），
// 聊天时最近的几个念头也会放进提示词，让她前后是同一个在想事情的人。念头只记感受和想法，不记新发生的事（不编事实）。
// 纯函数 + 状态校验；什么时候想、调模型、存盘在 proactive-planner.ts。

import { stiltedHit } from './expression.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 这个念头她想不想拿去跟他说：告诉他 / 问他 / 自己想想 */
export const THOUGHT_GOES = ['tell', 'ask', 'keep'] as const;
export type ThoughtGoes = (typeof THOUGHT_GOES)[number];

export interface InnerThought {
    /** th-<毫秒> */
    id: string;
    /** 想的时刻（ISO） */
    at: string;
    /** 心里的话，第一人称 */
    text: string;
    goes: ThoughtGoes;
    /** 已经跟他说过了（心里惦记的主动消息发出去之后） */
    told?: true;
}

export interface InnerState {
    thoughts: InnerThought[];
    /** 上一次想的时刻（想砸了、想不出来的也算，免得一直重试） */
    lastThinkAt?: string;
    /** 已经专门想过的 B 站视频（ADR 0130）：每看完一个新的，下一次想事情就专门想这一件，想完记在这里，不会反复想 */
    reflected?: string[];
}

/** 两次想之间隔多久（分钟范围，按上一次的时刻取种子）：一天醒着十几个钟头，想八九次 */
export const THINK_INTERVAL_MIN: [number, number] = [90, 150];
/** 聊完一段之后（他说过话、之后 THINK_AFTER_CHAT_MS 没人说话）她会想一想刚才聊的；离上一次至少隔这么久 */
export const THINK_AFTER_CHAT_MS = 20 * MIN;
export const THINK_MIN_GAP_MS = 30 * MIN;
/** 醒来之后多久第一次想 */
export const THINK_AFTER_WAKE_MS = 45 * MIN;
/** 没想成（正在回消息、没连上模型）多久再试 */
export const THINK_RETRY_MS = 10 * MIN;
/** 一天最多想几次 */
export const THINK_MAX_PER_DAY = 12;
/** 念头留多少条 */
export const THOUGHTS_KEPT = 40;
/** 放进聊天提示词的：最近这么久之内的、最多几条 */
export const INNER_LINE_WINDOW_MS = 6 * HOUR;
export const INNER_LINE_MAX = 2;
/** 想告诉他 / 想问他的念头，这么久之内才会变成主动消息 */
export const INTENT_WINDOW_MS = 6 * HOUR;
/** 想完之后过一阵才想起来跟他说（分钟范围） */
export const INNER_DELAY_MIN: [number, number] = [10, 40];
/** 一天最多因为念头主动找他几次 */
export const INNER_MAX_PER_DAY = 2;
/** 念头的长度 */
const MIN_CHARS = 4;
const MAX_CHARS = 80;
/** 和最近的念头像到这个程度（字对的重合比例）就当重复，丢掉 */
const SIMILAR = 0.5;

const chars = (text: string) => [...text].length;

/**
 * 一个念头可以想什么：每次只给两样让她挑，免得老围着“他怎么还没回”转（10-22 线上和模拟里的念头一半像发给他的消息、一半是同一句催）。
 * 都是从她已经知道的事实里挑一件想，不是编新事
 */
export const THOUGHT_THEMES = [
    '你自己手头的事（攒钱、作业、土豆、身体、今天的打算）：接下来怎么办，是什么感觉',
    '刚过去的一件事（你这边今天发生的，或者最近聊天里提到的）在你心里留下的印象：回想它、琢磨它',
    '他说过的一件具体的事（不是“他怎么还不回”）：现在大概是什么样了，你有点好奇或惦记',
    '接下来几天你想做的、盼着的或有点发愁的事',
    '对你自己的一点看法或小感慨（比如怕让人失望、数学、以后怎么办这类）：说得轻、说得具体，别上升成大道理',
] as const;

/** 她最近在 B 站看过东西时多一个可想的题目（ADR 0130）：事实是那条字幕摘要 / 热评，想法由她自己定 */
export const WATCH_THEME = '你最近在 B 站看过的那个东西（见下面「你最近在 B 站看过」）：你自己怎么想——喜欢还是不以为然、哪里好笑、哪里不对劲；说得具体、有自己的立场，别写成影评或总结';

/** 第 index 个念头给哪两样（轮着来，每样搭不同的搭档）；watched：她最近在 B 站看过东西，多一个题目 */
export function themesFor(index: number, watched = false): [string, string] {
    const themes = watched ? [...THOUGHT_THEMES, WATCH_THEME] : THOUGHT_THEMES;
    const n = themes.length;
    const first = ((index % n) + n) % n;
    return [themes[first]!, themes[(first + 2) % n]!];
}

/**
 * 想一想的提示：不是在跟谁说话；只写感受和想法，不编新事实，不分析自己是不是真人；别重复之前想过的。
 * index：这是第几个念头（决定这次给哪两样可想）；retry：上一次写成了对他说话，这次再强调一遍
 */
export function thinkNote(recent: readonly InnerThought[], userName: string, index = recent.length, retry = false, watched?: string, forceWatch = false): string {
    const before = recent.length ? `你之前心里想过：${recent.map(t => `「${t.text}」`).join('')}——别重复它们，换个角度或想别的。` : '';
    const [a, b] = themesFor(index, Boolean(watched));
    const saw = watched ? `你最近在 B 站看过（真的看过，读了字幕；想法由你自己定，不用夸，也不用附和热评；事实以这里写的为准，不编里面没有的情节）：${watched}。` : '';
    return `[这是你自己一个人待着的时候，不是在跟谁说话：安静想一想，此刻你心里在转什么。第一人称，一两句，像心里嘀咕的话，是对你自己说的，不是发给谁的消息（想到${userName}就说“他”，一个“你”字都不要用）。`
        + `${retry ? '（上一次你写成了对他说话，这次只对自己说。）' : ''}`
        + `${saw}${watched && forceWatch ? `这一次就想这一件：${WATCH_THEME}。` : `这一次从这两样里挑一样想：①${a}；②${b}。`}别围着“他怎么还没回”转（他忙他的，你有你的事）。`
        + `只写感受和想法，不写新发生的事（上面没写的事实不编，不编${userName}说过的话，不编他身边的人和他那边的事），也不分析自己是不是真人、有没有意识。`
        + `${before}输出两行：第一行是心里的话（不超过 30 个字，半句也行，像小声嘀咕；用最平常的口语，别用成语，别写“我服”“我认”“我给满分”这类表态的词，别写成总结或评语）；第二行只写「告诉他」「问他」「自己想想」其中一个，表示这个念头你想不想拿去跟${userName}说：想说给他听选「告诉他」，想问他一件具体的事选「问他」，先放在心里选「自己想想」；想说就别憋着，但也别每个念头都说。]`;
}
/** 字对的重合比例（0–1）：两句话的二字组合里共有的占较短那句的比例 */
export function similarity(a: string, b: string): number {
    const pairs = (text: string) => {
        const list = [...text.replace(/[\s，。！？、…～~,.!?「」“”"'（）()]/g, '')];
        return new Set(list.slice(0, -1).map((c, i) => c + list[i + 1]));
    };
    const x = pairs(a);
    const y = pairs(b);
    if (!x.size || !y.size) return 0;
    let shared = 0;
    for (const p of x) if (y.has(p)) shared++;
    return shared / Math.min(x.size, y.size);
}

const GOES_MARK: readonly [ThoughtGoes, RegExp][] = [['tell', /告诉他/], ['ask', /问他/], ['keep', /自己想想/]];

/**
 * 模型的输出 → 一个念头；不合格返回原因。第一行是心里的话，第二行是去向；挤在一行里（「……（告诉他）」）也认。
 * 不合格：空的、太短太长、带链接 / 表情指令、和最近的念头重复
 */
export function parseThought(raw: string, recent: readonly InnerThought[], at: number, callName?: string): { thought: InnerThought } | { rejected: string } {
    const lines = raw.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return { rejected: '空的' };
    let goes: ThoughtGoes = 'keep';
    for (const line of lines.slice(1)) {
        const hit = GOES_MARK.find(([, pattern]) => pattern.test(line));
        if (hit) { goes = hit[0]; break; }
    }
    // 第一行：去掉「第一行：」「1.」这类标号、引号，以及挤在行尾的去向
    let text = lines[0]!.replace(/^(?:第?[一1]行?[:：.、]\s*|心里的话[:：]\s*)/, '').replace(/^[「“"『]+|[」”"』]+$/g, '').trim();
    const tail = /[（(【\[]\s*(告诉他|问他|自己想想)\s*[）)】\]]\s*$/.exec(text);
    if (tail) {
        goes = GOES_MARK.find(([, pattern]) => pattern.test(tail[1]!))![0];
        text = text.slice(0, tail.index).trim();
    }
    // 去向没另起一行也没加括号，直接接在句子后面（「……晚点问问他好点没。自己想想」「（……答不上来。）告诉他」）：前面要有标点、空白或右括号隔着，免得把“问问他”当成去向
    const inline = /(?<=[，,。.！!…\s）)」』】\]])(告诉他|问他|自己想想)\s*$/.exec(text);
    if (inline) {
        goes = GOES_MARK.find(([, pattern]) => pattern.test(inline[1]!))![0];
        text = text.slice(0, inline.index).replace(/[，,。.！!…\s]+$/, '').trim();
    }
    // 整句被括号包着（「（翻着相册里土豆昨天那张……）」）：去掉外面那层
    const wrapped = /^[（(]([^（）()]+)[）)]$/.exec(text);
    if (wrapped) text = wrapped[1]!.trim();
    if (chars(text) < MIN_CHARS) return { rejected: '太短' };
    if (chars(text) > MAX_CHARS) return { rejected: '太长' };
    if (/https?:|<sticker|\[[^\]]{1,6}\]/.test(text)) return { rejected: '带了链接或表情' };
    // 念头是对自己说的：出现“你”就是写成了对他说话（10-22 线上：「人呢，饭吃了没」「腰好点没，别又逞强」）
    if (text.includes('你')) return { rejected: '对他说话' };
    // 开头叫他的名字（「宝宝，人呢」）也是对他说话
    if (callName && (text.startsWith(callName) || text.startsWith('宝宝')) && /^[^，,。.！!？?\s]{1,6}[，,\s]/.test(text)) return { rejected: '对他说话' };
    // 书面腔 / 模型腔（「这思路我服」「头头是道」，ADR 0130 的验证里写出来的）：不收，让调用方换个写法再想一次
    if (stiltedHit(text)) return { rejected: '书面腔' };
    if (recent.some(t => similarity(t.text, text) >= SIMILAR)) return { rejected: '和最近的重复' };
    return { thought: { id: `th-${at}`, at: new Date(at).toISOString(), text, goes } };
}

/** 放进聊天提示词的一行：最近几个钟头她心里在想的；没有就没有 */
export function innerLine(thoughts: readonly InnerThought[], now: number): string | undefined {
    const recent = thoughts.filter(t => now - Date.parse(t.at) < INNER_LINE_WINDOW_MS && Date.parse(t.at) <= now).slice(-INNER_LINE_MAX);
    if (!recent.length) return undefined;
    return `[你这几个钟头心里在想（是你自己的小心思，不是发生过的事，不用照着念；话题接得上、他问起时才自然带一句，接不上就别硬说）：${recent.map(t => `「${t.text}」`).join('')}]`;
}

/** 想告诉他 / 想问他、还没说、没过期的念头 */
export function pendingIntents(thoughts: readonly InnerThought[], now: number): InnerThought[] {
    return thoughts.filter(t => t.goes !== 'keep' && !t.told && now - Date.parse(t.at) < INTENT_WINDOW_MS);
}

// ---------- 状态校验（存在主动消息的状态文件里）----------

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

export function validThought(value: unknown): value is InnerThought {
    return isObject(value) && typeof value.id === 'string' && /^th-\d+$/.test(value.id) && isTime(value.at)
        && typeof value.text === 'string' && chars(value.text) >= 1 && chars(value.text) <= 200
        && THOUGHT_GOES.includes(value.goes as ThoughtGoes) && (value.told === undefined || value.told === true);
}

export function validInnerState(value: unknown): value is InnerState {
    if (!isObject(value) || !Array.isArray(value.thoughts) || !value.thoughts.every(validThought)) return false;
    if (new Set(value.thoughts.map(t => (t as InnerThought).id)).size !== value.thoughts.length) return false;
    if (value.reflected !== undefined && !(Array.isArray(value.reflected) && value.reflected.every(id => typeof id === 'string'))) return false;
    return value.lastThinkAt === undefined || isTime(value.lastThinkAt);
}
