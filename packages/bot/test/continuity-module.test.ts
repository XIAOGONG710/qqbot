import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { contributeTurn, type Turn, type TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { continuityModule } from '../src/modules/continuity.ts';
import { timeBlockModule } from '../src/modules/time-block.ts';

// 连续性（ADR 0157–0163）迁成模块（ADR 0336）：取还在联系人流水线原来的位置（危机、只想一想不取），取回来的写进 turn.facts.continuity，这个模块只放。
// 行为基线里这一段一直是空的（时间线、口味开着但没有内容），真实 App 的 memory-app-web-owner-review 测试核对上网查到的那一行
describe('连续性模块（ADR 0157–0163 / 0336）', () => {
    const at = new Date('2026-11-20T21:00:00+08:00');
    const lines = ['[你最近在 QQ 聊天以外做过的事（合成）：看了一部电影]', '[你刚上网查了一下（合成）：星云团子饼是一项离线测试事实]'];
    const withLines = (facts: TurnFacts, continuity: readonly string[]): TurnFacts => ({ ...facts, continuity });
    const turnOf = (facts: TurnFacts = {}, patch: Partial<Turn> = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: '在吗', time: at.toISOString() }], thinking: false, facts, ...patch,
    });
    const run = (t: Turn) => continuityModule().contribute!(t) as Piece[];

    test('取回来几行就放几段，都在 continuity 槽，先后不变', () => {
        assert.deepEqual(run(turnOf(withLines({}, lines))), lines.map(text => ({ slot: 'continuity', text })));
    });

    test('她主动找他时取回来的也照放（迁移前就是这样，取的时候带 initiating）', () => {
        assert.deepEqual(run(turnOf(withLines({}, lines), { initiate: { note: '', topic: '' } })), lines.map(text => ({ slot: 'continuity', text })));
    });

    test('没取（危机、只想一想）或没取到：什么都不放', () => {
        assert.deepEqual(run(turnOf()), []);
        assert.deepEqual(run(turnOf(withLines({}, []))), []);
        assert.deepEqual(run(turnOf({ crisis: { level: 'high' } as TurnFacts['crisis'] })), []);
        assert.deepEqual(run(turnOf({}, { thinking: true })), []);
    });

    test('只放、不判断：危机、只想一想由取的那一下挡（模块自己不再挡一次，挡两处时变异检验抓不到其中一处）', () => {
        assert.equal(run(turnOf(withLines({ crisis: { level: 'high' } as TurnFacts['crisis'] }, lines))).length, 2);
        assert.equal(run(turnOf(withLines({}, lines), { thinking: true })).length, 2);
    });

    test('拼进「此刻」块：在时间那一行后面，几行按原来的顺序', () => {
        const turn = turnOf(withLines({}, lines));
        const { afterHistory } = contributeTurn([continuityModule(), timeBlockModule()], turn) as { afterHistory: string[] };
        const now = afterHistory.at(-1)!.split('\n');
        assert.match(now[0]!, /^\[当前时间：/);
        assert.deepEqual(now.slice(-2), lines);
    });
});
