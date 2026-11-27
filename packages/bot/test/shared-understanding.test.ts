import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordUnderstandingTurn, withdrawUnderstandingTurn } from '../src/life/understanding.ts';
import { sharedUnderstandingLine, readSharedUnderstanding } from '../../../dsh-plugins/dsh-linmengyao-memory/shared-understanding.mjs';
import { pathToFileURL } from 'node:url';
import { selfMemoryModule } from '../src/modules/self-memory.ts';
import type { Turn } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';

test('有歧义的合成回复隔天澄清，QQ 和桌面重读同一条记录', async () => {
    const { desktopUnderstanding } = await import(pathToFileURL(join(import.meta.dirname, '../../../dsh-plugins/dsh-linmengyao-memory/index.js')).href) as {
        desktopUnderstanding: (cfg: { understandingFile: string }, query: string, now: number) => string;
    };
    const dir = mkdtempSync(join(tmpdir(), 'shared-understanding-'));
    try {
        const file = join(dir, 'UNDERSTANDING.json');
        const original = '行，你去忙吧。';
        const clarification = '我当时在赶车，想让你先忙，没有生气。';
        const day = Date.parse('2026-11-19T11:00:00Z');
        const tomorrow = day + 86_400_000;
        const qq = (words: string, now: number) => {
            const module = selfMemoryModule({ understanding: query => sharedUnderstandingLine(file, query, now) || undefined, traces: () => undefined });
            const at = new Date(now);
            const turn: Turn = { at, facts: {}, thinking: false, contact: { qq: 10001, name: '合成联系人', tier: 'boyfriend' },
                history: [{ role: 'user', content: words, time: at.toISOString() }] };
            return (module.contribute!(turn) as Piece[]).find(piece => piece.slot === 'understanding')?.text;
        };
        const dsh = (words: string, now: number) => desktopUnderstanding({ understandingFile: file }, words, now);
        recordUnderstandingTurn(file, '1', original, day);
        const pending = readSharedUnderstanding(file)[0]!;
        assert.equal(pending.status, 'tentative');
        assert.equal(pending.original, original);
        assert.equal(pending.hypotheses.length, 2);
        assert.equal(pending.revision, undefined);
        assert.match(qq(original, day)!, /两种|可能/);
        assert.equal(qq(original, day), dsh(original, day));
        recordUnderstandingTurn(file, '2', '我没有生气，刚才在做饭。', tomorrow);
        assert.equal(readSharedUnderstanding(file)[0]!.status, 'tentative', '无明确关联的说明不改这条记录');
        recordUnderstandingTurn(file, '3', clarification, tomorrow);
        recordUnderstandingTurn(file, '3', clarification, tomorrow);
        const saved = readSharedUnderstanding(file);
        assert.equal(saved.length, 1);
        assert.equal(saved[0]!.original, original);
        assert.deepEqual(saved[0]!.hypotheses, pending.hypotheses);
        assert.equal(saved[0]!.revision?.evidence, clarification);
        assert.equal(saved[0]!.status, 'corrected');
        assert.match(qq(original, tomorrow)!, /已澄清.*没有生气/s);
        assert.equal(qq(original, tomorrow), dsh(original, tomorrow));
        assert.equal(qq(clarification, tomorrow), dsh(clarification, tomorrow));
        assert.equal(dsh('中午吃什么', tomorrow), '');
        withdrawUnderstandingTurn(file, '3');
        recordUnderstandingTurn(file, '3', clarification, tomorrow);
        assert.equal(readSharedUnderstanding(file)[0]!.status, 'tentative');
        assert.doesNotMatch(dsh(original, tomorrow), /赶车|已澄清/);
        withdrawUnderstandingTurn(file, '1');
        recordUnderstandingTurn(file, '1', original, day);
        assert.equal(readSharedUnderstanding(file).length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
