// 发出去之前的两步修饰作为解释器的模块（ADR 0336「生成之后那一段」第 11 步）：拆好条之后、发出去之前，按修饰顺序表（DECORATE_STAGES）先加质感、再打错字。
// - 质感（ADR 0131 / 0134，配置 texture）：问号、感叹、句尾「～」、小黄脸……按哈希定，不抽随机数。上下文（他这一串说的话、是不是认真的回合、她最近带了几次小黄脸 / 「～」）
//   仍由联系人流水线在拼段落时原位算好（读聊天记录、小别扭是否生效、他难不难过），写进 turn.facts.texture，这里只用；只有男朋友档、不是只想一想的轮次才有。
// - 打错字再改口（ADR 0024 / 0086）：偶尔打错一个字，下一条补「*对的词」，能撤回时（ctx.canRecall）按比例改成撤回重发。打错字认的是汉字，不碰小黄脸 / 标点，所以排在质感之后。
// 两步的种子都只看是谁、拆好条的原稿说了什么，不看时间：同一句话结果固定（带时间时假模型的测试时过时不过）。危机回合（turn.facts.crisis）都不做（ADR 0068）。
// 不存状态、不调模型、同步。行为和迁移前 contact.ts 里的逐字一样（行为基线核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { maybeTypo, RECALL_SHARE } from '../language/expression.ts';
import { applyTexture } from '../language/texture.ts';

/** 质感：开了配置 texture 才挂 */
export function textureModule(): Module {
    return {
        id: 'texture',
        decorateAt: {
            texture: (parts, turn, ctx) => {
                const texture = turn.facts.texture;
                if (turn.facts.crisis || !texture) return parts;
                const textured = applyTexture(parts, {
                    seed: `${turn.contact.qq} ${ctx.original.join('|')}`, said: texture.said, serious: texture.serious,
                    recentFaces: texture.recentFaces, recentTildes: texture.recentTildes, maxBubbles: ctx.maxBubbles,
                });
                if (textured.notes.length) ctx.log(`质感：${textured.notes.join('；')}`);
                return textured.parts;
            },
        },
    };
}

/** 打错字再改口：没有开关，App 和模拟器都总是挂 */
export function typoModule(): Module {
    return {
        id: 'typo',
        decorateAt: {
            typo: (parts, turn, ctx) => {
                if (turn.facts.crisis) return parts;
                const typo = maybeTypo(parts, `${turn.contact.qq} ${ctx.original.join('|')}`, ctx.maxBubbles, ctx.canRecall ? RECALL_SHARE : 0);
                if (typo.note) ctx.log(`打错字：${typo.note}`);
                return typo.recall ? { parts: typo.parts, recall: typo.recall } : typo.parts;
            },
        },
    };
}
