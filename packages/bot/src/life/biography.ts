// 她的过去（ADR 0022 第 2 步）：卡上的 extensions.qqbot.biography（作者定稿的自传切好的块，转换器已按档位裁剪）→ 有线索才想起。
// - 线索：他这次的话（她上次回复之后他说的）里出现某块的 keys；最多放 PAST_CHUNKS 块，命中的词长的在前，一样长按资料顺序。
// - 想起之后，接下来没有新线索也沿用一会儿（同公共记忆的 stillInMind，ADR 0017）：追问「那后来呢」本身没有线索。
// - 留白照写：refuse 不想讲、vague 记不清、unsaid 心里的事不说出口——真人的过去有空洞。
// - 进提示词的是素材不是台词；附上这一档看得到的年表，让她知道先后。keys 不进提示词。

export type PastGap = 'refuse' | 'vague' | 'unsaid';

export interface PastChunk {
    id: string;
    title: string;
    keys: string[];
    gap?: PastGap;
    text: string;
}

export interface Biography {
    /** 「何时：何事」一行一件 */
    timeline: string[];
    chunks: PastChunk[];
}

/** 一轮最多想起几块 */
export const PAST_CHUNKS = 2;

const GAPS: readonly PastGap[] = ['refuse', 'vague', 'unsaid'];

const GAP_NOTE: Record<PastGap, string> = {
    refuse: '这段你不想讲：被问到就含糊过去，或者直说不想提，别细说、别编',
    vague: '这段你记不清：记得的照说，记不清的就说记不清，别补细节',
    unsaid: '这是你心里的事，不说出口',
};

export function parseBiography(value: unknown, source: string): Biography | undefined {
    if (value === undefined) return undefined;
    const data = value as { timeline?: unknown; chunks?: unknown };
    const strings = (list: unknown) => Array.isArray(list) && list.every(item => typeof item === 'string' && item);
    if (!strings(data.timeline) || !Array.isArray(data.chunks)) throw new Error(`${source}：extensions.qqbot.biography 应有 timeline（字符串数组）和 chunks`);
    const chunks = data.chunks.map((item, i) => {
        const c = item as Record<string, unknown>;
        if (typeof c.id !== 'string' || typeof c.title !== 'string' || typeof c.text !== 'string' || !c.text || !strings(c.keys)) {
            throw new Error(`${source}：extensions.qqbot.biography.chunks[${i}] 要有 id、title、keys、text`);
        }
        if (c.gap !== undefined && !GAPS.includes(c.gap as PastGap)) throw new Error(`${source}：biography.chunks[${i}].gap 只能是 ${GAPS.join('、')}`);
        return { id: c.id, title: c.title, keys: c.keys as string[], ...(c.gap ? { gap: c.gap as PastGap } : {}), text: c.text };
    });
    return { timeline: data.timeline as string[], chunks };
}

/** 他这次的话里提到的过去（命中 keys 的块，最多 PAST_CHUNKS 块）；她刚回过、他还没说新的就没有 */
export function pastCue(history: readonly { role: 'user' | 'assistant'; content: string }[], biography: Biography): PastChunk[] {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const said = history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
    if (!said) return [];
    return biography.chunks
        .map((chunk, order) => ({ chunk, order, hit: Math.max(0, ...chunk.keys.filter(key => said.includes(key)).map(key => [...key].length)) }))
        .filter(item => item.hit > 0)
        .sort((a, b) => b.hit - a.hit || a.order - b.order)
        .slice(0, PAST_CHUNKS)
        .map(item => item.chunk);
}

/** 提示词里的一段：想起的那几块（留白带说明）+ 年表 */
export function describePast(chunks: readonly PastChunk[], biography: Biography): string | undefined {
    if (chunks.length === 0) return undefined;
    return [
        '[你想起的从前（你自己的事，只是素材不是台词；他问到、话赶到了才用，用你自己的话挑要紧的说；用不上就别提，没写到的细节别编）]',
        ...chunks.map(chunk => `- ${chunk.title}：${chunk.text}${chunk.gap ? `（${GAP_NOTE[chunk.gap]}）` : ''}`),
        ...(biography.timeline.length ? [`你的年表：${biography.timeline.join('；')}`] : []),
    ].join('\n');
}
