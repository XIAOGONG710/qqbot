// 表达层（ADR 0024）：真人发消息长短不一、会打错字再改口。
// - 长短：按他这一轮最后一条消息的时间和内容取哈希，SHORT_CHANCE 的轮次时间块里加「这一轮回句短的」，LONG_CHANCE 的加「这一轮话多一点」；
//   收尾、主动找他时不加；身体不舒服（痛经、感冒，ADR 0025）、心情安静时不加「话多」。只给一句约束，不给台词；气泡上限、出口检查照旧。
//   （改前 84 次回复：两条气泡的占 57%，一条的 12%，中位数每条 14 个字——DSH 侧说的「恒定 2 条 × 15–20 字」）
// - 打错字：发出去的气泡里有常见的同音错词（TYPOS）时，TYPO_CHANCE 的概率打错一个；多数紧跟一条「*正确的词」改口，少数懒得改。
//   不靠模型：模型很少自己打错，让它「偶尔打错」会写成刻意的错。聊天记录里存的是发出去的样子（他看到的就是这样）。

/** 回句短的、话多一点的概率（按轮）；SHORT_CHANCE 是开了 shortReplies（候选 5）的，没开是 LEGACY_SHORT_CHANCE（上线前的老样子） */
export const SHORT_CHANCE = 0.5;
export const LEGACY_SHORT_CHANCE = 0.35;
export const LONG_CHANCE = 0.1;

export type LengthHint = 'short' | 'long';

/**
 * 这一轮要认真接话的意图行（先接他的情绪、替他高兴好事、回应他说的那件事、只接两个人的事、要亲近 / 要哄）：不加「回很短」。
 * 10-12 真模型回归：同时带「先接住他此刻的情绪」和「回很短」（哪怕写了「难受时不适用」）时，哭着来的那一轮她没有一句安慰；
 * 盲评 20 题里「短」在这类话题上输得多。只靠提示词里的例外不够，在代码里让路。
 */
export const ENGAGED_INTENT = /先接住他此刻的情绪|他刚说了件好事|回应他刚说的那件事|只接他刚说的你们两个人的事|他在向你要亲近|他在撒娇要你哄他|他到现在才看到你前面发的/;

/**
 * 他这一段话里在说不顺心、担心的事（被打回、没过、怎么办、还有救吗）：意图行不是「先接情绪」时也不加「回很短」。
 * 10-18 题库 be-021：他说报告被老师打回来、问「你说我这还有救吗」，意图行是「先直接回答他刚问的」，她只回了「有吧」两个字。
 * 只认明确说法（和 intent.ts 的 needsCare 一样不从普通短句猜心情）；「服了」「烦」这类玩笑里也常用的词不收。
 */
export const WORRIED_TEXT = /被(?:老师|老板|导师|领导)?(?:打回|拒|刷|退回|淘汰)|没(?:过|通过|考好)|挂(?:了|科)|考砸|还有救|有救吗|怎么办|咋办|我是不是(?:不行|太)/;

export interface LengthContext {
    history: readonly { role: 'user' | 'assistant'; content: string; time?: string }[];
    /** 这一轮的意图行（收尾时不加） */
    intent?: string;
    initiating?: boolean;
    /** 身体不舒服、心情安静：不加「话多」 */
    low?: boolean;
    /** 他这一轮说起了她认识的人（闺蜜）：被问「雨桐最近怎么样」要把事说准，不适合只回很短的一句 */
    aboutPerson?: boolean;
    /** 配置 shortReplies：开了才用候选 5 的概率、让路的规则和新措辞；不开就是上线前的老样子（ADR 0024 的 10-19 调整） */
    shortReplies?: boolean;
}

/** 这一轮说话的长短（没有就是照常） */
export function lengthHint(context: LengthContext): LengthHint | undefined {
    if (context.initiating || context.intent?.includes('收尾')) return undefined;
    const last = context.history.findLast(message => message.role === 'user');
    if (!last) return undefined;
    // 他明着让她讲（「你帮我认真讲讲」「详细说说」）就多说几句，不抽签（10-10 示例改短之后 boyfriend-tone T06 讲梯度下降只剩 53 字）
    if (!context.low && ASKS_TO_EXPLAIN.test(last.content)) return 'long';
    const roll = unit(`${last.time ?? ''} ${last.content} length`);
    const shortChance = context.shortReplies ? SHORT_CHANCE : LEGACY_SHORT_CHANCE;
    // 他问起她认识的人（「雨桐最近怎么样」）：只回很短的一句会把最近的几件事压成一个评语——10-19 npc-asks-days NA07 在候选 4/5 的抽签下
    // 4 次里 2 次回「老放我鸽子」（账上只有一次她临时去不了）。这类问题不加「回很短」
    if (roll < shortChance) return context.shortReplies && ((context.intent && ENGAGED_INTENT.test(context.intent)) || WORRIED_TEXT.test(saidSinceReply(context.history)) || context.aboutPerson) ? undefined : 'short';
    // 话多要有由头：他这次说的太短（「到家了」）就不加（第一批：一句「到家了」她一口气说了 4 条 77 个字）
    if (roll < shortChance + LONG_CHANCE && !context.low && [...saidSinceReply(context.history)].length >= LONG_MIN_CHARS) return 'long';
    return undefined;
}

/** 他明着让她讲、让她说详细 */
export const ASKS_TO_EXPLAIN = /讲讲|讲一下|详细|认真(?:说|讲|跟我说)|解释|教教?我|展开说|具体说说/;

/** 他这次说的不到这么多字，不加「话多一点」 */
export const LONG_MIN_CHARS = 8;

/**
 * 医书里的词，真人不这么说（用户 10-22：「她最近老是说肚子坠着，这不是正常人的语言说话方式」；线上 10-20 到 10-22 四条）：
 * 模型从“痛经”联想出“坠着 / 坠得 / 下坠 / 坠胀 / 坠痛”。事实行里写的是“肚子疼 / 隐隐地疼”，没有这个词——是模型自己带出来的。
 * 两处管：身体那一行教她大白话怎么说（body.ts），出口检查把这几个词当禁用词让她重写（contact.ts）。只收“坠”开头 / 带“坠”的组合，不碰“坠入爱河”“摇摇欲坠”。
 */
export const ODD_BODY_WORDS: readonly string[] = [
    '坠着', '坠得', '坠胀', '坠痛', '下坠', '肚子坠', '小腹坠', '腹坠', '点坠', '些坠',
    // 小说 / 文案里的动作神态，写进聊天话里就别扭（线上 637 条里读到的：「听得我嘴角上扬」「笔都没落下去」；她的卡本来就要求“不写动作、神态”）
    '嘴角上扬', '嘴角微扬', '嘴角扬起', '眼眶发热', '眼眶一热', '眼眶泛红', '心口发紧', '心头一暖', '心头一软', '心头一紧', '心里一暖', '笔都没落',
];
/**
 * 书面腔 / 模型腔（用户 10-23：「现在说话还是一股人机的感觉：开局出拳套这个思路我服，尤其是最后俩字」）。
 * 线上她的聊天里没有（708 条里 0 条），是新开的“看视频想事情”那条线写出来的：模型想写得“年轻、会玩”，就硬套「这 X 我服」，再配上成语（头头是道、煞有介事）。
 * 真人不这么说：「我服了」是一个整的感叹，「这思路我服」是把评价词硬放到句末；成语和“诚然 / 着实 / 颇为”是写文章的词。
 * 以“re:”开头的是正则（出口检查的 banned 认；其余是子串）。只收明显书面的、聊天里几乎不会出现的；不碰“我服了”“不以为然”的口语用法以外的常见词。
 */
export const STILTED_WORDS: readonly string[] = [
    're:我服(?!了|气)', 're:这[^，。！？,.!?\\s]{1,8}我(?:给满分|佩服)', '我给满分', '头头是道', '煞有介事', '恍然大悟', '百感交集', '心照不宣',
    '诚然', '着实', '颇为', '甚是', '愈发', '倍感', '不禁', '令人', '此刻的我',
];

/** 一句话里有没有书面腔 / 模型腔；有就返回命中的那一段 */
export function stiltedHit(text: string): string | undefined {
    for (const word of STILTED_WORDS) {
        if (word.startsWith('re:')) { const hit = new RegExp(word.slice(3)).exec(text); if (hit) return hit[0]; } else if (text.includes(word)) return word;
    }
    return undefined;
}

export const ODD_BODY_WORDING = '肚子疼、小腹酸、一抽一抽地疼、疼得没劲；别用“坠着”“下坠”“坠胀”这种医书里的词';

/**
 * 她最近几条里反复在说的字词（10-22 深夜测试对话：被追问时一段里 12 条气泡 9 条是“太急 / 太突然 / 困 / 明天说”；肚子坠着说了三个晚上）。
 * 最近 8 条气泡里至少 3 条出现的两字词、或至少 4 条出现的单字（去掉虚字、称呼、笑声），最多 4 个；不够 4 条气泡不算
 */
const CRUTCH_STOP = new Set([...'的了我你是不吗呢啊吧就也都在有这那么什好点一个没还会要说想去看到能和跟让给把被对为以及但可很真又再先后来过着起得别它他她们']);
const CRUTCH_SKIP = /宝宝|哈哈|抱抱|晚安|早安|嘿嘿|[mM]ua|睡觉|知道|可以|时候|现在|今天|不是|没有|就是|一下|什么|怎么|还是|已经|觉得|不会|不用|这么|那么|所以|因为|但是|然后/;
export function recentCrutches(history: LengthContext['history']): string[] {
    const mine = history.filter(message => message.role === 'assistant').slice(-8).map(message => message.content.replace(/\[[^\]]{1,12}\]/g, ''));
    if (mine.length < 4) return [];
    const pairs = new Map<string, number>();
    const singles = new Map<string, number>();
    for (const text of mine) {
        const chars = [...text.replace(/[\s\p{P}\p{S}]/gu, '')];
        const seenPairs = new Set<string>();
        const seenSingles = new Set<string>();
        chars.forEach((char, i) => {
            if (CRUTCH_STOP.has(char)) return;
            seenSingles.add(char);
            const next = chars[i + 1];
            if (next !== undefined && !CRUTCH_STOP.has(next)) seenPairs.add(char + next);
        });
        for (const p of seenPairs) pairs.set(p, (pairs.get(p) ?? 0) + 1);
        for (const c of seenSingles) singles.set(c, (singles.get(c) ?? 0) + 1);
    }
    const words = [...pairs].filter(([word, n]) => n >= 3 && !CRUTCH_SKIP.test(word)).sort((a, b) => b[1] - a[1]).map(([word]) => word);
    const chars = [...singles].filter(([char, n]) => n >= 4 && !words.some(word => word.includes(char)) && !CRUTCH_SKIP.test(char)).sort((a, b) => b[1] - a[1]).map(([char]) => char);
    return [...words, ...chars].slice(0, 4);
}

/**
 * 她最近几次开头用的同一个起头词（ADR 0135）。10-23 的主动消息模拟里 11 条非催他的里 6 条以「刚」开头，催他的 8 条里 5 条以「人呢」开头——
 * 单条都自然，连起来像套话。每次“话头”（她连着发的一串）的第一句算一次开头，最近 5 次里同一个起头词出现 2 次以上就返回它；
 * 起头词只认这些最常见的口头起头（不认任意前两个字：「刚在」「刚洗」不同，但都是「刚」）
 */
const OPENER_WORDS = /^(刚刚|刚|对了|哎呀|哎|诶|欸|唉|喂|人呢|跟你说|我跟你说|你猜|话说|今天)/;
export function repeatedOpener(history: LengthContext['history']): string | undefined {
    const openers: string[] = [];
    let previous: 'user' | 'assistant' | undefined;
    for (const message of history) {
        if (message.role === 'assistant' && previous !== 'assistant') {
            const text = message.content.replace(/\[[^\]]{1,12}\]/g, '').trim();
            openers.push(OPENER_WORDS.exec(text)?.[1] ?? '');
        }
        previous = message.role;
    }
    const recent = openers.slice(-5).filter(Boolean).map(word => (word === '刚刚' ? '刚' : word));
    const counts = new Map<string, number>();
    for (const word of recent) counts.set(word, (counts.get(word) ?? 0) + 1);
    return [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * 她这一天半里已经主动跟他说过的、关于她自己的事（ADR 0098）。10-20 到 10-21 三个晚上她每晚都提「肚子坠着」，他说「你会老是重复一件事」。
 * 「主动」= 说那句话的那一轮，他前面的话里没有提到这件事（他问起来她答，不算）。事实还在那里（时间块 / 身体那一行照旧写），只是说过了就不再自己提
 */
const TOLD_TOPICS: readonly { name: string; pattern: RegExp }[] = [
    { name: '肚子不舒服', pattern: /肚子|痛经|生理期|大姨妈|坠着|头疼|头痛|嗓子|感冒|发烧|不舒服/ },
    { name: '相机', pattern: /相机|镜头|a6100|参数|快门|攒钱/ },
    { name: '猫', pattern: /土豆|猫粮|喂猫/ },
    { name: '作业', pattern: /作业|ddl|数据结构|Linux|操作系统/ },
    { name: '快递', pattern: /快递|驿站/ },
];
export const TOLD_WINDOW_MS = 36 * 3_600_000;
export function alreadyTold(history: LengthContext['history'], now: number): string[] {
    const told = new Set<string>();
    let prompt = '';
    let previous: 'user' | 'assistant' | undefined;
    for (const message of history) {
        if (message.role === 'user') {
            prompt = previous === 'user' ? `${prompt}\n${message.content}` : message.content;
        } else {
            const at = message.time ? Date.parse(message.time) : Number.NaN;
            if (Number.isFinite(at) && now - at <= TOLD_WINDOW_MS) {
                const text = message.content.replace(/\[[^\]]{1,12}\]/g, '');
                for (const topic of TOLD_TOPICS) if (topic.pattern.test(text) && !topic.pattern.test(prompt)) told.add(topic.name);
            }
        }
        previous = message.role;
    }
    return [...told];
}

export function saidSinceReply(history: LengthContext['history']): string {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    return history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('');
}

export function describeLength(hint: LengthHint, shortReplies = false): string {
    return hint === 'short'
        ? !shortReplies ? '[这一轮说话：只回一句短的，几个字也行；不展开，不另起话题]' : '[这一轮说话：只回很短的一句，一两个字也行——语气词、单个词、一句反问都可以，不用凑成完整的句子；不展开，不另起话题。他在难受、报大事、等安慰或闹别扭时不适用，照平常的说]'
        : '[这一轮说话：话多一点，想说的可以多说几句、说完整，不用一两句就停]';
}

/** 常见的同音错词：[正确的, 打错的]（拼音输入法选错词）。第一批 348 次回复里原来那 10 个只出现在 2.6% 的回复里，补了几个常用的；「在宿舍」「在床上」她天天说，同一种错反复出现反而假，不放 */
export const TYPOS: readonly [string, string][] = [
    ['应该', '因该'],
    ['因为', '应为'],
    ['已经', '以经'],
    ['在干嘛', '再干嘛'],
    ['再说', '在说'],
    ['做作业', '作作业'],
    ['好像', '好象'],
    ['知道', '知到'],
    ['再见', '在见'],
    ['觉得', '觉的'],
    ['反正', '反证'],
    ['以后', '已后'],
    ['在家', '再家'],
    ['还在', '还再'],
    ['再来', '在来'],
];

/** 有能打错的词时打错的概率；打错了改口的概率 */
export const TYPO_CHANCE = 0.2;
export const CORRECT_CHANCE = 0.7;

/** 撤回重发（ADR 0086）：第 index 条先发打错的 wrong，afterMs 之后撤回，再发对的那条；撤回不了就补发 fix（「*对的词」） */
export interface TypoRecall {
    index: number;
    wrong: string;
    fix: string;
    afterMs: number;
}

/** 打错了又改口的，改口的方式里撤回重发的占比（有撤回的本事时） */
export const RECALL_SHARE = 0.5;

export interface Typo {
    parts: string[];
    /** 日志用：「应该 → 因该（改口）」 */
    note?: string;
    recall?: TypoRecall;
}

/**
 * 发出去之前：可能把一条里的一个词打错，后面跟一条改口。seed 让同一次回复的结果固定（测试、重放）。
 * 改口那条会超过这一轮的条数上限（上课只回一条）就不改（第二批：上课时多出一条「*在干嘛」）
 */
export function maybeTypo(parts: readonly string[], seed: string, maxBubbles = Infinity, recallShare = 0): Typo {
    const roll = unit(`${seed} typo`);
    if (roll >= TYPO_CHANCE) return { parts: [...parts] };
    for (const [i, part] of parts.entries()) {
        const found = TYPOS.find(([right]) => part.includes(right));
        if (!found) continue;
        const [right, wrong] = found;
        const typed = part.replace(right, wrong);
        const corrects = unit(`${seed} correct`) < CORRECT_CHANCE;
        // 撤回重发不多出一条，上课只回一条时也能用；种子只在有撤回的本事时才看，没有时和以前完全一样
        if (corrects && recallShare > 0 && unit(`${seed} recall`) < recallShare) {
            const afterMs = 1500 + Math.floor(unit(`${seed} recall at`) * 3500);
            return { parts: [...parts], note: `${right} → ${wrong}（撤回重发）`, recall: { index: i, wrong: typed, fix: `*${right}`, afterMs } };
        }
        const correct = corrects && parts.length < maxBubbles;
        const out = [...parts];
        out[i] = typed;
        if (correct) out.splice(i + 1, 0, `*${right}`);
        return { parts: out, note: `${right} → ${wrong}${correct ? '（改口）' : '（没改）'}` };
    }
    return { parts: [...parts] };
}

export function unit(text: string): number {
    let hash = 0x811c9dc5;
    for (const char of text) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash / 0x1_0000_0000;
}
