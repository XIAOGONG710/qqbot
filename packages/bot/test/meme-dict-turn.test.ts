// 梗百科那一行（DSH 2026-10-29）和热梗模块（ADR 0129 / 0336）的配合：他提到的词已经在热梗那一行里，就不再从词库给一遍。
// 热梗那一行由模块在 contribute 时写进 turn.facts.meme，旧逻辑拼段落时读它；行为基线的场景里没有词库，这里单独兜。
// 全部使用合成聊天、假模型，不访问真实运行数据。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { intentModule } from '../src/modules/intent.ts';
import { memesModule } from '../src/modules/memes.ts';
import { createContactResponder, type ContactPipelineOptions } from '../src/platform/contact.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

const NOW = Date.parse('2026-11-05T12:00:00+08:00');
const quiet = () => {};
const llm = { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' as const };
const character = () => parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红' } });
const library = [{ term: '尊嘟假嘟', meaning: '“真的假的”的卖萌说法', example: '', confidence: 'high' as const, firstSeen: '2026-11-01', lastSeen: '2026-11-04', seen: 3 }];
const dict = {
    mention: (text: string) => ['尊嘟假嘟', '绝绝子'].filter(term => text.includes(term)).map(term => ({ term, meaning: `${term}的用法`, origin: '', tags: '' }))[0],
};
const DICT_LINE = '他这句里提到一个网络词';

async function promptFor(said: string, overrides: Partial<ContactPipelineOptions> = {}): Promise<string> {
    const rows: StoredMessage[] = [];
    const prompts: OpenAIMessage[][] = [];
    const responder = createContactResponder({
        contact: { qq: 1, name: '小明', tier: 'boyfriend', knowsBot: true },
        card: { character: character(), worldInfo: [] }, llm,
        prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
        history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
        now: () => NOW, log: quiet, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
        turnModules: [intentModule(), memesModule(() => library, quiet)],
        memeDict: dict,
        send: async () => 101,
        generate: async () => '真的呀',
        onPrompt: prompt => { prompts.push(prompt.messages); },
        ...overrides,
    });
    try { responder.receive(said, 1, new Date(NOW)); await responder.whenIdle(); }
    finally { responder.stop(); }
    assert.ok(prompts.length >= 1, '应该生成过一次');
    return prompts[0]!.map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n');
}

describe('梗百科与热梗模块（DSH 梗百科 / ADR 0129）', () => {
    test('他用的词已经在热梗那一行里：只给热梗的意思，不再从词库给一遍', async () => {
        const prompt = await promptFor('尊嘟假嘟');
        assert.ok(prompt.includes('他这一句里用了个网上的梗「尊嘟假嘟」'));
        assert.ok(!prompt.includes(DICT_LINE));
    });

    test('他用的词不在热梗库里：从词库给', async () => {
        const prompt = await promptFor('今天这个饭绝绝子');
        assert.ok(prompt.includes(`${DICT_LINE}「绝绝子」`));
    });

    test('热梗没开（没有热梗模块）：词库照样给', async () => {
        const prompt = await promptFor('尊嘟假嘟', { turnModules: [intentModule()] });
        assert.ok(prompt.includes(`${DICT_LINE}「尊嘟假嘟」`));
        assert.ok(!prompt.includes('他这一句里用了个网上的梗'));
    });
});
