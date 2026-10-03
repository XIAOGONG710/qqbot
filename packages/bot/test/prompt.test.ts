import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { buildPrompt, ST_DEFAULT_PRESET, type ChatMessage, type PromptInput } from '../src/prompt.ts';
import { loadCharacterCard, parseCharacterCard, type Character } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS, loadWorldInfo, parseWorldInfo } from '../src/st/world-info.ts';
import { estimateTokens } from '../src/tokens.ts';

const stDir = resolve(import.meta.dirname, '../../../characters/linmengyao/st');
const card = loadCharacterCard(resolve(stDir, 'linmengyao.json'));
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
        assert.deepEqual(messages.map(m => m.role), ['system', 'system', 'system', 'system', 'system', 'system', 'user', 'system']);
        assert.equal(messages[0]!.content, '你是林梦瑶，正在用 QQ 和阿明私聊。下面是你的设定。');
        assert.ok(messages[1]!.content.startsWith('林梦瑶，在读学生。下文的「你」就是林梦瑶'));
        assert.equal(messages[2]!.content, card.personality);
        assert.ok(messages[3]!.content.startsWith('正在和你私聊的阿明就是你的男朋友'));
        assert.equal(messages[4]!.content, scene.content, '世界书 after 放在角色设定之后');
        assert.equal(messages[5]!.content, ST_DEFAULT_PRESET.newChatPrompt);
        assert.equal(messages[6]!.content, '宝宝在干嘛');
        assert.equal(messages[7]!.content, card.postHistoryInstructions);
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
        const { messages } = build(history, { settings: { ...settings, maxContext: 3000 } });
        const chat = messages.filter(m => m.role !== 'system');
        assert.ok(chat.length > 0 && chat.length < history.length);
        assert.equal(chat.at(-1)!.content, history.at(-1)!.content);
        const total = messages.reduce((sum, m) => sum + estimateTokens(m.role) + estimateTokens(m.content), 0);
        assert.ok(total <= 3000 - 300 - 3);
    });
});

describe('拼装规则', () => {
    test('角色卡没有 system_prompt 时用预设的 main', () => {
        const { messages } = build([{ role: 'user', content: '嗨' }], { character: minimalCard({ description: 'd' }), worldInfo: [] });
        assert.deepEqual(messages.map(m => m.content), [
            'Write 小红\'s next reply in a fictional chat between 小红 and 阿明.',
            'd',
            '[Start a new Chat]',
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

    test('有示例对话的角色卡报错（运行时尚未实现）', () => {
        assert.throws(() => build([], { character: minimalCard({ mes_example: '<START>\n{{user}}: hi' }), worldInfo: [] }), /示例对话/);
    });

    test('不是角色卡的 JSON 报错', () => {
        assert.throws(() => parseCharacterCard({ entries: {} }), /不是角色卡/);
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

