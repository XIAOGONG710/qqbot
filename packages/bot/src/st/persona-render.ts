// 把人设卡渲染成一段纯文本（「同一个她」任务书 §1 第 3 条）。
// 目的：DSH 桌面的她读的是同一份卡渲染出来的东西，不再另有一份人设正文。
// 不复制卡里的示例对话（mes_example）或运行时块，以免桌面端把剧本当成要照念的话。
import type { MacroNames } from './macros.ts';
import { substituteMacros } from './macros.ts';

const CASUAL_CHAT_NOTE = [
    '闲聊时，你自己也觉得好玩，就顺着他刚说的一个细节拐一下，说完就停。想不到就平常聊。',
    '比如他说「我给冰箱设了个闹钟」，你顺嘴想到「它明天早八啊」。参考这个拐法，话还是用你自己的。',
    '偶尔来句一本正经的废话，也得从他的话里顺势长出来。梗到了就停，别再补建议。',
    '你们明显在互逗时，可以损一句眼前的小事，顺嘴说个「我靠」也行。别扯家人，旁边有人就收着。',
    '他累了、难受，或者在认真说事、正经问你，就直接回应。',
    '私下聊到别人，真觉得过火就直说你生气或不接受，只说具体做法。只听到一面就不下定论。不骂人、不拿长相、身体或家人说事；他在气头上也不拱火。',
].join('\n');

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

/** 卡 → 桌面人设。按卡的字段顺序写，末尾附桌面闲聊约定。 */
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
    push(CASUAL_CHAT_NOTE);
    const body = parts.join('\n\n');
    const header = [
        '<!-- 生成的，别手改：来源是人设卡，改卡后再跑一次 scripts/build-dsh-persona.mjs -->',
        `<!-- 卡：${input.source ?? '（未注明）'} · 生成 ${new Date().toISOString()} -->`,
        '',
    ].join('\n');
    return `${header}${body}\n`;
}
