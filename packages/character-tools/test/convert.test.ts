import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildCharacter, checkPrivacy, checkReferences } from '../src/build.ts';
import { personaToCard, STAGE_DIRECTION_SCRIPT, textFor } from '../src/persona-to-card.ts';
import { scenesToLorebook } from '../src/scenes-to-lorebook.ts';
import { scheduleForTier } from '../src/schedule-to-card.ts';
import { booksForTier, moodsForTier } from '../src/her-days-to-card.ts';
import { checkSource, fromYaml, readSource, SECTION_KEYS, SOURCE_FILES, toYaml, type CharacterSource } from '../src/source.ts';
import { WORLD_INFO_POSITION } from '../src/st-format.ts';

const characterDir = resolve(import.meta.dirname, '../../../characters/linmengyao');
const source = readSource(join(characterDir, 'source'));
const tiers = source.tiers.tiers;
const copy = (): CharacterSource => structuredClone(source);
const card = (tier: string, from: CharacterSource = source) => personaToCard(from, tier, { world: 'w' });
const cardText = (tier: string) => {
    const { data } = card(tier);
    return [data.description, data.personality, data.scenario, data.post_history_instructions, data.mes_example, data.system_prompt].join('\n');
};

test('st/ 下的文件就是 source/ 生成的（改了资料要重新生成，st/ 不手改）', () => {
    const built = buildCharacter(source);
    assert.equal(built.files.size, 14);
    for (const [file, text] of built.files) {
        assert.equal(readFileSync(join(characterDir, 'st', file), 'utf8'), text, file);
    }
});

test('资料写成 YAML 再读回来不变（页面保存时就是这样写的）', () => {
    for (const key of Object.keys(SOURCE_FILES) as (keyof typeof SOURCE_FILES)[]) {
        const raw = { ...copy(), [key]: fromYaml(toYaml(source[key]), key) };
        assert.deepEqual(checkSource(raw as never), source, key);
    }
    // 日期、时间按字符串读，不变成 Date
    assert.equal(typeof (fromYaml('d: 2026-10-01\nt: 07:40\n', 'x') as Record<string, unknown>).d, 'string');
});

test('七个档位：boyfriend bestie girl_friend known classmate stranger unlisted', () => {
    assert.deepEqual(tiers.map(t => t.name), ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger', 'unlisted']);
});

test('角色卡是 ST 能导入的 V2 结构，名字相同，用标签区分档位，并关联世界书', () => {
    for (const tier of tiers) {
        const { spec, spec_version, data } = card(tier.name);
        assert.equal(spec, 'chara_card_v2');
        assert.equal(spec_version, '2.0');
        assert.equal(data.name, '林梦瑶');
        assert.deepEqual(data.tags, [tier.name]);
        assert.equal(data.extensions.world, 'w');
        assert.deepEqual(data.alternate_greetings, []);
    }
});

test('男朋友档：给男朋友档的字段都进了 description，有改写的用改写后的文字', () => {
    const { description } = card('boyfriend').data;
    let checked = 0;
    for (const key of SECTION_KEYS) {
        for (const [name, field] of Object.entries(source.persona.sections[key])) {
            if (!field.tiers!.includes('boyfriend')) continue;
            const shown = textFor(field, 'boyfriend');
            assert.ok(description.includes(shown), `sections.${key}.${name} 没有出现在 description 里`);
            if (shown !== field.text) assert.ok(!description.includes(field.text), `sections.${key}.${name} 改写过，原文不该出现`);
            checked++;
        }
    }
    assert.ok(checked > 40, `只检查了 ${checked} 个字段`);
});

test('字段只给 tiers 里的档位；改写按顺序取第一条含这一档的', () => {
    const s = copy();
    s.persona.sections.dorm = { pet: { text: '宿舍养了金鱼', tiers: ['bestie'], variants: [{ tiers: ['bestie'], text: '养了两条金鱼' }, { tiers: ['bestie'], text: '不会用到' }] } };
    assert.match(card('bestie', s).data.description, /【宿舍】\n养了两条金鱼/);
    assert.doesNotMatch(card('boyfriend', s).data.description, /金鱼/);
});

test('档位隐私检查：现在的资料没有问题；卡、作息、世界书正文里出现本档禁用词或占位符都会查出来，世界书触发词不查', () => {
    assert.deepEqual(checkPrivacy(buildCharacter(source), source), []);

    const s = copy();
    const scene = s.scenes.find(x => x.tiers.includes('stranger') && !x.tiers.includes('boyfriend'))!;
    const word = s.tiers.tiers.find(t => t.name === 'stranger')!.banned[0]!;
    scene.avoid.push(`我${word}`);
    scene.trigger.push(word);
    s.schedule.where.by_tier = [{ tiers: s.tiers.tiers.map(t => t.name), text: '<HIS_NICKNAME_1>在学校' }];
    const problems = checkPrivacy(buildCharacter(s), s);
    const lore = problems.filter(p => p.where === `世界书 ${scene.id}`);
    assert.deepEqual([...new Set(lore.map(p => p.tier))].sort(), ['stranger', 'unlisted'].filter(t => !(t === 'unlisted' && s.tiers.tiers.find(x => x.name === 'unlisted')!.drop_scenes?.includes(scene.id))));
    assert.ok(lore.every(p => p.word === word), '触发词不查，只查正文');
    assert.equal(problems.filter(p => p.where === '作息' && p.word === '<HIS_NICKNAME_1>').length, tiers.length);
});

test('每个档位的卡里都没有这一档的禁用词（低档位看不到高档位的事实）', () => {
    for (const tier of tiers) {
        const text = cardText(tier.name);
        const found = tier.banned.filter(word => text.includes(word));
        assert.deepEqual(found, [], `${tier.name} 的卡里出现了 ${found.join('、')}`);
    }
});

test('每张卡带去掉行首括号的正则和这一档的禁用词（只给运行时，不进提示词，ADR 0006）', () => {
    for (const tier of tiers) {
        const { extensions } = card(tier.name).data;
        assert.deepEqual(extensions.regex_scripts, [STAGE_DIRECTION_SCRIPT], tier.name);
        assert.deepEqual(extensions.qqbot?.banned, tier.banned, tier.name);
    }
    const re = new RegExp('^[ \\t]*[（(][^（）()\\n]*[）)][ \\t]*', 'gm');
    assert.equal(STAGE_DIRECTION_SCRIPT.findRegex, `/${re.source}/${re.flags}`);
});

test('每日心情和在读的书：只给五个熟悉档位，TextField 和情节节点都按档位裁剪', () => {
    for (const tier of ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate']) {
        assert.equal(moodsForTier(source, tier)?.length, 5, tier);
        assert.equal(booksForTier(source, tier)?.length, 3, tier);
    }
    for (const tier of ['stranger', 'unlisted']) {
        assert.equal(moodsForTier(source, tier), undefined, tier);
        assert.equal(booksForTier(source, tier), undefined, tier);
        assert.equal(card(tier).data.extensions.qqbot?.moods, undefined, tier);
        assert.equal(card(tier).data.extensions.qqbot?.books, undefined, tier);
    }
    assert.match(moodsForTier(source, 'boyfriend')!.find(m => m.name === '黏人')!.style, /\{\{user\}\}/);
    assert.doesNotMatch(moodsForTier(source, 'classmate')!.find(m => m.name === '黏人')!.style, /\{\{user\}\}/);
    assert.ok(booksForTier(source, 'boyfriend')!.find(b => b.id === 'jiasi')!.nodes.some(n => n.id === 'jiasi-publish'));
    assert.ok(!booksForTier(source, 'classmate')!.find(b => b.id === 'jiasi')!.nodes.some(n => n.id === 'jiasi-publish'));
    assert.equal(booksForTier(source, 'boyfriend')!.find(b => b.id === 'yaowu')!.total, undefined, '药屋没有可靠总卷数');
});

test('心情和书的资料写错会报错；两个新文件缺失时仍能读旧资料形状', () => {
    const four = { persona: copy().persona, scenes: copy().scenes, schedule: copy().schedule, tiers: copy().tiers };
    assert.deepEqual(Object.keys(checkSource(four)), ['persona', 'scenes', 'schedule', 'tiers']);
    const s = copy();
    s.moods!.moods[0]!.when[0]!.day = 'rainy' as never;
    assert.throws(() => checkSource(s), /rainy 不是日子条件/);
    const b = copy();
    b.books!.books[0]!.total = { amount: 10, unit: '章', source: '来源' };
    assert.throws(() => checkSource(b), /total\.unit 要和 progress\.unit 一样/);
    const unknownTier = copy();
    unknownTier.books!.books[0]!.nodes[0]!.tiers = ['teacher'];
    assert.throws(() => checkReferences(unknownTier), /books\.yml .*没有档位 teacher/);
});

test('隐私检查覆盖心情和书；受限出版节点不漏进同学档', () => {
    const word = source.tiers.tiers.find(t => t.name === 'classmate')!.banned.find(item => item === '青岛')!;
    assert.ok(word);
    assert.doesNotMatch(JSON.stringify(card('classmate').data.extensions.qqbot?.books), /青岛/);
    const s = copy();
    s.moods!.moods[0]!.style.text += word;
    s.books!.books[0]!.nodes[0]!.points.push(`去了${word}`);
    const problems = checkPrivacy(buildCharacter(s), s);
    assert.ok(problems.some(p => p.tier === 'classmate' && p.where === '心情' && p.word === word));
    assert.ok(problems.some(p => p.tier === 'classmate' && p.where === '在读的书' && p.word === word));
});

test('只有男朋友和闺蜜档知道「他」是男朋友；其他档位没有「别提男朋友」这种提醒，只有中性的一句', () => {
    for (const tier of tiers) {
        const { description, scenario } = card(tier.name).data;
        const knows = ['boyfriend', 'bestie'].includes(tier.name);
        assert.equal(description.includes('「他」是你的男朋友'), knows, tier.name);
        assert.equal(scenario.endsWith(source.tiers.discreet.text), !knows, tier.name);
        assert.doesNotMatch(scenario, /只跟那一个死党闺蜜说/);
    }
});

test('男朋友档的分寸和示例只给男朋友档', () => {
    const boyfriend = card('boyfriend').data;
    assert.match(boyfriend.post_history_instructions, /你喜欢他，也依赖他/);
    assert.equal(boyfriend.mes_example.split('<START>').length - 1, tiers[0]!.examples!.length);
    for (const tier of tiers.slice(1)) {
        const { data } = card(tier.name);
        assert.doesNotMatch(data.post_history_instructions, /你喜欢他/);
        assert.equal(data.mes_example, '');
    }
});

test('名单外好友：被认真问到是不是 AI 时承认；场景去掉否认是 AI 的两条', () => {
    assert.match(card('unlisted').data.description, /不要否认，用你自己的口气大方承认/);
    assert.match(card('stranger').data.description, /不承认、绕开/);
    const ids = (book: ReturnType<typeof scenesToLorebook>) => Object.values(book.entries).map(e => e.comment);
    const stranger = ids(scenesToLorebook(source.scenes, 'stranger'));
    const unlisted = ids(scenesToLorebook(source.scenes, 'stranger', ['probe-are-you-ai', 'probe-prove-real']));
    assert.equal(unlisted.length, stranger.length - 2);
    assert.ok(!unlisted.some(c => /probe-are-you-ai|probe-prove-real/.test(c)));
    assert.throws(() => scenesToLorebook(source.scenes, 'stranger', ['nope']), /没有要去掉的 nope/);
});

test('脱敏占位符和旧引擎参数不进任何一张卡，也不在资料里', () => {
    for (const tier of tiers) {
        assert.doesNotMatch(JSON.stringify(card(tier.name)), /<BOYFRIEND_REAL_NAME>|<HIS_NICKNAME_\d>|interval_seconds|warmth/);
    }
    assert.doesNotMatch(JSON.stringify(source), /<BOYFRIEND_REAL_NAME>|<HIS_NICKNAME_\d>/);
});

test('资料写错时报错：不认识的键、缺段、字段没写给哪些档位、档位名写错、说话方式指向不存在的键', () => {
    const raw = () => ({ persona: copy().persona, scenes: copy().scenes, schedule: copy().schedule, tiers: copy().tiers }) as Record<string, unknown>;
    const withPersona = (patch: (p: Record<string, unknown>) => void) => {
        const r = raw();
        patch(r.persona as Record<string, unknown>);
        return () => checkSource(r as never);
    };
    assert.throws(withPersona(p => { p.hobby = {}; }), /persona\.yml 有不认识的键：hobby/);
    assert.throws(withPersona(p => { delete (p.sections as Record<string, unknown>).dorm; }), /缺少段 dorm/);
    assert.throws(withPersona(p => { (p.sections as Record<string, Record<string, unknown>>).dorm!.pet = { text: '金鱼' }; }), /sections\.dorm\.pet\.tiers 应为字符串数组/);
    assert.throws(withPersona(p => { (p.social as Record<string, Record<string, unknown>>).boyfriend!.tiers = ['boyfriend']; }), /不按档位过滤/);

    const s = copy();
    s.persona.sections.dorm.pet = { text: '金鱼', tiers: ['boyfriend', 'teacher'] };
    assert.throws(() => checkReferences(s), /sections\.dorm\.pet\.tiers：没有档位 teacher/);
    const s2 = copy();
    s2.tiers.tiers[1]!.social = 'nobody';
    assert.throws(() => buildCharacter(s2), /social「nobody」在 persona\.yml 的 social 里没有/);
    const s3 = copy();
    s3.tiers.tiers.push({ ...s3.tiers.tiers[0]! });
    assert.throws(() => checkSource({ ...s3 } as never), /档位 boyfriend 重复/);
});

test('重要的日子：日期跟着那句文字的档位写进卡的 extensions.qqbot.dates，不进 ST 读的字段；没有日子的档位不写这一项', () => {
    const datesOf = (tier: string, from: CharacterSource = source) => card(tier, from).data.extensions.qqbot?.dates;
    assert.deepEqual(datesOf('boyfriend')?.map(d => d.name), ['你的生日', '你们在一起的纪念日', '他的生日']);
    assert.deepEqual(datesOf('boyfriend')?.find(d => d.name === '他的生日'), { name: '他的生日', date: '09-29', lunar: '08-08', midnight: true });
    assert.deepEqual(datesOf('known')?.map(d => d.name), ['你的生日']);
    for (const tier of ['classmate', 'stranger', 'unlisted']) assert.equal(datesOf(tier), undefined, tier);
    assert.doesNotMatch(cardText('boyfriend'), /midnight|09-29/);

    // 隐私检查也查日子的说法
    const s = copy();
    const word = s.tiers.tiers.find(t => t.name === 'known')!.banned[0]!;
    s.persona.sections.dates.her_birthday!.day!.name = `${word}的生日`;
    assert.ok(checkPrivacy(buildCharacter(s), s).some(p => p.tier === 'known' && p.where === '重要的日子' && p.word === word));
});

test('主动找人：只有写了 proactive 的档位（男朋友档）卡里有 extensions.qqbot.proactive', () => {
    assert.deepEqual(card('boyfriend').data.extensions.qqbot?.proactive, {
        occasions: ['morning', 'after_class', 'bedtime', 'quiet', 'follow_up', 'dates'], dailyMax: 2, unansweredMax: 1,
    });
    for (const tier of tiers.filter(t => t.name !== 'boyfriend')) assert.equal(card(tier.name).data.extensions.qqbot?.proactive, undefined, tier.name);
});

test('日子和主动设置写错时报错；页面上全清空的当作没写', () => {
    const raw = () => ({ persona: copy().persona, scenes: copy().scenes, schedule: copy().schedule, tiers: copy().tiers }) as unknown as CharacterSource;
    const check = (patch: (s: CharacterSource) => void) => {
        const r = raw();
        patch(r);
        return checkSource(r as never);
    };
    const his = (s: CharacterSource) => s.persona.sections.dates.his_birthday!;
    assert.throws(() => check(s => { his(s).day = { name: '他的生日' }; }), /至少写一个/);
    assert.throws(() => check(s => { his(s).day!.date = '9-29'; }), /date 应为 MM-DD/);
    assert.throws(() => check(s => { his(s).day!.lunar = '08-31'; }), /农历一个月最多 30 天/);
    assert.throws(() => check(s => { s.persona.sections.dorm.room!.day = { name: 'x', date: '01-01' }; }), /有不认识的键：day/);
    const boyfriend = (s: CharacterSource) => s.tiers.tiers[0]!;
    assert.throws(() => check(s => { boyfriend(s).proactive!.occasions = ['morning', 'lunch' as never]; }), /lunch 不是时机/);
    assert.throws(() => check(s => { boyfriend(s).proactive!.daily_max = 0; }), /daily_max 应为 1–10 的整数/);
    assert.throws(() => check(s => { s.tiers.tiers.at(-1)!.proactive = { occasions: ['morning'], daily_max: 1, unanswered_max: 1 }; }), /名单外的好友不主动找/);
    assert.equal(check(s => { boyfriend(s).proactive!.occasions = []; }).tiers.tiers[0]!.proactive, undefined);
    assert.equal(check(s => { his(s).day = null as never; }).persona.sections.dates.his_birthday!.day, undefined);
    assert.equal(check(s => { his(s).day = { name: ' ', date: '' } as never; }).persona.sections.dates.his_birthday!.day, undefined);
    assert.deepEqual(check(s => { s.tiers.tiers[1]!.proactive = { occasions: ['morning'] } as never; }).tiers.tiers[1]!.proactive,
        { occasions: ['morning'], daily_max: 2, unanswered_max: 1 });
});

test('回复节奏（ADR 0013）：每档的 pace 写进 extensions.qqbot.pace；超出 0.5–3 报错，页面上清空的当作没写', () => {
    assert.deepEqual(tiers.map(t => [t.name, card(t.name).data.extensions.qqbot?.pace]), [
        ['boyfriend', 1], ['bestie', 1.2], ['girl_friend', 1.3], ['known', 1.4], ['classmate', 1.6], ['stranger', 2.2], ['unlisted', 2.2],
    ]);
    const check = (pace: unknown) => {
        const r = { persona: copy().persona, scenes: copy().scenes, schedule: copy().schedule, tiers: copy().tiers } as unknown as CharacterSource;
        r.tiers.tiers[0]!.pace = pace as never;
        return checkSource(r as never).tiers.tiers[0]!;
    };
    assert.throws(() => check(5), /pace 应为 0\.5–3 的数/);
    assert.throws(() => check('1.5'), /pace 应为 0\.5–3 的数/);
    assert.equal('pace' in check(null), false);
    assert.equal(check(1.6).pace, 1.6);
});

test('男朋友档世界书只收场景档含 boyfriend 的场景', () => {
    const book = scenesToLorebook(source.scenes, 'boyfriend');
    const expected = source.scenes.filter(s => s.tiers.includes('boyfriend'));
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
    const strangerOnly = source.scenes.filter(s => !s.tiers.includes('boyfriend')).map(s => s.id);
    for (const entry of entries) assert.ok(!strangerOnly.some(id => entry.comment.includes(`（${id}）`)));
});

test('没有该场景档的场景时报错；场景 id 重复时报错', () => {
    assert.throws(() => scenesToLorebook(source.scenes, 'teacher'), /没有场景档为 teacher/);
    const s = copy();
    s.scenes.push({ ...s.scenes[0]! });
    assert.throws(() => checkSource(s as never), /场景 id .* 重复/);
});

// ---------- 作息（ADR 0007） ----------
const scheduleOf = (tier: string, from: CharacterSource = source) => scheduleForTier(from.schedule, tier);
/** 作息里所有会进提示词的文字 */
const scheduleText = (tier: string) => JSON.stringify(scheduleOf(tier));

test('作息：几点睡、几点起、节次、学期、假期、调休、课程、空闲活动', () => {
    const s = scheduleOf('boyfriend');
    assert.equal(s.sleep, '02:00');
    assert.deepEqual(s.wake, { early: '07:40', lazy: '09:30', earlySlot: '1-2' });
    assert.deepEqual(s.periods['1-2'], { start: '08:20', end: '09:40' });
    assert.deepEqual(s.semester, { start: '2026-08-31', weeks: 18 });
    assert.deepEqual(s.holidays.map(h => [h.name, h.start, h.end]), [['中秋节', '2026-09-25', '2026-09-27'], ['国庆节', '2026-10-01', '2026-10-07']]);
    assert.deepEqual(s.makeups, [{ date: '2026-09-20', asDay: 0 }, { date: '2026-10-10', asDay: 0 }]);
    assert.equal(s.courses.length, source.schedule.courses.length);
    assert.deepEqual(s.courses[1], {
        day: 1, slot: '3-4', weeks: '1-16', kind: 'hard', name: '大数据应用技术', room: '知行楼303', practice: { fromWeek: 9, room: '知行楼303（机房）' },
    });
    assert.deepEqual(s.kinds.hard, { label: '专业课，认真听', seeAfterMin: [5, 20], maxBubbles: 1 });
    assert.equal(s.free.morning.length + s.free.afternoon.length + s.free.evening.length, source.schedule.free.length);
});

test('作息按档位裁剪：课名、教室、课型叫法只给 BFGK；拍照的活动只给 BFGK；城市同学以下不给；他在哪只给男朋友档', () => {
    for (const tier of tiers) {
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
        assert.equal(s.holidays.some(h => h.partnerBack !== undefined), tier.name === 'boyfriend', tier.name);
        // 上课多久才看到消息与档位无关
        assert.deepEqual(s.kinds.machine.seeAfterMin, [2, 6], tier.name);
    }
    assert.equal(scheduleOf('classmate').holidays[1]!.where, '没回家，留在学校');
    // ADR 0014：他回青岛是说好的，她是没抢到票（只写「他回青岛了」，她会当成他瞒着她走了）
    assert.equal(scheduleOf('boyfriend').holidays[1]!.partner, '{{user}}回青岛过国庆了（放假前就说好的）');
    assert.equal(scheduleOf('boyfriend').holidays[1]!.where, '没抢到回青岛的票，留在学校（你们说好以后放假一起走，这次你不难受）');
});

test('作息里没有这一档的禁用词', () => {
    for (const tier of tiers) {
        const found = tier.banned.filter(word => scheduleText(tier.name).includes(word));
        assert.deepEqual(found, [], `${tier.name} 的作息里出现了 ${found.join('、')}`);
    }
});

test('作息写进卡的 extensions.qqbot.schedule，不进 ST 读的字段', () => {
    const schedule = scheduleOf('classmate');
    const { data } = personaToCard(source, 'classmate', { world: 'w', schedule });
    assert.deepEqual(data.extensions.qqbot, {
        banned: tiers.find(t => t.name === 'classmate')!.banned,
        schedule,
        pace: 1.6,
        moods: moodsForTier(source, 'classmate'),
        books: booksForTier(source, 'classmate'),
    });
    assert.equal(cardText('classmate'), [data.description, data.personality, data.scenario, data.post_history_instructions, data.mes_example, data.system_prompt].join('\n'));
});

test('作息写错时报错：按档位的说法缺档位或重复、档位名写错、节次不存在、时间格式不对；调休补哪天直接改', () => {
    const withSchedule = (patch: (s: CharacterSource['schedule']) => void) => {
        const s = copy();
        patch(s.schedule);
        return s;
    };
    assert.throws(() => checkReferences(withSchedule(s => { s.where.by_tier = [{ tiers: ['boyfriend', 'bestie', 'girl_friend', 'known'], text: '在学校' }]; })), /缺少档位 classmate、stranger、unlisted/);
    assert.throws(() => checkReferences(withSchedule(s => { s.where.by_tier.push({ tiers: ['boyfriend'], text: '在学校' }); })), /档位 boyfriend 出现了两次/);
    assert.throws(() => checkReferences(withSchedule(s => { s.free[0]!.tiers = ['teacher']; })), /没有档位 teacher/);
    assert.throws(() => checkSource({ ...copy(), schedule: withSchedule(s => { s.courses[0]!.slot = '5-6'; }).schedule } as never), /5-6 不在 periods 里/);
    assert.throws(() => checkSource({ ...copy(), schedule: withSchedule(s => { s.sleep = '2:00'; }).schedule } as never), /应为 HH:MM/);
    const overridden = scheduleOf('boyfriend', withSchedule(s => { s.makeups[1]!.as_day = 4; }));
    assert.deepEqual(overridden.makeups[1], { date: '2026-10-10', asDay: 4 });
});
