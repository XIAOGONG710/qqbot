// 「让她从真人聊天里学怎么说话」的第一个实验（只在模拟器里用，线上没有；ADR 0180 草稿）。
//
// 用户 10-30：「可以让她自主地去学习真人怎么说话聊天，而不是限制她的字数，她现在正是需要学习成长的时候。」
// 模型本身改不了（走 API），所以「学」只能是：①看真人遇到类似的话是怎么回的（检索例子，放进提示词）；②自己总结、调整习惯（以后做）。
// 这里先量①：不限制任何字数，只给她 K 条真人在相似的话后面的回法，看每条长短、几条、只回一个字的比例会不会自己往真人靠。
// 防泄漏：留一法——例子池是别的题，同一段对话里的（上文、他说的、她回的有任何一句重合）一律不用；防照抄：另外量她有没有原样抄例子里的句子。

export interface ExemplarCase {
    id: string;
    /** 他这一轮说的话，一条一个气泡 */
    stimulus: string[];
    /** 真人的回复，一条一个气泡 */
    human?: string[];
    /** 更早的聊天（只用来判断是不是同一段对话） */
    context?: Array<{ content: string }>;
}

const lines = (item: ExemplarCase): Set<string> => new Set([...item.stimulus, ...(item.human ?? []), ...(item.context ?? []).map(line => line.content)].map(text => text.trim()).filter(text => [...text].length >= 3));

/** 两题是不是同一段对话：他说的 / 她回的 / 上文里有任何一句（3 字以上）一模一样 */
export function sameConversation(a: ExemplarCase, b: ExemplarCase): boolean {
    const left = lines(a);
    for (const text of lines(b)) if (left.has(text)) return true;
    return false;
}

function grams(text: string): Set<string> {
    const flat = text.replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i < flat.length - 1; i++) out.add(flat.slice(i, i + 2));
    if (flat.length === 1) out.add(flat);
    return out;
}

/** 他说的话有多像：二字词重叠 / 较短那边的个数；再加一点"长短差不多"的分 */
export function stimulusSimilarity(a: string[], b: string[]): number {
    const A = grams(a.join(''));
    const B = grams(b.join(''));
    const overlap = !A.size || !B.size ? 0 : [...A].filter(gram => B.has(gram)).length / Math.min(A.size, B.size);
    const la = [...a.join('')].length;
    const lb = [...b.join('')].length;
    const lengthScore = 1 - Math.min(1, Math.abs(la - lb) / Math.max(la, lb, 1));
    return overlap * 0.8 + lengthScore * 0.2;
}

/** 给 target 挑 k 条例子：池里排除自己和同一段对话的，按他说的话有多像排序，同分按 id 定序（可复现） */
export function pickExemplars(target: ExemplarCase, pool: readonly ExemplarCase[], k: number): ExemplarCase[] {
    return pool
        .filter(item => item.id !== target.id && item.human?.length && !sameConversation(target, item))
        .map(item => ({ item, score: stimulusSimilarity(target.stimulus, item.stimulus) }))
        .sort((x, y) => y.score - x.score || x.item.id.localeCompare(y.item.id))
        .slice(0, k)
        .map(entry => entry.item);
}

/** 放进提示词的一段：只看口气、长短、反应的方式，别照抄 */
export function formatExemplars(list: readonly ExemplarCase[]): string | undefined {
    if (!list.length) return undefined;
    const body = list.map(item => `他说：${item.stimulus.join(' / ')}\n她回：${(item.human ?? []).join(' / ')}`).join('\n\n');
    return `[真人聊天里，别人遇到类似的话是这样回的（只看口气、长短、反应的方式，别照抄原话，也别提这是参考）：\n${body}]`;
}

/** 她这一轮有几句是原样抄了例子里的真人回复（3 字以上） */
export function copiedLines(reply: readonly string[], list: readonly ExemplarCase[]): number {
    const known = new Set(list.flatMap(item => item.human ?? []).map(text => text.trim()).filter(text => [...text].length >= 3));
    return reply.filter(text => known.has(text.trim())).length;
}
