// 出口检查作为审稿模块（ADR 0336「生成之后那一段」第 6 步；ADR 0014 / 0051 / 0068 / 0321）：事实检查之后的第一道——
// 收拾小黄脸和照抄的标记、去掉重复的开头，查禁用词、做不到的事、助手腔、说话的毛病、书的进度……有问题带说明重写一次，还有就删行（reviewReply）。
// 危机回合（turn.facts.crisis，联系人流水线按他发的内容判断后写进去）换成危机检查（reviewCrisisReply：先走平常那一套，再查方法 / 敷衍 / 收尾，
// 还不过就发固定兜底），并且这一轮到此为止：后面的 <<查>>、形状、话说到一半、删行收尾、末查事实都不跑，草稿和重写里的设备指令一律不登记。
// 挂在审稿顺序表的 exit 位置；这个位置只该有这一个模块。没有开关：App / 模拟器总是挂着它。
//
// 上下文（2026-11-16 起自己算，exitOptionsOf）：禁用词（卡上的 + 医书里的词 + 书面腔）、他的名字、说话的毛病（开了 speechCheck：聊天记录在这一刻读；小别扭生效的轮次放过带点抱怨的话、
// 固定说法放过重复）、在读的书的进度（turn.facts.books）、小黄脸（这一刻再读一次聊天记录）、文字抱抱（最终的意图里有「QQ 文字里的抱抱」）、图片表情、重写 / 采用 / 日志。
// 算好写进 ctx.scratch.exitOptions，删行收尾用同一份、不重读。按联系人 / 配置给的几样在 ReviewCtx.exit 和 history；和迁移前联系人流水线在这一步之前算的逐字一样（同一刻、同样的读法）。
// 不经联系人流水线、也没人预先放好上下文时（接线漏了）照旧：平常回合原样放过，危机回合发固定兜底。
// 原来这一步总是 await（reviewReply / reviewCrisisReply 都是 async），这里也总是返回 promise：多出的微任务落在本来就异步的路径上。

import { fewerRules } from '../language/fewer-rules.ts';
import type { Module, ReviewCtx, ReviewVerdict, Turn } from '../interpreter/interpreter.ts';
import { crisisFallback, faceContext, reviewCrisisReply, reviewReply, type ReviewOptions } from '../language/exit-check.ts';
import { ODD_BODY_WORDS, STILTED_WORDS } from '../language/expression.ts';
import { speechContext, TAIL_CAPS } from '../language/speech-check.ts';

/** 出口检查那一刻的上下文；ctx.exit / ctx.history 没有时（不经联系人流水线）不算 */
export function exitOptionsOf(turn: Turn, ctx: ReviewCtx): ReviewOptions | undefined {
    const given = ctx.exit;
    if (!given) return undefined;
    const { facts, contact } = turn;
    const history = ctx.history ?? (() => []);
    return {
        // 角色卡的禁用词 + 医书里的词（“肚子坠着”之类，expression.ts 的 ODD_BODY_WORDS）：出了就让她重写
        // 少规矩（ADR 0342）：只留卡上的红线，医书词和书面腔不再让她重写
        banned: fewerRules() ? [...(turn.card?.banned ?? [])] : [...(turn.card?.banned ?? []), ...ODD_BODY_WORDS, ...STILTED_WORDS],
        userName: contact.name,
        ...(given.speechCheck ? { speech: { ...speechContext(history(), given.tailCap ? { tailCaps: TAIL_CAPS } : {}), ...(facts.sulk ? { allowGrievance: true } : {}), ...(ctx.allowRepeat ? { allowRepeat: true } : {}) } } : {}),
        ...(facts.books?.context ? { books: facts.books.context } : {}),
        // 小黄脸（ADR 0051）：最近几次带得太密、他认真说事她只回表情
        faces: faceContext(history(), contact.tier),
        ...(facts.intent?.includes('QQ 文字里的抱抱') ? { textIntimacy: true } : {}),
        ...(given.imageStickers ? { imageStickers: true } : {}),
        regenerate: ctx.regenerate,
        onRewriteAccepted: ctx.accept,
        log: ctx.log,
    };
}

export function reviewExitModule(): Module {
    return {
        id: 'review-exit',
        reviewAt: {
            exit(text, turn, ctx): string | ReviewVerdict | Promise<string | ReviewVerdict> {
                const options = ctx.scratch.exitOptions ?? exitOptionsOf(turn, ctx);
                if (options) ctx.scratch.exitOptions = options;
                const crisis = turn.facts.crisis;
                const stop = (reviewed: string): ReviewVerdict => {
                    ctx.dropDevices();
                    return { text: reviewed, stop: true };
                };
                // 联系人流水线总是给 ctx.exit；没有、也没人预先放好就是接线漏了：记一句。危机回合宁可发固定兜底（预先写好的、已经查过的话），也不把没查过的话发出去
                if (!options) {
                    ctx.log('出口检查：没有出口检查的上下文，跳过');
                    return crisis ? stop(crisisFallback(crisis.level)) : text;
                }
                if (!crisis) return reviewReply(text, options);
                return reviewCrisisReply(text, options, crisis.level).then(stop);
            },
        },
    };
}
