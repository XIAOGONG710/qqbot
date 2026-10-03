import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { isTable, readScenes, readToml, type Table } from '../src/legacy.ts';
import { personaToCard } from '../src/persona-to-card.ts';
import { scenesToLorebook } from '../src/scenes-to-lorebook.ts';
import { WORLD_INFO_POSITION } from '../src/st-format.ts';

const legacyDir = resolve(import.meta.dirname, '../../../characters/linmengyao/legacy');
const loadPersona = () => readToml(join(legacyDir, 'persona.toml'));
const scenes = readScenes(join(legacyDir, 'speech_library.toml'));

test('角色卡是 ST 能导入的 V2 结构，并关联世界书', () => {
    const card = personaToCard(loadPersona(), { world: 'w' });
    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.spec_version, '2.0');
    assert.equal(card.data.name, '林梦瑶');
    assert.equal(card.data.extensions.world, 'w');
    assert.deepEqual(card.data.alternate_greetings, []);
});

test('转换的章节里每一句原文都进了 description', () => {
    const toml = loadPersona();
    const persona = toml.persona as Table;
    const { description } = personaToCard(toml, { world: 'w' }).data;
    const sections = ['relation', 'family', 'dorm', 'study', 'friends', 'money', 'heart', 'speech', 'taboo',
        'identity_note', 'daily_extra', 'dates', 'growth'];
    for (const key of sections) {
        for (const [field, value] of Object.entries(persona[key] as Table)) {
            assert.ok(description.includes(String(value).trim()), `persona.${key}.${field} 没有出现在 description 里`);
        }
    }
});

test('脱敏占位符和旧引擎参数不进角色卡', () => {
    const json = JSON.stringify(personaToCard(loadPersona(), { world: 'w' }));
    assert.doesNotMatch(json, /<BOYFRIEND_REAL_NAME>|<HIS_NICKNAME_\d>/);
    // [persona.social] 其他档位与 [persona.social_extra] 的独有内容
    assert.doesNotMatch(json, /中午食堂去不去|你哪位|姐妹/);
});

test('persona.toml 出现未登记的键时报错', () => {
    const extraTop = { ...loadPersona(), newEngine: {} };
    assert.throws(() => personaToCard(extraTop, { world: 'w' }), /未登记的键：newEngine/);

    const toml = loadPersona();
    (toml.persona as Table).hobby = { a: '画画' };
    assert.throws(() => personaToCard(toml, { world: 'w' }), /未登记的键：hobby/);

    const toml2 = loadPersona();
    ((toml2.persona as Table).social as Table).teacher = '对老师：客气';
    assert.throws(() => personaToCard(toml2, { world: 'w' }), /未登记 \[teacher\]/);
});

test('traits 原文变了就报错，不默默套用人称改写', () => {
    const toml = loadPersona();
    ((toml.persona as Table).traits as Table).clingy = '会想你。';
    assert.throws(() => personaToCard(toml, { world: 'w' }), /traits\.clingy/);
});

test('男朋友档世界书只收含 boyfriend 档位的场景', () => {
    const book = scenesToLorebook(scenes, 'boyfriend');
    const expected = scenes.filter(s => s.tier.includes('boyfriend'));
    const entries = Object.values(book.entries);
    assert.equal(entries.length, expected.length);
    assert.ok(expected.length > 0);
    entries.forEach((entry, i) => {
        const scene = expected[i]!;
        assert.equal(book.entries[String(i)], entry);
        assert.equal(entry.uid, i);
        assert.deepEqual(entry.key, scene.trigger);
        assert.ok(entry.comment.includes(scene.id));
        for (const line of scene.examples) assert.ok(entry.content.includes(`「${line}」`));
        assert.equal(entry.matchWholeWords, false);
        assert.equal(entry.position, WORLD_INFO_POSITION.after);
        assert.equal(entry.disable, false);
        assert.equal(entry.constant, false);
    });
    // 陌生人专属场景不能混进来
    const strangerOnly = scenes.filter(s => !s.tier.includes('boyfriend')).map(s => s.id);
    for (const entry of entries) assert.ok(!strangerOnly.some(id => entry.comment.includes(`（${id}）`)));
});

test('没有该档位的场景时报错', () => {
    assert.throws(() => scenesToLorebook(scenes, 'teacher'), /没有档位为 teacher/);
});

test('isTable 不把数组和日期当成表', () => {
    assert.equal(isTable([]), false);
    assert.equal(isTable(new Date()), false);
    assert.equal(isTable({}), true);
});
