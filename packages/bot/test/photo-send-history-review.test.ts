import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { photoShelf } from '../src/vision/photos.ts';
import { createContactResponder } from '../src/platform/contact.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import type { StoredMessage } from '../src/memory/history.ts';

test('主动图片历史传递确认消息ID并优先使用发送快照，旧货架调用仍兼容', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-sent-history-'));
 try {
  const source = join(dir, 'synthetic.jpg'); writeFileSync(source, 'synthetic-photo');
  const shelf = photoShelf({ dir: join(dir, 'photos'), log: () => {} }); const entry = shelf.add(source, 'cat', '当前货架说明');
  const token = `<photo:${entry.id}>`;
  for (const useSnapshot of [true, false]) {
   const stored: StoredMessage[] = []; let calls = 0;
   const responder = createContactResponder({
    contact: { qq: 1, name: '合成人', tier: 'boyfriend', knowsBot: true },
    card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '合成角色' } }), worldInfo: [] },
    llm: { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' },
    prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
    history: { load: () => stored, append: (_qq, message) => { stored.push(message); } }, photos: shelf,
    ...(useSnapshot ? { sentHistory: (sent: string, id: number) => { assert.equal(sent, token); assert.equal(id, 44); calls++; return '她发了张照片：本次发送快照'; } } : {}),
    now: () => Date.parse('2026-11-05T12:00:00Z'), log: () => {}, send: async () => 44, generate: async () => token,
   });
   try {
    const result = await responder.initiate({ label: '合成照片', note: '合成照片', topic: '合成', maxBubbles: 1, dryRun: false, commit: () => {}, photo: 'cat' });
    assert.equal(result.result, 'sent'); assert.equal(calls, useSnapshot ? 1 : 0);
    assert.deepEqual(stored.map(message => [message.messageId, message.content]), [[44, `她发了张照片：${useSnapshot ? '本次发送快照' : '当前货架说明'}`]]);
   } finally { responder.stop(); }
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
