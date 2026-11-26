import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newWorldInfoEntry, WORLD_INFO_LOGIC, WORLD_INFO_POSITION } from '../src/st-format.ts';

/** 与 newWorldInfoEntryTemplate 字段、默认值逐项对齐（characterFilter* 不进模板）。 */
function expectedEntry(uid: number) {
    return {
        uid,
        key: [] as string[],
        keysecondary: [] as string[],
        comment: '',
        content: '',
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: false,
        order: 100,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null as number | null,
        caseSensitive: null as boolean | null,
        matchWholeWords: null as boolean | null,
        useGroupScoring: null as boolean | null,
        automationId: '',
        role: 0,
        sticky: null as number | null,
        cooldown: null as number | null,
        delay: null as number | null,
        triggers: [] as string[],
        displayIndex: uid,
    };
}

test('world_info_position / world_info_logic 常量与 SillyTavern 的数值一一对应', () => {
    assert.deepEqual(WORLD_INFO_POSITION, {
        before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7,
    });
    assert.deepEqual(WORLD_INFO_LOGIC, { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });
});

test('空字段时逐字段等于新建条目模板，uid 同时是 displayIndex', () => {
    assert.deepEqual(newWorldInfoEntry(7, {}), expectedEntry(7));
    assert.deepEqual(newWorldInfoEntry(0, {}), expectedEntry(0));
});

test('传入字段覆盖默认值，中文 content / key / comment 原样写入', () => {
    const entry = newWorldInfoEntry(12, {
        key: ['梦瑶', '她'],
        keysecondary: ['下雨'],
        comment: '她的过去',
        content: '周六下午，她去图书馆看书。',
        constant: true,
        selectiveLogic: WORLD_INFO_LOGIC.AND_ALL,
        position: WORLD_INFO_POSITION.atDepth,
        depth: 2,
        triggers: ['雨天'],
    });
    assert.deepEqual(entry, {
        ...expectedEntry(12),
        key: ['梦瑶', '她'],
        keysecondary: ['下雨'],
        comment: '她的过去',
        content: '周六下午，她去图书馆看书。',
        constant: true,
        selectiveLogic: 3,
        position: 4,
        depth: 2,
        triggers: ['雨天'],
    });
    assert.equal(entry.content, '周六下午，她去图书馆看书。');
    assert.deepEqual(entry.key, ['梦瑶', '她']);
});

test('字段缺失时保留模板默认值；显式 undefined 会盖掉默认值', () => {
    const partial = newWorldInfoEntry(3, { comment: '备注' });
    assert.equal(partial.comment, '备注');
    assert.equal(partial.content, '');
    assert.equal(partial.probability, 100);
    assert.deepEqual(partial.key, []);

    const overridden = newWorldInfoEntry(3, { comment: undefined, probability: undefined, key: undefined });
    assert.equal(overridden.comment, undefined);
    assert.equal(overridden.probability, undefined);
    assert.equal(overridden.key, undefined);
    assert.equal(overridden.order, 100, '没显式传入的字段仍是默认值');
});

test('不做运行时校验：非法值按传入内容原样输出，不抛错也不回退', () => {
    const entry = newWorldInfoEntry(-1, {
        position: 999,
        probability: -5,
        depth: Number.NaN,
        scanDepth: -10,
        order: 1.5,
    });
    assert.equal(entry.uid, -1);
    assert.equal(entry.position, 999);
    assert.equal(entry.probability, -5);
    assert.ok(Number.isNaN(entry.depth));
    assert.equal(entry.scanDepth, -10);
    assert.equal(entry.order, 1.5);
});

test('displayIndex 始终由 uid 决定，传入字段无法篡改', () => {
    const entry = newWorldInfoEntry(42, { displayIndex: 999 } as unknown as Parameters<typeof newWorldInfoEntry>[1]);
    assert.equal(entry.displayIndex, 42);
    assert.equal(entry.uid, 42);
});

test('多次调用不共享模板里的数组：改一条不影响另一条', () => {
    const first = newWorldInfoEntry(1, {});
    const second = newWorldInfoEntry(2, {});
    assert.notEqual(first.key, second.key);
    assert.notEqual(first.keysecondary, second.keysecondary);
    assert.notEqual(first.triggers, second.triggers);
    first.key.push('只属于第一条');
    assert.deepEqual(second.key, []);
    assert.deepEqual(newWorldInfoEntry(3, {}).key, []);
});
