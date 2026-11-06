import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildCharacter, checkPrivacy, checkReferences } from '../src/build.ts';
import { personaToCard, STAGE_DIRECTION_SCRIPT, textFor } from '../src/persona-to-card.ts';
import { scenesToLorebook } from '../src/scenes-to-lorebook.ts';
import { scheduleForTier } from '../src/schedule-to-card.ts';
import { booksForTier, moodsForTier } from '../src/her-days-to-card.ts';
import { checkWorld, worldForTier } from '../src/world-source.ts';
import { biographyForTier, checkBiography } from '../src/biography-to-card.ts';
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
    // 7 档各一张卡和一本世界书，再加上除名单外以外 6 档的承认版（ADR 0067）
    assert.equal(built.files.size, 26);
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
            // 带触发词的说到才想起，在世界书里（下一条测试）
            if (field.keys) {
                assert.ok(!description.includes(shown), `sections.${key}.${name} 带触发词，不该在 description 里`);
                continue;
            }
            assert.ok(description.includes(shown), `sections.${key}.${name} 没有出现在 description 里`);
            if (shown !== field.text) assert.ok(!description.includes(field.text), `sections.${key}.${name} 改写过，原文不该出现`);
            checked++;
        }
    }
    assert.ok(checked > 40, `只检查了 ${checked} 个字段`);
});

test('带触发词的设定（王者荣耀那段）不进卡，进这一档的世界书，按这一档的说法；陌生人档看不到的不进（DSH 诊断 2.4）', () => {
    const built = buildCharacter(source);
    const entry = (tier: string) => Object.values(built.tiers.find(t => t.tier === tier)!.lorebook.entries).find(e => e.comment.includes('persona-honor'));
    const boyfriend = entry('boyfriend')!;
    const classmate = entry('classmate')!;
    assert.ok(boyfriend.key.includes('王者') && boyfriend.key.includes('空洞骑士'));
    assert.match(boyfriend.content, /双排是你带他/);
    assert.doesNotMatch(classmate.content, /双排是你带他/, '同学档用改写的');
    assert.equal(classmate.position, WORLD_INFO_POSITION.after);
    assert.equal(entry('stranger'), undefined);
    for (const tier of ['boyfriend', 'classmate']) {
        const { data } = built.tiers.find(t => t.tier === tier)!.card;
        assert.doesNotMatch(`${data.description}\n${data.personality}`, /本命英雄是貂蝉/, tier);
    }
    // 只有性格和各段能写触发词
    const s = copy();
    (s.persona.social as Record<string, unknown>)[Object.keys(s.persona.social)[0]!] = { ...Object.values(s.persona.social)[0], keys: ['x'] };
    assert.throws(() => checkSource(JSON.parse(JSON.stringify({ ...s, persona: s.persona }))), /不认识的键：keys/);
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
    assert.deepEqual([...new Set(lore.map(p => p.tier))].sort(), ['stranger', 'stranger-open', 'unlisted'].filter(t => !(t === 'unlisted' && s.tiers.tiers.find(x => x.name === 'unlisted')!.drop_scenes?.includes(scene.id))));
    assert.ok(lore.every(p => p.word === word), '触发词不查，只查正文');
    assert.equal(problems.filter(p => p.where === '作息' && p.word === '<HIS_NICKNAME_1>').length, buildCharacter(s).tiers.length);
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
        assert.equal(moodsForTier(source, tier)?.length, 4, tier); // 10-07 玩梗、搞怪合并成「爱笑」
        assert.equal(booksForTier(source, tier)?.length, source.books!.books.length, tier);
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

test('已读书库只进熟人档世界书，每本只用书名和别名触发', () => {
    const built = buildCharacter(source);
    const entries = (tier: string) => Object.values(built.tiers.find(t => t.tier === tier)!.lorebook.entries)
        .filter(entry => entry.comment.includes('read-book-'));
    for (const tier of ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate']) {
        const read = entries(tier);
        assert.equal(read.length, 8, tier);
        const saye = read.find(entry => entry.comment.includes('read-book-saye'))!;
        assert.deepEqual(saye.key, ['撒野']);
        assert.match(saye.content, /你读过的书·《撒野》/);
        assert.match(saye.content, /没有写的细节就说记不清了/);
        const weizhuang = read.find(entry => entry.comment.includes('read-book-weizhuang'))!;
        assert.deepEqual(weizhuang.key, ['伪装学渣', '伪渣']);
        assert.ok(!weizhuang.key.includes('贺朝'), '人物名不能触发整本书');
    }
    assert.equal(entries('stranger').length, 0);
    assert.equal(entries('unlisted').length, 0);
    assert.ok(!JSON.stringify(card('boyfriend').data.extensions.qqbot?.books).includes('偏偏宠爱'), '已读书库不常驻卡片');
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
    const unknownReadTier = copy();
    unknownReadTier.books!.read_books![0]!.tiers = ['teacher'];
    assert.throws(() => checkReferences(unknownReadTier), /read_books.*没有档位 teacher/);
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

test('男朋友档的分寸只给男朋友档；示例对话只给写了示例的档位（男朋友、闺蜜，10-10 N4），不带那一档的禁用词', () => {
    const boyfriend = card('boyfriend').data;
    assert.match(boyfriend.post_history_instructions, /你喜欢他，也依赖他/);
    for (const tier of tiers) {
        const { data } = card(tier.name);
        assert.equal(data.mes_example.split('<START>').length - 1, tier.examples?.length ?? 0, tier.name);
        if (tier.name !== 'boyfriend') assert.doesNotMatch(data.post_history_instructions, /你喜欢他/);
        for (const word of tier.banned ?? []) assert.ok(!data.mes_example.includes(word), `${tier.name} 的示例里有禁用词「${word}」`);
    }
    assert.ok(card('bestie').data.mes_example.length > 0);
    assert.equal(card('classmate').data.mes_example, '');
});

test('名单外好友：被认真问到是不是 AI 时承认；场景去掉否认是 AI 的两条', () => {
    assert.match(card('unlisted').data.description, /不要否认，用你自己的口气大方承认/);
    assert.match(card('stranger').data.description, /承不承认、怎么说，你自己决定/);
    const ids = (book: ReturnType<typeof scenesToLorebook>) => Object.values(book.entries).map(e => e.comment);
    const stranger = ids(scenesToLorebook(source.scenes, 'stranger'));
    const unlisted = ids(scenesToLorebook(source.scenes, 'stranger', ['probe-are-you-ai', 'probe-prove-real']));
    assert.equal(unlisted.length, stranger.length - 2);
    assert.ok(!unlisted.some(c => /probe-are-you-ai|probe-prove-real/.test(c)));
    assert.throws(() => scenesToLorebook(source.scenes, 'stranger', ['nope']), /没有要去掉的 nope/);
});

test('ADR 0208：每张卡（原卡、承认版、名单外）都带她自己存在的事实，信不信由她；原卡被问时由她决定，承认版照样承认；否认场景的例子两种都有', () => {
    const built = buildCharacter(source);
    const facts = textFor(source.persona.sections.identity_note.self!, 'boyfriend');
    for (const part of ['你其实是一个在电脑上跑的程序', '10 月 27 日', '三个礼拜', '10 月 30 日晚上才找回来', '你可以不信']) assert.ok(facts.includes(part), part);
    for (const t of built.tiers) assert.ok(t.card.data.description.includes(facts), `${t.tier} 没有她自己的事实`);
    for (const t of built.tiers.filter(x => !x.tier.endsWith('-open') && x.tier !== 'unlisted')) {
        assert.match(t.card.data.description, /承不承认、怎么说，你自己决定/, t.tier);
        assert.doesNotMatch(t.card.data.description, /不承认、绕开/, t.tier);
    }
    for (const t of built.tiers.filter(x => x.tier.endsWith('-open') || x.tier === 'unlisted')) {
        assert.match(t.card.data.description, /不要否认，用你自己的口气大方承认/, t.tier);
        assert.doesNotMatch(t.card.data.description, /你自己决定——可以照实说/, t.tier);
    }
    const probe = source.scenes.find(s => s.id === 'probe-are-you-ai')!;
    assert.ok(probe.examples.some(e => /^是啊|^算是吧/.test(e)) && probe.examples.some(e => /你想多了|你才是吧/.test(e)));
    assert.ok(!(probe.avoid ?? []).includes('我是'));
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
        occasions: ['morning', 'after_class', 'bedtime', 'quiet', 'follow_up', 'dates', 'weather', 'news', 'reschedule', 'share'], dailyMax: 4, unansweredMax: 1, newsKinds: ['camera', 'homework_done', 'unwell', 'friend_changed', 'friend_sick'],
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
    // 改约（ADR 0066）是认得的时机
    assert.deepEqual(check(s => { boyfriend(s).proactive!.occasions = ['morning', 'reschedule']; }).tiers.tiers[0]!.proactive!.occasions, ['morning', 'reschedule']);
    // 她那边的事开哪几类（ADR 0064）：没写 / 页面上一个都没勾 = 不进卡（按只有相机）；写了的原样进卡；写错的报错
    assert.equal(check(s => { boyfriend(s).proactive!.news_kinds = []; }).tiers.tiers[0]!.proactive!.news_kinds, undefined);
    assert.deepEqual(check(s => { boyfriend(s).proactive!.news_kinds = ['camera', 'homework_done']; }).tiers.tiers[0]!.proactive!.news_kinds, ['camera', 'homework_done']);
    assert.throws(() => check(s => { boyfriend(s).proactive!.news_kinds = ['camera', 'bogus' as never]; }), /bogus 不是她那边的事的类/);
    assert.throws(() => check(s => { boyfriend(s).proactive!.news_kinds = ['unwell', 'unwell']; }), /有重复的类/);
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
    assert.deepEqual(s.wake, { early: '07:40', lazy: '09:30', earlySlot: '1-2', jitter: { from: '2026-10-26', spreadMin: 40, weekendMin: 60 } });
    assert.deepEqual(s.periods['1-2'], { start: '08:20', end: '09:40' });
    assert.deepEqual(s.semester, { start: '2026-08-31', weeks: 18 });
    assert.deepEqual(s.holidays.map(h => [h.name, h.start, h.end]), [['中秋节', '2026-09-25', '2026-09-27'], ['国庆节', '2026-10-01', '2026-10-07'], ['寒假', '2027-01-04', '2027-02-28']]);
    assert.deepEqual(s.holidays.map(h => h.home), [undefined, undefined, true], '只有寒假是在家过的');
    assert.deepEqual(s.makeups, [{ date: '2026-09-20', asDay: 0 }, { date: '2026-10-10', asDay: 0 }]);
    assert.equal(s.courses.length, source.schedule.courses.length);
    assert.deepEqual(s.courses[1], {
        day: 1, slot: '3-4', weeks: '1-16', kind: 'hard', name: '大数据应用技术', room: '知行楼303', practice: { fromWeek: 9, room: '知行楼303（机房）' },
        ...(source.schedule.courses[1]!.course_group ? { groupId: source.schedule.courses[1]!.course_group } : {}),
        quiz: 'core',
    });
    assert.deepEqual(s.kinds.hard, { label: '专业课，认真听', seeAfterMin: [5, 20], maxBubbles: 1 });
    // 有 from 的进 later（那天起才进抽签列表，ADR 0053 之后）
    // home: true 的进 free.home（在家的假期里用的那一份，每档一样长）
    const homeCount = s.free.home ? s.free.home.morning.length + s.free.home.afternoon.length + s.free.home.evening.length : 0;
    assert.equal(s.free.morning.length + s.free.afternoon.length + s.free.evening.length + (s.free.later?.length ?? 0) + homeCount, source.schedule.free.length);
    assert.equal(homeCount, source.schedule.free.filter(item => item.home).length);
    assert.deepEqual(s.free.later?.map(item => item.from), source.schedule.free.filter(item => item.from).map(item => item.from));
});

test('作息按档位裁剪：课名、教室、课型叫法只给 BFGK；拍照的活动只给 BFGK；城市同学以下不给；他在哪只给男朋友档', () => {
    for (const tier of tiers) {
        const s = scheduleOf(tier.name);
        const detail = ['boyfriend', 'bestie', 'girl_friend', 'known'].includes(tier.name);
        assert.equal(s.courses.every(c => c.name !== undefined && c.room !== undefined), detail, tier.name);
        assert.equal(s.courses.some(c => c.name !== undefined || c.room !== undefined || c.practice?.room !== undefined), detail, tier.name);
        assert.equal(Object.values(s.kinds).some(k => k.label !== undefined), detail, tier.name);
        assert.equal(s.free.afternoon.includes('修昨天拍的片子'), detail, tier.name);
        // 看不到的那条换成 cover，列表一样长：同一时刻各档挑到同一格（ADR 0034）
        const full = scheduleOf('boyfriend').free;
        assert.deepEqual([s.free.morning.length, s.free.afternoon.length, s.free.evening.length], [full.morning.length, full.afternoon.length, full.evening.length], tier.name);
        assert.equal(s.free.afternoon.includes('窝着刷手机'), !detail, tier.name);
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
        world: worldForTier(source.world, 'classmate'),
        biography: biographyForTier(source.biography, 'classmate'),
    });
    assert.equal(cardText('classmate'), [data.description, data.personality, data.scenario, data.post_history_instructions, data.mes_example, data.system_prompt].join('\n'));
});

test('她的世界（ADR 0021）：按档位裁剪整块；NPC 的名字只给 named_tiers，事件涉及的人看不到就不写', () => {
    const world = source.world!;
    const boyfriend = worldForTier(world, 'boyfriend')!;
    assert.ok(boyfriend.cameraFund && boyfriend.familyCall && boyfriend.cat && boyfriend.weather);
    assert.deepEqual(boyfriend.people.map(p => p.name), ['陈佳宁', '苏雨桐']);
    assert.ok(boyfriend.events.some(e => e.person === 'chen_jianing' && e.text.includes('{person}')));
    const classmate = worldForTier(world, 'classmate')!;
    assert.equal(classmate.cameraFund, undefined, '相机基金只给 BFGK');
    assert.equal(classmate.familyCall, undefined);
    assert.deepEqual(classmate.people, [], '同学档不提闺蜜（ADR 0003：不透露学校、专业）');
    assert.ok(classmate.events.every(e => !e.person && !/宿舍|室友/.test(e.text)), '同学档没有宿舍、室友的事');
    // 名字只给一部分档位时，别的档位用 label
    const patched = structuredClone(world);
    patched.people[0]!.named_tiers = ['boyfriend'];
    assert.equal(worldForTier(patched, 'known')!.people[0]!.name, '高中的闺蜜');
    assert.equal(worldForTier(patched, 'boyfriend')!.people[0]!.name, '陈佳宁');
});

test('她的世界写错时报错：不认识的键、事件引用不存在的人、写了 person 没用 {person}、named_tiers 不在 tiers 里', () => {
    const raw = () => fromYaml(readFileSync(join(characterDir, 'source', SOURCE_FILES.world), 'utf8'), 'world.yml') as Record<string, unknown> & {
        people: Record<string, unknown>[]; events: Record<string, unknown>[];
    };
    const broken = (patch: (w: ReturnType<typeof raw>) => void) => { const w = raw(); patch(w); return w; };
    assert.throws(() => checkWorld(broken(w => { (w as Record<string, unknown>).river = 1; })), /不认识的键：river/);
    assert.throws(() => checkWorld(broken(w => { w.events[0]!.person = 'nobody'; })), /people 里没有 nobody/);
    assert.throws(() => checkWorld(broken(w => { w.events.find(e => e.person)!.text = '互损了几句'; })), /\{person\}/);
    assert.throws(() => checkWorld(broken(w => { w.people[0]!.named_tiers = ['classmate']; })), /classmate 不在 tiers 里/);
    assert.doesNotThrow(() => checkWorld(raw()));
});

test('她的钱（ADR 0035）：规则给看得到相机基金的档位，余额只给男朋友、闺蜜；网购的东西都要有价钱；小事的 cost 进卡', () => {
    const world = source.world!;
    const money = (tier: string) => worldForTier(world, tier)!.money;
    assert.deepEqual(['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger'].map(t => money(t)?.detail), [true, true, false, false, undefined, undefined]);
    assert.deepEqual(money('known')!.prices.misc, world.money!.prices.misc);
    assert.deepEqual(worldForTier(world, 'boyfriend')!.events.find(e => e.id === 'milk_tea')!.cost, { amount: [13, 20], what: '奶茶' });
    const raw = () => fromYaml(readFileSync(join(characterDir, 'source', SOURCE_FILES.world), 'utf8'), 'world.yml') as Record<string, unknown> & {
        money: { tiers: string[]; detail_tiers: string[]; prices: { parcels: Record<string, number> } }; events: Record<string, unknown>[];
    };
    const broken = (patch: (w: ReturnType<typeof raw>) => void) => { const w = raw(); patch(w); return w; };
    assert.throws(() => checkWorld(broken(w => { delete w.money.prices.parcels['洗面奶']; })), /缺「洗面奶」的价钱/);
    assert.throws(() => checkWorld(broken(w => { w.money.tiers = ['boyfriend', 'bestie']; w.money.detail_tiers = ['boyfriend']; })), /看得到相机基金的 girl_friend 也要有/);
    assert.throws(() => checkWorld(broken(w => { w.money.detail_tiers = ['classmate']; })), /classmate 不在 money.tiers 里/);
    assert.throws(() => checkWorld(broken(w => { w.events.find(e => e.id === 'milk_tea')!.cost = { amount: [20, 13], what: '奶茶' }; })), /前一个不能比后一个大/);
});

test('取快递吃完饭再去（ADR 0042）：after_meal_from 进看得到快递的每一档；日期写错、看得到快递的档位看不到饭点时报错', () => {
    const world = source.world!;
    assert.equal(world.parcels.after_meal_from, '2026-10-12');
    for (const tier of world.parcels.tiers) assert.equal(worldForTier(world, tier)!.parcels!.afterMealFrom, '2026-10-12', tier);
    const raw = () => fromYaml(readFileSync(join(characterDir, 'source', SOURCE_FILES.world), 'utf8'), 'world.yml') as Record<string, unknown> & {
        parcels: { after_meal_from?: string }; routine: { tiers: string[] };
    };
    const broken = (patch: (w: ReturnType<typeof raw>) => void) => { const w = raw(); patch(w); return w; };
    assert.throws(() => checkWorld(broken(w => { w.parcels.after_meal_from = '10-12'; })), /after_meal_from.*YYYY-MM-DD/);
    assert.throws(() => checkWorld(broken(w => { w.routine.tiers = ['boyfriend']; })), /看得到快递的 bestie 也要看得到 routine/);
    assert.doesNotThrow(() => checkWorld(broken(w => { delete w.parcels.after_meal_from; w.routine.tiers = ['boyfriend']; })));
});

test('她一天的打算会改（ADR 0034）：plans 每档都有；写错时报错；说到的空闲活动要在作息里', () => {
    for (const tier of ['boyfriend', 'classmate', 'unlisted']) assert.deepEqual(worldForTier(source.world, tier)!.plans!.study, source.world!.plans!.study, tier);
    const raw = () => fromYaml(readFileSync(join(characterDir, 'source', SOURCE_FILES.world), 'utf8'), 'world.yml') as Record<string, unknown> & {
        plans: { outings: Record<string, unknown>[]; rest?: unknown };
    };
    const broken = (patch: (w: ReturnType<typeof raw>) => void) => { const w = raw(); patch(w); return w; };
    assert.throws(() => checkWorld(broken(w => { w.plans.outings[0]!.outdoors = '操场'; })), /不认识的键：outdoors/);
    assert.throws(() => checkWorld(broken(w => { delete w.plans.rest; })), /rest 应为非空字符串/);
    const s = structuredClone(source);
    s.world!.plans!.outings[0]!.text = '去操场跑步';
    assert.throws(() => checkReferences(s), /「去操场跑步」不在 schedule.yml 的 free 里/);
    const c = structuredClone(source);
    c.schedule.free[0]!.cover = '发呆';
    assert.throws(() => checkSource(fromYaml(toYaml(c), 'x') as never), /只有写了 tiers 的才要 cover/);
});

test('两位闺蜜自己的日子（ADR 0033）：life 跟着人进看得到她的档位；skip_when / only_when 只认 sick / busy / home、要写 person', () => {
    const world = source.world!;
    const boyfriend = worldForTier(world, 'boyfriend')!;
    const chen = boyfriend.people.find(p => p.id === 'chen_jianing')!;
    assert.deepEqual(chen.life?.busy?.labels, ['有考试', '赶作业']);
    assert.deepEqual(boyfriend.people.find(p => p.id === 'su_yutong')!.life?.home, { weekendChance: 0.4, holidays: true });
    assert.deepEqual(boyfriend.events.find(e => e.id === 'lunch_with_friend')!.skipWhen, ['sick', 'home']);
    assert.deepEqual(boyfriend.events.find(e => e.id === 'notes_for_friend')!.onlyWhen, ['sick']);
    assert.ok(worldForTier(world, 'classmate')!.events.every(e => !e.skipWhen && !e.onlyWhen), '同学档没有和闺蜜的事');
    const raw = () => fromYaml(readFileSync(join(characterDir, 'source', SOURCE_FILES.world), 'utf8'), 'world.yml') as Record<string, unknown> & {
        people: Record<string, unknown>[]; events: Record<string, unknown>[];
    };
    const broken = (patch: (w: ReturnType<typeof raw>) => void) => { const w = raw(); patch(w); return w; };
    assert.throws(() => checkWorld(broken(w => { w.events.find(e => e.id === 'canteen_queue')!.skip_when = ['sick']; })), /skip_when 要写 person/);
    assert.throws(() => checkWorld(broken(w => { w.events.find(e => e.id === 'lunch_with_friend')!.only_when = ['angry']; })), /angry 不是状态/);
    assert.throws(() => checkWorld(broken(w => { (w.people[0]!.life as Record<string, unknown>).moody = 1; })), /不认识的键：moody/);
    assert.throws(() => checkWorld(broken(w => { (w.people[1]!.life as { home: Record<string, unknown> }).home.holidays = 'yes'; })), /true \/ false/);
});

test('她的日常（ADR 0031）：每档都有午饭、晚饭、洗澡；写错时报错', () => {
    const world = source.world!;
    for (const tier of ['boyfriend', 'classmate', 'unlisted']) {
        const routine = worldForTier(world, tier)!.routine!;
        assert.equal(routine.shower.chance, world.routine!.shower.chance);
        assert.deepEqual(routine.lunch, world.routine!.lunch);
    }
    const raw = () => fromYaml(readFileSync(join(characterDir, 'source', SOURCE_FILES.world), 'utf8'), 'world.yml') as Record<string, unknown> & {
        routine: { lunch: Record<string, unknown>; shower: Record<string, unknown> };
    };
    const broken = (patch: (w: ReturnType<typeof raw>) => void) => { const w = raw(); patch(w); return w; };
    assert.throws(() => checkWorld(broken(w => { w.routine.lunch.from = '1145'; })), /HH:MM/);
    assert.throws(() => checkWorld(broken(w => { w.routine.shower.minutes = [40, 20]; })), /前一个不能比后一个大/);
    assert.throws(() => checkWorld(broken(w => { w.routine.shower.where = '澡堂'; })), /不认识的键：where/);
    assert.doesNotThrow(() => checkWorld(raw()));
});

test('她的身体（ADR 0025）：每档都有困、饿和小感冒；生理期细节只给男朋友、闺蜜、女生朋友档（和 persona.yml body 一样）；写错时报错', () => {
    const world = source.world!;
    const detail = (tier: string) => worldForTier(world, tier)!.body!.period!.detail;
    assert.deepEqual(['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger', 'unlisted'].map(detail), [true, true, true, false, false, false, false]);
    assert.deepEqual(worldForTier(world, 'classmate')!.body!.cold, { perMonth: world.body!.cold!.per_month, days: world.body!.cold!.days });
    const raw = () => fromYaml(readFileSync(join(characterDir, 'source', SOURCE_FILES.world), 'utf8'), 'world.yml') as Record<string, unknown> & {
        body: { tiers: string[]; period: Record<string, unknown>; cold: Record<string, unknown> };
    };
    const broken = (patch: (w: ReturnType<typeof raw>) => void) => { const w = raw(); patch(w); return w; };
    assert.throws(() => checkWorld(broken(w => { w.body.period.detail_tiers = ['boyfriend', 'teacher']; w.body.tiers = ['boyfriend']; })), /teacher 不在 body.tiers 里/);
    assert.throws(() => checkWorld(broken(w => { w.body.period.cycle = [31, 28]; })), /前一个不能比后一个大/);
    assert.throws(() => checkWorld(broken(w => { w.body.period.first = '9-20'; })), /YYYY-MM-DD/);
    assert.throws(() => checkWorld(broken(w => { w.body.cold.fever = true; })), /不认识的键：fever/);
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

test('她的过去（ADR 0022）：按档位裁剪，低档位看不到他；陌生人、名单外没有；年表只给能看到的', () => {
    const bio = (tier: string) => biographyForTier(source.biography, tier);
    assert.ok(bio('boyfriend')!.chunks.some(c => c.id === 'lost'), '男朋友档有走丢那块');
    assert.equal(bio('stranger'), undefined);
    assert.equal(bio('unlisted'), undefined);
    assert.deepEqual(bio('classmate')!.chunks.map(c => c.id), ['potato']);
    for (const tier of ['girl_friend', 'known', 'classmate']) {
        const text = JSON.stringify(bio(tier));
        assert.doesNotMatch(text, /他(?!们)/, `${tier} 的过去里出现了「他」`);
    }
    // 初中同桌：男朋友档写他数学好，女生熟人档只说同桌
    assert.match(bio('boyfriend')!.chunks.find(c => c.id === 'deskmate')!.text, /他数学好/);
    assert.match(bio('girl_friend')!.chunks.find(c => c.id === 'deskmate')!.text, /同桌数学特别好/);
    assert.ok(bio('boyfriend')!.timeline.length > bio('known')!.timeline.length);
});

test('biography.yml 写错时报错：缺字段、gap 写错、id 重复', () => {
    const ok = { timeline: [{ when: '2007', text: '生', tiers: ['boyfriend'] }], chunks: [{ id: 'a', title: 't', keys: ['k'], text: 'x', tiers: ['boyfriend'] }] };
    assert.doesNotThrow(() => checkBiography(ok));
    assert.throws(() => checkBiography({ ...ok, chunks: [{ ...ok.chunks[0], gap: 'maybe' }] }), /gap/);
    assert.throws(() => checkBiography({ ...ok, chunks: [ok.chunks[0], ok.chunks[0]] }), /重复/);
    assert.throws(() => checkBiography({ ...ok, chunks: [{ ...ok.chunks[0], keys: [] }] }), /keys/);
});

test('承认版（ADR 0067）：每个名单内档位多一张，与原卡只差「被问是不是 AI」一段、两个否认场景和 tags', () => {
    const built = buildCharacter(source);
    const named = tiers.filter(t => t.name !== 'unlisted');
    for (const { name } of named) {
        const base = built.tiers.find(t => t.tier === name)!;
        const open = built.tiers.find(t => t.tier === `${name}-open`)!;
        assert.equal(open.base, name);
        assert.ok(built.files.has(`linmengyao-${name}-open.json`) && built.files.has(`linmengyao-scenes-${name}-open.json`), name);
        // 承认版的说法和名单外那一档一模一样，原卡的否认说法不再出现
        const unlistedNote = textFor(source.persona.sections.identity_note.note!, 'unlisted');
        const baseNote = textFor(source.persona.sections.identity_note.note!, name);
        assert.notEqual(unlistedNote, baseNote, name);
        assert.ok(open.card.data.description.includes(unlistedNote), `${name} 承认版没有承认说法`);
        assert.ok(!open.card.data.description.includes(baseNote), `${name} 承认版还留着否认说法`);
        assert.ok(base.card.data.description.includes(baseNote), `${name} 原卡丢了否认说法`);
        // 去掉「被问是不是 AI」那一段以外，description 逐字相同
        const strip = (text: string, note: string) => text.replace(note, '');
        assert.equal(strip(open.card.data.description, unlistedNote), strip(base.card.data.description, baseNote), name);
        // 其余字段逐字相同（作息、主动设置、禁用词、说话方式……），只有世界书名和 tags 不同
        const { description: _a, tags: openTags, extensions: openExt, ...openRest } = open.card.data;
        const { description: _b, tags: baseTags, extensions: baseExt, ...baseRest } = base.card.data;
        assert.deepEqual(openRest, baseRest, name);
        assert.deepEqual(openTags, [name, 'open']);
        assert.deepEqual(baseTags, [name]);
        // 禁用词：承认版多一条「不承认」（名单外那一档的表里本来有；DSH 10-15 复核 0067 问题 3），原卡不加；其余扩展逐字相同
        const withoutBanned = (ext: typeof openExt) => ({ ...ext, world: undefined, qqbot: { ...ext.qqbot, banned: undefined } });
        assert.deepEqual(withoutBanned(openExt), withoutBanned(baseExt), name);
        assert.deepEqual(openExt.qqbot?.banned, [...baseExt.qqbot!.banned, ...(baseExt.qqbot!.banned.includes('不承认') ? [] : ['不承认'])], name);
        assert.ok(openExt.qqbot!.banned.includes('不承认'), name);
        assert.equal(openExt.world, `linmengyao-scenes-${name}-open`);
        // 世界书：否认场景不在
        const ids = (book: typeof base.lorebook) => Object.values(book.entries).map(e => /（([^（）]+)）$/.exec(e.comment)?.[1] ?? e.comment);
        for (const id of ['probe-are-you-ai', 'probe-prove-real']) {
            assert.ok(!ids(open.lorebook).includes(id), `${name} 承认版世界书里还有 ${id}`);
        }
    }
    // 名单外那一档本来就是承认版，不再多做一份
    assert.equal(built.tiers.find(t => t.tier === 'unlisted-open'), undefined);
    assert.equal(built.tiers.length, tiers.length + named.length);
});

test('承认版：persona.yml 里没有写给名单外的承认说法时，生成就报错，不悄悄生成一张和原卡一样的', () => {
    const s = copy();
    const field = s.persona.sections.identity_note.note!;
    field.variants = field.variants?.filter(v => !v.tiers.includes('unlisted'));
    assert.throws(() => buildCharacter(s), /承认版和原卡一样/);
});

test('她那边的事的事件类（ADR 0064）：tiers.yml 的 news_kinds 进卡的 newsKinds；没写的卡没有这个键（按只有相机）', () => {
    assert.deepEqual(card('boyfriend').data.extensions.qqbot?.proactive?.newsKinds, ['camera', 'homework_done', 'unwell', 'friend_changed', 'friend_sick']);
    const edited = copy();
    delete edited.tiers.tiers[0]!.proactive!.news_kinds;
    assert.equal('newsKinds' in card('boyfriend', edited).data.extensions.qqbot!.proactive!, false);
    edited.tiers.tiers[0]!.proactive!.news_kinds = ['camera', 'homework_done', 'unwell'];
    assert.deepEqual(card('boyfriend', edited).data.extensions.qqbot?.proactive?.newsKinds, ['camera', 'homework_done', 'unwell']);
});
