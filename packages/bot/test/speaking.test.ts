import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { VOICE_HINT, voiceHint } from '../src/language/speaking.ts';

describe('她可以说出来（2026-11-01；11-13 起每轮都给）', () => {
    test('不再掷骰子：每轮都给同一句', () => {
        assert.equal(voiceHint(), VOICE_HINT);
        assert.equal(voiceHint(), voiceHint());
    });

    test('提示里写清楚了怎么写、多长、想发就发', () => {
        assert.match(VOICE_HINT, /<<语音：/);
        assert.match(VOICE_HINT, /四十字以内/);
        assert.match(VOICE_HINT, /想发就发/);
    });
});
