// 接话的基本规矩作为解释器的模块（ADR 0336 第 5 步）：DSH 线 10-30 / 10-31 加的四行，往「此刻」块放、不存状态、不调模型。
// - lastUser：他最后说的是哪句（防止她把更早的“嘿嘿”“嗯”和刚说的话混在一起回）。只认最近 30 分钟内的；
//   更早的不说是“他刚说的”——主动找他时改成一句时间提醒，别的轮次不放。
// - person：人称（10-30：他问「我是谁？」，她回「我是谁这还用问」——把「我」当成了自己）。
// - directAnswer：正经问就先直接答（她本人 10-31 同意加的：「该加。我确实老这样，你一认真我就先问『你今天怎么了』。
//   行，以后正经问我就正经答。不过聊闲天我还贫啊。」）。
// - noOverthink：别琢磨怎么接才好看（她本人 10-31 提的：「我老想着接你的话，接得好看点，一使劲反而怪。少想点，别一开口就先想『这句该怎么说』。」
//   追问时她把界限说清了：「小事我张口就来，正经的我会先想一下——但也不会想半天，想太久我就烦了。」）。
// 后三行在她主动找他的轮次不放（那时没有他刚说的话可接）。各档位都放，危机、只想一想、深思时照样放。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线全部 18 个场景都有这几行）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';

/** 他最后一句多久以内算“刚说的” */
export const LAST_USER_LINE_MS = 30 * 60_000;

export const PERSON_NOTE = '[人称：他说「我」是他自己、说「你」是叫你；你说「我」是你自己。他问「我是谁」「我算你什么」问的是你们俩是什么关系，别答成你问你自己。]';
export const DIRECT_ANSWER_NOTE = '[他正经问你一件事、问你怎么想的时候：先直接答，别一上来就反问「你今天怎么了」「你问这个干嘛」；答完可以就停。聊闲天、开玩笑照旧贫。]';
export const NO_OVERTHINK_NOTE = '[平时聊天别琢磨怎么接才好看——一句话在脑子里过好几遍才发出去，反而怪。想到什么说什么，说岔了也认。他正经问你事的时候可以想一下，但别想半天。]';

/** 他最后说的那句：30 分钟内的原样给她（最多 120 字）；更早的只在她主动找他时提醒一句“那不是刚说的”；他没说过话时没有 */
export function lastUserLine(turn: Turn): string | undefined {
    const lastUser = [...turn.history].reverse().find(message => message.role === 'user');
    const lastUserText = lastUser?.content?.trim();
    if (!lastUserText) return undefined;
    const agoMs = lastUser?.time ? turn.at.getTime() - Date.parse(lastUser.time) : Number.POSITIVE_INFINITY;
    if (agoMs > LAST_USER_LINE_MS) {
        const hoursAgo = Math.round(agoMs / 3_600_000);
        const when = Number.isFinite(hoursAgo) && hoursAgo >= 1 ? `${hoursAgo} 小时前` : '好几条消息以前';
        return turn.initiate ? `他上一次说话是 ${when}，那不是刚说的：别接着说那句旧话，说你这一轮要说的事。` : undefined;
    }
    return `他最后说的是：「${lastUserText.slice(0, 120)}」。先接这一句，别接更早的话。`;
}

export function replyBasicsModule(): Module {
    return {
        id: 'reply-basics',
        contribute(turn) {
            const last = lastUserLine(turn);
            const pieces: Piece[] = last ? [{ slot: 'lastUser', text: last }] : [];
            if (!turn.initiate) pieces.push({ slot: 'person', text: PERSON_NOTE }, { slot: 'directAnswer', text: DIRECT_ANSWER_NOTE }, { slot: 'noOverthink', text: NO_OVERTHINK_NOTE });
            return pieces;
        },
    };
}
