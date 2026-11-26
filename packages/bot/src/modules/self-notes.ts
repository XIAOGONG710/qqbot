// 她自己决定记不记的标记作为解释器的模块（ADR 0336「生成之后那一段」第 12 步）：她在回复里写 `<<记住：…>>` / `<<日记：…>>` / `<<私密：…>>`，
// 发出去之前从字里摘掉、该记的记下（absorbAt.notes，标记处理顺序表的第一步）：
// - 私密：只写进她自己的灵魂目录（App 给 keepPrivate），不进记忆；
// - 日记：男朋友档、App 给了 keepDiary（配置 diaryInsights）时在本地也留一份（ADR 0194：她翻日记时要读，Hindsight 里没法按日期整批读），没留成只记日志；
// - 记住 / 日记：有长期记忆时写进记忆（App 给 remember；不等它，失败只记日志）。
// 摘标记和开关无关，所以 App 总是挂（提示词里教她写这些标记的那几行是 modules/self-memory.ts，跟着 selfDirectedMemory）。
// 不存状态、不调模型；碰外部的都是 App 给的函数。行为和迁移前 app.ts 的 absorbMarkers 里的逐字一样（行为基线 review / self-memory 等场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';

export type SelfNoteKind = '记住' | '日记' | '私密';

/** 剥掉回复里的 `<<记住：…>>` / `<<日记：…>>` / `<<私密：…>>`，返回干净文本和要记的条目（空的不算） */
export function takeSelfNotes(input: string): { text: string; notes: Array<{ kind: SelfNoteKind; text: string }> } {
    const notes: Array<{ kind: SelfNoteKind; text: string }> = [];
    const text = input.replace(/<<(记住|日记|私密)[：:]\s*([\s\S]*?)>>/g, (_, kind: SelfNoteKind, body: string) => {
        const value = body.trim();
        if (value) notes.push({ kind, text: value });
        return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { text, notes };
}

/** 她在主动查到的旧记忆里明确提出待核对时，摘掉隐藏标记并保留她写的依据。 */
export function takeMemoryReview(input: string): { text: string; reviews: Array<{ reference: string; note: string }> } {
    const reviews: Array<{ reference: string; note: string }> = [];
    const text = input.replace(/<<记忆待核对[：:]\s*([\s\S]*?)>>/g, (_match, body: string) => {
        const separator = body.indexOf('｜');
        const reference = separator < 0 ? '' : body.slice(0, separator).trim();
        const note = separator < 0 ? '' : body.slice(separator + 1).trim().replace(/\s+/g, ' ').slice(0, 500);
        if (/^[a-f0-9]{24}$/.test(reference) && note) reviews.push({ reference, note });
        return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { text, reviews: reviews.slice(0, 1) };
}

/** 她处理已出现过的待核对项时用隐藏标记作决定；无效或空更正不会保存。 */
export function takeMemoryReviewResolution(input: string): { text: string; resolutions: Array<{ reference: string; decision: { kind: 'confirm' } | { kind: 'correct'; correction: string } }> } {
    const resolutions: Array<{ reference: string; decision: { kind: 'confirm' } | { kind: 'correct'; correction: string } }> = [];
    const text = input.replace(/<<记忆核对结果[：:]([\s\S]*?)>>/g, (_match, body: string) => {
        const separator = body.indexOf('｜');
        const reference = separator < 0 ? '' : body.slice(0, separator).trim();
        const result = separator < 0 ? '' : body.slice(separator + 1).trim();
        if (/^[a-f0-9]{24}$/.test(reference) && result === '确认原记录') resolutions.push({ reference, decision: { kind: 'confirm' } });
        else if (/^[a-f0-9]{24}$/.test(reference) && /^补充更正[：:]/.test(result)) {
            const value = result.replace(/^补充更正[：:]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 500);
            if (value) resolutions.push({ reference, decision: { kind: 'correct', correction: value } });
        }
        return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { text, resolutions: resolutions.slice(0, 1) };
}

export interface SelfNotesModuleOptions {
    /** 私密的话写进她自己的地方 */
    keepPrivate: (text: string) => void;
    /** 她在男朋友档聊天里写的日记在本地留一份（配置 diaryInsights 开着才给）；抛错只记日志 */
    keepDiary?: (text: string, contact: Contact) => void;
    /** 写进长期记忆；没开长期记忆时返回 undefined */
    remember: (contact: Contact, text: string, kind: '记住' | '日记') => Promise<void> | undefined;
    /** 记录她主动查记忆时提出的核对依据；由 App 限定为设备所有者 */
    reviewMemory?: (contact: Contact, review: { reference: string; note: string }) => void;
    log: Log;
}

export function selfNotesModule(options: SelfNotesModuleOptions): Module {
    return {
        id: 'self-notes',
        absorbAt: {
            notes: (input, contact) => {
                const reviewed = takeMemoryReview(takeMemoryReviewResolution(input).text);
                for (const review of reviewed.reviews) {
                    try { options.reviewMemory?.(contact, review); }
                    catch (error) { options.log(`[${contact.qq}] 记忆核对依据没能保存：${error instanceof Error ? error.message : String(error)}`); }
                }
                const taken = takeSelfNotes(reviewed.text);
                for (const note of taken.notes) {
                    if (note.kind === '私密') {
                        options.keepPrivate(note.text);
                        continue;
                    }
                    if (note.kind === '日记' && options.keepDiary && contact.tier === 'boyfriend') {
                        try { options.keepDiary(note.text, contact); } catch (error) { options.log(`[${contact.qq}] 她写的日记没能在本地留一份：${error instanceof Error ? error.message : String(error)}`); }
                    }
                    void options.remember(contact, note.text, note.kind)
                        ?.catch(error => options.log(`[${contact.qq}] 她自己记的事没写进记忆：${error instanceof Error ? error.message : String(error)}`));
                }
                return taken.text;
            },
        },
    };
}
