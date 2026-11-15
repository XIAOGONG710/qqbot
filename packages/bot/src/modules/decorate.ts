// 发出去之前的两步修饰作为解释器的模块（ADR 0336「生成之后那一段」第 11 步）：拆好条之后、发出去之前，按修饰顺序表（DECORATE_STAGES）先加质感、再打错字。
// - 质感（ADR 0131 / 0134，配置 texture）：问号、感叹、句尾「～」、小黄脸……按哈希定，不抽随机数。上下文（他这一串说的话、是不是认真的回合、她最近带了几次小黄脸 / 「～」）
//   在判断那一串的 texture 位置算（decideAt.texture，深思和「/亲热」之后、拼段落之前——迁移前联系人流水线里的原位），写进 turn.facts.texture；只有男朋友档、不是只想一想的轮次才有。
//   危机、小别扭生效、他难过 / 生病、意图是先接住他此刻的情绪的回合算「认真的回合」，不加。聊天记录在那一刻现读（经 DecideCtx）。
// - 打错字再改口（ADR 0024 / 0086）：偶尔打错一个字，下一条补「*对的词」，能撤回时（ctx.canRecall）按比例改成撤回重发。打错字认的是汉字，不碰小黄脸 / 标点，所以排在质感之后。
// 两步的种子都只看是谁、拆好条的原稿说了什么，不看时间：同一句话结果固定（带时间时假模型的测试时过时不过）。危机回合（turn.facts.crisis）都不做（ADR 0068）。
// 不存状态、不调模型、同步。行为和迁移前 contact.ts 里的逐字一样（行为基线核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { maybeTypo, RECALL_SHARE } from '../language/expression.ts';
import { faceContext } from '../language/exit-check.ts';
import { needsCareText } from '../language/intent.ts';
import { applyTexture, TEXTURE_TILDE_WINDOW } from '../language/texture.ts';

/** 质感：开了配置 texture 才挂 */
export function textureModule(): Module {
    return {
        id: 'texture',
        decideAt: {
            texture: (turn, ctx) => {
                const { contact, facts, history: chat } = turn;
                if (contact.tier !== 'boyfriend' || turn.thinking) return;
                const saidNow = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
                facts.texture = {
                    said: saidNow,
                    serious: Boolean(facts.crisis || facts.grievanceActive || facts.sulk || needsCareText(saidNow) || (facts.baseIntent && /先接住他此刻的情绪/.test(facts.baseIntent))),
                    recentFaces: faceContext(ctx.history(), contact.tier).recent.filter(reply => /\[[\p{Script=Han}A-Za-z0-9]{1,6}\]/u.test(reply)).length,
                    recentTildes: faceContext(ctx.history(), contact.tier).recent.slice(-TEXTURE_TILDE_WINDOW).filter(reply => /[～~]\s*$/m.test(reply)).length,
                };
            },
        },
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
