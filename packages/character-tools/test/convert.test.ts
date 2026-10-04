import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { isTable, readScenes, readToml, type Table } from '../src/legacy.ts';
import { parseTierConfig, personaToCard, type TierConfig } from '../src/persona-to-card.ts';
import { scenesToLorebook } from '../src/scenes-to-lorebook.ts';
import { WORLD_INFO_POSITION } from '../src/st-format.ts';

const characterDir = resolve(import.meta.dirname, '../../../characters/linmengyao');
const legacyDir = join(characterDir, 'legacy');
const loadPersona = () => readToml(join(legacyDir, 'persona.toml'));
const loadTiersToml = () => readToml(join(characterDir, 'tiers.toml'));
const tiers = parseTierConfig(loadTiersToml());
const scenes = readScenes(join(legacyDir, 'speech_library.toml'));
const card = (tier: string, persona = loadPersona(), config: TierConfig = tiers) => personaToCard(persona, config, tier, { world: 'w' });
const cardText = (tier: string) => {
    const { data } = card(tier);
    return [data.description, data.personality, data.scenario, data.post_history_instructions, data.mes_example, data.system_prompt].join('\n');
};

test('七个档位：boyfriend bestie girl_friend known classmate stranger unlisted', () => {
    assert.deepEqual(tiers.tiers.map(t => t.name), ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger', 'unlisted']);
});

test('角色卡是 ST 能导入的 V2 结构，名字相同，用标签区分档位，并关联世界书', () => {
    for (const tier of tiers.tiers) {
        const { spec, spec_version, data } = card(tier.name);
        assert.equal(spec, 'chara_card_v2');
        assert.equal(spec_version, '2.0');
        assert.equal(data.name, '林梦瑶');
        assert.deepEqual(data.tags, [tier.name]);
        assert.equal(data.extensions.world, 'w');
        assert.deepEqual(data.alternate_greetings, []);
    }
});

test('男朋友档：转换的章节里每一句原文都进了 description（男朋友档改写过的字段不再原样出现）', () => {
    const toml = loadPersona();
    const persona = toml.persona as Table;
    const { description } = card('boyfriend', toml).data;
    const rewritten = new Set(tiers.rewrites.filter(r => r.tiers.has('boyfriend')).map(r => r.field));
    const sections = ['relation', 'family', 'dorm', 'study', 'friends', 'money', 'heart', 'speech', 'taboo',
        'identity_note', 'daily_extra', 'dates', 'growth'];
    let checked = 0;
    for (const key of sections) {
        for (const [field, value] of Object.entries(persona[key] as Table)) {
            const original = String(value).trim();
            if (rewritten.has(`${key}.${field}`)) {
                assert.ok(!description.includes(original), `persona.${key}.${field} 改写过，原文不该原样出现`);
                continue;
            }
            assert.ok(description.includes(original), `persona.${key}.${field} 没有出现在 description 里`);
            checked++;
        }
    }
    assert.ok(checked > 40, `只检查了 ${checked} 个字段`);
});

test('每个档位的卡里都没有这一档的禁用词（低档位看不到高档位的事实）', () => {
    for (const tier of tiers.tiers) {
        const text = cardText(tier.name);
        const found = tier.banned.filter(word => text.includes(word));
        assert.deepEqual(found, [], `${tier.name} 的卡里出现了 ${found.join('、')}`);
    }
});

test('只有男朋友和闺蜜档知道「他」是男朋友；其他档位没有「别提男朋友」这种提醒，只有中性的一句', () => {
    for (const tier of tiers.tiers) {
        const { description, scenario } = card(tier.name).data;
        const knows = ['boyfriend', 'bestie'].includes(tier.name);
        assert.equal(description.includes('「他」是你的男朋友'), knows, tier.name);
        assert.equal(scenario.endsWith(tiers.discreet), !knows, tier.name);
        assert.doesNotMatch(scenario, /只跟那一个死党闺蜜说/);
    }
});

test('男朋友档的分寸和示例只给男朋友档', () => {
    const boyfriend = card('boyfriend').data;
    assert.match(boyfriend.post_history_instructions, /你喜欢他，也依赖他/);
    assert.equal(boyfriend.mes_example.split('<START>').length - 1, tiers.tiers[0]!.examples.length);
    for (const tier of tiers.tiers.slice(1)) {
        const { data } = card(tier.name);
        assert.doesNotMatch(data.post_history_instructions, /你喜欢他/);
        assert.equal(data.mes_example, '');
    }
});

test('名单外好友：被认真问到是不是 AI 时承认；场景去掉否认是 AI 的两条', () => {
    assert.match(card('unlisted').data.description, /不要否认，用你自己的口气大方承认/);
    assert.match(card('stranger').data.description, /不承认、绕开/);
    const ids = (book: ReturnType<typeof scenesToLorebook>) => Object.values(book.entries).map(e => e.comment);
    const stranger = ids(scenesToLorebook(scenes, 'stranger'));
    const unlisted = ids(scenesToLorebook(scenes, 'stranger', ['probe-are-you-ai', 'probe-prove-real']));
    assert.equal(unlisted.length, stranger.length - 2);
    assert.ok(!unlisted.some(c => /probe-are-you-ai|probe-prove-real/.test(c)));
    assert.throws(() => scenesToLorebook(scenes, 'stranger', ['nope']), /没有要去掉的 nope/);
});

test('脱敏占位符和旧引擎参数不进任何一张卡', () => {
    for (const tier of tiers.tiers) {
        assert.doesNotMatch(JSON.stringify(card(tier.name)), /<BOYFRIEND_REAL_NAME>|<HIS_NICKNAME_\d>|interval_seconds|warmth/);
    }
});

test('persona.toml 出现未登记的键时报错', () => {
    const extraTop = { ...loadPersona(), newEngine: {} };
    assert.throws(() => card('boyfriend', extraTop), /未登记的键：newEngine/);

    const toml = loadPersona();
    (toml.persona as Table).hobby = { a: '画画' };
    assert.throws(() => card('boyfriend', toml), /未登记的键：hobby/);

    const toml2 = loadPersona();
    ((toml2.persona as Table).social as Table).teacher = '对老师：客气';
    assert.throws(() => card('boyfriend', toml2), /未登记 \[teacher\]/);
});

test('写进卡的字段没登记可见性、或登记了不存在的字段，都报错', () => {
    const toml = loadPersona();
    ((toml.persona as Table).dorm as Table).pet = '宿舍养了金鱼';
    assert.throws(() => card('boyfriend', toml), /没有登记 dorm\.pet/);

    const raw = loadTiersToml();
    (raw.visible as Table)['dorm.pet'] = 'B';
    assert.throws(() => card('boyfriend', loadPersona(), parseTierConfig(raw)), /登记了不存在的字段 dorm\.pet/);
});

test('原文变了就报错，不默默套用改写', () => {
    const toml = loadPersona();
    ((toml.persona as Table).traits as Table).clingy = '会想你。';
    assert.throws(() => card('boyfriend', toml), /traits\.clingy.*原文变了/);

    // 只在别的档位用到的改写也要检查
    const toml2 = loadPersona();
    ((toml2.persona as Table).daily_extra as Table).cat = '楼下有只猫。';
    assert.throws(() => card('boyfriend', toml2), /daily_extra\.cat.*出现 0 次/);
});

test('档位代号写错时报错', () => {
    const raw = loadTiersToml();
    (raw.visible as Table)['relation.how'] = 'BX';
    assert.throws(() => parseTierConfig(raw), /档位代号 X 不存在/);
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
