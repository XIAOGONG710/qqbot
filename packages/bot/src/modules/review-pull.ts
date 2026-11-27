// 她想查才查作为审稿模块（ADR 0336「生成之后那一段」第 5 步；配置 selfDirectedMemory，DSH 10-30）：她在回复里写了 <<查：关键词>>，
// 就按这个词去长期记忆里查；查到了带着结果重写一次（不算「采用重写」，设备指令仍是原稿的），查不到、没开长期记忆就只摘掉标记。标记一律不发出去。
// 挂在审稿顺序表的 pull 位置（出口检查之后、形状裁剪之前）。摘标记不看开关：App / 模拟器总是挂着它；查记忆的函数只有开了长期记忆和 selfDirectedMemory 才给。
// 没写标记、或者没法查（没给 recall、关键词是空的）时同步返回：原来这些情况不 await，这里也不多一个微任务。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 review 场景核对：查到了重写、没查到摘标记）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Contact } from '../platform/config.ts';
import type { MemoryReview, MemoryReviewResolution } from '../memory/memory-review.ts';
import { takeMemoryReviewResolution } from './self-notes.ts';

const PULL = /<<查[：:]\s*([\s\S]*?)>>/;
const PULL_ALL = /<<查[：:][\s\S]*?>>/g;

const countLines = (text: string) => text.split('\n').length - 1;
const strip = (text: string) => text.replace(PULL_ALL, '').trim();

/** 查到之后重写时加的那句说明 */
export const pullNote = (recalled: string) => {
    const canLinkReview = /<<记忆引用:[a-f0-9]{24}>>/.test(recalled);
    const pendingReview = /待核对备注/.test(recalled);
    const review = canLinkReview
        ? `如果你明确觉得某条可能记错，别当作确定事实，也别自行改动；用普通话说明原记录的日期和来源，请他帮你核对。只把新的疑点写进隐藏标记 <<记忆待核对：引用｜疑点>>，引用必须照抄该条末尾的内部引用。只有明确有疑点才标，不要每条都写。${pendingReview ? '这条以前留过待核对备注，这是第一次把它带回给你看。看完由你决定：确认原记录，或补充更正。想确认时写隐藏标记 <<记忆核对结果：引用｜确认原记录>>；想补充更正时写 <<记忆核对结果：引用｜补充更正：内容>>，引用照抄原记录末尾。只有你明确决定时才写；不想现在处理就不写结果标记，不追问、不催促，也不在之后反复提醒。更正只作为附注保存，不自动改写原始记忆。' : ''}`
        : '这些记录没有可精确回连的引用；拿不准就直接说不确定，不要写待核对标记，也不要自行改动或删除旧记忆。';
    return `（你刚才想起来了：\n${recalled}\n用这些回答他，不要再写 <<查>> 标记。${review}）`;
};

export interface ReviewPullOptions {
    /**
     * 按她写的词查长期记忆（App：memory.recallPull(contact, query, new Date())）；查不到返回 undefined，出错当查不到。
     * 不给就只摘标记（没开长期记忆 / selfDirectedMemory、模拟器）
     */
    recall?: (contact: Contact, query: string) => Promise<string | { text: string; offers: MemoryReview[] } | undefined>;
    finishReview?: (contact: Contact, offers: readonly MemoryReview[], resolution?: MemoryReviewResolution) => void;
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
                        const material = typeof recalled === 'string' ? recalled : recalled.text;
                        // 她查的词可能是私事，日志只记字数（决定单第 29 条，记忆审查 U6）
                        ctx.log(`她主动查记忆：${[...query].length} 字（${countLines(material)} 条）`);
                        reviewed = await ctx.regenerate(pullNote(material));
                        if (typeof recalled !== 'string' && recalled.offers.length) {
                            const resolution = takeMemoryReviewResolution(reviewed).resolutions[0];
                            const matched = resolution && recalled.offers.some(offer => offer.reference === resolution.reference);
                            try { options.finishReview?.(turn.contact, recalled.offers, matched ? resolution : undefined); }
                            catch { ctx.log('记忆核对结果没能保存'); }
                        }
                    }
                    return strip(reviewed);
                })();
            },
        },
    };
}
