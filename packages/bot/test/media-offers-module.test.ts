import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { contributeTurn, type Turn, type TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { intentModule } from '../src/modules/intent.ts';
import { mediaOffersModule, type MediaOffersFacts } from '../src/modules/media-offers.ts';
import type { BotConfig } from '../src/platform/config.ts';
import { createContactResponder, loadTierCard, type ContactPipelineOptions } from '../src/platform/contact.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { syntheticCardPattern } from './fixtures/card.ts';
import type { StickerShelf } from '../src/social/stickers.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { photoShelf, type PhotoShelf } from '../src/vision/photos.ts';

// 图片表情清单（ADR 0063 / 0099 / 0132）和照片清单（ADR 0109 / 0128 / 0240）迁成模块（ADR 0336）：清单在联系人流水线原位取（货架每取一次都碰索引 / 文件，
// 取的次数和先后是行为），写进 turn.facts，模块只放 sticker、photo 两个槽。
// 行为基线里一处都没有（没有场景开图片表情和照片货架）；App 那一路由 app.test.ts 的图片表情和照片货架用例管，这里管模块本身、
// 和联系人流水线那一路「各放一次、货架各取两次（条件一次、内容一次）」。全部用合成角色、合成图片、假模型。

type Facts = TurnFacts & MediaOffersFacts;

const STICKERS = '[这一轮你要发一个图片表情：文字回完以后，另起一行单独写 <sticker:编号>（这一行必须有）]\n- <sticker:123456abcdef>：合成白猫捂嘴偷笑（好笑）';
const PHOTOS = '[你手机里风景的照片（都是以前拍的，别说成刚拍的；只能从下面选，编号不解释，一轮最多发一张）]\n- <photo:0123456789ab>：合成晚霞';

describe('图片表情和照片清单（ADR 0063 / 0109 / 0336）', () => {
    const at = new Date('2026-11-05T12:00:00+08:00');
    const turnOf = (facts: Facts = {}, patch: Partial<Turn> = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: '哈哈哈哈笑死我了', time: at.toISOString() }], thinking: false, facts, ...patch,
    });
    const run = (t: Turn) => mediaOffersModule().contribute!(t) as Piece[];

    test('旧逻辑没写（没抽到、货架里没有、不发照片）：什么都不放；空串当没有', () => {
        assert.deepEqual(run(turnOf()), []);
        assert.deepEqual(run(turnOf({ stickerLine: '', photoLine: '' })), []);
        assert.deepEqual(run(turnOf({ photo: 'view', stickerOnly: true })), [], '只有判断、没有清单：不放（清单由旧逻辑原位取）');
    });

    test('两段各进各的槽，原文照放', () => {
        assert.deepEqual(run(turnOf({ stickerLine: STICKERS })), [{ slot: 'sticker', text: STICKERS }]);
        assert.deepEqual(run(turnOf({ photoLine: PHOTOS })), [{ slot: 'photo', text: PHOTOS }]);
        assert.deepEqual(run(turnOf({ stickerLine: STICKERS, photoLine: PHOTOS })), [{ slot: 'sticker', text: STICKERS }, { slot: 'photo', text: PHOTOS }]);
    });

    test('条件都在取的地方：同学档、危机、主动找他也照放', () => {
        const facts: Facts = { stickerLine: STICKERS, photoLine: PHOTOS, crisis: { match: '', level: 'concern' } };
        for (const patch of [{ contact: { qq: 2, name: '小周', tier: 'classmate' } }, { initiate: { note: '', topic: '' } }] satisfies Partial<Turn>[]) {
            assert.equal(run(turnOf(facts, patch)).length, 2);
        }
    });

    test('同步返回；「此刻」块里表情清单在照片清单前面', () => {
        const assembled = contributeTurn([mediaOffersModule()], turnOf({ photoLine: PHOTOS, stickerLine: STICKERS }));
        assert.ok(!(assembled instanceof Promise));
        assert.deepEqual(assembled.afterHistory, [[STICKERS, PHOTOS].join('\n')]);
    });

    describe('联系人流水线那一路（接线前旧逻辑放、接线后模块放；模块没挂或旧逻辑没写 facts 时是 0）', () => {
        const NOW = Date.parse('2026-11-05T12:00:00+08:00');
        async function promptFor(said: string, overrides: Partial<ContactPipelineOptions>): Promise<string> {
            const rows: StoredMessage[] = [];
            const prompts: OpenAIMessage[][] = [];
            const responder = createContactResponder({
                contact: { qq: 1, name: '阿明', tier: 'boyfriend', knowsBot: true },
                card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红' } }), worldInfo: [] },
                llm: { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' },
                prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
                history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
                now: () => NOW, log: () => {}, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
                turnModules: [intentModule(), mediaOffersModule()],
                send: async () => 101,
                generate: async () => '哈哈哈',
                onPrompt: prompt => { prompts.push(prompt.messages); },
                ...overrides,
            });
            try { responder.receive(said, 1, new Date(NOW)); await responder.whenIdle(); }
            finally { responder.stop(); }
            assert.equal(prompts.length, 1);
            return prompts[0]!.map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n');
        }
        const count = (text: string, needle: string) => text.split(needle).length - 1;
        const stickerShelfOf = (answer: string | undefined, calls: ({ text: string; only?: boolean } | undefined)[]): StickerShelf => ({
            consider: async () => undefined, discover: async () => undefined,
            prompt: context => { calls.push(context); return answer; },
            clean: text => text, resolve: () => undefined, history: text => text, used: () => undefined, status: () => ({ count: 1 }),
        });

        test('图片表情：抽到了，清单放一次；货架取了两次（条件一次、内容一次），两次都按他这句话', async () => {
            const calls: ({ text: string; only?: boolean } | undefined)[] = [];
            const text = await promptFor('哈哈哈哈笑死我了', { stickers: stickerShelfOf(STICKERS, calls), stickerChance: 1 });
            assert.equal(count(text, STICKERS), 1);
            assert.deepEqual(calls, [{ text: '哈哈哈哈笑死我了' }, { text: '哈哈哈哈笑死我了' }]);
        });

        test('图片表情：货架里挑不出来，只取一次、不放', async () => {
            const calls: ({ text: string; only?: boolean } | undefined)[] = [];
            const text = await promptFor('哈哈哈哈笑死我了', { stickers: stickerShelfOf(undefined, calls), stickerChance: 1 });
            assert.equal(count(text, '<sticker:'), 0);
            assert.equal(calls.length, 1);
        });

        test('图片表情：没抽到，一次都不取', async () => {
            const calls: ({ text: string; only?: boolean } | undefined)[] = [];
            await promptFor('哈哈哈哈笑死我了', { stickers: stickerShelfOf(STICKERS, calls), stickerChance: 0 });
            assert.equal(calls.length, 0);
        });

        test('照片：他要看风景、货架里有，清单放一次；货架的清单取了两次（每次都重读索引）', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'qqbot-media-offers-'));
            try {
                const source = join(dir, 'view.jpg');
                writeFileSync(source, Buffer.from([0xff, 0xd8, 0xff, ...Buffer.from('synthetic-view')]));
                const shelf = photoShelf({ dir: join(dir, 'shelf'), log: () => {}, now: () => new Date(NOW) });
                const entry = shelf.add(source, 'view', '合成晚霞');
                const prompted: [string, string | undefined][] = [];
                const counted: PhotoShelf = { ...shelf, prompt: (kind, dish) => { prompted.push([kind, dish]); return shelf.prompt(kind, dish); } };
                const text = await promptFor('发张风景的照片我看看', { photos: counted });
                assert.equal(count(text, `- <photo:${entry.id}>：合成晚霞`), 1);
                assert.deepEqual(prompted, [['view', undefined], ['view', undefined]]);
            } finally { rmSync(dir, { recursive: true, force: true }); }
        });
    });

    // 模拟器那一路（场景的 stickers / photos 是真的货架代码）：行为基线碰不到；接线后模拟器没挂这个模块，这里是 0、报错
    describe('模拟器那一路', () => {
        const llm: BotConfig['llm'] = { baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {} };
        const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
        const run = async (said: string, patch: Record<string, unknown>) => {
            const dir = mkdtempSync(join(tmpdir(), 'qqbot-media-offers-sim-'));
            const prompts: string[] = [];
            try {
                await runScenario(parseScenario({
                    name: 'media-offers', tier: 'boyfriend', start: '2026-11-05T12:00:00+08:00', memory: false, schedule: false,
                    ...patch, steps: [{ say: said }, { advance: '10m' }],
                }), {
                    runId: 'media-offers', dataDir: dir, card: loadTierCard(syntheticCardPattern, 'boyfriend'), llm, prompt, settle: { quietMs: 10, maxMs: 50 },
                    generate: async messages => { prompts.push(messages.map(m => String(m.content)).join('\n')); return '哈哈哈'; },
                });
            } finally { rmSync(dir, { recursive: true, force: true }); }
            assert.ok(prompts.length >= 1);
            return prompts[0]!;
        };
        const count = (text: string, needle: string) => text.split(needle).length - 1;

        test('图片表情：抽到了，收藏清单放一次', async () => {
            const text = await run('哈哈哈哈笑死我了', { stickers: [{ id: 'a1b2c3d4e5f6', description: '合成橘猫翻白眼', tags: ['好笑'] }], stickerChance: 1 });
            assert.equal(count(text, '- <sticker:a1b2c3d4e5f6>：合成橘猫翻白眼'), 1, text);
        });

        test('照片：他要看风景、货架里有，清单放一次', async () => {
            const text = await run('发张风景的照片我看看', { photos: [{ kind: 'view', caption: '合成晚霞' }] });
            assert.equal(count(text, '>：合成晚霞'), 1, text);
        });
    });
});
