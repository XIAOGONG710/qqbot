// 让她看真人怎么回（ADR 0190 第 2 步）：从已批准的真人语料里挑几条「他说完这种话，真人女生怎么接」，
// 放进提示词当参考——教她口气和长短，不是给她定字数。
// 两条防线：留一法（同一段对话的例子不用——现在只按 id，语料够细也可以按 session）、防照抄（n-gram 重叠）。
import { existsSync, readFileSync } from 'node:fs';

export interface Exemplar {
    id: string;
    /** 来源（语料文件 + 段落号），审计用 */
    source: string;
    license: string;
    relation?: string;
    scene?: number;
    /** 他说的那句 */
    said: string;
    /** 真人女生的回法（一条到三条气泡） */
    replied: string[];
}

export interface PickOptions {
    /** 挑几条，默认 4（Claude 的实验里 4 条比 8 条好） */
    k?: number;
}

const BIGRAM = /[\p{Script=Han}A-Za-z0-9]{2}/gu;

/** 两字词集合：中文按字滑动取二元组，英文数字按词 */
function bigrams(text: string): Set<string> {
    const clean = text.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
    const out = new Set<string>();
    for (let i = 0; i + 2 <= clean.length; i++) out.add(clean.slice(i, i + 2));
    return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
    let n = 0;
    for (const token of a) if (b.has(token)) n++;
    return n;
}

/** 读语料：一行一个 JSON；坏行跳过，文件不在返回空 */
export function loadExemplars(path: string, log: (message: string) => void = () => undefined): Exemplar[] {
    if (!existsSync(path)) return [];
    const out: Exemplar[] = [];
    for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
        try {
            const row = JSON.parse(line) as Exemplar;
            if (row?.said && Array.isArray(row.replied) && row.replied.length) out.push(row);
        } catch { /* 坏行跳过 */ }
    }
    log(`真人例子：${out.length} 条（${path}）`);
    return out;
}

/** 按「他说的话」挑最像的几条；同样的输入每次都挑同样的，方便复现 */
export function pickExemplars(pool: readonly Exemplar[], said: string, options: PickOptions = {}): Exemplar[] {
    const k = Math.max(0, Math.min(options.k ?? 4, pool.length));
    if (!k || !said.trim()) return [];
    const target = bigrams(said);
    return [...pool]
        .map(example => ({ example, score: overlap(target, bigrams(example.said)) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.example.id.localeCompare(b.example.id))
        .slice(0, k)
        .map(item => item.example);
}

/** 她这条是不是原样抄了例子：连着 8 个字一样就算（Claude 的实验里 0 条被抄，这道只是保险） */
export function looksCopied(reply: string, examples: readonly Exemplar[], run = 8): boolean {
    const clean = (text: string) => text.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
    const target = clean(reply);
    if (target.length < run) return false;
    for (const example of examples) {
        for (const bubble of example.replied) {
            const source = clean(bubble);
            for (let i = 0; i + run <= source.length; i++) {
                if (target.includes(source.slice(i, i + run))) return true;
            }
        }
    }
    return false;
}

/** 放进提示词的那几行：明确说「学口气和长短，别搬内容」 */
export function exemplarLine(examples: readonly Exemplar[]): string | undefined {
    if (!examples.length) return undefined;
    const lines = examples.map((example, i) => `例 ${i + 1}：他说「${example.said.slice(0, 40)}」，她回「${example.replied.join('」「').slice(0, 60)}」`);
    return `[几个真人在类似的话后面是这么回的——看她们的长度、口气、怎么收尾，学那个；不准原样抄，也不准把例子里的地点、人、事搬进来]\n${lines.join('\n')}`;
}
