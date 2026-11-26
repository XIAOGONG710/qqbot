import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Turn } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { innerModule, type InnerModuleOptions } from '../src/modules/inner.ts';

// 内心的那一行（ADR 0101）：危机回合不放；取到空行不放；快照轮次放但不记日志。
// 文件名带 -module 是因为已有 inner.test.ts 测的是 src/proactive/inner.ts（不同模块，不能覆盖）。
const at = new Date('2026-11-20T20:00:00+08:00');
const turnOf = (patch: Partial<Turn> = {}): Turn => ({
    contact: { qq: 1, name: '阿明', tier: 'boyfriend' },
    at,
    history: [],
    thinking: false,
    facts: {},
    ...patch,
});
const run = (options: InnerModuleOptions, turn: Turn): Piece[] => innerModule(options).contribute!(turn) as Piece[];

describe('内心模块（modules/inner.ts）', () => {
    test('模块 id 是 inner', () => {
        const options: InnerModuleOptions = { innerLine: () => undefined, log: () => {} };
        assert.equal(innerModule(options).id, 'inner');
    });

    test('取到一行：放进 inner 槽，innerLine 收到同一 contact，日志带 [qq]', () => {
        const contact = { qq: 42, name: '阿明', tier: 'boyfriend' as const };
        const turn = turnOf({ contact });
        const lines: string[] = [];
        let seen: unknown;
        const out = run({
            innerLine: c => { seen = c; return '今天在想他面试顺不顺利'; },
            log: line => { lines.push(line); },
        }, turn);
        assert.deepEqual(out, [{ slot: 'inner', text: '今天在想他面试顺不顺利' }]);
        assert.equal(seen, contact);
        assert.deepEqual(lines, ['[42] 内心：这一轮提示词里放了她最近的念头']);
    });

    test('危机回合：不放，innerLine 不取，日志不写', () => {
        let innerCalls = 0;
        const lines: string[] = [];
        const out = run({
            innerLine: () => { innerCalls++; return '一行念头'; },
            log: line => { lines.push(line); },
        }, turnOf({ facts: { crisis: { match: '不想活了', level: 'concern' } } }));
        assert.deepEqual(out, []);
        assert.equal(innerCalls, 0);
        assert.deepEqual(lines, []);
    });

    test('innerLine 返回 undefined：不放，也不记日志', () => {
        const lines: string[] = [];
        const out = run({ innerLine: () => undefined, log: line => { lines.push(line); } }, turnOf());
        assert.deepEqual(out, []);
        assert.deepEqual(lines, []);
    });

    test('innerLine 返回空串：不放，也不记日志', () => {
        const lines: string[] = [];
        const out = run({ innerLine: () => '', log: line => { lines.push(line); } }, turnOf());
        assert.deepEqual(out, []);
        assert.deepEqual(lines, []);
    });

    test('快照轮次（snapshot）：照样放，但不记日志', () => {
        const lines: string[] = [];
        const out = run({ innerLine: () => '一行念头', log: line => { lines.push(line); } }, turnOf({ snapshot: true }));
        assert.deepEqual(out, [{ slot: 'inner', text: '一行念头' }]);
        assert.deepEqual(lines, []);
    });

    test('超长的一行原样透传', () => {
        const long = '在想他'.repeat(2000);
        assert.deepEqual(run({ innerLine: () => long, log: () => {} }, turnOf()), [{ slot: 'inner', text: long }]);
    });

    test('主动找他、只想一想都照放（源码只拦危机）', () => {
        const lines: string[] = [];
        const turn = turnOf({ initiate: { note: '想他了', topic: '近况' }, thinking: true });
        const out = run({ innerLine: () => '一行念头', log: line => { lines.push(line); } }, turn);
        assert.deepEqual(out, [{ slot: 'inner', text: '一行念头' }]);
        assert.deepEqual(lines, ['[1] 内心：这一轮提示词里放了她最近的念头']);
    });

    test('快照 + 危机：危机优先，innerLine 不取', () => {
        let innerCalls = 0;
        const out = run({
            innerLine: () => { innerCalls++; return '一行念头'; },
            log: () => {},
        }, turnOf({ snapshot: true, facts: { crisis: { match: '不想活了', level: 'concern' } } }));
        assert.deepEqual(out, []);
        assert.equal(innerCalls, 0);
    });
});
