// 角色卡示例对话（mes_example）拆成 Chat Completion 消息。对照 vendor/SillyTavern：
//   public/script.js parseMesExamples：按 <START> 分块（不以 <START> 开头时先补一个）
//   public/scripts/openai.js setOpenAIMessageExamples / parseExampleIntoIndividual：
//     每块第一行是块头，跳过；以“{{user}}:”开头的行起一条 example_user，以“{{char}}:”开头的行起一条 example_assistant，
//     不以名字开头的行并入当前这条；内容去掉第一处“名字:”再去首尾空白；role 都是 system，name 标出是谁说的
// 只实现单角色私聊（没有群聊的名字前缀）。传进来的文本要先做过宏替换（ST 是 baseChatReplace）。

import type { OpenAIMessage } from '../language/prompt.ts';
import type { MacroNames } from './macros.ts';

export function parseMesExamples(examples: string): string[] {
    if (!examples || examples === '<START>') return [];
    const text = examples.startsWith('<START>') ? examples : `<START>\n${examples.trim()}`;
    return text.split(/<START>/gi).slice(1).map(block => `<START>\n${block.trim()}\n`);
}

export function parseExampleIntoIndividual(block: string, names: MacroNames): OpenAIMessage[] {
    const lines = block.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '').split('\n');
    const result: OpenAIMessage[] = [];
    let current: string[] = [];
    let speaker: 'user' | 'char' | null = null;

    const add = (who: 'user' | 'char') => {
        const name = who === 'user' ? names.user : names.char;
        result.push({
            role: 'system',
            content: current.join('\n').replace(`${name}:`, '').trim(),
            name: who === 'user' ? 'example_user' : 'example_assistant',
        });
        current = [];
    };

    for (const line of lines.slice(1)) {
        if (line.startsWith(`${names.user}:`)) {
            if (speaker === 'char') add('char');
            speaker = 'user';
        } else if (line.startsWith(`${names.char}:`)) {
            if (speaker === 'user') add('user');
            speaker = 'char';
        }
        current.push(line);
    }
    if (speaker) add(speaker);
    return result;
}
