import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../src/platform/config.ts';
import { deepSeekImageDescriber } from '../src/vision/vision.ts';

test('视觉超时配置和直接factory均仅接受正有限32位整数，缺省保持兼容', () => {
 const base = { llm: { baseUrl: 'https://synthetic.invalid', model: 'synthetic' }, characterCard: 'synthetic-{tier}.json',
  contacts: [{ qq: 1, name: '合成人', tier: 'classmate' }], vision: { provider: 'deepseek', model: 'synthetic' } };
 const parse = (timeoutMs: unknown) => parseAppConfig({ ...base, vision: { ...base.vision, timeoutMs } }, 'C:/synthetic', { QQBOT_LLM_API_KEY: 'synthetic' });
 for (const timeoutMs of [0, -1, 1.5, Infinity, NaN, 2_147_483_648, null, '15']) {
  assert.throws(() => parse(timeoutMs), /vision.timeoutMs/);
  assert.throws(() => deepSeekImageDescriber({ baseUrl: 'https://synthetic.invalid', model: 'synthetic', apiKey: 'synthetic', timeoutMs: timeoutMs as number }), /timeoutMs/);
 }
 for (const timeoutMs of [1, 8000, 2_147_483_647]) assert.equal(parse(timeoutMs).vision!.timeoutMs, timeoutMs);
 assert.equal(parse(undefined).vision!.timeoutMs, 8000);
});
