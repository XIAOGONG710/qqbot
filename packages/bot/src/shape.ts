// 形状控制（配置 shape，默认关）：按他这一轮说了多长，定她这一轮每条最多几个字、最多几条，并在发出去之前强制执行。
// 为什么：10-20 重算她的聊天记录，每条气泡中位 16 字、几乎全在 13–19 字之间，1–4 字的占 0%，真人是中位 6–7 字、长短不齐的重尾，
// 而且真人会跟着对方的长短走（他发 5 个字她也只回几个字）。「回短一点」只是提示词里的一句软话（shortReplies），模型不听；
// 这里换成具体的数字（每条不超过 N 个字，最多 M 条），超了重写一次，还超就在分句处截断。
// 数字不是编的：气泡字数档按真人聊天（情侣截图 482 个气泡 + 他自己发的话）的分布取，档的权重再按他这一轮的长短挪一挪。
// 不适用：主动找他、收尾、他明着让她讲、危机回合（调用方不传）。他在难受、报大事、等安慰、问起她认识的人时只用长的几档（不会只回两个字）。

import { ASKS_TO_EXPLAIN, saidSinceReply, unit, WORRIED_TEXT, type LengthContext } from './expression.ts';

export type ShapeKind = 'micro' | 'short' | 'medium' | 'long' | 'wide';

export interface ShapePlan {
    kind: ShapeKind;
    /** 每条最多几个字 */
    cap: number;
    /** 最多几条 */
    maxBubbles: number;
}

const BUCKETS: readonly { kind: ShapeKind; cap: number }[] = [
    { kind: 'micro', cap: 4 }, { kind: 'short', cap: 8 }, { kind: 'medium', cap: 14 }, { kind: 'long', cap: 24 }, { kind: 'wide', cap: 40 },
];

/** 各档权重（和为 1）：按他这一轮说了几个字挪。基线 ≈ 真人每条的分布（≤4 字约四分之一、≤8 字过半、≤14 字约八成） */
const WEIGHTS = {
    tiny: [0.4, 0.35, 0.18, 0.06, 0.01],
    base: [0.25, 0.3, 0.27, 0.14, 0.04],
    talky: [0.12, 0.25, 0.33, 0.25, 0.05],
    long: [0.06, 0.15, 0.3, 0.34, 0.15],
} as const;
/** 要认真接话的轮次只用后三档（不能只回两个字） */
const ENGAGED_WEIGHTS = [0, 0, 0.45, 0.4, 0.15] as const;
/** 亲近 / 撒娇的轮次：真人这时也是短短的几句（抱抱、想你），但不回「嗯」 */
const INTIMATE_WEIGHTS = [0, 0.35, 0.4, 0.2, 0.05] as const;
/**
 * 现有的「认真接话」名单（ENGAGED_INTENT）把「回应他刚说的那件事」也算进去了，而这是最常见的意图行——10-21 模拟里 104 轮有 72% 落在名单里，
 * 极短的两档只剩 28%（该有 55%），这也是 shortReplies 一直压不下来的原因。这里只把真正要有内容的拆出来：难受、报好事、等他的解释
 */
const SUBSTANTIVE_INTENT = /先接住他此刻的情绪|他刚说了件好事|他到现在才看到你前面发的/;
const INTIMATE_INTENT = /只接他刚说的你们两个人的事|他在向你要亲近|他在撒娇要你哄他/;
/**
 * 收尾的意图行是「顺着他的话收尾，只回一两句」。不能像 lengthHint 那样看有没有「收尾」两个字：亲近那条意图行里写着「他真要收尾时回应后顺着收尾」，
 * 会被当成收尾——10-21 模拟里亲近的 35 轮因此一轮形状也没有，shortReplies 在这类轮次也一直没起作用
 */
const CLOSING_INTENT = /顺着他的话收尾/;
/** 收尾的轮次：真人这时就是一两个字（晚安、好哒、嗯嗯） */
const CLOSING_WEIGHTS = [0.4, 0.4, 0.15, 0.05, 0] as const;

export type ShapeContext = Pick<LengthContext, 'history' | 'intent' | 'initiating' | 'low' | 'aboutPerson'>;

const chars = (text: string) => [...text.replace(/\[[^\]]{1,6}\]/g, '#')].length;

/** 这一轮的形状；不适用返回 undefined（调用方照旧用 lengthHint） */
export function planShape(context: ShapeContext): ShapePlan | undefined {
    if (context.initiating) return undefined;
    const last = context.history.findLast(message => message.role === 'user');
    if (!last) return undefined;
    if (ASKS_TO_EXPLAIN.test(last.content)) return undefined;
    const said = saidSinceReply(context.history);
    const his = chars(said);
    const closing = Boolean(context.intent && CLOSING_INTENT.test(context.intent));
    const engaged = !closing && Boolean((context.intent && SUBSTANTIVE_INTENT.test(context.intent)) || WORRIED_TEXT.test(said) || context.aboutPerson);
    const intimate = !closing && !engaged && Boolean(context.intent && INTIMATE_INTENT.test(context.intent));
    let weights: readonly number[] = closing ? CLOSING_WEIGHTS : engaged ? ENGAGED_WEIGHTS : intimate ? INTIMATE_WEIGHTS : his <= 3 ? WEIGHTS.tiny : his <= 10 ? WEIGHTS.base : his <= 25 ? WEIGHTS.talky : WEIGHTS.long;
    // 心情安静、身体不舒服：往短里挪一点（话少、不展开），不用到最长的两档
    if (context.low && !engaged) weights = weights.map((weight, i) => weight * [1.5, 1.3, 1, 0.5, 0.2][i]!);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const key = `${last.time ?? ''} ${last.content}`;
    const roll = unit(`${key} shape`) * total;
    let acc = 0;
    let index = weights.length - 1;
    for (const [i, weight] of weights.entries()) {
        acc += weight;
        if (roll < acc) { index = i; break; }
    }
    const bucket = BUCKETS[index]!;
    const countRoll = unit(`${key} shape count`);
    // 一轮几条：真人 1 条 51–65%、2 条 22–28%、3 条以上约 15–20%；极短的一档多半只发一条
    const maxBubbles = closing ? (countRoll < 0.7 ? 1 : 2) : bucket.kind === 'micro' ? (countRoll < 0.8 ? 1 : 2) : countRoll < 0.55 ? 1 : countRoll < 0.83 ? 2 : 3;
    return { kind: bucket.kind, cap: bucket.cap, maxBubbles };
}

/** 放进提示词的一行；不给台词，只给数字和方向 */
export function describeShape(plan: ShapePlan): string {
    if (plan.kind === 'micro') {
        return `[这一轮说话：${plan.maxBubbles === 1 ? '只回一条' : `最多 ${plan.maxBubbles} 条`}，每条不超过 ${plan.cap} 个字——语气词、单个词、一句反问都可以，不用凑成完整的句子；不展开，不另起话题。他在难受、报大事、等安慰或闹别扭时不适用，照平常的说]`;
    }
    if (plan.kind === 'short') {
        return `[这一轮说话：每条不超过 ${plan.cap} 个字，最多 ${plan.maxBubbles} 条；像手机上随手打的，半句也行，不用凑成完整的句子；不展开，不另起话题]`;
    }
    return `[这一轮说话：每条不超过 ${plan.cap} 个字，最多 ${plan.maxBubbles} 条；想到哪说到哪，不用把话说圆]`;
}

// ───────── 强制执行 ─────────

const STICKER_LINE = /^<sticker:[a-f0-9]{12}>$/i;
/** 超出多少算「太长」：给一点余地，免得 9 个字的话为了 8 的上限被砍 */
const slack = (cap: number) => Math.max(2, Math.ceil(cap * 0.35));
const limitOf = (plan: ShapePlan) => plan.cap + slack(plan.cap);
const BOUNDARY = /[，,。！!？?～~…、；;\s]/;

function lines(reply: string): string[] {
    return reply.split('\n').map(line => line.trim()).filter(Boolean);
}

/** 哪些行太长 / 条数超了 */
export function shapeProblems(reply: string, plan: ShapePlan): { tooLong: number; tooMany: number } {
    const text = lines(reply).filter(line => !STICKER_LINE.test(line));
    return { tooLong: text.filter(line => chars(line) > limitOf(plan)).length, tooMany: Math.max(0, text.length - plan.maxBubbles) };
}

/** 把一行截到上限以内，只在分句处截（不拦腰截断一个词）；找不到分句处就原样留着。返回 undefined = 没截 */
function cutLine(line: string, limit: number): string | undefined {
    const list = [...line];
    for (let end = Math.min(list.length - 1, limit); end >= 2; end--) {
        if (!BOUNDARY.test(list[end]!)) continue;
        const head = list.slice(0, end).join('').replace(/[，,、；;\s]+$/, '');
        if (chars(head) >= 2) return head;
    }
    return undefined;
}

/** 超出的条数去掉、太长的行在分句处截断；返回处理后的回复和改了什么（给日志） */
export function trimToShape(reply: string, plan: ShapePlan): { reply: string; notes: string[] } {
    const notes: string[] = [];
    let all = lines(reply);
    // 条数只数文字的行：图片表情的指令行不占名额，原样留着
    const textCount = all.filter(line => !STICKER_LINE.test(line)).length;
    if (textCount > plan.maxBubbles) {
        notes.push(`去掉第 ${plan.maxBubbles + 1} 条起的 ${textCount - plan.maxBubbles} 条`);
        let kept = 0;
        all = all.filter(line => STICKER_LINE.test(line) || ++kept <= plan.maxBubbles);
    }
    const limit = limitOf(plan);
    all = all.map(line => {
        if (STICKER_LINE.test(line) || chars(line) <= limit) return line;
        const cut = cutLine(line, limit);
        if (cut) notes.push(`一条 ${chars(line)} 字的截到 ${chars(cut)} 字`);
        else notes.push(`一条 ${chars(line)} 字的找不到分句处，原样留着`);
        return cut ?? line;
    });
    return { reply: all.join('\n'), notes };
}

export interface ShapeDeps {
    /** 在原来的提示词末尾加上这句说明重新生成，返回清理过的回复 */
    regenerate: (note: string) => Promise<string>;
    log: (message: string) => void;
}

/** 出口：太长或条数超了，带说明重写一次；还超就截断 */
export async function shapeReply(reply: string, plan: ShapePlan, deps: ShapeDeps): Promise<string> {
    const first = shapeProblems(reply, plan);
    if (first.tooLong === 0 && first.tooMany === 0) return reply;
    deps.log(`形状：${first.tooLong ? `有 ${first.tooLong} 条超过 ${limitOf(plan)} 字` : ''}${first.tooLong && first.tooMany ? '，' : ''}${first.tooMany ? `多了 ${first.tooMany} 条` : ''}，带说明重写一次`);
    let current = reply;
    try {
        const rewritten = await deps.regenerate(`[上一版回复没有发出去：太长了——这一轮每条不超过 ${plan.cap} 个字，最多 ${plan.maxBubbles} 条。意思不变，缩短重写，只输出要发的消息。]`);
        if (lines(rewritten).length > 0) current = rewritten;
    } catch (error) {
        deps.log(`形状：重写失败（${error instanceof Error ? error.message : String(error)}），直接截断`);
    }
    const trimmed = trimToShape(current, plan);
    if (trimmed.notes.length) deps.log(`形状：${trimmed.notes.join('；')}`);
    return trimmed.reply;
}
