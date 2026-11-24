import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { photoShelf, stripPhotoArtifacts } from '../src/vision/photos.ts';
import { createContactResponder } from '../src/platform/contact.ts';
import { mediaOffersModule } from '../src/modules/media-offers.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

test('照片关闭或开启时都清掉未知畸形控制语法；货架清理只保留本轮获准的精确有效编号，主动那条不带照片', async () => {
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
    turnModules: [mediaOffersModule()],
    generate: async () => '普通文字\n' + artifact,
   });
   try {
    const result = await responder.initiate({ label: '合成', note: '合成照片', topic: '合成', maxBubbles: 3, dryRun: true, commit: () => {} });
    assert.equal(result.result, 'dryRun');
    if (result.result === 'dryRun') {
     // 主动那条不再带照片（photoShares 11-24 删了）：编号一律摘掉，连有效的也不留
     const output = result.parts.join('\n');
     assert.doesNotMatch(output, /<photo:/i, artifact);
     assert.ok(output.includes('普通文字'));
     if (artifact.includes('后续普通文字')) assert.ok(output.includes('后续普通文字'));
    }
   } finally { responder.stop(); }
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
