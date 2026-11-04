import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { photoShelf, stripPhotoArtifacts } from '../src/vision/photos.ts';
import { createContactResponder } from '../src/platform/contact.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

test('联系人链只允许本轮照片类别与当前菜名，模型不能借已知编号越权', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-contact-'));
    try {
        const now = Date.parse('2026-11-05T12:00:00+08:00');
        const shelf = photoShelf({ dir: join(dir, 'shelf'), log: () => {}, now: () => new Date(now) });
        const add = (name: string, kind: 'cat' | 'view' | 'food', dish?: string) => {
            const file = join(dir, `${name}.jpg`); writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, ...Buffer.from(name)]));
            return shelf.add(file, kind, '合成照片', dish);
        };
        const cat = add('cat', 'cat'); const view = add('view', 'view');
        const food = add('food', 'food', '合成菜甲'); const wrongFood = add('wrong-food', 'food', '合成菜乙');
        for (const [kind, dish, chosen, allowed] of [
            ['cat', undefined, view.id, false], ['cat', undefined, cat.id, true],
            ['food', '合成菜甲', wrongFood.id, false], ['food', '合成菜甲', food.id, true],
        ] as const) {
            const responder = createContactResponder({
                contact: { qq: 1, name: '合成人', tier: 'boyfriend', knowsBot: true },
                card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '合成角色' } }), worldInfo: [] },
                llm: { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' },
                prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
                history: { load: () => [], append: () => {} }, photos: shelf, now: () => now, log: () => {},
                send: async () => 1, generate: async () => `翻到啦\n<photo:${chosen}>`,
            });
            try {
                const result = await responder.initiate({ label: '合成', note: '合成照片', topic: '合成', maxBubbles: 3, dryRun: true, commit: () => {}, photo: kind, ...(dish ? { photoDish: dish } : {}) });
                assert.equal(result.result, 'dryRun');
                if (result.result === 'dryRun') assert.equal(result.parts.some(part => part.includes(`<photo:${chosen}>`)), allowed);
            } finally { responder.stop(); }
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('照片关闭或开启时都清掉未知畸形控制语法，只保留本轮获准的精确有效编号', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-control-'));
 try {
  const shelf = photoShelf({ dir: join(dir, 'shelf'), log: () => {} }); const file = join(dir, 'cat.jpg'); writeFileSync(file, 'synthetic-cat'); const entry = shelf.add(file, 'cat', '合成猫');
 assert.equal(stripPhotoArtifacts('前<photo:unknown>后\r\n<photo:未闭合\r\n末尾'), '前后\n末尾');
 assert.equal(shelf.clean(`普通文字\n<photo:${entry.id}>\n<photo:unknown>\n<photo:未闭合`, true, { kind: 'cat' }), `普通文字\n<photo:${entry.id}>`);
  for (const enabled of [false, true]) for (const artifact of [`<photo:${entry.id}>`, `<PHOTO:${entry.id.toUpperCase()}>`, '<photo:unknown>', '<photo:123>', '<photo:未闭合', '<photo:未闭合\r\n后续普通文字']) {
   const responder = createContactResponder({
    contact: { qq: 1, name: '合成人', tier: 'boyfriend', knowsBot: true },
    card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '合成角色' } }), worldInfo: [] },
    llm: { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' },
    prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
    history: { load: () => [], append: () => {} }, ...(enabled ? { photos: shelf } : {}), now: () => Date.parse('2026-11-05T12:00:00Z'), log: () => {}, send: async () => 1,
    generate: async () => '普通文字\n' + artifact,
   });
   try {
    const result = await responder.initiate({ label: '合成', note: '合成照片', topic: '合成', maxBubbles: 3, dryRun: true, commit: () => {}, photo: 'cat' });
    assert.equal(result.result, 'dryRun');
    if (result.result === 'dryRun') {
     const output = result.parts.join('\n'); const valid = /^<photo:[a-f0-9]{12}>$/i.test(artifact);
     if (enabled && valid) assert.ok(output.includes(`<photo:${entry.id}>`));
     else assert.doesNotMatch(output, /<photo:/i, artifact);
     assert.ok(output.includes('普通文字'));
     if (artifact.includes('后续普通文字')) assert.ok(output.includes('后续普通文字'));
    }
   } finally { responder.stop(); }
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
