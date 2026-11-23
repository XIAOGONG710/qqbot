import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { appendFeelings, COARSE_AFTER_DAYS, ledgerNote, ledgerPath, readLedger, withheldCause, withholdOf } from '../src/emotion/feeling-ledger.ts';
import type { Felt } from '../src/emotion/feelings.ts';
import type { LedgerEntry } from '../src/emotion/feeling-ledger.ts';

// ADR 0347 第 5 层：感觉账。只追加；疼和她妈那块的慌不原样带上；三个月前只剩个大概；开心不降。
const at = (d: number, h: number) => new Date(2026, 10, d, h).getTime();
const f = (kind: Felt['kind'], cause: string, extra: Partial<Felt> = {}): Felt =>
    ({ kind, weight: 1.5, level: 'clear', cause, source: 'world', aboutHim: false, ...extra });
const dir = () => mkdtempSync(join(tmpdir(), 'feeling-ledger-'));

describe('感觉账：只追加', () => {
    test('明显以上的记一行；同一天同一件同一类不重复记；faint 不收', () => {
        const soul = dir();
        const felt = [f('joy', '相机到手了'), f('sad', '小测没考好'), f('tired', '熬到两点', { level: 'faint' })];
        assert.equal(appendFeelings(soul, felt, at(21, 20)), 2);
        assert.equal(appendFeelings(soul, felt, at(21, 21)), 0);
        assert.equal(readLedger(soul).length, 2);
        assert.ok(!readLedger(soul).some(row => row.kind === 'tired'));
    });

    test('换个日子同一种感受再记一次——账是流水，不是去重表', () => {
        const soul = dir();
        appendFeelings(soul, [f('joy', '和他聊到很晚')], at(20, 22));
        assert.equal(appendFeelings(soul, [f('joy', '和他聊到很晚')], at(21, 22)), 1);
        assert.equal(readLedger(soul).length, 2);
    });

    test('文件不在、坏行都跳过，不炸', () => {
        const soul = dir();
        assert.deepEqual(readLedger(soul), []);
        writeFileSync(ledgerPath(soul), 'not json\n{"at":"x"}\n\n', 'utf8');
        assert.deepEqual(readLedger(soul), []);
    });
});

describe('感觉账：她不想原样带上的两类', () => {
    test('疼记成「身上不太舒服」，不说是什么事', () => {
        const soul = dir();
        appendFeelings(soul, [f('sad', '痛经疼得躺着')], at(21, 15));
        const [row] = readLedger(soul) as [LedgerEntry];
        assert.equal(row.withhold, 'pain');
        assert.equal(row.coarse, true);
        assert.equal(withheldCause(row.withhold), '身上不太舒服');
        // 召回时只说换过的那句、不带程度（11-23：QQ 这边原来没换，照出「有点难过」，和插件不一致）
        assert.match(ledgerNote(row), /只记得个大概：身上不太舒服（那是你当时的感觉，现在不一定还这样）/);
        assert.doesNotMatch(ledgerNote(row), /痛经|难过/);
    });

    test('她妈那块的慌只说「心里一直悬着」；别的担心照原样', () => {
        assert.equal(withholdOf('worry', '我妈又说成绩的事'), 'mother');
        assert.equal(withheldCause('mother'), '心里一直悬着');
        assert.equal(withholdOf('worry', '高数补考没过'), '');
        assert.equal(withholdOf('sad', '我妈说我'), '', '只有担心的那种才换说法');
    });

    test('账里留着原文，召回时换说法——她自己翻得到，带上来时不说', () => {
        const soul = dir();
        appendFeelings(soul, [f('worry', '我妈又提成绩了')], at(21, 15));
        const raw = readFileSync(ledgerPath(soul), 'utf8');
        assert.match(raw, /我妈又提成绩了/);
        assert.doesNotMatch(ledgerNote(readLedger(soul)[0]!), /我妈/);
    });
});

describe('感觉账：衰减不按天数硬删', () => {
    test(`${COARSE_AFTER_DAYS} 天以前的降成大概，但还在账里`, () => {
        const soul = dir();
        appendFeelings(soul, [f('sad', '水卡找不到了')], at(1, 10));
        const later = at(1, 10) + (COARSE_AFTER_DAYS + 5) * 86_400_000;
        const [row] = readLedger(soul, later) as [LedgerEntry];
        assert.ok(row, '没被删掉');
        assert.equal(row.coarse, true);
        assert.match(ledgerNote(row), /只记得个大概/);
    });

    test('开心和松口气不降——想起来还会笑的那种就留着', () => {
        const soul = dir();
        appendFeelings(soul, [f('joy', '他记着我生日'), f('relief', '作业交上去了')], at(1, 10));
        const later = at(1, 10) + 400 * 86_400_000;
        for (const row of readLedger(soul, later)) {
            assert.equal(row.coarse, false, row.kind);
            assert.doesNotMatch(ledgerNote(row), /只记得个大概/);
        }
    });
});

// 她 11-22 第 3 问：「会带一点。想起来还是有点堵，但堵一会儿就过去了，不会攒着」——因为他而起的附，但最多到「有点」
test('因为他难过 / 烦 / 担心的：附，但最多到「有点」；别的照程度', async () => {
    const { ledgerNote } = await import('../src/emotion/feeling-ledger.ts');
    const base = { at: Date.now(), cause: '他好久不回消息', coarse: false, withhold: '' as const };
    assert.match(ledgerNote({ ...base, kind: 'sad', level: 'strong', aboutHim: true } as never), /心里有点难过/);
    assert.doesNotMatch(ledgerNote({ ...base, kind: 'sad', level: 'strong', aboutHim: true } as never), /很难过/);
    assert.match(ledgerNote({ ...base, kind: 'joy', level: 'strong', aboutHim: true } as never), /心里很开心/, '开心的不压');
    assert.match(ledgerNote({ ...base, kind: 'sad', level: 'strong', aboutHim: false } as never), /心里很难过/, '不是因为他的照程度');
});
