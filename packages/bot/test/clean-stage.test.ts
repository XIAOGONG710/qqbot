import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CLEAN_STAGES, cleanStages, createInterpreter, type CleanCtx, type Module, type Turn } from '../src/interpreter/interpreter.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { createContactResponder, type ContactPipelineOptions } from '../src/platform/contact.ts';
import { stripDeviceTokens, type ParsedTokens } from '../src/platform/device-actions.ts';
import { crisisModule } from '../src/modules/crisis.ts';
import { intentModule } from '../src/modules/intent.ts';
import { candidatesModule } from '../src/modules/candidates.ts';
import { mediaOffersModule } from '../src/modules/media-offers.ts';
import { reviewExitModule } from '../src/modules/review-exit.ts';
import { reviewFinalizeModule } from '../src/modules/review-finalize.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// 清理顺序表和草稿（ADR 0336「生成之后那一段」第 8、9 步）：行为基线 media / candidates / devices / review 场景逐字不变，这里核对表本身、媒体清理的模块和设备指令跟着哪一稿走
const turnOf = (facts: Turn['facts'] = {}): Turn => ({ contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T20:00:00+08:00'), history: [], thinking: false, facts });
const ID = '0123456789ab';

describe('清理顺序表（ADR 0336 第 9 步）', () => {
    test('顺序照迁移前的手写顺序：图片表情 → 照片 → 只发表情', () => {
        assert.deepEqual([...CLEAN_STAGES], ['stickers', 'photos', 'stickerOnly']);
    });

    test('先按表上的位置、同一位置再按注册顺序；同步返回；货架经 CleanCtx 给到', () => {
        const seen: string[] = [];
        const ctx: CleanCtx = { stickers: { clean: text => text } };
        const late: Module = { id: 'late', cleanAt: { stickerOnly: text => `${text}3`, stickers: (text, _turn, got) => { seen.push(got === ctx ? 'ctx' : 'other'); return `${text}1`; } } };
        const early: Module = { id: 'early', cleanAt: { photos: text => `${text}2`, stickers: text => `${text}0` } };
        const out = cleanStages([late, early], '稿', turnOf(), ctx);
        assert.equal(out, '稿1023');
        assert.deepEqual(seen, ['ctx']);
        assert.equal(cleanStages([], '原稿', turnOf(), {}), '原稿');
    });

    test('只挂了 cleanAt 的模块也交给联系人流水线（createInterpreter 不筛掉它）', () => {
        const only: Module = { id: 'only-clean', cleanAt: { photos: text => text } };
        const interpreter = createInterpreter({ modules: [only], exec: { every: () => 0 as never, cancel: () => {} } });
        assert.deepEqual(interpreter.turnModules.map(module => module.id), ['only-clean']);
    });
});

describe('图片表情和照片的清理（modules/media-offers.ts 的 cleanAt）', () => {
    const clean = (text: string, facts: Turn['facts'] = {}, ctx: CleanCtx = {}) => cleanStages([mediaOffersModule()], text, turnOf(facts), ctx);

    test('没有货架：表情和照片编号一律摘掉', () => {
        assert.equal(clean(`好呀\n<sticker:${ID}>\n<photo:${ID}>`, { stickersAllowed: true, photo: 'cat' }), '好呀');
    });

    test('有收藏库：按这一轮允不允许交给收藏库（没写 stickersAllowed 就是不允许）', () => {
        const calls: [string, boolean | undefined][] = [];
        const ctx: CleanCtx = { stickers: { clean: (text, allow) => { calls.push([text, allow]); return `${text}!`; } } };
        assert.equal(clean('稿', {}, ctx), '稿!');
        assert.equal(clean('稿', { stickersAllowed: true }, ctx), '稿!');
        assert.deepEqual(calls, [['稿', false], ['稿', true]]);
    });

    test('有照片货架：这一轮发照片才允许，范围是那一类（吃的再加那道菜）；不发照片时不给范围', () => {
        const calls: unknown[][] = [];
        const ctx: CleanCtx = { photos: { clean: (...args) => { calls.push(args); return 'x'; } } };
        clean('稿', {}, ctx);
        clean('稿', { photo: 'view' }, ctx);
        clean('稿', { photo: 'food', photoDish: '合成菜' }, ctx);
        assert.deepEqual(calls, [['稿', false, undefined], ['稿', true, { kind: 'view' }], ['稿', true, { kind: 'food', dish: '合成菜' }]]);
    });

    test('只发表情的轮次：多写的文字去掉、只留表情那一行；没写表情就照写的发；不是这种轮次不动', () => {
        const ctx: CleanCtx = { stickers: { clean: text => text } };
        assert.equal(clean(`哈哈哈\n<sticker:${ID}>\n笑死`, { stickerOnly: true, stickersAllowed: true }, ctx), `<sticker:${ID}>`);
        assert.equal(clean('哈哈哈\n笑死', { stickerOnly: true, stickersAllowed: true }, ctx), '哈哈哈\n笑死');
        assert.equal(clean(`哈哈哈\n<sticker:${ID}>`, { stickersAllowed: true }, ctx), `哈哈哈\n<sticker:${ID}>`);
    });
});

describe('草稿和设备指令分开（ADR 0336 第 8 步）', () => {
    const NOW = Date.parse('2026-11-05T12:00:00+08:00');
    const llm = { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' as const };
    /** 假的设备控制：认 <device:动作> 的动作名，记下每次解析的原文和登记的动作 */
    const run = async (said: string, overrides: Partial<ContactPipelineOptions>) => {
        const rows: StoredMessage[] = [];
        const sent: string[] = [];
        const parsed: string[] = [];
        const committed: string[][] = [];
        const responder = createContactResponder({
            contact: { qq: 1, name: '小明', tier: 'boyfriend', knowsBot: true },
            card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红', extensions: { qqbot: { banned: ['秘密'] } } } }), worldInfo: [] }, llm,
            prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
            history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
            now: () => NOW, log: () => {}, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
            turnModules: [crisisModule({ log: () => {} }), intentModule(), reviewExitModule(), reviewFinalizeModule()],
            send: async (_qq, text) => { sent.push(text); return sent.length + 100; },
            devices: {
                parse: (text): ParsedTokens => {
                    parsed.push(text);
                    return { reply: stripDeviceTokens(text), proposals: [...text.matchAll(/<device:(\w+)>/g)].map(match => ({ action: match[1]!, targets: [], params: {} })), rejected: [] };
                },
                commit: tokens => { committed.push(tokens.proposals.map(proposal => proposal.action)); },
            },
            ...overrides,
        });
        try { responder.receive(said, 1, new Date(NOW)); await responder.whenIdle(); } finally { responder.stop(); }
        return { sent, parsed, committed };
    };

    test('挑候选：每个候选都清理一次（解析一次），挑中的再清理一次；只登记挑中那一个的设备指令，登记一次', async () => {
        // 他难过（care，最多 2 句）：第 1 个 3 句还叮嘱作息、第 3 个约「写完跟我说一声」，挑第 2 个
        const candidates = ['别难过了\n早点睡\n明天就好了\n<device:timer>', '抱抱\n怎么回事呀\n<device:ring>', '抱抱\n写完跟我说一声\n<device:notify>'];
        let n = 0;
        const out = await run('今天又被导师骂了，好难过', {
            turnModules: [crisisModule({ log: () => {} }), intentModule(), reviewExitModule(), reviewFinalizeModule(), candidatesModule({ count: 3, history: () => [] })],
            generate: async () => candidates[n++ % 3]!,
        });
        assert.equal(n, 3);
        assert.deepEqual(out.parsed, [...candidates, candidates[1]]);
        assert.deepEqual(out.committed, [['ring']]);
        assert.deepEqual(out.sent, ['抱抱', '怎么回事呀']);
    });

    test('不挑候选：清理的那一稿带的设备指令发送前登记一次；字里不留指令', async () => {
        const out = await run('今天心情不错', { generate: async () => '好呀\n<device:ring>' });
        assert.deepEqual(out.committed, [['ring']]);
        assert.deepEqual(out.sent, ['好呀']);
    });

    test('出口检查重写并采用：登记的是重写稿的设备指令，原稿的不登记', async () => {
        let calls = 0;
        const out = await run('今天心情不错', { generate: async () => (++calls === 1 ? '秘密\n<device:timer>' : '好呀\n<device:ring>') });
        assert.equal(calls, 2);
        assert.deepEqual(out.committed, [['ring']]);
    });
});
