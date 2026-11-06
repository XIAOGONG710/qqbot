import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { summarizeWorld, useWorldNeeds, worldAt } from '../src/world/world.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { resolve } from 'node:path';
import { syntheticCardPath } from './fixtures/card.ts';

const at = (iso: string) => new Date(`${iso}+08:00`);

afterEach(() => useWorldNeeds(undefined));

describe('世界里的需要投影（ADR 0229）', () => {
    test('和行动选择共用同一份只读投影，落进 WorldNow 和摘要', () => {
        const card = loadCharacterCard(syntheticCardPath('boyfriend'));
        useWorldNeeds({ at: time => ({ at: time.toISOString(), energy: 24, hunger: 83, stress: 76 }) });
        const now = worldAt(card.herWorld!, card.schedule!, at('2026-10-20T21:00'))!;
        assert.deepEqual(now.needs, { at: '2026-10-20T13:00:00.000Z', energy: 24, hunger: 83, stress: 76 });
        assert.match(summarizeWorld(now), /需要 精力 24、饥饿 83、压力 76/);
    });

    test('没有锚点时不改变旧世界形状', () => {
        const card = loadCharacterCard(syntheticCardPath('boyfriend'));
        const now = worldAt(card.herWorld!, card.schedule!, at('2026-10-20T21:00'))!;
        assert.equal(now.needs, undefined);
        assert.doesNotMatch(summarizeWorld(now), /需要 精力/);
    });

    test('假期作为世界事实进入快照，不只靠 atSchool 反推', () => {
        const card = loadCharacterCard(syntheticCardPath('boyfriend'));
        const now = worldAt(card.herWorld!, card.schedule!, at('2026-10-05T14:00'))!;
        assert.equal(now.holiday?.name, '国庆节');
        assert.equal(now.holiday?.start, '2026-10-01');
        assert.equal(typeof now.atSchool, 'boolean', '是否回家是地点事实，不能代替假期名称');
        assert.match(summarizeWorld(now), /放假 国庆节/);
    });
});
