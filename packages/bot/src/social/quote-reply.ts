// 引用回复（ADR 0136，配置 quoteReply，默认关）：QQ 里长按一条消息「回复」，对方那边这条回复上方带着被引用的那句。
// 她以前一次都没引用过（只会看懂他的引用，onebot.ts 的 segmentsToText）。真人在两种时候引用：
//  1. 他连着发了几条，其中一条是个问题、但不是最后一条——她回答那个问题，引用它，免得对不上号；
//  2. 打错字撤回失败（超过两分钟），补「*对的词」时引用刚才那条错的。
// 其余时候不引用：他自己 654 条消息里引用过 1 次（0.15%），所以只在这两种明确的时候、按概率引，不是每次都引。
// 纯函数，随机的部分按消息 id 定，同一串消息重算多少次都一样（responder 会在新消息来时重算）。

import { RECALLED_TEXT, type StoredMessage } from '../memory/history.ts';
import { pick, unansweredMessages } from './reply-timing.ts';

/**
 * 明确是在问：带问号，或者句尾是「吗 / 么」，或者带疑问词又以「呢 / 吗 / 啊」收尾。比 intent.ts 的 QUESTION 严——那条的「哪」「几」「什么」
 * 会把“我在想去哪玩”这种陈述也算问句，拿它挑引用会引错；引用宁可漏掉，不要引错
 */
const CLEAR_QUESTION = /[?？]|(?:吗|(?<![什怎这那多])么)[~～。.!！\s]*$|(?:什么|怎么|为什么|为啥|几点|哪|多少|谁).{0,12}(?:呢|吗|啊)[~～!！\s]*$/;
export function clearQuestion(text: string): boolean {
    return CLEAR_QUESTION.test(text.trim());
}

/** 他连发里有个不是最后一条的问题时，引用它的概率 */
export const QUOTE_SHARE = 0.6;
/** 撤回失败、补「*对的词」时引用那条错的概率 */
export const QUOTE_FIX_SHARE = 0.35;
/** 被引用的那句：太短（「在吗」「？」）引用起来像多余，太长引用卡片占半屏 */
export const QUOTE_MIN_CHARS = 4;
export const QUOTE_MAX_CHARS = 60;
/** 手机端的消息 id 是 32 位以内的整数；戳一戳、B 站私信这类合成的记录 id 在这之上，引用它们 QQ 会报错 */
const REAL_MESSAGE_ID_LIMIT = 2 ** 32;

export interface QuotePlan {
    /** 要引用的那条（他的）QQ 消息 id */
    messageId: number;
    /** 那句话的文字（给提示词用：让她第一条先回它） */
    text: string;
}

/** 这条能不能被引用：真的 QQ 消息、不是他撤回的、不是自己就带引用的、不是图片 / 语音 / 表情包的占位符、长度合适 */
function quotable(message: StoredMessage): boolean {
    if (message.role !== 'user' || message.messageId === undefined) return false;
    if (message.messageId <= 0 || message.messageId >= REAL_MESSAGE_ID_LIMIT) return false;
    const text = message.content.trim();
    if (text === RECALLED_TEXT || text.startsWith('[')) return false;
    const length = [...text].length;
    return length >= QUOTE_MIN_CHARS && length <= QUOTE_MAX_CHARS;
}

/**
 * 这一轮要不要引用他的某一句：他还没回的那一串里至少两条、有一条不是最后一条的问题，按概率引用其中最晚的那个问题。
 * 没有就返回 undefined（绝大多数轮次）。history 是带消息 id 的聊天记录（responder 里的 StoredMessage）
 */
export function planQuote(history: readonly StoredMessage[], userId: number, share = QUOTE_SHARE): QuotePlan | undefined {
    const pending = unansweredMessages([...history]);
    if (pending.length < 2) return undefined;
    const question = pending.slice(0, -1).findLast(message => quotable(message) && clearQuestion(message.content));
    if (!question) return undefined;
    if (pick(`${userId} ${question.messageId}`, 'quote', [0, 999]) >= share * 1000) return undefined;
    return { messageId: question.messageId!, text: question.content.trim() };
}

/** 撤回失败、补「*对的词」时要不要引用那条错的（按那条错的消息 id 定） */
export function quoteFix(userId: number, wrongId: number, share = QUOTE_FIX_SHARE): boolean {
    return pick(`${userId} ${wrongId}`, 'quote-fix', [0, 999]) < share * 1000;
}

/** 提示词里的一行：这一轮第一条是引用他那句回的，先回那一句 */
export function describeQuote(plan: QuotePlan): string {
    const text = [...plan.text].length > 30 ? `${[...plan.text].slice(0, 30).join('')}…` : plan.text;
    return `[你这一轮的第一条是在 QQ 里引用他那句「${text}」回的：第一条先直接回它，再顺着回他后面说的；第一条里别再把那句话复述一遍]`;
}
