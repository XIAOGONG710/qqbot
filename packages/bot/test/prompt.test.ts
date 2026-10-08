import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { buildPrompt, ST_DEFAULT_PRESET, type ChatMessage, type OpenAIMessage, type PromptInput } from '../src/prompt.ts';
import { loadCharacterCard, parseCharacterCard, type Character } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS, loadWorldInfo, parseWorldInfo } from '../src/st/world-info.ts';
import { estimateTokens } from '../src/tokens.ts';

const stDir = resolve(import.meta.dirname, '../../../characters/linmengyao/st');
const card = loadCharacterCard(resolve(stDir, 'linmengyao-boyfriend.json'));
const lorebook = loadWorldInfo(resolve(stDir, `${card.world}.json`), card.world);

const settings = { maxContext: 8192, maxTokens: 300, worldInfo: DEFAULT_WORLD_INFO_SETTINGS };

function build(history: ChatMessage[], overrides: Partial<PromptInput> = {}) {
    return buildPrompt({
        character: card,
        worldInfo: lorebook,
        history,
        userName: '阿明',
        settings,
        countTokens: estimateTokens,
        ...overrides,
    });
}

const minimalCard = (data: Record<string, unknown>): Character =>
    parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红', ...data } });

describe('用林梦瑶的角色卡拼提示词', () => {
    test('消息顺序同 ST 默认预设，宏已替换', () => {
        const { messages } = build([{ role: 'user', content: '宝宝在干嘛' }]);
        const scene = lorebook.find(e => e.key.includes('在干嘛'))!;
        assert.equal(messages[0]!.content, '你是林梦瑶，正在用 QQ 和阿明私聊。下面是你的设定。');
        assert.ok(messages[1]!.content.startsWith('林梦瑶，在读大学生。下文的「你」就是林梦瑶'));
        assert.equal(messages[2]!.content, card.personality);
        assert.ok(messages[3]!.content.startsWith('正在和你私聊的阿明就是你的男朋友'));
        assert.equal(messages[4]!.content, scene.content, '世界书 after 放在角色设定之后');
        // 示例对话：每块一条 [Example Chat]，接着一问一答
        const examples = messages.slice(5, -3);
        const blocks = card.mesExample.split('<START>').length - 1;
        assert.equal(examples.filter(m => m.content === ST_DEFAULT_PRESET.newExampleChatPrompt).length, blocks);
        assert.deepEqual(examples.slice(0, 3).map(m => m.name), [undefined, 'example_user', 'example_assistant']);
        assert.equal(examples.length, blocks * 3);
        assert.deepEqual(messages.slice(-3).map(m => m.role), ['system', 'user', 'system']);
        assert.equal(messages.at(-3)!.content, ST_DEFAULT_PRESET.newChatPrompt);
        assert.equal(messages.at(-2)!.content, '宝宝在干嘛');
        assert.equal(messages.at(-1)!.content, card.postHistoryInstructions);
        assert.ok(messages.every(m => !/\{\{|\}\}/.test(m.content)), '不应残留宏');
    });

    test('没命中场景时不注入世界书', () => {
        const { messages, activatedWorldInfo } = build([{ role: 'user', content: '今天好热' }]);
        assert.equal(activatedWorldInfo.length, 0);
        assert.ok(!messages.some(m => m.content.startsWith('[场景参考')));
    });

    test('只按最近两条消息匹配场景（她自己的上一句也算）', () => {
        const history: ChatMessage[] = [
            { role: 'user', content: '要抱抱' },
            { role: 'assistant', content: '才不要' },
            { role: 'user', content: '好吧' },
        ];
        assert.equal(build(history).activatedWorldInfo.length, 0);
        const recent = build([{ role: 'assistant', content: '在干嘛呢你' }, { role: 'user', content: '好吧' }]);
        assert.ok(recent.activatedWorldInfo.some(e => e.key.includes('干嘛呢')));
    });

    test('聊天记录超出预算时丢最早的，保留最新的', () => {
        const history: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `第${i}条消息，凑一点长度凑一点长度凑一点长度`,
        }));
        const { messages } = build(history, { settings: { ...settings, maxContext: 3500 } });
        const chat = messages.filter(m => m.role !== 'system');
        assert.ok(chat.length > 0 && chat.length < history.length);
        assert.equal(chat.at(-1)!.content, history.at(-1)!.content);
        const total = messages.reduce((sum, m) => sum + estimateTokens(m.role) + estimateTokens(m.content), 0);
        assert.ok(total <= 3500 - 300 - 3);
    });
});

describe('说到才想起的设定（DSH 诊断 2.4）', () => {
    test('同学档：王者荣耀那段不在卡里，说到王者、空洞骑士时才从世界书进来', () => {
        const classmate = loadCharacterCard(resolve(stDir, 'linmengyao-classmate.json'));
        const book = loadWorldInfo(resolve(stDir, `${classmate.world}.json`), classmate.world);
        const prompt = (content: string) => build([{ role: 'user', content }], { character: classmate, worldInfo: book });
        const text = (content: string) => prompt(content).messages.map(m => m.content).join('\n');
        assert.doesNotMatch(text('孩子你无敌了'), /本命英雄是貂蝉/);
        assert.match(text('今晚打王者吗'), /本命英雄是貂蝉/);
        assert.match(text('空洞骑士那个boss过了没'), /菜猫/);
    });
});

describe('拼装规则', () => {
    test('角色卡没有 system_prompt 时用预设的 main', () => {
        const { messages } = build([{ role: 'user', content: '嗨' }], { character: minimalCard({ description: 'd' }), worldInfo: [] });
        assert.deepEqual(messages.map(m => m.content), [
            'Write 小红\'s next reply in a fictional chat between 小红 and 阿明.',
            'd',
            // 没有示例对话：不插 [Start a new Chat]（DSH 诊断 2.3）
            '嗨',
        ]);
    });

    test('{{original}} 展开为被覆盖的预设原文', () => {
        const character = minimalCard({ system_prompt: '{{original}} 用中文。' });
        const { messages } = build([], { character, worldInfo: [] });
        assert.equal(messages[0]!.content, 'Write 小红\'s next reply in a fictional chat between 小红 and 阿明. 用中文。');
    });

    test('世界书 before 在 main 之后、角色描述之前', () => {
        const worldInfo = parseWorldInfo({ entries: { 0: { uid: 0, constant: true, position: 0, content: '世界观' } } }, 'w');
        const { messages } = build([], { character: minimalCard({ description: 'd' }), worldInfo });
        assert.deepEqual(messages.slice(0, 3).map(m => m.content).slice(1), ['世界观', 'd']);
    });

    test('示例对话按块拆开：每块前一条 [Example Chat]，按说话人分条带 name，放在聊天记录之前', () => {
        const character = minimalCard({
            description: 'd',
            post_history_instructions: 'phi',
            mes_example: '{{user}}: 在吗\n{{char}}: 在\n刚下课\n<START>\n{{user}}: 晚安\n{{user}}: 睡了\n{{char}}: 晚安',
        });
        const { messages } = build([{ role: 'user', content: '嗨' }], { character, worldInfo: [] });
        const ex = (content: string, name: string): OpenAIMessage => ({ role: 'system', content, name });
        assert.deepEqual(messages.slice(1), [
            { role: 'system', content: 'd' },
            { role: 'system', content: '[Example Chat]' },
            ex('在吗', 'example_user'),
            ex('在\n刚下课', 'example_assistant'),
            { role: 'system', content: '[Example Chat]' },
            ex('晚安\n阿明: 睡了', 'example_user'),
            ex('晚安', 'example_assistant'),
            { role: 'system', content: '[Start a new Chat]' },
            { role: 'user', content: '嗨' },
            { role: 'system', content: 'phi' },
        ]);
    });

    test('示例对话默认用聊天记录剩下的预算，整块放不下就停；pinExamples 时先放示例', () => {
        const block = (i: number) => `<START>\n{{user}}: 例${i}问，凑一点长度凑一点长度\n{{char}}: 例${i}答，凑一点长度凑一点长度`;
        const character = minimalCard({ mes_example: [1, 2, 3].map(block).join('\n') });
        const history: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `第${i}条消息，凑一点长度凑一点长度凑一点长度`,
        }));
        const count = (pinExamples: boolean, length: number) => {
            const { messages } = build(history.slice(-length), {
                character, worldInfo: [], settings: { ...settings, maxContext: 1500, pinExamples },
            });
            return {
                examples: messages.filter(m => m.name === 'example_user').length,
                chat: messages.filter(m => m.role !== 'system').length,
            };
        };
        assert.deepEqual(count(false, 4), { examples: 3, chat: 4 }, '记录少时示例都放得下');
        assert.equal(count(false, 200).examples, 0, '记录占满预算时示例被挤掉');
        const pinned = count(true, 200);
        assert.equal(pinned.examples, 3, '置顶时示例始终保留');
        assert.ok(pinned.chat < count(false, 200).chat, '置顶时聊天记录让出示例的预算');
    });

    test('运行时追加的内容放在聊天记录之后、末尾指令之前，计入预算；时间宏按 now 替换', () => {
        const character = minimalCard({ description: '今天是{{weekday}}', post_history_instructions: 'phi' });
        const { messages } = build([{ role: 'user', content: '嗨' }], {
            character,
            worldInfo: [],
            afterHistory: ['[当前时间：…]', ''],
            now: new Date('2026-10-04T12:00:00'),
        });
        assert.deepEqual(messages.slice(1).map(m => m.content), ['今天是星期日', '嗨', '[当前时间：…]', 'phi']);
    });

    test('不是角色卡的 JSON 报错', () => {
        assert.throws(() => parseCharacterCard({ entries: {} }), /不是角色卡/);
    });

    test('回复节奏系数（extensions.qqbot.pace，ADR 0013）：没写是 1，超出 0.5–3 报错；生成的卡里同学档 1.6、名单外 2.2', () => {
        const parse = (qqbot: object) => parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红', extensions: { qqbot } } });
        assert.equal(parse({ banned: [] }).pace, 1);
        assert.equal(parse({ banned: [], pace: 1.6 }).pace, 1.6);
        assert.throws(() => parse({ banned: [], pace: 5 }), /pace 应为 0\.5–3 的数/);
        assert.throws(() => parse({ banned: [], pace: '2' }), /pace/);
        const pace = (tier: string) => loadCharacterCard(resolve(stDir, `linmengyao-${tier}.json`)).pace;
        assert.deepEqual(['boyfriend', 'classmate', 'stranger', 'unlisted'].map(pace), [1, 1.6, 2.2, 2.2]);
    });

    test('personaDescription（dummyId 100001）插在世界书 before 之后、角色描述之前，宏已替换', () => {
        const worldInfo = parseWorldInfo({ entries: { 0: { uid: 0, constant: true, position: 0, content: '世界观' } } }, 'w');
        const { messages } = build([], {
            character: minimalCard({ description: '角色描述' }),
            worldInfo,
            userPersona: '{{user}}是{{char}}的同班同学，坐后排。',
        });
        // 顺序应为：main -> wi.before ('世界观') -> personaDescription -> charDescription ('角色描述') -> [Start a new Chat]
        assert.equal(messages[1]!.content, '世界观');
        assert.equal(messages[2]!.content, '阿明是小红的同班同学，坐后排。');
        assert.equal(messages[3]!.content, '角色描述');
    });
});

