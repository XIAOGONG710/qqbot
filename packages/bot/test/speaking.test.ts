import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { VOICE_HINT, VOICE_HINT_RATE, voiceHint } from '../src/language/speaking.ts';

describe('她可以说出来（2026-11-01）', () => {
    test('按概率给：低随机数给，高随机数不给', () => {
        assert.equal(voiceHint(0), VOICE_HINT);
        assert.equal(voiceHint(VOICE_HINT_RATE - 0.001), VOICE_HINT);
        assert.equal(voiceHint(VOICE_HINT_RATE), undefined);
        assert.equal(voiceHint(0.9), undefined);
    });

    test('提示里写清楚了怎么写、多长、别滥用', () => {
        assert.match(VOICE_HINT, /<<语音：/);
        assert.match(VOICE_HINT, /四十字以内/);
        assert.match(VOICE_HINT, /别每句都用/);
    });
});
