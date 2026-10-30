import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moodPaceLine, moodShape, tunedMaxBubbles } from '../src/emotion/express.ts';

const felt = (kind: string, level: string) => ({ kind, level }) as never;

// 2026-10-30：心境原来只进提示词一行字，回多少泡跟它无关
test('心情低：难过/烦/累压过开心时，最多收成一两条', () => {
    const mood = moodShape([felt('sad', 'strong'), felt('tired', 'clear')]);
    assert.equal(tunedMaxBubbles(3, mood), 2);
    assert.equal(tunedMaxBubbles(1, mood), 1);
    assert.ok(moodPaceLine(mood)?.includes('提不起劲'));
});

test('心情好又没有负面：允许多一泡，最多三泡', () => {
    const mood = moodShape([felt('joy', 'strong'), felt('joy', 'clear')]);
    assert.equal(tunedMaxBubbles(2, mood), 3);
    assert.equal(tunedMaxBubbles(3, mood), 3);
    assert.ok(moodPaceLine(mood)?.includes('心情好'));
});

test('正负都有、或者都 faint：不干预', () => {
    assert.equal(tunedMaxBubbles(3, moodShape([felt('sad', 'strong'), felt('joy', 'strong')])), 3);
    assert.equal(tunedMaxBubbles(3, moodShape([felt('sad', 'faint')])), 3);
    assert.equal(moodPaceLine(moodShape([felt('sad', 'strong'), felt('joy', 'strong')])), undefined);
});
