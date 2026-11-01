import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { VOICE_HINT, VOICE_HINT_RATE, voiceHint, voiceRoll } from '../src/language/speaking.ts';

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

    test('voiceRoll：同一句每次一样（提示词要重启前后一致，ADR 0039），不看他以外的人说了什么', () => {
        const chat = [
            { role: 'user', content: '在干嘛', time: '2026-11-01 20:00' },
            { role: 'assistant', content: '没干嘛', time: '2026-11-01 20:01' },
        ];
        assert.equal(voiceRoll(chat), voiceRoll([...chat]));
        assert.equal(voiceRoll(chat), voiceRoll([...chat, { role: 'assistant', content: '你呢', time: '2026-11-01 20:02' }]));
        assert.notEqual(voiceRoll(chat), voiceRoll([{ role: 'user', content: '在干嘛', time: '2026-11-01 20:05' }]));
        assert.notEqual(voiceRoll(chat), voiceRoll([{ role: 'user', content: '吃了吗', time: '2026-11-01 20:00' }]));
    });

    test('voiceRoll：落在 0–1 里；没有他的话就不给；大约 VOICE_HINT_RATE 的轮次会给', () => {
        assert.equal(voiceRoll([]), 1);
        assert.equal(voiceHint(voiceRoll([{ role: 'assistant', content: '我先说的' }])), undefined);
        const chats = Array.from({ length: 2000 }, (_, i) => [{ role: 'user', content: `第${i}句`, time: `2026-11-01 ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` }]);
        const rolls = chats.map(voiceRoll);
        assert.ok(rolls.every(roll => roll >= 0 && roll < 1));
        const given = chats.filter(chat => voiceHint(voiceRoll(chat)) !== undefined).length / chats.length;
        assert.ok(Math.abs(given - VOICE_HINT_RATE) < 0.04, `给的比例 ${given.toFixed(3)} 应接近 ${VOICE_HINT_RATE}`);
    });
});
