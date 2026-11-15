// 话说到一半作为审稿模块（ADR 0336「生成之后那一段」第 4 步；ADR 0141）：停在转折上、停在没说完的词上，带说明重写一次；还是这样就退到上一个逗号 / 并回前一条。
// 挂在审稿顺序表的 unfinished 位置（形状裁剪之后、删行收尾之前：并回去 / 退回去会让一条变长，放在字数检查前面会被再截一次）。
// 只在开了说话检查（配置 speechCheck）时挂——开关由 App / 模拟器决定挂不挂，模块本身不看开关；危机回合在出口检查那一步就结束了，走不到这里。
// 重写、采用重写、日志都用联系人流水线给的那几个（ctx.regenerate / ctx.accept / ctx.log），和迁移前传给 finishReply 的是同一组函数。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 review 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { finishReply } from '../language/unfinished.ts';

export function reviewUnfinishedModule(): Module {
    return {
        id: 'review-unfinished',
        reviewAt: {
            unfinished: (text, _turn, ctx) => finishReply(text, { regenerate: ctx.regenerate, onRewriteAccepted: ctx.accept, log: ctx.log }),
        },
    };
}
