// 说话的毛病（ADR 0014 决策 2、3）：出口检查里和做不到的事、禁用词一起查（exit-check.ts），按行。
// - 助手腔：客服式的收尾和套话、分点列条理。
// - 算账：说对方找她找得晚、隔了很久才来。前面是「我」的不算（「我这会儿才翻到」）。
// - 怪他没说：怪对方没告诉她、没带上她（10-05 取证里全是状态行「他回青岛了」引出来的）。
// - 对照的酸话（ADR 0019 决策 4，算账的一种）：拿他和自己比着说委屈（「你在家吃大餐，我在这边啃食堂」）。同一行里他那头（享福、在家、玩）
//   和她这头（一个人、留守、啃食堂）都有才算，几个自带委屈的说法单独就算；他那头是问句的不算（「你那边下雨了吗，我这儿……」）。
//   误报评估见 docs/research/2026-10-06-dsh/contrast-eval.md（F 组：模拟器原文 6,511 行命中 15 行，0 误报）。
// - 重复：和她最近 8 次回复比。开头的短句已经用过 2 次，或者 4 个字的片段已经说过 2 次（对方最近 3 条说过的话题词不算）。
//   开头是「行」「哟」这类语气词的，直接去掉，不重写。
// - 叮嘱重复（10-09）：同一段聊天（隔 45 分钟以上算新的一段）里已经叮嘱过他早点睡 / 吃饭 / 穿衣，这句又叮嘱同一类；他最近一句自己提到这件事的不算。

import type { StoredMessage } from '../memory/history.ts';
import { EPISODE_GAP_MS } from '.././memory/episodes.ts';
import type { BookProgress, ReadingBook } from '../life/her-days.ts';
import { hasTail, tailParticle, TAIL_PARTICLES } from './rough-edges.ts';

export type SpeechKind = 'service' | 'ledger' | 'blame' | 'contrast' | 'repeat' | 'nag' | 'tail';

export interface SpeechIssue {
    /** 回复里的第几行（从 0 开始，按 \n 分） */
    line: number;
    kind: SpeechKind;
    /** 命中的片段；重复时是那个开头或片段 */
    match: string;
    /** 重复的是开头、片段，还是原话（最近说过的整句又说一遍） */
    repeat?: 'opener' | 'phrase' | 'verbatim';
    /** 重复：最近几次回复里用过几次 */
    count?: number;
    /** 重复的开头是语气词：去掉它之后的这一行（只剩语气词时是空串） */
    stripped?: string;
    /** 叮嘱重复：叮嘱的是哪一类 */
    nag?: NagKind;
}

/** 和哪些话比：她最近几次回复（旧到新，每次是发出去的几行），对方最近几条 */
export interface SpeechContext {
    recent: readonly (readonly string[])[];
    his: readonly string[];
    /** 这一段聊天里她已经说过的话（隔 45 分钟以上算新的一段）；不传就不查叮嘱重复 */
    segment?: readonly string[];
    /** 小别扭这一轮（ADR 0074）：「隔了很多天才来」「也不说一声」这类带点抱怨的话是这一轮想要的，不按算账 / 怪他没说拦 */
    allowGrievance?: boolean;
    /** 这句话本来就是一个固定的习惯说法（B 站私信之后叫他去看，ADR 0089）：最近说过一模一样的不算复读，不查重复（开头、原话、四字片段） */
    allowRepeat?: boolean;
    /** 句尾语气字封顶（ADR 0146，配置 tailCap）：哪个字、她最近的气泡里以它收尾的占比不超过多少；没列的字不管；不传就不查 */
    tailCaps?: Readonly<Record<string, number>>;
    /** 封顶用的：她最近 TAIL_WINDOW 条文字气泡里，一共几条、各个语气字各收尾了几条 */
    tailRecent?: { bubbles: number; counts: Readonly<Record<string, number>> };
}

/**
 * 按字封顶（ADR 0146，实验 C 的测量，条数口径，10-05 起）：她多出来的尾巴几乎全在「吧」和「呢」上——
 * 吧：她 5.0%（10-19 起）/ 4.9%（之前），他 2.2%，真人女生 1.6%，真人男生 0.6%；呢：她 5.0% / 4.5%，他 1.8%，女生 0.5%，男生 0%。
 * 啊（她 6.1% / 2.9%，他 4.9%，女生 2.6%，男生 4.6%）在真人范围内，嘛 / 呀 / 啦 她反而偏少，所以不封。
 * 封在他本人水平略放宽一点：吧 3%、呢 2.5%（窗口 80 条里最多各挂 2 次）。
 */
export const TAIL_CAPS: Readonly<Record<string, number>> = { 吧: 0.03, 呢: 0.025 };
/** 看她最近多少条文字气泡来算占比（她一天大约 20 条，80 条约四天） */
export const TAIL_WINDOW = 80;

/** 去掉了会变成另一个意思或不成词的固定搭配（干嘛、网吧、好吧、行吧……）；这些里的「吧 / 嘛」不是挂上去的尾巴 */
const TAIL_PROTECTED = /(?:干嘛|网吧|酒吧|贴吧|吧台|(?:好|行|算了|拉倒|得了|走|来|是|对|不是|别|随便|可以|成|也行|就这样|那就这样)吧)$/;
/** 「你呢」「然后呢」这类省略问句里的「呢」是疑问本身，不能去 */
const TAIL_ELLIPTIC = /^(?:你|我|他|她|那|这|然后|所以|那你|那他|那我)(?:们)?呢$/;
/** 太短的（好啊、在呢、是啊）是应声，去掉就只剩一个字，不动 */
const TAIL_MIN_CHARS = 5;
const TAIL_FACE = /\[[^\]]{1,6}\]/g;
const TAIL_TRAILING = /[\s。！!？?，,、～~…\.]+$/u;
const NON_TEXT_ROW = /^\[(?:图片表情|表情包|sticker|图片|B 站私信)|^<(?:sticker|photo)|^她发了(?:个表情包|张照片)|^https?:\/\//;

/** 这一行句尾那个语气字去掉之后的样子；不是该去的（没挂尾巴 / 固定搭配 / 太短）返回 undefined。标点、拖音、表情记号原样留着 */
export function stripTailParticle(line: string): string | undefined {
    if (!hasTail(line)) return undefined;
    // 从尾巴往前跳过标点、拖音和表情记号，找到那个语气字的位置
    let end = line.length;
    for (;;) {
        const before = end;
        const face = /\[[^\]]{1,6}\]$/.exec(line.slice(0, end));
        if (face) end -= face[0].length;
        const trailing = TAIL_TRAILING.exec(line.slice(0, end));
        if (trailing) end -= trailing[0].length;
        if (end === before) break;
    }
    const at = end - 1;
    if (at < 0 || !TAIL_PARTICLES.includes(line[at]!)) return undefined;
    const body = line.slice(0, end).replace(TAIL_FACE, '');
    if ([...body].length < TAIL_MIN_CHARS || TAIL_PROTECTED.test(body) || TAIL_ELLIPTIC.test(body)) return undefined;
    return `${line.slice(0, at)}${line.slice(at + 1)}`;
}

/** 她最近 TAIL_WINDOW 条文字气泡里，一共几条、各个语气字各收尾了几条 */
export function tailRecentOf(history: readonly StoredMessage[]): { bubbles: number; counts: Record<string, number> } {
    const mine = history.filter(m => m.role === 'assistant' && !NON_TEXT_ROW.test(m.content.trim()) && m.content.trim()).slice(-TAIL_WINDOW);
    const counts: Record<string, number> = {};
    for (const m of mine) {
        const particle = tailParticle(m.content.trim());
        if (particle) counts[particle] = (counts[particle] ?? 0) + 1;
    }
    return { bubbles: mine.length, counts };
}

export type NagKind = 'sleep' | 'eat' | 'warm';

/** 叮嘱的几类说法（她的性格是爱念叨，一段聊天里念叨一次是她，念叨两次就是复读机） */
const NAGS: Record<NagKind, { said: RegExp; his: RegExp }> = {
    // 「别弄太晚」「别又搞到后半夜」也是（10-09 nag-once 模拟：第一句是这种说法，没认出来，第二句「弄完早点睡」就没拦住）
    sleep: {
        said: /早点睡|早些睡|早睡|早点休息|别熬|少熬|熬太晚|快去睡|赶紧睡|去睡吧|快睡吧|别太晚|别(?:又)?(?:弄|搞|写|玩|拖|熬)(?:到|得)?(?:太晚|那么晚|后半夜|半夜|一两点|两三点|三四点|凌晨)/,
        his: /睡|熬|通宵|困|晚安/,
    },
    eat: { said: /记得吃|按时吃|好好吃饭|别饿着|吃早饭|吃点东西|先吃饭/, his: /吃|饿|饭/ },
    warm: { said: /多穿|别着凉|多喝点?热?水|注意保暖/, his: /冷|凉|感冒|降温|风大/ },
};

/** 这一行又叮嘱了这段聊天里已经叮嘱过的那一类？他最近一句自己提到这件事（「今晚不睡了」「好饿」）的不算 */
function nagRepeat(text: string, context: SpeechContext): { kind: NagKind; match: string } | undefined {
    if (!context.segment?.length) return undefined;
    const latestHis = context.his.at(-1) ?? '';
    for (const [kind, { said, his }] of Object.entries(NAGS) as [NagKind, typeof NAGS[NagKind]][]) {
        const hit = said.exec(text);
        if (!hit || his.test(latestHis)) continue;
        if (context.segment.some(line => said.test(line))) return { kind, match: hit[0] };
    }
    return undefined;
}

/** 这一段聊天里她说过的话：从最后一条往回，隔了 EPISODE_GAP_MS 以上就停（和记忆切片段同一个数） */
function segmentReplies(history: readonly StoredMessage[]): string[] {
    let start = history.length;
    while (start > 0) {
        const here = Date.parse(history[start - 1]!.time);
        const before = start > 1 ? Date.parse(history[start - 2]!.time) : NaN;
        start--;
        if (!Number.isNaN(here) && !Number.isNaN(before) && here - before >= EPISODE_GAP_MS) break;
    }
    return history.slice(start).filter(m => m.role === 'assistant').map(m => m.content);
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
/** 用过几次算重复（这次是第三次）；出口检查用这个，模拟器评估时可以传别的（inspectSpeech 的 repeatAt） */
export const REPEAT_AT = 2;

/** 很短的情绪话（想你、抱抱、晚安……）：2026-10-30 她说「情侣之间说两遍『想你』怎么了」，这类不按重复处理 */
const SHORT_FEEL = /想你|想我|爱你|喜欢|抱|亲|在呢|晚安|早安|早|嗯|哈哈|好嘛|不要|别嘛/;

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

/** 「你」开头的这一小句不是问句 */
const NOT_QUESTION = '(?![^，,。！？!?]*(?:吗|呢|么|[?？]))';
/** 对照的酸话（F 组）：反话的「你倒是…」、自带委屈的说法单独就算 */
const CONTRAST_ALONE = new RegExp([
    '你倒是(?:回(?:家|去|青岛|老家)|玩|在家|舒服|潇洒|爽|开心|过得|自在)',
    '没(?:带|算|给|留)我(?:的)?(?:份儿?|一份)',
    '(?:啃|吃)(?:食堂)?剩(?:菜|饭)',
    '喝西北风',
    `咱俩${CLAUSE}{0,8}(?:不一样|天差地别)`,
].join('|'));
/** 说他舒服（反话）：和她这头的强、弱说法都能配 */
const HIS_EASE = new RegExp(`你${NOT_QUESTION}${CLAUSE}{0,8}(?:舒服|舒坦|爽|潇洒|逍遥|滋润|快活)`);
/** 他那头（在家、回去、玩）：只和她这头的强说法配 */
const HIS_SIDE = new RegExp(`你${NOT_QUESTION}${CLAUSE}{0,8}(?:回家|在家|家里|回青岛|那边|那头|那儿|玩|爬山|海边|吃香的|大餐|开心|乐呵|舒服|舒坦|爽|潇洒)`);
/** 她这头，自带委屈 */
const MY_SIDE_STRONG = /留我一个人|就剩我一个|就我一个人?|我一个人(?:在|蹲|守|留|待)|留守|啃食堂|发霉|苦哈哈/;
/** 她这头，只是地点 */
const MY_SIDE_WEAK = /我(?:在)?(?:这边|这头|这儿|这里)/;

/** 这一行的对照酸话：命中的那一段（他那头），没有返回 null */
export function contrastHit(text: string): RegExpExecArray | null {
    const alone = CONTRAST_ALONE.exec(text);
    if (alone) return alone;
    const strong = MY_SIDE_STRONG.exec(text);
    const ease = HIS_EASE.exec(text);
    if (ease && (strong ?? MY_SIDE_WEAK.exec(text))) return ease;
    const side = HIS_SIDE.exec(text);
    if (side && strong) return side;
    return null;
}

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

/**
 * 口头禅：几种说法算同一个开头，去掉它后面的话照发。每个单算都没到重复的门槛，合起来是一个腔调翻来覆去（10-10 线上）：
 * - 夸他「行」：两分钟里连着「行啊你」「行啊你」「你可真行」「真有你的」开头
 * - 回绝他要亲要抱：四分钟里「想得美」「你想得美」「想得美」，后来又「你做梦呢」「你想得美」
 */
const TICS = [
    { pattern: new RegExp(`^(?:行啊你|可以啊你|你可真行|真有你的|你行啊|厉害了你|你真行)[啊呀]?[${PUNCT}]*`), key: '行啊你 / 你可真行 / 真有你的 这类' },
    { pattern: new RegExp(`^(?:你想得美|想得美|你想的美|想的美|美得你|你做梦呢|做梦呢|你做梦吧|做梦吧)[啊呀吧]?[${PUNCT}]*`), key: '想得美 / 做梦呢 这类' },
];

/** 原话重复：6 个字以上（不算标点）的小句和她最近几次回复里的一模一样（10-10 11:48 线上：他回了个表情，她把上一条「我舍友出门了，柜子里就剩半包饼干，中午不想吃这个」整句又说了一遍） */
const VERBATIM_MIN = 6;
const plain = (text: string) => text.replace(/[\p{P}\p{S}\s]/gu, '');

/** 这一行里最近原样说过的小句（他最近说过的不算：那是在接他的话），和去掉它们后剩下的话（可能是空串） */
function verbatim(text: string, said: string, his: string): { match: string; stripped: string } | undefined {
    const pieces = text.split(new RegExp(`([${PUNCT}]+)`));
    const repeated: string[] = [];
    let rest = '';
    for (let i = 0; i < pieces.length; i += 2) {
        const clause = pieces[i]!.trim();
        const core = plain(clause);
        if (core.length >= VERBATIM_MIN && said.includes(core) && !his.includes(core)) repeated.push(clause);
        else if (clause) rest += clause + (pieces[i + 1] ?? '');
    }
    if (!repeated.length) return undefined;
    return { match: repeated.join('，'), stripped: rest.replace(new RegExp(`^[${PUNCT}]+|[，,、：:；;\\s]+$`, 'g'), '') };
}

/** 这一行的开头：语气词（按一种算）、口头禅（每一类按一种算），或者第一个短句（3 个字以内、不是整行）；都不是就没有 */
export function opener(line: string): { key: string; stripped?: string } | undefined {
    const text = line.trim();
    for (const tic of TICS) {
        const hit = tic.pattern.exec(text);
        if (hit) return { key: tic.key, stripped: text.slice(hit[0].length).trim() };
    }
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

export function inspectSpeech(reply: string, context: SpeechContext, { repeatAt = REPEAT_AT }: { repeatAt?: number } = {}): SpeechIssue[] {
    const issues: SpeechIssue[] = [];
    const lines = reply.split('\n');
    const recentOpeners = context.recent.map(r => new Set(r.map(l => opener(l)?.key).filter(Boolean)));
    const recentGrams = context.recent.map(r => grams(r.join('\n')));
    const hisGrams = new Set(context.his.flatMap(m => [...grams(m)]));
    const said = context.recent.map(r => plain(r.join(''))).join('|');
    const his = context.his.map(plain).join('|');
    for (const [line, raw] of lines.entries()) {
        const text = raw.trim();
        if (!text) continue;
        // 10-30 用户：算账、怪他没说、对照的酸话不再拦——她可以怪他、可以翻旧账（对他的特殊滤镜去掉）。
        // 只剩助手腔这一类：那是「不像真人」，不是「对他太好」。
        for (const [kind, find] of [['service', (t: string) => SERVICE.exec(t)]] as const) {
            const hit = find(text);
            // 引号里是别人的话（「面试官问『你还有什么想问的』」），不算她说的
            if (hit && !insideQuote(text, hit.index)) issues.push({ line, kind, match: hit[0].trim() });
        }
        const nag = nagRepeat(text, context);
        if (nag) {
            issues.push({ line, kind: 'nag', match: nag.match, nag: nag.kind });
            continue;
        }
        if (context.allowRepeat) continue;
        // 很短的撒娇 / 情绪话，重复也不重写（她 10-30 的原话：说两遍想你没什么）
        if ([...text].length <= 6 && SHORT_FEEL.test(text)) continue;
        const again = verbatim(text, said, his);
        if (again) {
            issues.push({ line, kind: 'repeat', repeat: 'verbatim', match: again.match, count: 1, stripped: again.stripped });
            continue;
        }
        const open = opener(text);
        if (open) {
            const count = recentOpeners.filter(s => s.has(open.key)).length;
            if (count >= repeatAt) {
                issues.push({ line, kind: 'repeat', repeat: 'opener', match: open.key, count, ...(open.stripped !== undefined ? { stripped: open.stripped } : {}) });
                continue;
            }
        }
        for (const gram of grams(text)) {
            if (hisGrams.has(gram)) continue;
            const count = recentGrams.filter(s => s.has(gram)).length;
            if (count >= repeatAt) {
                issues.push({ line, kind: 'repeat', repeat: 'phrase', match: gram, count });
                break;
            }
        }
    }
    // 整条都是原话：去不掉，带说明重写
    const whole = issues.filter(i => i.repeat === 'verbatim' && i.stripped === '');
    if (whole.length && whole.length === lines.filter(l => l.trim()).length) for (const issue of whole) delete issue.stripped;
    // 句尾语气字按字封顶（ADR 0146）：某个字（吧 / 呢）最近以它收尾的占比已经到了真人的水平，这一轮再用它收尾的就把那个字去掉（不重写）。
    // 已经有别的问题的行不动（去开头 / 重写之后下一轮会重新查）；从前往后数，前面的行占了名额后面的才会被去
    if (context.tailCaps && context.tailRecent) {
        let bubbles = context.tailRecent.bubbles;
        const counts: Record<string, number> = { ...context.tailRecent.counts };
        for (const [line, raw] of lines.entries()) {
            if (!raw.trim() || NON_TEXT_ROW.test(raw.trim())) continue;
            bubbles++;
            const particle = tailParticle(raw.trim());
            if (!particle) continue;
            const cap = context.tailCaps[particle];
            const used = counts[particle] ?? 0;
            const stripped = cap === undefined || issues.some(i => i.line === line) ? undefined : stripTailParticle(raw);
            if (cap !== undefined && stripped !== undefined && (used + 1) / bubbles > cap) {
                issues.push({ line, kind: 'tail', match: particle, count: used, stripped });
                continue;
            }
            counts[particle] = used + 1;
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
export function speechContext(history: readonly StoredMessage[], options: { tailCaps?: Readonly<Record<string, number>> } = {}): SpeechContext {
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
    return {
        recent: replies.slice(-RECENT_REPLIES), his, segment: segmentReplies(history),
        ...(options.tailCaps ? { tailCaps: options.tailCaps, tailRecent: tailRecentOf(history) } : {}),
    };
}

/** 日志里的说法（不带行号） */
export function describeSpeechIssue(issue: SpeechIssue): string {
    switch (issue.kind) {
        case 'service': return `助手腔「${issue.match}」`;
        case 'ledger': return `算账「${issue.match}」`;
        case 'blame': return `怪对方没说「${issue.match}」`;
        case 'contrast': return `对照的酸话「${issue.match}」`;
        case 'repeat': return issue.repeat === 'opener' ? `开头「${issue.match}」最近用过 ${issue.count} 次`
            : issue.repeat === 'verbatim' ? `「${issue.match}」最近说过原话` : `「${issue.match}」最近说过 ${issue.count} 次`;
        case 'nag': return `又叮嘱「${issue.match}」（这段已经叮嘱过）`;
        case 'tail': return `句尾「${issue.match}」（最近 ${TAIL_WINDOW} 条里已经有 ${issue.count} 条以它收尾，压回真人的水平）`;
    }
}

/** 去掉语气词就解决了的重复、句尾语气字超出封顶（不用重写） */
export function strippable(issue: { kind: string; stripped?: string }): boolean {
    return (issue.kind === 'repeat' || issue.kind === 'tail') && issue.stripped !== undefined;
}

/** 去掉重复的语气词开头、口头禅、原样说过的小句；只剩这些的那一行删掉，全删光了就原样留着（不因为口癖不回） */
export function stripOpeners(reply: string, issues: readonly { line: number; kind: string; stripped?: string }[]): string {
    const strip = new Map(issues.filter(strippable).map(i => [i.line, i.stripped!]));
    if (strip.size === 0) return reply;
    const lines = reply.split('\n').map((line, i) => strip.get(i) ?? line).filter(line => line.trim());
    return lines.length ? lines.join('\n') : reply;
}
