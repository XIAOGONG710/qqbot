import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendDream, dreamAppraisals, dreamNoteLine, dreamPrompt, hasDream, inSleepHours, lastNightDream, readDreams } from '../src/life/dreams.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'qqbot-dream-'));
const dream = (at: number, date = '2026-10-31') => ({ date, dream: '梦见他在收拾行李，我站在门口没说话。', feel: { kind: 'worry' as const, strength: 1 as const, why: '梦见他要走' }, at });

// 用户 10-31：做梦，而且梦要能影响她醒来后的情绪（梦见分手 → 醒来怕他离开）
test('存梦、读梦、一天一条；坏行不影响别的', () => {
    const d = dir();
    appendDream(d, dream(Date.now()));
    assert.equal(hasDream('2026-10-31', d), true);
    assert.equal(readDreams(d).length, 1);
    writeFileSync(join(d, 'dreams', 'DREAMS.jsonl'), readFileSync(join(d, 'dreams', 'DREAMS.jsonl'), 'utf8') + 'not json\n');
    assert.equal(readDreams(d).length, 1, '坏行跳过');
});

test('昨晚的梦变成一条小分量的心境事实（不压过真事）', () => {
    const d = dir();
    const now = new Date('2026-10-31T09:00:00+08:00').getTime();
    appendDream(d, dream(now - 3 * 3_600_000));
    const list = dreamAppraisals(d, now);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.source, 'self');
    assert.equal(list[0]!.kind, 'worry');
    assert.equal(list[0]!.strength, 1);
    assert.ok(list[0]!.cause.includes('梦见他要走'));
    assert.equal(dreamAppraisals(d, now + 20 * 3_600_000).length, 0, '过了一天就散了');
});

test('睡觉时段才做梦；早上那句要说是梦', () => {
    assert.equal(inSleepHours(1), true);
    assert.equal(inSleepHours(23), true);
    assert.equal(inSleepHours(9), false);
    const line = dreamNoteLine({ date: '2026-10-31', dream: '梦见你走了', feel: { kind: 'worry', strength: 1 }, at: Date.now() })!;
    assert.ok(line.includes('那是梦，不是真的事'));
    assert.ok(line.includes('有点慌'));
});

test('做梦的提示词：允许荒诞和吵架，不要解析', () => {
    const p = dreamPrompt({ events: ['上早八'], feelings: ['担心（她要走）'], journal: '', name: '林梦瑶' });
    assert.ok(p.system.includes('允许荒诞'));
    assert.ok(p.system.includes('不要写'));
    assert.ok(p.user.includes('上早八'));
});
