// 她想查才查作为审稿模块（ADR 0336「生成之后那一段」第 5 步；配置 selfDirectedMemory，DSH 10-30）：她在回复里写了 <<查：关键词>>，
// 就按这个词去长期记忆里查；查到了带着结果重写一次（不算「采用重写」，设备指令仍是原稿的），查不到、没开长期记忆就只摘掉标记。标记一律不发出去。
// 挂在审稿顺序表的 pull 位置（出口检查之后、形状裁剪之前）。摘标记不看开关：App / 模拟器总是挂着它；查记忆的函数只有开了长期记忆和 selfDirectedMemory 才给。
// 没写标记、或者没法查（没给 recall、关键词是空的）时同步返回：原来这些情况不 await，这里也不多一个微任务。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 review 场景核对：查到了重写、没查到摘标记）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Contact } from '../platform/config.ts';

const PULL = /<<查[：:]\s*([\s\S]*?)>>/;
const PULL_ALL = /<<查[：:][\s\S]*?>>/g;

const countLines = (text: string) => text.split('\n').length - 1;
const strip = (text: string) => text.replace(PULL_ALL, '').trim();

/** 查到之后重写时加的那句说明 */
export const pullNote = (recalled: string) => `（你刚才想起来了：\n${recalled}\n用这些回答他，不要再写 <<查>> 标记。）`;

export interface ReviewPullOptions {
    /**
     * 按她写的词查长期记忆（App：memory.recallPull(contact, query, new Date())）；查不到返回 undefined，出错当查不到。
     * 不给就只摘标记（没开长期记忆 / selfDirectedMemory、模拟器）
     */
    recall?: (contact: Contact, query: string) => Promise<string | undefined>;
}

export function reviewPullModule(options: ReviewPullOptions = {}): Module {
    const { recall } = options;
    return {
        id: 'review-pull',
        reviewAt: {
            pull(text, turn, ctx) {
                const pull = PULL.exec(text);
                if (!pull) return text;
                const query = pull[1]!.trim();
                if (!query || !recall) return strip(text);
                return (async () => {
                    const recalled = await recall(turn.contact, query).catch(() => undefined);
                    let reviewed = text;
                    if (recalled) {
                        ctx.log(`她主动查记忆：${query}（${countLines(recalled)} 条）`);
                        reviewed = await ctx.regenerate(pullNote(recalled));
                    }
                    return strip(reviewed);
                })();
            },
        },
    };
}
