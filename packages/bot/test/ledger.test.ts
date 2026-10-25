import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { canonical, GENESIS_PREV, Ledger } from '../src/ledger.ts';

describe('哈希链账本（ADR 0157）', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const make = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-ledger-')); dirs.push(dir); return new Ledger(join(dir, 'x', 'a.jsonl')); };
    const fill = (ledger: Ledger) => { for (let i = 0; i < 4; i++) ledger.append('k', { i, text: `第 ${i} 条` }, new Date(2026, 9, 26, 0, i)); };

    test('canonical：键的顺序不影响结果，undefined 的键不算', () => {
        assert.equal(canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), canonical({ a: [2, { d: 1 }], b: 1 }));
        assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
    });

    test('追加、读回、验过：序号连续，第一条接 64 个 0，后一条接前一条的哈希', () => {
        const ledger = make();
        assert.deepEqual(ledger.verify(), { ok: true, count: 0 });
        fill(ledger);
        const entries = ledger.read();
        assert.deepEqual(entries.map(e => e.seq), [0, 1, 2, 3]);
        assert.equal(entries[0]!.prev, GENESIS_PREV);
        assert.equal(entries[2]!.prev, entries[1]!.hash);
        assert.deepEqual(ledger.verify(), { ok: true, count: 4 });
    });

    test('改了某一条的内容：从那一条起验不过', () => {
        const ledger = make();
        fill(ledger);
        const lines = readFileSync(ledger.path, 'utf8').trim().split('\n');
        lines[1] = lines[1]!.replace('第 1 条', '第 X 条');
        writeFileSync(ledger.path, lines.join('\n') + '\n');
        const result = ledger.verify();
        assert.equal(result.ok, false);
        assert.equal(result.brokenAt, 1);
        assert.match(result.reason!, /被改过/);
    });

    test('删掉中间一条：接不上', () => {
        const ledger = make();
        fill(ledger);
        const lines = readFileSync(ledger.path, 'utf8').trim().split('\n');
        writeFileSync(ledger.path, [lines[0], lines[2], lines[3]].join('\n') + '\n');
        const result = ledger.verify();
        assert.equal(result.ok, false);
        assert.match(result.reason!, /序号对不上|接不上/);
    });

    test('尾巴被截掉：账本自己还连得上，但和另存的末尾哈希对不上', () => {
        const ledger = make();
        fill(ledger);
        const lines = readFileSync(ledger.path, 'utf8').trim().split('\n');
        writeFileSync(ledger.path, lines.slice(0, 2).join('\n') + '\n');
        const result = ledger.verify();
        assert.equal(result.ok, false);
        assert.match(result.reason!, /尾巴被截掉/);
    });

    test('读不出来的一行不会被悄悄跳过', () => {
        const ledger = make();
        fill(ledger);
        appendFileSync(ledger.path, '{坏了\n');
        const result = ledger.verify();
        assert.equal(result.ok, false);
        assert.match(result.reason!, /读不出来/);
    });
});
