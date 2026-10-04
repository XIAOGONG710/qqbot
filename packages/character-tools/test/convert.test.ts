import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { isTable, readScenes, readToml, type Table } from '../src/legacy.ts';
import { parseTierConfig, personaToCard, STAGE_DIRECTION_SCRIPT, type TierConfig } from '../src/persona-to-card.ts';
import { scenesToLorebook } from '../src/scenes-to-lorebook.ts';
import { scheduleForTier } from '../src/schedule-to-card.ts';
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

test('每张卡带去掉行首括号的正则和这一档的禁用词（只给运行时，不进提示词，ADR 0006）', () => {
    for (const tier of tiers.tiers) {
        const { extensions } = card(tier.name).data;
        assert.deepEqual(extensions.regex_scripts, [STAGE_DIRECTION_SCRIPT], tier.name);
        assert.deepEqual(extensions.qqbot, { banned: tier.banned }, tier.name);
    }
    const re = new RegExp('^[ \\t]*[（(][^（）()\\n]*[）)][ \\t]*', 'gm');
    assert.equal(STAGE_DIRECTION_SCRIPT.findRegex, `/${re.source}/${re.flags}`);
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

// ---------- 作息（ADR 0007） ----------
const scheduleToml = readToml(join(legacyDir, 'schedule.toml'));
const timetableToml = readToml(join(legacyDir, 'timetable.toml'));
const scheduleOf = (tier: string, config: TierConfig = tiers) => scheduleForTier(scheduleToml, timetableToml, config.schedule, tier);
/** 作息里所有会进提示词的文字 */
const scheduleText = (tier: string) => JSON.stringify(scheduleOf(tier));

test('作息：几点睡、几点起、节次、学期、假期、调休、课程、空闲活动都来自 legacy', () => {
    const s = scheduleOf('boyfriend');
    assert.equal(s.sleep, '02:00');
    assert.deepEqual(s.wake, { early: '07:40', lazy: '09:30', earlySlot: '1-2' });
    assert.deepEqual(s.periods['1-2'], { start: '08:20', end: '09:40' });
    assert.deepEqual(s.semester, { start: '2026-08-31', weeks: 18 });
    assert.deepEqual(s.holidays.map(h => [h.name, h.start, h.end]), [['中秋节', '2026-09-25', '2026-09-27'], ['国庆节', '2026-10-01', '2026-10-07']]);
    assert.deepEqual(s.makeups, [{ date: '2026-09-20', asDay: 0 }, { date: '2026-10-10', asDay: 0 }]);
    assert.equal(s.courses.length, (timetableToml.course as unknown[]).length);
    assert.deepEqual(s.courses[1], {
        day: 1, slot: '3-4', weeks: '1-16', kind: 'hard', name: '大数据应用技术', room: '知行楼303', practice: { fromWeek: 9, room: '知行楼303（机房）' },
    });
    assert.deepEqual(s.kinds.hard, { label: '专业课，认真听', seeAfterMin: [5, 20], maxBubbles: 1 });
    assert.equal(s.free.morning.length + s.free.afternoon.length + s.free.evening.length, (timetableToml.free as unknown[]).length);
});

test('作息按档位裁剪：课名、教室、课型叫法只给 BFGK；拍照的活动只给 BFGK；城市同学以下不给；他在哪只给男朋友档', () => {
    for (const tier of tiers.tiers) {
        const s = scheduleOf(tier.name);
        const detail = ['boyfriend', 'bestie', 'girl_friend', 'known'].includes(tier.name);
        assert.equal(s.courses.every(c => c.name !== undefined && c.room !== undefined), detail, tier.name);
        assert.equal(s.courses.some(c => c.name !== undefined || c.room !== undefined || c.practice?.room !== undefined), detail, tier.name);
        assert.equal(Object.values(s.kinds).some(k => k.label !== undefined), detail, tier.name);
        assert.equal(s.free.afternoon.includes('修昨天拍的片子'), detail, tier.name);
        assert.equal(scheduleText(tier.name).includes('济南'), detail, tier.name);
        assert.equal(scheduleText(tier.name).includes('青岛'), tier.name === 'boyfriend' || detail, tier.name);
        assert.equal(s.partner !== undefined, tier.name === 'boyfriend', tier.name);
        assert.equal(s.holidays.some(h => h.partner !== undefined), tier.name === 'boyfriend', tier.name);
        // 上课多久才看到消息与档位无关
        assert.deepEqual(s.kinds.machine.seeAfterMin, [2, 6], tier.name);
    }
    assert.equal(scheduleOf('classmate').holidays[1]!.where, '没回家，留在学校');
    assert.equal(scheduleOf('boyfriend').holidays[1]!.partner, '他回青岛了');
});

test('作息里没有这一档的禁用词', () => {
    for (const tier of tiers.tiers) {
        const found = tier.banned.filter(word => scheduleText(tier.name).includes(word));
        assert.deepEqual(found, [], `${tier.name} 的作息里出现了 ${found.join('、')}`);
    }
});

test('作息写进卡的 extensions.qqbot.schedule，不进 ST 读的字段', () => {
    const schedule = scheduleOf('classmate');
    const { data } = personaToCard(loadPersona(), tiers, 'classmate', { world: 'w', schedule });
    assert.deepEqual(data.extensions.qqbot, { banned: tiers.tiers.find(t => t.name === 'classmate')!.banned, schedule });
    assert.equal(cardText('classmate'), [data.description, data.personality, data.scenario, data.post_history_instructions, data.mes_example, data.system_prompt].join('\n'));
});

test('[schedule] 写错时报错：没有的假期、没有的活动、不是调休日、缺档位；调休补哪天可以覆盖', () => {
    const withSchedule = (patch: (s: Table) => void) => {
        const toml = loadTiersToml();
        patch(toml.schedule as Table);
        return parseTierConfig(toml);
    };
    assert.throws(() => scheduleOf('boyfriend', withSchedule(s => { (s.holiday as Table)['元旦'] = { where: { BFGKCSU: '在家' } }; })), /没有这个假期/);
    assert.throws(() => scheduleOf('boyfriend', withSchedule(s => { (s.free_only as Table)['去海边'] = 'B'; })), /没有「去海边」/);
    assert.throws(() => scheduleOf('boyfriend', withSchedule(s => { s.makeup = { '2026-10-11': 4 }; })), /不是 timetable.toml 里的调休日/);
    assert.throws(() => withSchedule(s => { s.where = { BFGK: '在学校' }; }), /缺少档位 classmate、stranger、unlisted/);
    assert.throws(() => withSchedule(s => { s.where = { BFGK: '在学校', CSUB: '在学校' }; }), /档位 boyfriend 出现了两次/);
    const overridden = scheduleOf('boyfriend', withSchedule(s => { s.makeup = { '2026-10-10': 4 }; }));
    assert.deepEqual(overridden.makeups[1], { date: '2026-10-10', asDay: 4 });
});

test('作息：睡到几点和平时几点起对不上时报错', () => {
    const toml = readToml(join(legacyDir, 'timetable.toml'));
    (toml.wakeup as Table).lazy = '10:00';
    assert.throws(() => scheduleForTier(scheduleToml, toml, tiers.schedule, 'boyfriend'), /睡到 09:30，timetable.toml 平时 10:00 起/);
});
