// 「像不像真人」检测器：只看写法（长短、标点、语气词、连接词、结构），不看内容词。
// 用途：①当尺子——拿真人的话和她的话训练一个简单的区分器，它分得越开说明越露馅，报出来的特征权重就是露馅的地方；
// 改完再量，分不开了才算好；②挑候选——同一句话生成几条，挑 P(真人) 最高的。
// 逻辑回归，没有依赖；特征都是「这一条气泡」的写法，不含具体的词（连接词、语气词这类功能词算写法）。

/** 一条气泡里的 [表情] 记号不算字数 */
const FACE = /\[[^\]]{1,6}\]/g;
const HAS_FACE = /\[[^\]]{1,6}\]/;

export const FEATURE_NAMES = [
    'len_log', 'len_le2', 'len_le4', 'len_le8', 'len_ge15', 'len_ge25',
    'end_period', 'end_exclaim', 'end_question', 'end_tilde', 'end_ellipsis', 'end_comma', 'end_none',
    'comma_count', 'period_count', 'clause_count', 'max_clause_len', 'multi_clause',
    'has_question', 'has_exclaim', 'has_tilde', 'has_ellipsis', 'has_enumeration',
    'hanzi_ratio', 'ascii_ratio', 'digit_ratio', 'has_emoji', 'has_face',
    'part_ma', 'part_ne', 'part_ba', 'part_a', 'part_la', 'part_ou', 'has_haha', 'has_ya', 'repeat_char',
    'starts_wo', 'starts_ni', 'connective', 'de_ratio', 'le_ratio', 'hedge', 'complete_sentence',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

const CONNECTIVE = /其实|不过|但是|可是|所以|因为|而且|然后|还是|而是|或者|如果|虽然|总之|毕竟|反而|似乎|大概|可能|应该|估计/g;
const HEDGE = /也许|可能|大概|或许|说不定|似乎|应该是|估计/;
const EMOJI = /\p{Extended_Pictographic}/u;

const chars = (text: string) => [...text.replace(FACE, '')];

/** 一条气泡的特征向量（顺序同 FEATURE_NAMES） */
export function bubbleFeatures(raw: string): number[] {
    const text = raw.trim();
    const body = chars(text);
    const n = body.length;
    const last = body.at(-1) ?? '';
    const bodyText = body.join('');
    const clauses = bodyText.split(/[，,。！!？?～~…、；;\s]+/).filter(Boolean);
    const count = (pattern: RegExp) => (bodyText.match(pattern) ?? []).length;
    const ratio = (pattern: RegExp) => (n ? count(pattern) / n : 0);
    const flag = (value: boolean) => (value ? 1 : 0);
    const stripped = bodyText.replace(/[\s\p{P}\p{S}]+$/u, '');
    const finalChar = [...stripped].at(-1) ?? '';
    return [
        Math.log1p(n), flag(n <= 2), flag(n <= 4), flag(n <= 8), flag(n >= 15), flag(n >= 25),
        flag(last === '。'), flag(last === '！' || last === '!'), flag(last === '？' || last === '?'), flag(last === '～' || last === '~'), flag(last === '…' || bodyText.endsWith('...')), flag(last === '，' || last === ','), flag(!/[\p{P}\p{S}]/u.test(last)),
        Math.min(count(/[，,]/g), 6), Math.min(count(/[。.]/g), 4), Math.min(clauses.length, 8), Math.min(Math.max(0, ...clauses.map(clause => [...clause].length)), 30) / 30, flag(clauses.length >= 3),
        flag(/[？?]/.test(bodyText)), flag(/[！!]/.test(bodyText)), flag(/[～~]/.test(bodyText)), flag(/…|\.{3}/.test(bodyText)), flag(/、/.test(bodyText)),
        ratio(/\p{Script=Han}/gu), ratio(/[A-Za-z]/g), ratio(/\d/g), flag(EMOJI.test(text)), flag(HAS_FACE.test(text)),
        flag(finalChar === '吗' || finalChar === '嘛'), flag(finalChar === '呢'), flag(finalChar === '吧'), flag(finalChar === '啊' || finalChar === '呀'), flag(finalChar === '啦' || finalChar === '了'), flag(finalChar === '哦' || finalChar === '喔' || finalChar === '噢'), flag(/哈{2,}|嘿{2,}|hh/i.test(bodyText)), flag(/呀/.test(bodyText)), flag(/(.)\1/u.test(bodyText) && n <= 6),
        flag(bodyText.startsWith('我')), flag(bodyText.startsWith('你')), Math.min(count(CONNECTIVE), 3), ratio(/的/g), ratio(/了/g), flag(HEDGE.test(bodyText)),
        // 像一句写完整的话：有主语和谓语的长句、以句号收尾（碎片、语气词、反问不算）
        flag(n >= 9 && last === '。'),
    ];
}

export interface Model {
    names: readonly string[];
    mean: number[];
    std: number[];
    weights: number[];
    bias: number;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface TrainOptions {
    /** L2 正则；样本少所以不小 */
    lambda?: number;
    iterations?: number;
    rate?: number;
}

/** 标签：1 = 真人，0 = 她。逻辑回归（特征先标准化），批量梯度下降 */
export function trainModel(rows: readonly { x: number[]; y: 0 | 1; w?: number }[], options: TrainOptions = {}): Model {
    const { lambda = 0.05, iterations = 1500, rate = 0.3 } = options;
    const d = FEATURE_NAMES.length;
    const total = rows.reduce((sum, row) => sum + (row.w ?? 1), 0);
    const mean = Array.from({ length: d }, (_, j) => rows.reduce((sum, row) => sum + (row.w ?? 1) * row.x[j]!, 0) / total);
    const std = Array.from({ length: d }, (_, j) => Math.sqrt(rows.reduce((sum, row) => sum + (row.w ?? 1) * (row.x[j]! - mean[j]!) ** 2, 0) / total) || 1);
    const z = rows.map(row => row.x.map((value, j) => (value - mean[j]!) / std[j]!));
    const weights = new Array<number>(d).fill(0);
    let bias = 0;
    for (let step = 0; step < iterations; step++) {
        const grad = new Array<number>(d).fill(0);
        let gradBias = 0;
        for (const [i, row] of rows.entries()) {
            const w = row.w ?? 1;
            const error = (sigmoid(bias + z[i]!.reduce((sum, value, j) => sum + value * weights[j]!, 0)) - row.y) * w;
            for (let j = 0; j < d; j++) grad[j]! += error * z[i]![j]!;
            gradBias += error;
        }
        for (let j = 0; j < d; j++) weights[j]! -= rate * (grad[j]! / total + lambda * weights[j]!);
        bias -= rate * (gradBias / total);
    }
    return { names: FEATURE_NAMES, mean, std, weights, bias };
}

/** 这条气泡像真人的概率（0–1） */
export function humanProbability(model: Model, text: string): number {
    const x = bubbleFeatures(text);
    return sigmoid(model.bias + x.reduce((sum, value, j) => sum + ((value - model.mean[j]!) / model.std[j]!) * model.weights[j]!, 0));
}

/** AUC：随机取一条真人的、一条她的，真人的分更高的概率（0.5 = 分不开） */
export function auc(scores: readonly { score: number; y: 0 | 1 }[]): number {
    const sorted = [...scores].sort((a, b) => a.score - b.score);
    let rankSum = 0;
    let positives = 0;
    let i = 0;
    while (i < sorted.length) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1]!.score === sorted[i]!.score) j++;
        const rank = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) if (sorted[k]!.y === 1) { rankSum += rank; positives++; }
        i = j + 1;
    }
    const negatives = sorted.length - positives;
    return positives && negatives ? (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives) : NaN;
}

/** 每个特征对「像真人」的贡献方向：权重 × 标准差之前的标准化权重（正 = 越有越像真人，负 = 越有越像她/AI） */
export function featureEffects(model: Model): { name: string; weight: number }[] {
    return model.names.map((name, j) => ({ name, weight: model.weights[j]! })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}
