// 她自己记下的东西作为解释器的模块（ADR 0336 第 5 步）：DSH 线上她夜里自己想、自己写的几样，聊天时按他这句话挑相关的放进提示词。
// 都是她自己的观察，不是设定；规则都在各自的文件里，这里只是接线：
// - speechNote：她自己总结的说话习惯（ADR 0193，language/speech-notes.ts）——口气上的参考，总是放（按他这句话排序）；
// - review：她回头看聊天时记下的（ADR 0221，language/chat-review.ts）——他在难受时不放（那一轮先接住他，别想着自己的毛病）；
// - insight：她翻自己日记时发现的自己（ADR 0194，life/diary-insights.ts）——他这句正好聊到才放；
// - takes：她读完 / 看完之后自己想的（ADR 0204，life/reading-takes.ts）——聊到那本书 / 视频、或问最近看了什么才放；
// - thoughts：她没想完的问题后来想出来的（ADR 0207，life/open-questions.ts）——他再问到同一件事才放；
// - guesses：她猜的事（ADR 0213，life/her-guesses.ts）——他这句提到同一类事才放。
// 只给男朋友档；只想一想、危机、小别扭的轮次都不放（她主动开口也放：习惯不看有没有他的上一句）。各自的开关由 App 决定给不给读取函数。
// 夜里想、写这些文件的那一半还在 app.ts 的计时器里，迁那些计时器时一起收。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 her-notes 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { needsCareText } from '../language/intent.ts';
import { reviewLine, type ReviewNote } from '../language/chat-review.ts';
import { speechNotesLine, type SpeechNote } from '../language/speech-notes.ts';
import { insightsLine, type Insight } from '../life/diary-insights.ts';
import { guessesLine, type Guess } from '../life/her-guesses.ts';
import { thoughtsLine, type Thought } from '../life/open-questions.ts';
import { takesLine, type Take } from '../life/reading-takes.ts';
import type { Log } from '../platform/log.ts';

/** 各样的读取函数；配置没开的就不给 */
export interface HerNotesOptions {
    speechNotes?: () => readonly SpeechNote[];
    chatReview?: () => readonly ReviewNote[];
    diaryInsights?: () => readonly Insight[];
    readingTakes?: () => readonly Take[];
    openQuestions?: () => readonly Thought[];
    herGuesses?: () => readonly Guess[];
    /** 她猜的事按这个时刻算「最近几天对上的」（同联系人流水线的时钟） */
    now: () => number;
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export function herNotesModule(options: HerNotesOptions): Module {
    return {
        id: 'her-notes',
        contribute(turn) {
            if (turn.contact.tier !== 'boyfriend' || turn.thinking || turn.facts.crisis || turn.facts.grievance) return [];
            const said = turn.history.findLast(message => message.role === 'user')?.content;
            const log = (message: string) => options.log(`[${turn.contact.qq}] ${message}`);
            const pieces: Piece[] = [];
            const add = (slot: Piece['slot'], text: string | undefined, note: string) => {
                if (!text) return;
                log(note);
                pieces.push({ slot, text });
            };
            if (options.speechNotes) add('speechNote', speechNotesLine(options.speechNotes(), said), '说话习惯：这一轮放了几条她自己总结的（日志不记内容）');
            if (options.chatReview && !needsCareText(said ?? '')) add('review', reviewLine(options.chatReview()), '聊天回顾：这一轮放了她自己记下的（日志不记内容）');
            if (options.diaryInsights) add('insight', insightsLine(options.diaryInsights(), said), '自我认识：这一轮放了几条她翻日记时发现的自己（日志不记内容）');
            if (options.readingTakes) add('takes', takesLine(options.readingTakes(), said), '读完看完的想法：这一轮放了她自己想的（日志不记内容）');
            if (options.openQuestions) add('thoughts', thoughtsLine(options.openQuestions(), said), '没想完的问题：这一轮放了她自己后来想的（日志不记内容）');
            if (options.herGuesses) add('guesses', guessesLine(options.herGuesses(), said, options.now()), '她猜的事：这一轮放了她自己记的（日志不记内容）');
            return pieces;
        },
    };
}
