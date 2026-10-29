// 把人设卡渲染成一段纯文本（「同一个她」任务书 §1 第 3 条）。
// 目的：DSH 桌面的她读的是同一份卡渲染出来的东西，不再另有一份人设正文。
// 刻意**不含**示例对话（mes_example）和运行时块：示例是给 QQ 的语气锚，桌面端不需要，也容易被她当成剧本来演。
import type { MacroNames } from './macros.ts';
import { substituteMacros } from './macros.ts';

export interface PersonaCardFields {
    name?: string;
    system_prompt?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    post_history_instructions?: string;
}

export interface RenderPersonaInput {
    card: PersonaCardFields;
    names: MacroNames;
    /** 卡文件的位置或摘要，写进文件头，方便判断这份是不是过期了 */
    source?: string;
}

/** 卡 → 一段文字。顺序：身份声明、设定、性格、场景、说话规矩；空字段跳过 */
export function renderPersona(input: RenderPersonaInput): string {
    const { card, names } = input;
    const parts: string[] = [];
    const push = (text?: string) => {
        const value = substituteMacros(String(text ?? '').trim(), names).trim();
        if (value) parts.push(value);
    };
    push(card.system_prompt);
    push(card.description);
    push(card.personality);
    push(card.scenario);
    push(card.post_history_instructions);
    const body = parts.join('\n\n');
    const header = [
        '<!-- 生成的，别手改：来源是人设卡，改卡后再跑一次 scripts/build-dsh-persona.mjs -->',
        `<!-- 卡：${input.source ?? '（未注明）'} · 生成 ${new Date().toISOString()} -->`,
        '',
    ].join('\n');
    return `${header}${body}\n`;
}
