// 出口检查作为审稿模块（ADR 0336「生成之后那一段」第 6 步；ADR 0014 / 0051 / 0068 / 0321）：事实检查之后的第一道——
// 收拾小黄脸和照抄的标记、去掉重复的开头，查禁用词、做不到的事、助手腔、说话的毛病、书的进度……有问题带说明重写一次，还有就删行（reviewReply）。
// 危机回合（turn.facts.crisis，联系人流水线按他发的内容判断后写进去）换成危机检查（reviewCrisisReply：先走平常那一套，再查方法 / 敷衍 / 收尾，
// 还不过就发固定兜底），并且这一轮到此为止：后面的 <<查>>、形状、话说到一半、删行收尾、末查事实都不跑，草稿和重写里的设备指令一律不登记。
// 挂在审稿顺序表的 exit 位置；这个位置只该有这一个模块。没有开关：App / 模拟器总是挂着它。
//
// 上下文（禁用词、他的名字、说话的毛病——聊天记录在这一刻读、在读的书、小黄脸、文字抱抱、图片表情、重写 / 采用 / 日志）仍由联系人流水线在出口检查之前算好、
// 写进 ctx.scratch.exitOptions（删行收尾用同一份）；这里不重算、不重读聊天记录，所以行为和迁移前 contact.ts 里的逐字一样。
// 原来这一步总是 await（reviewReply / reviewCrisisReply 都是 async），这里也总是返回 promise：多出的微任务落在本来就异步的路径上。

import type { Module, ReviewVerdict } from '../interpreter/interpreter.ts';
import { crisisFallback, reviewCrisisReply, reviewReply } from '../language/exit-check.ts';

export function reviewExitModule(): Module {
    return {
        id: 'review-exit',
        reviewAt: {
            exit(text, turn, ctx): string | ReviewVerdict | Promise<string | ReviewVerdict> {
                const options = ctx.scratch.exitOptions;
                const crisis = turn.facts.crisis;
                const stop = (reviewed: string): ReviewVerdict => {
                    ctx.dropDevices();
                    return { text: reviewed, stop: true };
                };
                // 联系人流水线总在出口检查之前写好；没有就是接线漏了：记一句。危机回合宁可发固定兜底（预先写好的、已经查过的话），也不把没查过的话发出去
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
