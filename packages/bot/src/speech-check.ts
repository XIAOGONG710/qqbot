// 说话的毛病（ADR 0014 决策 2、3）：出口检查里和做不到的事、禁用词一起查（exit-check.ts），按行。
// - 助手腔：客服式的收尾和套话、分点列条理。
// - 算账：说对方找她找得晚、隔了很久才来。前面是「我」的不算（「我这会儿才翻到」）。
// - 怪他没说：怪对方没告诉她、没带上她（10-05 取证里全是状态行「他回青岛了」引出来的）。
// - 重复：和她最近 8 次回复比。开头的短句已经用过 2 次，或者 4 个字的片段已经说过 2 次（对方最近 3 条说过的话题词不算）。
//   开头是「行」「哟」这类语气词的，直接去掉，不重写。

import type { StoredMessage } from './history.ts';
import type { BookProgress, ReadingBook } from './her-days.ts';

export type SpeechKind = 'service' | 'ledger' | 'blame' | 'repeat';

export interface SpeechIssue {
    /** 回复里的第几行（从 0 开始，按 \n 分） */
    line: number;
    kind: SpeechKind;
    /** 命中的片段；重复时是那个开头或片段 */
    match: string;
    /** 重复的是开头还是片段 */
    repeat?: 'opener' | 'phrase';
    /** 重复：最近几次回复里用过几次 */
    count?: number;
    /** 重复的开头是语气词：去掉它之后的这一行（只剩语气词时是空串） */
    stripped?: string;
}

/** 和哪些话比：她最近几次回复（旧到新，每次是发出去的几行），对方最近几条 */
export interface SpeechContext {
    recent: readonly (readonly string[])[];
    his: readonly string[];
}

/** 这一轮放进提示词的书和它当天的进度；focusIds 是最近消息明确在聊的书 */
export interface BookProgressContext {
    books: readonly { book: ReadingBook; progress: BookProgress }[];
    focusIds?: readonly string[];
}

export interface BookProgressIssue {
    line: number;
    bookId: string;
    title: string;
    raw: string;
    said: number;
    expected: number;
    unit: string;
    kind: 'progress' | 'total';
}

/** 和她最近几次回复比 */
export const RECENT_REPLIES = 8;
/** 对方最近几条里说过的片段不算重复 */
const HIS_MESSAGES = 3;
/** 用过几次算重复（这次是第三次） */
const REPEAT_AT = 2;

const CLAUSE = '[^，。！？、,.!?\\s]';
const NOT_ME = '(?<![我俺])';
/** 一个短句到这儿结束 */
const END = `[${'，,。.！!？?\\s~～…'}]|$`;

const SERVICE = new RegExp([
    '^\\s*(?:\\d+[.、)）](?!\\d)|[-•·*]\\s|[①②③④⑤⑥])\\s*\\S',
    `(?:有|还有)(?:什么|啥)?(?:需要|问题|不懂的?)(?:的话)?${CLAUSE}{0,4}(?:随时|再|尽管|就)(?:找|问|叫|跟|来)`,
    '随时(?:来)?(?:找我|叫我|跟我说|告诉我|问我|喊我)',
    '希望(?:对你|能)?(?:有|帮)(?:帮助|到你|用)',
    '(?:很高兴|乐意)(?:能|为你|帮)',
    '不客气',
    '还有(?:什么|别的|其他)(?:想(?:问|了解|知道)|需要|问题)',
].join('|'));

const LEDGER = new RegExp([
    '才(?:想起|记起|舍得)(?:来)?(?:我|找我|回我|问我|理我|还有我)',
    `${NOT_ME}(?:这会儿|现在|这时候|这个点儿?|今天|到现在)才(?:来|想起|冒出来|回我|问|找|理)`,
    '还知道(?:回来|想我|找我|回我|理我|有个?我)',
    '(?<!别)把我(?:给)?忘了',
    `${NOT_ME}终于(?:想起|舍得)`,
    '想起(?:我|还有我)(?:来)?[了啦]',
    '把我晾|晾着?我|冷落我',
    '(?:一|大|半)(?:整)?天(?:都)?没(?:动静|影|消息|音讯)',
    '(?:说完|然后|又)就?没(?:影|动静)了',
    '失踪人口',
    `(?:一个字|一句话|一条消息|一点消息)(?:都|也)没(?:有|回|发)我?(?=${END})`,
    `(?<=^|[${'，,。.！!？?\\s~～…'}]|你)还活着[啊呀呢吗]?(?=${END})`,
    '以为你把我(?:删|拉黑)',
].join('|'));

const BLAME = new RegExp([
    '(?:也|都)不(?:提前|先)?(?:说|讲|跟我说|告诉我|知会|吱|跟我念叨)一声',
    `${NOT_ME}(?:也|都)不(?:提前|先)(?:说|讲|跟我说|告诉我)`,
    '(?:也|都)不(?:告诉|跟)我(?:说)?',
    '(?:也|都)不(?:说|想着)(?:带|叫|陪|来找|去)',
    '招呼都不打',
    '没想着(?:告诉|叫|带)我',
    '背着我(?!的)',
    '把我(?:一个人)?(?:扔|丢|撂)',
    '也不(?:带|叫|喊|陪|来找)我',
    '不(?:带上|叫上|喊上)我(?!也)',
    `(?<![别])不(?:叫|喊|带)我(?=玩|[${'，,。.！!？?\\s~～…'}]|$)`,
    '(?:你|一个人)偷偷(?:跑|回|溜|去)',
    '(?:怎么|之前|也|都|从来)没(?:听你|跟我)(?:说|提)(?:过|起)',
    `我(?:怎么|咋)不知道[啊呢]?(?=${END})`,
    '怎么不(?:早说|早告诉我|早跟我说|跟我说|告诉我)',
    `你${CLAUSE}{0,3}怎么不说(?=${END})`,
    '你倒好(?!意思)',
    '(?<!别)留我一个人',
].join('|'));

const PUNCT = '，,。.！!？?、~～…：:；;“”"\'（）()\\s';
const SPLIT = new RegExp(`[${PUNCT}]`);
/** 能直接去掉的语气词开头：两个字的直接认，单字的后面要跟标点（「行不行」「好看」不是） */
const MARKER = new RegExp(`^(?:(行行行|行行|行了吧|行了|行吧|好吧|好好好|哎哟|得了吧|得了)[${PUNCT}]*|(行|哟|哼|切|啧|嗯|哦|好)[${PUNCT}]+)`);
const FAMILY: Record<string, string> = {
    行行行: '行', 行行: '行', 行了吧: '行', 行了: '行', 行吧: '行', 行: '行', 哎哟: '哟', 哟: '哟',
    好吧: '好', 好好好: '好', 好: '好', 得了吧: '得了', 得了: '得了',
};
/** 太常见、算不上口癖的开头 */
const PLAIN_OPENERS = new Set(['我', '你', '他', '她', '它', '那', '这', '就', '我也', '你也', '我在', '你在', '那你', '我就', '你就',
    '我这', '你这', '我还', '你还', '我是', '你是', '不是', '没有', '还没', '今天', '明天', '晚安', '宝宝', '真的']);
/** 太常见的 4 字片段 */
const PLAIN_GRAMS = new Set(['你是不是', '是不是你', '我也不知', '也不知道', '不知道啊', '怎么回事', '什么时候']);

/** 这一行的开头：语气词（按一种算），或者第一个短句（3 个字以内、不是整行）；都不是就没有 */
export function opener(line: string): { key: string; stripped?: string } | undefined {
    const text = line.trim();
    const marker = MARKER.exec(text);
    if (marker) {
        const word = marker[1] ?? marker[2]!;
        return { key: FAMILY[word] ?? word, stripped: text.slice(marker[0].length).trim() };
    }
    const first = text.split(SPLIT)[0] ?? '';
    if (first.length === 0 || first.length > 3 || first === text || PLAIN_OPENERS.has(first)) return undefined;
    return { key: first };
}

/** index 处在没合上的「」或“”里 */
function insideQuote(text: string, index: number): boolean {
    const before = text.slice(0, index);
    const open = (o: string, c: string) => before.split(o).length - before.split(c).length > 0;
    return open('「', '」') || open('“', '”');
}

/** 一段话里的 4 字片段（只算汉字，不跨标点） */
function grams(text: string): Set<string> {
    const set = new Set<string>();
    for (const part of text.split(SPLIT)) {
        const chars = [...part];
        for (let i = 0; i + 4 <= chars.length; i++) {
            const gram = chars.slice(i, i + 4).join('');
            if (/^[一-鿿]{4}$/.test(gram) && !PLAIN_GRAMS.has(gram)) set.add(gram);
        }
    }
    return set;
}

export function inspectSpeech(reply: string, context: SpeechContext): SpeechIssue[] {
    const issues: SpeechIssue[] = [];
    const lines = reply.split('\n');
    const recentOpeners = context.recent.map(r => new Set(r.map(l => opener(l)?.key).filter(Boolean)));
    const recentGrams = context.recent.map(r => grams(r.join('\n')));
    const hisGrams = new Set(context.his.flatMap(m => [...grams(m)]));
    for (const [line, raw] of lines.entries()) {
        const text = raw.trim();
        if (!text) continue;
        for (const [kind, re] of [['service', SERVICE], ['ledger', LEDGER], ['blame', BLAME]] as const) {
            const hit = re.exec(text);
            // 引号里是别人的话（「面试官问『你还有什么想问的』」），不算她说的
            if (hit && !insideQuote(text, hit.index)) issues.push({ line, kind, match: hit[0].trim() });
        }
        const open = opener(text);
        if (open) {
            const count = recentOpeners.filter(s => s.has(open.key)).length;
            if (count >= REPEAT_AT) {
                issues.push({ line, kind: 'repeat', repeat: 'opener', match: open.key, count, ...(open.stripped !== undefined ? { stripped: open.stripped } : {}) });
                continue;
            }
        }
        for (const gram of grams(text)) {
            if (hisGrams.has(gram)) continue;
            const count = recentGrams.filter(s => s.has(gram)).length;
            if (count >= REPEAT_AT) {
                issues.push({ line, kind: 'repeat', repeat: 'phrase', match: gram, count });
                break;
            }
        }
    }
    return issues;
}

const NUMBER_TEXT = '[0-9零〇一二两三四五六七八九十百千万]+';
const BOOK_NUMBER = new RegExp(`(第\\s*)?(${NUMBER_TEXT})\\s*(章|卷)`, 'g');

/** 中文数字（到万）和阿拉伯数字；只给进度规则用。 */
export function parseChineseNumber(text: string): number | undefined {
    if (/^\d+$/.test(text)) return Number(text);
    const digit: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (![...text].some(char => '十百千万'.includes(char))) {
        if (![...text].every(char => char in digit)) return undefined;
        return Number([...text].map(char => digit[char]).join(''));
    }
    const unit: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
    let total = 0;
    let section = 0;
    let number = 0;
    for (const char of text) {
        if (char in digit) {
            number = digit[char]!;
        } else if (char === '万') {
            section += number;
            total += (section || 1) * 10_000;
            section = 0;
            number = 0;
        } else if (char in unit) {
            section += (number || 1) * unit[char]!;
            number = 0;
        } else {
            return undefined;
        }
    }
    return total + section + number;
}

/**
 * 书的进度数字：章差 5% 以上、卷不相同就命中；「集」不看。
 * 「第 300 章往后」是情节节点的门槛，不是她的阅读进度；「第 550 章完结」按总量看。
 */
export function inspectBookProgress(reply: string, context: BookProgressContext): BookProgressIssue[] {
    const issues: BookProgressIssue[] = [];
    const focus = new Set(context.focusIds ?? []);
    for (const [line, text] of reply.split('\n').entries()) {
        BOOK_NUMBER.lastIndex = 0;
        for (const match of text.matchAll(BOOK_NUMBER)) {
            const raw = match[0];
            const said = parseChineseNumber(match[2]!);
            if (said === undefined) continue;
            const before = text.slice(Math.max(0, match.index! - 12), match.index!);
            const after = text.slice(match.index! + raw.length, match.index! + raw.length + 6);
            const total = /(?:一共|总共|全书|共)(?:有)?\s*$/.test(before) || /^(?:完结|全书)/.test(after);
            // 「看到 N 章」「翻了前两卷」是进度；「今天看了五章」是看了多少，不算（每天 5 章正是资料里的进度）
            const progressCue = /(?:(?:看到|读到|追到|翻到)了?|(?:看|读|翻)(?:了|完了?)前|现在|目前|已经)\s*$/.test(before);
            if (!match[1] && !total && !progressCue) continue;
            if (!total && /^(?:往后|以后|开始|起|叫)/.test(after)) continue;
            const unit = match[3]!;
            const byUnit = context.books.filter(item => (total ? item.book.total?.unit : item.progress.unit) === unit && (!total || item.book.total));
            if (!byUnit.length) continue;
            const explicit = byUnit.filter(item => [item.book.title, ...item.book.aliases].some(name => name && text.includes(name)));
            const focused = byUnit.filter(item => focus.has(item.book.id));
            // 「第二章课后题」这类不是书；裸「第 N 章/卷」只有行里点了书名，或最近明确在聊这本书时才算。
            if (match[1] && !total && !progressCue && !explicit.length && !focused.length) continue;
            const candidates = explicit.length ? explicit : focused.length ? focused : byUnit;
            const expectedOf = (item: (typeof candidates)[number]) => total ? item.book.total!.amount : item.progress.amount;
            const candidate = candidates.length === 1 ? candidates[0]! : [...candidates].sort((a, b) => relative(said, expectedOf(a)) - relative(said, expectedOf(b)))[0]!;
            const expected = expectedOf(candidate);
            const wrong = unit === '卷' ? said !== expected : relative(said, expected) >= 0.05;
            if (wrong) issues.push({ line, bookId: candidate.book.id, title: candidate.book.title, raw, said, expected, unit, kind: total ? 'total' : 'progress' });
        }
    }
    return issues;
}

function relative(actual: number, expected: number): number {
    return expected === 0 ? (actual === 0 ? 0 : Infinity) : Math.abs(actual - expected) / expected;
}

/** 从聊天记录取比较用的：她最近几次回复（连着的几条算一次）、对方最近几条 */
export function speechContext(history: readonly StoredMessage[]): SpeechContext {
    const replies: string[][] = [];
    let open = false;
    for (const message of history) {
        if (message.role === 'assistant') {
            if (!open) replies.push([]);
            replies.at(-1)!.push(message.content);
            open = true;
        } else {
            open = false;
        }
    }
    const his = history.filter(m => m.role === 'user').slice(-HIS_MESSAGES).map(m => m.content);
    return { recent: replies.slice(-RECENT_REPLIES), his };
}

/** 日志里的说法（不带行号） */
export function describeSpeechIssue(issue: SpeechIssue): string {
    switch (issue.kind) {
        case 'service': return `助手腔「${issue.match}」`;
        case 'ledger': return `算账「${issue.match}」`;
        case 'blame': return `怪对方没说「${issue.match}」`;
        case 'repeat': return issue.repeat === 'opener' ? `开头「${issue.match}」最近用过 ${issue.count} 次` : `「${issue.match}」最近说过 ${issue.count} 次`;
    }
}

/** 去掉语气词就解决了的重复（不用重写） */
export function strippable(issue: { kind: string; stripped?: string }): boolean {
    return issue.kind === 'repeat' && issue.stripped !== undefined;
}

/** 去掉重复的语气词开头；只剩语气词的那一行删掉，全删光了就原样留着（不因为口癖不回） */
export function stripOpeners(reply: string, issues: readonly { line: number; kind: string; stripped?: string }[]): string {
    const strip = new Map(issues.filter(strippable).map(i => [i.line, i.stripped!]));
    if (strip.size === 0) return reply;
    const lines = reply.split('\n').map((line, i) => strip.get(i) ?? line).filter(line => line.trim());
    return lines.length ? lines.join('\n') : reply;
}
