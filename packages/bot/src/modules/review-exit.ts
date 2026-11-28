// 出口检查作为审稿模块（ADR 0336「生成之后那一段」第 6 步；ADR 0014 / 0051 / 0068 / 0321）：事实检查之后的第一道——
// 收拾小黄脸和照抄的标记、去掉重复的开头，查禁用词、做不到的事、助手腔、说话的毛病、书的进度……有问题带说明重写一次，还有就删行（reviewReply）。
// 危机回合（turn.facts.crisis，联系人流水线按他发的内容判断后写进去）换成危机检查（reviewCrisisReply：先走平常那一套，再查方法 / 敷衍 / 收尾，
// 还不过就发固定兜底），并且这一轮到此为止：后面的 <<查>>、形状、话说到一半、删行收尾、末查事实都不跑，草稿和重写里的设备指令一律不登记。
// 挂在审稿顺序表的 exit 位置；这个位置只该有这一个模块。没有开关：App / 模拟器总是挂着它。
//
// 上下文（2026-11-16 起自己算，exitOptionsOf）：禁用词（卡上的 + 医书里的词 + 书面腔）、他的名字、说话的毛病（开了 speechCheck：聊天记录在这一刻读；小别扭生效的轮次放过带点抱怨的话、
// 固定说法放过重复）、在读的书的进度（turn.facts.books）、小黄脸（这一刻再读一次聊天记录）、文字抱抱（最终的意图里有「QQ 文字里的抱抱」）、图片表情、重写 / 采用 / 日志。
// 软风格那几样（说话毛病的哪几类查、医书词和书面腔、认真求哄 / 转话题时要她重写的说法）从软风格规则表拿（language/style-rules.ts，QQBOT_STYLE_RULES；默认就是原来写死的）。
// 算好写进 ctx.scratch.exitOptions，删行收尾用同一份、不重读。按联系人 / 配置给的几样在 ReviewCtx.exit 和 history；和迁移前联系人流水线在这一步之前算的逐字一样（同一刻、同样的读法）。
// 不经联系人流水线、也没人预先放好上下文时（接线漏了）照旧：平常回合原样放过，危机回合发固定兜底。
// 原来这一步总是 await（reviewReply / reviewCrisisReply 都是 async），这里也总是返回 promise：多出的微任务落在本来就异步的路径上。

import { fewerRules } from '../language/fewer-rules.ts';
import type { Module, ReviewCtx, ReviewVerdict, Turn } from '../interpreter/interpreter.ts';
import { crisisFallback, faceContext, reviewCrisisReply, reviewReply, type ReviewOptions } from '../language/exit-check.ts';
import { speechContext } from '../language/speech-check.ts';
import { skippedSpeechKinds, STYLE_RULES, styleBannedWords, styleRulesLogLine } from '../language/style-rules.ts';
import { recognizes } from './semantic-judgment.ts';
import { keywordTopicShift } from '../language/prompt.ts';
export { keywordTopicShift } from '../language/prompt.ts';

/** 关键词认「他认真求哄」（兼容入口：没开语义判断、或判断退回时用；硬编码改造第一优先级，对照过了才考虑收掉） */
export const keywordCareRequest = (said: string): boolean => /^(?:我)?(?:是)?认真(?:地)?想听你哄我(?:一下|一句)?[。！!?？\s]*$/u.test(said.trim());

/** 出口检查那一刻的上下文；ctx.exit / ctx.history 没有时（不经联系人流水线）不算 */
export function exitOptionsOf(turn: Turn, ctx: ReviewCtx): ReviewOptions | undefined {
    const given = ctx.exit;
    if (!given) return undefined;
    const { facts, contact } = turn;
    const history = ctx.history ?? (() => []);
    const latest = turn.history.at(-1);
    const playfulReply = process.env.QQBOT_PLAYFUL_PERSONA === '1' && !facts.crisis && !turn.initiate && !turn.thinking && latest?.role === 'user';
    const banned = fewerRules() && !facts.crisis ? [...(turn.card?.banned ?? [])] : [...(turn.card?.banned ?? []), ...styleBannedWords()];
    const precedingUser = playfulReply ? turn.history.slice(0, -1).findLast(message => message.role === 'user') : undefined;
    // 私聊语义判断（QQBOT_SEMANTIC_JUDGMENT，modules/semantic-judgment.ts 的 recognizes）：有能用的判断就按它认「求哄 / 收住」，只换「认不认」，重写的内容不变；
    // 没有就照旧按关键词（开着但退回时，分几条发的转述不认）。要她重写的说法在软风格规则表里（careAvoid / careTiredAvoid / closingAvoid / closingJokeAvoid）
    if (playfulReply && recognizes(turn, 'care', keywordCareRequest)) {
        banned.push(...STYLE_RULES.careAvoid);
        // 他前一句累没累还是按关键词认（语义判断只读他最后那几句的意思，第四批没接这一项）
        if (precedingUser && /忙了(?:一?整|一)天|累[了得坏]|(?:今天|这会儿).{0,8}(?:很累|太累|好累|挺累|累死)/u.test(precedingUser.content)) {
            banned.push(...STYLE_RULES.careTiredAvoid);
        }
    }
    if (playfulReply && recognizes(turn, 'closing', keywordTopicShift)) {
        banned.push(...STYLE_RULES.closingAvoid);
        if (precedingUser?.content.includes('笑话') && !latest.content.includes('笑')) banned.push(...STYLE_RULES.closingJokeAvoid);
    }
    const skip = skippedSpeechKinds();
    return {
        // 角色卡的禁用词 + 医书里的词（“肚子坠着”之类，expression.ts 的 ODD_BODY_WORDS）：出了就让她重写
        // 少规矩（ADR 0342）：只留卡上的红线，医书词和书面腔不再让她重写
        banned,
        userName: contact.name,
        ...(given.speechCheck ? { speech: { ...speechContext(history()), ...(facts.sulk ? { allowGrievance: true } : {}), ...(ctx.allowRepeat ? { allowRepeat: true } : {}) } } : {}),
        ...(facts.books?.context ? { books: facts.books.context } : {}),
        // 小黄脸（ADR 0051）：最近几次带得太密、他认真说事她只回表情
        faces: faceContext(history(), contact.tier),
        ...(facts.intent?.includes('QQ 文字里的抱抱') ? { textIntimacy: true } : {}),
        ...(given.imageStickers ? { imageStickers: true } : {}),
        ...(skip.size ? { skip } : {}),
        regenerate: ctx.regenerate,
        onRewriteAccepted: ctx.accept,
        log: ctx.log,
    };
}

export function reviewExitModule(): Module {
    let styleLogged = false;
    return {
        id: 'review-exit',
        reviewAt: {
            exit(text, turn, ctx): string | ReviewVerdict | Promise<string | ReviewVerdict> {
                if (!styleLogged) {
                    styleLogged = true;
                    const line = styleRulesLogLine();
                    if (line) ctx.log(line);
                }
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
