import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { summarizeWorld, useWorldNeeds, worldAt } from '../src/world/world.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { resolve } from 'node:path';

const at = (iso: string) => new Date(`${iso}+08:00`);

afterEach(() => useWorldNeeds(undefined));

describe('世界里的需要投影（ADR 0229）', () => {
    test('和行动选择共用同一份只读投影，落进 WorldNow 和摘要', () => {
        const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
        useWorldNeeds({ at: time => ({ at: time.toISOString(), energy: 24, hunger: 83, stress: 76 }) });
        const now = worldAt(card.herWorld!, card.schedule!, at('2026-10-20T21:00'))!;
        assert.deepEqual(now.needs, { at: '2026-10-20T13:00:00.000Z', energy: 24, hunger: 83, stress: 76 });
        assert.match(summarizeWorld(now), /需要 精力 24、饥饿 83、压力 76/);
    });

    test('没有锚点时不改变旧世界形状', () => {
        const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
        const now = worldAt(card.herWorld!, card.schedule!, at('2026-10-20T21:00'))!;
        assert.equal(now.needs, undefined);
        assert.doesNotMatch(summarizeWorld(now), /需要 精力/);
    });
});
