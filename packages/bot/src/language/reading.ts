// 「他这句到底在说什么」（2026-10-30，用户：她现在不能理解我说话的意思）。
// 不调模型，只做三件事，然后把结论递给她，让她先想清楚再回：
//   1. 他连着发的几条算一句话（线上 bug：「我长相一般」+「的」，她只回了最后那个「的」）
//   2. 他这句里的指代（这个 / 那个 / 上面 / 刚才 / 那我呢）——把最近的候选摆出来
//   3. 他这句是不是接着上一条说的（很短、没有主语、末尾是「的/了/吧」这类）
import type { StoredMessage } from '../memory/history.ts';

type Said = Pick<StoredMessage, 'role' | 'content'> & { time?: string };

/** 连着发的几条合成一句：同一分钟内、或者上一条明显没说完 */
export const JOIN_MS = 90_000;

const CONTINUES = /[，,、…—\-]$|的$|了$|吧$|呢$|啊$|是$|和$|跟$|在$/;
const DEICTIC = /这个|那个|上面|刚才|刚刚|前面|那我呢|你说的|你说的那个|这|那/;

export interface ReadTurn {
    /** 他这一轮连着发的合并成一句 */
    said: string;
    /** 被合并进来的条数（>1 说明他分了几条发） */
    parts: number;
    /** 这句里的指代词（有就把最近的候选递给她） */
    referent?: string[];
    /** 很短、又没有主语的补充句 */
    continuation: boolean;
    /** 他之前已经答过这些话题了（她别再重复确认） */
    answered?: string[];
}

/** 把最近几条「他说的」按时间合成一轮 */
export function readTurn(history: readonly Said[], now?: number): ReadTurn | undefined {
    const his = history.map((message, index) => ({ message, index })).filter(item => item.message.role === 'user');
    if (!his.length) return undefined;
    const lastIndex = his[his.length - 1]!.index;
    // 从最后一条往前收：同一轮（上面还有她的话就停）里连着发的
    const group: Said[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i]!;
        if (message.role !== 'user') break;
        if (group.length && !sameTurn(group[group.length - 1]!, message)) break;
        group.unshift(message);
    }
    const said = group.map(message => message.content.trim()).filter(Boolean).join('');
    if (!said) return undefined;
    const referent = DEICTIC.test(said) ? recentTopics(history, lastIndex) : undefined;
    // 只在他「上一轮之前」的话里找答案：这一轮还在说的事不算已经答过
    const groupStart = history.length - group.length;
    const answered = referent?.filter(topic => answeredTopic(history, topic, -1, groupStart));
    return {
        said,
        parts: group.length,
        ...(referent?.length ? { referent } : {}),
        continuation: group.length === 1 && [...said].length <= 4 && CONTINUES.test(said) === false ? true : group.length > 1,
        ...(answered?.length ? { answered } : {}),
    };
}

/** 两条他说的算不算同一轮：隔得近，或者上一条明显没说完 */
function sameTurn(previous: Said, next: Said): boolean {
    const a = Date.parse(previous.time ?? '');
    const b = Date.parse(next.time ?? '');
    const close = Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) <= JOIN_MS;
    return close || CONTINUES.test(previous.content.trim());
}

/** 最近的候选话题：他前几条里像「一件具体的事」的短句（去掉寒暄和单字） */
export function recentTopics(history: readonly Said[], beforeIndex: number): string[] {
    const topics: string[] = [];
    for (let i = beforeIndex - 1; i >= 0 && topics.length < 3; i--) {
        const message = history[i]!;
        if (message.role !== 'user') continue;
        const text = message.content.trim();
        if ([...text].length < 3 || [...text].length > 40) continue;
        if (/^(在吗|在不在|嗯|好|行|哈哈|睡了|晚安)/.test(text)) continue;
        topics.push(text);
    }
    return topics.reverse();
}

/** 递给她的一行：先说清他说的是什么，再回 */
export function readingLine(turn: ReadTurn | undefined): string | undefined {
    if (!turn) return undefined;
    const pieces = [`他这一轮说的是：「${turn.said.slice(0, 120)}」`];
    if (turn.parts > 1) pieces.push(`（他分 ${turn.parts} 条发的，按一句看，别只盯最后那几个字）`);
    if (turn.referent?.length) pieces.push(`他说的「这个/那个」可能指：${turn.referent.map(t => `「${t.slice(0, 20)}」`).join('、')}`);
    if (turn.answered?.length) pieces.push(`「${turn.answered[0]!.slice(0, 20)}」他前面已经答过了，别再问是不是/有没有`);
    if (!turn.referent?.length) {
        pieces.push('把这一轮当成完整一句来理解，直接回应他已经说清的部分；别为了保险反问「你指哪件」，也别只接最后半句');
    } else if (turn.referent.length === 1) {
        pieces.push('结合上面的唯一候选理解，能确定就直接回；只有仍有两种以上合理解释时才简短确认，同时先回应已经说清的部分，别把整轮只回成反问');
    } else {
        pieces.push('先按上下文判断最可能的指向；只有确实无法区分这些候选时才简短确认，同时先回应已经说清的部分，别把整轮只回成反问');
    }
    return `[${pieces.join('；')}]`;
}

/**
 * 他是不是已经答过这件事了（2026-10-31：免费线路诊断出她常重复确认——
 * 例：他早说过「撤回两条」，她还在问「又想不认账了」）。
 * 只看他后续的陈述句里有没有和这个话题重叠的信息；纯疑问/寒暄不算答过。
 * ponytail: 2 字滑窗重叠，够用但会误判同义词；真出问题再上语义匹配。
 */
export function answeredTopic(history: readonly Said[], topic: string, fromIndex = -1, untilIndex = history.length): boolean {
    const clean = (text: string) => text.replace(/[\s，。！？、,.!?~～…「」『』"']/g, '');
    const target = clean(topic);
    if ([...target].length < 2) return false;
    const grams = new Set<string>();
    for (let i = 0; i + 1 < [...target].length; i++) grams.add([...target].slice(i, i + 2).join(''));
    for (let i = fromIndex + 1; i < untilIndex; i++) {
        const message = history[i]!;
        if (message.role !== 'user') continue;
        const said = String(message.content ?? '').trim();
        if ([...said].length < 5) continue;
        if (/[？?]$/.test(said)) continue; // 他自己在问，不算答过
        const body = clean(said);
        let hits = 0;
        for (let j = 0; j + 1 < [...body].length; j++) if (grams.has([...body].slice(j, j + 2).join(''))) hits++;
        if (hits >= 2) return true;
    }
    return false;
}
