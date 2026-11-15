// 删行收尾作为审稿模块（ADR 0336「生成之后那一段」第 2 步；ADR 0321）：所有可能重写的步骤（出口检查、<<查>>、形状、话说到一半）之后的最后一关，
// 只清理 / 删行、不再调模型（finalizeReply）。挂在审稿顺序表的 finalize 位置；危机回合在出口检查那一步就结束了，走不到这里。
// 用的是出口检查那一刻算好的同一份上下文（禁用词、说话的毛病——聊天记录在那一刻读、在读的书、小黄脸……），从 ctx.scratch.exitOptions 取，不重读聊天记录。
// 迁移期由联系人流水线在出口检查之前写进 scratch；出口检查迁成模块（第 6 步）之后由它写。
// 同步：原来这一步不 await，这里也同步返回（审稿位置都同步时不多一个微任务）。
// 行为和迁移前 contact.ts 里的逐字一样（language-review.test.ts「重写加入禁用词仍被最终检查拦截」核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { finalizeReply } from '../language/exit-check.ts';

export function reviewFinalizeModule(): Module {
    return {
        id: 'review-finalize',
        reviewAt: {
            finalize(text, _turn, ctx) {
                const options = ctx.scratch.exitOptions;
                // 联系人流水线总在出口检查之前写好；没有就是接线漏了，原样放过（日志留一句，测试会看到发出去的没删行）
                if (!options) {
                    ctx.log('删行收尾：没有出口检查那一刻的上下文，跳过');
                    return text;
                }
                return finalizeReply(text, options);
            },
        },
    };
}
