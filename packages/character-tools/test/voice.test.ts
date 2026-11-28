// persona.yml 的 voice 段（ADR 0353）：跨端的表达与称呼只写在资料里一处，转换器按档位写进卡；没写就和改造前一字不差。只用合成角色。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildCharacter, checkPrivacy, checkReferences } from '../src/build.ts';
import { DEFAULT_CARD_NOTES } from '../src/persona-to-card.ts';
import { checkSource, readSource, VOICE_KEYS, VOICE_READERS, writeSource, type CharacterSource } from '../src/source.ts';

const syntheticDir = resolve(import.meta.dirname, '../../bot/test/fixtures/synthetic-character');
const source = readSource(join(syntheticDir, 'source'));
const withoutVoice = (s: CharacterSource): CharacterSource => {
    const { voice: _voice, ...persona } = s.persona;
    return { ...s, persona };
};
const withVoiceEdit = (s: CharacterSource, edit: (voice: NonNullable<CharacterSource['persona']['voice']>) => void): CharacterSource => {
    const copy = structuredClone(s);
    edit(copy.persona.voice!);
    return copy;
};

test('合成资料生成的卡和 st/ 里提交的逐字节相同（convert:synthetic 跑过）', () => {
    for (const [file, text] of buildCharacter(source, 'synthetic').files) {
        assert.equal(readFileSync(join(syntheticDir, 'st', file), 'utf8'), text, file);
    }
});

test('不写 voice：卡里除了没有 extensions.qqbot.voice，其余和写了内置默认时一字不差', () => {
    const plain = buildCharacter(withoutVoice(source), 'synthetic');
    const voiced = buildCharacter(source, 'synthetic');
    for (const [i, built] of plain.tiers.entries()) {
        const card = structuredClone(voiced.tiers[i]!.card);
        assert.ok(card.data.extensions.qqbot?.voice, built.tier);
        delete card.data.extensions.qqbot!.voice;
        assert.deepEqual(built.card, card, built.tier);
        assert.equal(built.card.data.extensions.qqbot?.voice, undefined);
        assert.ok(built.card.data.post_history_instructions.includes(DEFAULT_CARD_NOTES), built.tier);
    }
});

test('按档位给：看不到的档位卡里是空串（不退回内置默认）；card_notes 看不到的档位卡末尾不带', () => {
    const narrowed = withVoiceEdit(source, voice => {
        voice.playful = { text: '合成：只给男朋友和同学的分寸', tiers: ['boyfriend', 'classmate'] };
        voice.qq_private = { text: '合成：只给男朋友的 QQ 口气', tiers: ['boyfriend'], variants: [] };
        voice.card_notes = { text: '合成：男朋友档的卡末尾', tiers: ['boyfriend'], variants: [{ tiers: ['classmate'], text: '合成：同学档改写' }] };
        voice.card_notes.tiers!.push('classmate');
    });
    const built = buildCharacter(narrowed, 'synthetic');
    const card = (tier: string) => built.tiers.find(t => t.tier === tier)!.card.data;
    assert.equal(card('boyfriend').extensions.qqbot?.voice?.playful, '合成：只给男朋友和同学的分寸');
    assert.equal(card('classmate-open').extensions.qqbot?.voice?.playful, '合成：只给男朋友和同学的分寸');
    assert.equal(card('stranger').extensions.qqbot?.voice?.playful, '');
    assert.equal(card('classmate').extensions.qqbot?.voice?.qqPrivate, '');
    assert.match(card('boyfriend').post_history_instructions, /不编你们没一起经历过的事。\n合成：男朋友档的卡末尾/);
    assert.match(card('classmate').post_history_instructions, /合成：同学档改写/);
    assert.doesNotMatch(card('stranger').post_history_instructions, /合成：|像同学之间讲题/);
    // 做不到的事和格式不归资料管，每档照旧在前面
    for (const { card: { data } } of built.tiers) assert.match(data.post_history_instructions, /只输出你要发出去的消息[\s\S]*你们只在 QQ 上打字说话/);
});

test('voice 段的校验：不认识的键、没写 tiers、档位名写错都报错；没写或空对象当作没写；存回去不丢', () => {
    const raw = (voice: unknown) => {
        const persona = { ...structuredClone(source.persona), voice };
        return { persona, scenes: source.scenes, schedule: source.schedule, tiers: source.tiers, moods: source.moods, books: source.books, world: source.world, biography: source.biography };
    };
    assert.throws(() => checkSource(raw({ tone: { text: 'x', tiers: ['boyfriend'] } })), /voice 有不认识的键：tone/);
    assert.throws(() => checkSource(raw({ playful: { text: 'x' } })), /voice\.playful\.tiers 应为字符串数组/);
    assert.throws(() => checkSource(raw({ playful: { text: '  ', tiers: ['boyfriend'] } })), /voice\.playful\.text 应为非空字符串/);
    assert.throws(() => checkReferences(checkSource(raw({ playful: { text: 'x', tiers: ['nobody'] } }))), /persona\.yml voice\.playful\.tiers：没有档位 nobody/);
    assert.equal(checkSource(raw(undefined)).persona.voice, undefined);
    assert.equal(checkSource(raw({})).persona.voice, undefined);
    assert.equal(checkSource(raw(null)).persona.voice, undefined);
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-voice-source-'));
    try {
        writeSource(dir, source);
        assert.deepEqual(readSource(dir).persona.voice, source.persona.voice);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('隐私检查也查 voice：这一档的禁用词写进给它的那一条就报出来', () => {
    const leaky = withVoiceEdit(source, voice => {
        voice.playful = { text: '合成：提到阿测', tiers: ['boyfriend', 'classmate'] };
    });
    const problems = checkPrivacy(buildCharacter(leaky, 'synthetic'), leaky);
    assert.ok(problems.some(p => p.tier === 'classmate' && p.where === '表达与称呼 playful' && p.word === '阿测'));
    assert.ok(problems.some(p => p.tier === 'classmate-open' && p.where === '表达与称呼 playful'));
    assert.ok(!problems.some(p => p.tier === 'boyfriend'));
    assert.deepEqual(checkPrivacy(buildCharacter(source, 'synthetic'), source), []);
});

test('每个 voice 键都写明了由哪一端读', () => {
    assert.deepEqual(Object.keys(VOICE_READERS), [...VOICE_KEYS]);
});
