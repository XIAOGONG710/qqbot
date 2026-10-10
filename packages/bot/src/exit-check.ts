// 出口检查（ADR 0006 决策 3）：清理之后、拆条发送之前，查做不到的事和低档位禁用词。
// 命中就在提示词末尾加一句说明，意思不变重写一次；重写的结果仍命中的行删掉。重写失败就用第一版、删掉命中的行。
// 括号里的动作不在这里：卡上的 ST 正则在清理时就删了（st/regex.ts，决策 2）。
// 说话的毛病（ADR 0014，传了 speech 才查，规则在 speech-check.ts）：助手腔、算账、怪对方没说一起重写；
// 重写后还在的删掉那一行（删完一行不剩就照发）。重复的语气词开头直接去掉、不重写；别的重复重写一次，还重复就照发。
// 书的进度数字（ADR 0015，这一轮放了「在读的书」才传 books）：说的第几卷 / 章、一共几章和资料对不上，重写一次，还不对就照发。
// 编出一整段聊天（ADR 0033 模拟器里见到）：回复里出现提示词的结构（「[Start a new Chat]」、行首「[当前时间」「[你现在」……），是在替两个人写对话；
// 重写一次，还在就从那一行起全删。
// QQ 小黄脸（ADR 0051）：白名单外的方括号、一次回复里 3 个以上（只留第一个）、她最近 6 次回复里已经带了 2 次（不熟的档位 1 次）这次又带，直接去掉、不重写；
// 白名单外的去掉之后什么都不剩，或者他在认真说事她整条只回了表情，重写一次（白名单外的还在就删那一行，只回表情的照发）。
// 照抄他发来的语音、图片在聊天记录里的写法（ADR 0052，行首「[语音」「[图片」）：重写一次，还在就删掉那一行。
// （单独的「[图片]」「[语音]」先被小黄脸那步当白名单外的方括号去掉；带秒数、带字的那种由这一条拦。）

import type { Tier } from './config.ts';
import type { StoredMessage } from './history.ts';
import { facesIn, normalizeFaces, onlyFaces, removeFaces } from './qq-faces.ts';
import { isAck, isReaction } from './reply-timing.ts';
import {
    describeSpeechIssue, inspectBookProgress, inspectSpeech, speechContext, stripOpeners, strippable,
    type BookProgressContext, type NagKind, type SpeechContext, type SpeechIssue,
} from './speech-check.ts';

/** 叮嘱重复时重写说明里的说法 */
const NAG_TOPIC: Record<NagKind, string> = { sleep: '早点睡', eat: '吃饭', warm: '穿衣喝水' };

export interface ExitIssue {
    /** 回复里的第几行（从 0 开始，按 \n 分） */
    line: number;
    kind: 'promise' | 'banned' | 'script' | 'media' | SpeechIssue['kind'] | 'progress' | 'face';
    /** 命中的片段 */
    match: string;
    /** 说话的毛病里的重复（speech-check.ts） */
    repeat?: SpeechIssue['repeat'];
    count?: number;
    stripped?: string;
    /** 叮嘱重复（speech-check.ts）：叮嘱的是哪一类 */
    nag?: SpeechIssue['nag'];
    /** 进度数字：哪本书、资料里是多少 */
    book?: { title: string; expected: number; unit: string; total: boolean };
    /** 小黄脸：QQ 里没有的表情（unknown），他在认真说事她只回了表情（only） */
    face?: 'unknown' | 'only';
}

/** 一次回复里最多几个小黄脸，再多只留第一个（ADR 0051） */
export const MAX_FACES = 2;
/**
 * 她最近 FACE_WINDOW 次回复里已经有几次带了小黄脸，这次就不带：男朋友、闺蜜、女生朋友 FACE_WINDOW_MAX 次（连着三次都带也就不会有了），
 * 别的档位 FACE_WINDOW_MAX_DISTANT 次（卡上也是对不熟的人更少）
 */
export const FACE_WINDOW = 6;
export const FACE_WINDOW_MAX = 2;
export const FACE_WINDOW_MAX_DISTANT = 1;
const CLOSE_TIERS: readonly Tier[] = ['boyfriend', 'bestie', 'girl_friend'];

/** 查小黄脸用的上下文（ADR 0051） */
export interface FaceContext {
    /** 她最近 FACE_WINDOW 次回复（旧到新，连着的几条算一次） */
    recent: readonly string[];
    /** 最近 FACE_WINDOW 次里已经带了这么多次，这次就不带；不写按 FACE_WINDOW_MAX */
    windowMax?: number;
    /** 她上次回复之后他发的里面有认真说事的（不只是「哈哈」「嗯」「晚安」、表情这类反应和附和）；主动找他时一般没有 */
    serious: boolean;
}

export function faceContext(history: readonly StoredMessage[], tier?: Tier): FaceContext {
    const lastReply = history.findLastIndex(m => m.role === 'assistant');
    const his = history.slice(lastReply + 1).filter(m => m.role === 'user');
    return {
        recent: speechContext(history).recent.slice(-FACE_WINDOW).map(reply => reply.join('\n')),
        windowMax: !tier || CLOSE_TIERS.includes(tier) ? FACE_WINDOW_MAX : FACE_WINDOW_MAX_DISTANT,
        serious: his.some(m => !isReaction(m.content) && !isAck(m.content)),
    };
}

/**
 * 小黄脸直接去掉的几种（不重写）：白名单外的方括号（去完什么都不剩就留着，交给重写）；一次回复里超过 MAX_FACES 个只留第一个；
 * 她最近 FACE_WINDOW 次回复里已经有 windowMax 次带了，这次的去掉（整条只有表情的不去）。白名单的名字统一成正式写法（「[ok]」「【捂脸】」）。
 * notes 是日志里的说法
 */
export function tidyFaces(reply: string, faces?: FaceContext): { reply: string; notes: string[] } {
    const notes: string[] = [];
    let text = normalizeFaces(reply);
    const { unknown } = facesIn(text);
    if (unknown.length) {
        const kept = removeFaces(text, face => face === undefined);
        if (kept.replace(/[\p{P}\p{S}\s～~]/gu, '')) {
            text = kept;
            notes.push(`QQ 里没有的表情「${[...new Set(unknown)].join('')}」`);
        }
    }
    const count = facesIn(text).sendable.length;
    if (count > MAX_FACES) {
        let seen = 0;
        text = removeFaces(text, face => face !== undefined && seen++ > 0);
        notes.push(`一次回复里 ${count} 个小黄脸，只留第一个`);
    }
    const used = faces ? faces.recent.slice(-FACE_WINDOW).filter(r => facesIn(r).sendable.length > 0).length : 0;
    if (faces && used >= (faces.windowMax ?? FACE_WINDOW_MAX) && facesIn(text).sendable.length > 0 && !onlyFaces(text)) {
        text = removeFaces(text, face => face !== undefined);
        notes.push(`最近 ${FACE_WINDOW} 次回复里已经带了 ${used} 次，这次的不带`);
    }
    return { reply: text, notes };
}

// 做不到的事：bot 只能发文字（决策 3）。主动给人看 / 发照片、语音、视频、红包，打电话、开视频，或者说得像已经发了。
// 拒绝的说法不算：前面三个字以内有「不、没、别、懒得」（「才不想给你看」「我又没开相册给你看」），
// 或者紧跟着「不行、不了、不方便、没法、算了」（「打电话不行」）；隔了标点的不管。
// 再往前就不算了：「等它好好坐着不动我再拍了发你」是承诺。
const CLAUSE = '[^，。！？、,.!?\\s]';
const NOT_NEGATED = `(?<!(?:[不没别]|懒得)${CLAUSE}{0,3})`;
const NOT_REFUSED = `(?!${CLAUSE}{0,2}(?:不行|不了|不方便|没法|算了))`;
const PROMISE = new RegExp(NOT_NEGATED + '(?:' + [
    '给你(?:看|发|拍|翻|传|寄)',
    '发(?:给)?你',
    '拍(?:给你|了?一?张|了好几张)',
    '刚拍的',
    '翻(?:两|几)张',
    '(?:打|开)个?(?:电话|视频)',
    '(?:视频|语音)通话',
    // 「你发语音干嘛」说的是他发的语音（ADR 0052 之后常见），不算；「给你发语音」由上面的「给你发」管
    `(?<!你${CLAUSE}{0,3})发(?:个|条|段)?语音`,
    '发个?红包',
    '(?:要|想)(?:不要)?看(?:不|吗|嘛)$',
].join('|') + ')' + NOT_REFUSED);

/** 提示词的结构：新对话的分隔、时间块里各行的开头；放完假那几天「[宝宝国庆放完假……]」那一行以称呼开头（ADR 0007 调整 2026-10-10） */
const SCRIPT = /\[Start a new Chat\]|^\s*\[(?:当前时间|距上一条消息|你现在|你今天的|你那边|这一轮|你的身体|你今天的打算)|^\s*\[[^\]\n]{1,16}放完假|^\s*\[(?:\d{4}年)?\d{1,2}月\d{1,2}日 星期/;

/**
 * 他发来的语音、图片在聊天记录里的写法（ADR 0052：「[语音 8秒：……]」「[图片，上面写着：……]」「[图片]」）：
 * 她照抄出来就是在假装发语音、发图，那一行不发
 */
const MEDIA_LINE = /^\s*\[(?:语音|图片)(?:\]|[ ，：])/;

export function inspectReply(reply: string, banned: readonly string[], speech?: SpeechContext, books?: BookProgressContext, faces?: FaceContext): ExitIssue[] {
    const issues: ExitIssue[] = [];
    for (const [line, text] of reply.split('\n').entries()) {
        const media = MEDIA_LINE.exec(text);
        if (media) issues.push({ line, kind: 'media', match: media[0].trim() });
        const script = SCRIPT.exec(text);
        if (script) issues.push({ line, kind: 'script', match: script[0].trim() });
        const promise = PROMISE.exec(text.trim());
        if (promise) issues.push({ line, kind: 'promise', match: promise[0] });
        for (const word of banned) if (text.includes(word)) issues.push({ line, kind: 'banned', match: word });
        // QQ 里没有的表情：平时 tidyFaces 已经去掉，还在的是去掉就什么都不剩的
        for (const token of new Set(facesIn(text).unknown)) issues.push({ line, kind: 'face', face: 'unknown', match: token });
    }
    if (faces?.serious && onlyFaces(reply)) issues.push({ line: 0, kind: 'face', face: 'only', match: reply.trim() });
    if (speech) issues.push(...inspectSpeech(reply, speech));
    if (books) {
        issues.push(...inspectBookProgress(reply, books).map((issue): ExitIssue => ({
            line: issue.line, kind: 'progress', match: issue.raw,
            book: { title: issue.title, expected: issue.expected, unit: issue.unit, total: issue.kind === 'total' },
        })));
    }
    return issues.sort((a, b) => a.line - b.line);
}

/** 删掉有问题的行 */
export function dropLines(reply: string, issues: readonly ExitIssue[]): string {
    const bad = new Set(issues.map(i => i.line));
    return reply.split('\n').filter((_, i) => !bad.has(i)).join('\n').trim();
}

/** 日志里的一句：第几行、哪一类、命中什么 */
export function summarizeIssues(issues: readonly ExitIssue[]): string {
    return issues.map(i => `第 ${i.line + 1} 行${i.kind === 'script' ? `编了一段对话「${i.match}」` : i.kind === 'media' ? `照抄了语音、图片的写法「${i.match}」` : i.kind === 'promise' ? `做不到的事「${i.match}」`
        : i.kind === 'banned' ? `禁用词「${i.match}」`
            : i.kind === 'face' ? (i.face === 'only' ? `他在认真说事，只回了表情「${i.match}」` : `QQ 里没有的表情「${i.match}」`)
            : i.kind === 'progress' ? `进度数字「${i.match}」（《${i.book!.title}》${progressFact(i.book!)}）` : describeSpeechIssue(i as SpeechIssue)}`).join('、');
}

/** 资料里的进度：看到第 7 卷 / 全书 550 章 */
function progressFact(book: NonNullable<ExitIssue['book']>): string {
    return book.total ? `全书 ${book.expected} ${book.unit}` : `看到第 ${book.expected} ${book.unit}`;
}

/** 重写时加在提示词末尾的说明：哪一句不能发、为什么、要怎么说 */
export function rewriteNote(reply: string, issues: readonly ExitIssue[], userName: string): string {
    const lines = reply.split('\n');
    const reasons = [...new Set(issues.map(i => i.line))].map(line => {
        const why = issues.filter(i => i.line === line).map(i => {
            switch (i.kind) {
                case 'script': return `从这里开始你在替你和${userName}两个人写一段聊天记录；只写你这一次要发给${userName}的话`;
                case 'media': return `这是${userName}发来的语音、图片在聊天记录里的写法，你发不了语音和图片，只能打字，不写这种方括号`;
                case 'promise': return '答应或者像是已经给对方发照片、语音、视频，或者打电话，可你只能打字聊天';
                case 'banned': return `提到了「${i.match}」，这是不该对${userName}说的`;
                case 'service': return `像客服说的话，用你自己的口气跟${userName}说`;
                case 'ledger': return `在说${userName}隔了这么久才来找你；${userName}来找你你是高兴的，直接接话`;
                case 'blame': return `在怪${userName}没告诉你、没带上你；${userName}说起自己的事是在跟你分享，顺着问问、替对方高兴`;
                case 'contrast': return `在拿${userName}和你自己比着说委屈；说你这边的事就说你这边的，${userName}那边的事顺着问问`;
                case 'repeat': return i.repeat === 'opener'
                    ? `开头的「${i.match}」你最近几次回复已经用过 ${i.count} 次，换个开头`
                    : i.repeat === 'verbatim'
                        ? `是你刚才说过的原话，别再说一遍；接${userName}刚发的这条`
                        : `里的「${i.match}」你最近几次回复已经说过 ${i.count} 次，换个说法`;
                case 'nag': return `又在叮嘱${userName}${NAG_TOPIC[i.nag ?? 'sleep']}；这段聊天里你已经叮嘱过了，别再说一遍，接${userName}刚说的就行`;
                case 'progress': return `「${i.match}」和你的进度对不上：《${i.book!.title}》你${progressFact(i.book!)}`;
                case 'face': return i.face === 'only'
                    ? `${userName}在认真跟你说事，你只回了个表情；用话回${userName}`
                    : `QQ 里没有「${i.match}」这个表情，发不出去；要带表情只用设定里说的那几个`;
            }
        });
        return `「${lines[line]!.trim()}」${[...new Set(why)].join('；')}`;
    });
    const changesMeaning = issues.some(i => (i.kind === 'repeat' && i.repeat === 'verbatim') || i.kind === 'ledger' || i.kind === 'blame' || i.kind === 'contrast' || i.kind === 'service' || i.kind === 'progress' || i.kind === 'nag');
    return `[上一版回复没有发出去：${reasons.join('；')}。${changesMeaning ? '别的意思' : '意思'}不变，重写这次的回复，只输出要发的消息。]`;
}

export interface ReviewOptions {
    banned: readonly string[];
    userName: string;
    /** 说话的毛病（ADR 0014）：和她最近几次回复、对方最近几条比；不传就不查 */
    speech?: SpeechContext;
    /** 这一轮放进提示词的在读的书（ADR 0015）；不传就不查进度数字 */
    books?: BookProgressContext;
    /** 小黄脸（ADR 0051）：她最近几次回复、他是不是在认真说事；不传就只查白名单外的和一次回复里堆太多 */
    faces?: FaceContext;
    /** 在原来的提示词末尾加上这句说明重新生成，返回清理过的回复 */
    regenerate: (note: string) => Promise<string>;
    log: (message: string) => void;
}

const HARD = new Set<ExitIssue['kind']>(['promise', 'banned', 'media']);

/** 先收拾小黄脸，再去掉重复的语气词开头（可能连着几个，最多去两轮），返回去过之后的回复和剩下要重写的问题 */
function strip(reply: string, options: ReviewOptions): { reply: string; issues: ExitIssue[] } {
    const tidy = tidyFaces(reply, options.faces);
    if (tidy.notes.length) options.log(`出口检查：小黄脸——${tidy.notes.join('；')}，去掉`);
    let text = tidy.reply;
    for (let round = 0; ; round++) {
        const issues = inspectReply(text, options.banned, options.speech, options.books, options.faces);
        const removable = issues.filter(strippable);
        if (removable.length === 0 || round === 2) return { reply: text, issues: issues.filter(i => !strippable(i)) };
        const next = stripOpeners(text, removable);
        if (next === text) return { reply: text, issues: issues.filter(i => !strippable(i)) };
        options.log(`出口检查：${summarizeIssues(removable)}，去掉`);
        text = next;
    }
}

/**
 * 重写之后（或重写失败时）还剩的问题：编的对话从那一行起全删；做不到的事、禁用词、照抄的语音图片行、QQ 里没有的表情删行；助手腔、算账、怪对方没说也删，删完一行不剩就留着；
 * 重复、进度数字、只回了表情照发
 */
function settle(reply: string, issues: readonly ExitIssue[]): { reply: string; dropped: boolean } {
    const script = issues.find(i => i.kind === 'script');
    if (script) {
        const kept = reply.split('\n').slice(0, script.line).join('\n');
        return { reply: settle(kept, issues.filter(i => i.line < script.line)).reply, dropped: true };
    }
    const hard = issues.filter(i => HARD.has(i.kind) || (i.kind === 'face' && i.face === 'unknown'));
    const soft = issues.filter(i => i.kind === 'service' || i.kind === 'ledger' || i.kind === 'blame' || i.kind === 'contrast');
    const withSoft = dropLines(reply, [...hard, ...soft]);
    if (withSoft || soft.length === 0) return { reply: withSoft, dropped: hard.length + soft.length > 0 };
    return { reply: dropLines(reply, hard), dropped: hard.length > 0 };
}

export async function reviewReply(reply: string, options: ReviewOptions): Promise<string> {
    const first = strip(reply, options);
    if (first.issues.length === 0) return first.reply;
    options.log(`出口检查：${summarizeIssues(first.issues)}，带说明重写一次`);
    let rewritten: string;
    try {
        rewritten = await options.regenerate(rewriteNote(first.reply, first.issues, options.userName));
    } catch (error) {
        options.log(`出口检查：重写失败（${error instanceof Error ? error.message : String(error)}），用第一版、删掉命中的行`);
        return settle(first.reply, first.issues).reply;
    }
    const second = strip(rewritten, options);
    if (second.issues.length === 0) {
        options.log('出口检查：重写后通过');
        return second.reply;
    }
    const { reply: settled, dropped } = settle(second.reply, second.issues);
    options.log(`出口检查：重写后仍有${summarizeIssues(second.issues)}，${dropped ? '删掉这几行' : '照发'}`);
    return settled;
}
