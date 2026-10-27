// 「毛刺」的度量（ADR 0146，实验 C）：真人打字不是每句都圆——会在句尾挂一个没用的语气字、说话前停半拍（嗯 / 呃 / 省略号）、笑一下。
// 视频《更像人的插件》（B 站，作者数了 1.6 万条评论和 56 万条弹幕，每千字约 1.6 个毛刺）给了这个思路，但那个数字是别的语料、别的口径，
// 不能照搬；这里把口径写死在代码里，用同一把尺子分别量「他本人的话」「真人女生的样本」「她」，目标按真人那几行定，不按视频。
//
// 只看写法，不看内容词：一条气泡里有没有，不数重复（一条气泡最多算一次）。

/** 末尾的语气字（吗不算：那是疑问，不是挂的尾巴）；同 humanness.ts 的 part_* 特征同一批字 */
export const TAIL_PARTICLES = '吧啊呢嘛哦呀啦';

const FACE = /\[[^\]]{1,6}\]/g;
const TRAILING = /[\s。！!？?，,、～~…\.]+$/u;

/** 去掉气泡尾巴上的标点、拖音、表情记号之后的最后一个字；没有返回空串 */
export function finalChar(raw: string): string {
    const body = raw.replace(FACE, '').replace(TRAILING, '');
    return [...body].at(-1) ?? '';
}

/** 气泡结尾是不是挂了一个语气字（「好啊」「是吧」「在呢」）；整条就一个字（「啊」「哦」）不算挂尾巴，那是应声 */
export function hasTail(raw: string): boolean {
    const last = finalChar(raw);
    if (!last || !TAIL_PARTICLES.includes(last)) return false;
    const body = raw.replace(FACE, '').replace(TRAILING, '');
    return [...body].length >= 2;
}

/** 挂在句尾的那个语气字；没挂返回 undefined */
export function tailParticle(raw: string): string | undefined {
    return hasTail(raw) ? finalChar(raw) : undefined;
}

/** 说话前停半拍：句首或句中独立的「嗯 / 呃 / 额 / 唔」，或分句开头的「那个 / 就是」 */
const HESITATION = /(?:^|[，,。！？!?\s…~～、])(?:嗯{1,3}|呃{1,2}|额{1,2}|唔{1,2}|emm+|那个|就是)(?=[，,。…~～\s、]|$)/i;
const ELLIPSIS = /……|\.{3,}|…/;
const LAUGH = /哈哈|嘿嘿|嘻嘻|呵呵|[hH]{3,}|233+|笑死|xswl/;

export interface Edges {
    /** 句尾挂了语气字 */
    tail: boolean;
    /** 停半拍：嗯 / 呃 / 那个 / 就是（不含省略号，省略号单独数） */
    hesitation: boolean;
    ellipsis: boolean;
    laugh: boolean;
}

export function edgesOf(raw: string): Edges {
    const text = raw.replace(FACE, '');
    return { tail: hasTail(raw), hesitation: HESITATION.test(text), ellipsis: ELLIPSIS.test(text), laugh: LAUGH.test(text) };
}

export interface EdgeStats {
    bubbles: number;
    chars: number;
    /** 每种毛刺出现在多少条气泡里 */
    tail: number;
    hesitation: number;
    ellipsis: number;
    laugh: number;
    /** 至少带一种 */
    any: number;
}

export function measureEdges(texts: readonly string[]): EdgeStats {
    const stats: EdgeStats = { bubbles: 0, chars: 0, tail: 0, hesitation: 0, ellipsis: 0, laugh: 0, any: 0 };
    for (const raw of texts) {
        const text = raw.trim();
        if (!text) continue;
        const edges = edgesOf(text);
        stats.bubbles++;
        stats.chars += [...text.replace(FACE, '')].length;
        if (edges.tail) stats.tail++;
        if (edges.hesitation) stats.hesitation++;
        if (edges.ellipsis) stats.ellipsis++;
        if (edges.laugh) stats.laugh++;
        if (edges.tail || edges.hesitation || edges.ellipsis || edges.laugh) stats.any++;
    }
    return stats;
}

/** 占比（条数口径，0–1）；没有气泡返回 0 */
export function share(stats: EdgeStats, key: 'tail' | 'hesitation' | 'ellipsis' | 'laugh' | 'any'): number {
    return stats.bubbles ? stats[key] / stats.bubbles : 0;
}

/** 每千字几条气泡带这种毛刺（和视频的口径最接近，但仍是「条」不是「处」） */
export function perThousandChars(stats: EdgeStats, key: 'tail' | 'hesitation' | 'ellipsis' | 'laugh' | 'any'): number {
    return stats.chars ? (stats[key] * 1000) / stats.chars : 0;
}
