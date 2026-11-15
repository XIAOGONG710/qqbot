import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AFFECT_REPLIES, describeWarmAffect, warmAffect } from '../src/emotion/affect.ts';
import type { Turn, TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import type { ChatMessage } from '../src/language/prompt.ts';
import { describeUnsettled, type OpenLoop } from '../src/life/open-loops.ts';
import { warmModule } from '../src/modules/warm.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { syntheticCardPath } from './fixtures/card.ts';

// 情绪余温（ADR 0028）和没了结的事（ADR 0023）迁成模块（ADR 0336）：行为基线里余温在 register（想念）、watched（道歉）两个场景，
// 安慰和没了结的事基线一处都没走到，条件由这里逐个核对
describe('情绪余温和没了结的事模块（ADR 0028 / 0023 / 0336）', () => {
    const card = loadCharacterCard(syntheticCardPath('boyfriend'));
    const noMoods = { ...card, moods: [] };
    const at = new Date('2026-11-20T21:00:00+08:00');
    const said = (content: string): ChatMessage => ({ role: 'user', content });
    const her = (content: string): ChatMessage => ({ role: 'assistant', content });
    const loop = (what: string): OpenLoop => ({ id: 'u-1', kind: 'unsettled', what, said: '2026-11-19', episode: 'ep-1' });
    const thing = '11月19日说好一起看电影，他加班没去成';
    const turnOf = (history: readonly ChatMessage[], unsettled?: readonly string[], patch: Partial<Turn> = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history, thinking: false, card,
        facts: unsettled ? { unsettled } : {}, ...patch,
    });
    const logs: string[] = [];
    const run = (t: Turn) => warmModule({ log: message => logs.push(message) }).contribute!(t) as Piece[];

    test('他刚道歉：放 warm 槽，写法同 describeWarmAffect；日志同迁移前', () => {
        logs.length = 0;
        const history = [her('哼'), said('对不起嘛')];
        assert.deepEqual(run(turnOf(history)), [{ slot: 'warm', text: describeWarmAffect(warmAffect(history))! }]);
        assert.deepEqual(logs, ['[1] 情绪余温：repair，还影响 3 轮']);
    });

    test('想念、安慰也算；连发的气泡算一轮，回满三轮就散', () => {
        assert.match(run(turnOf([said('想你了')]))[0]!.text, /想念或喜欢/);
        assert.match(run(turnOf([said('抱抱，别难过')]))[0]!.text, /关心、安慰你/);
        const after = (rounds: number) => [said('对不起'), ...Array.from({ length: rounds }, (_, i) => [her(`嗯${i}`), her('好'), said('然后呢')]).flat()];
        assert.equal(run(turnOf(after(AFFECT_REPLIES - 1))).length, 1);
        assert.deepEqual(run(turnOf(after(AFFECT_REPLIES))), []);
    });

    test('卡上没有心情：没有余温，也不换成「正在修补」的说法', () => {
        logs.length = 0;
        const history = [said('对不起')];
        assert.deepEqual(run(turnOf(history, [], { card: noMoods })), []);
        assert.deepEqual(run(turnOf(history, [thing], { card: noMoods })), [{ slot: 'unsettled', text: describeUnsettled([loop(thing)], false)! }]);
        // 不经联系人流水线建的轮次可以没有卡：同样不算余温
        assert.deepEqual(run(turnOf(history, undefined, { card: undefined })), []);
        assert.deepEqual(logs, []);
    });

    test('没了结的事：放 unsettled 槽；他在道歉 / 安慰时换成修补的说法，想念不算修补', () => {
        const two = ['11月19日说好一起看电影，他加班没去成', '聊到期末复习计划说到一半就断了'];
        assert.deepEqual(run(turnOf([said('今天好累')], two)), [{ slot: 'unsettled', text: describeUnsettled(two.map(loop), false)! }]);
        assert.match(run(turnOf([said('今天好累')], two))[0]!.text, /余波/);
        for (const words of ['对不起，是我不好', '抱抱，别难过']) {
            const pieces = run(turnOf([said(words)], [thing]));
            assert.deepEqual(pieces.map(p => p.slot), ['unsettled', 'warm'], words);
            assert.equal(pieces[0]!.text, describeUnsettled([loop(thing)], true), words);
            assert.match(pieces[0]!.text, /正在修补/, words);
        }
        const missing = run(turnOf([said('想你了')], [thing]));
        assert.equal(missing[0]!.text, describeUnsettled([loop(thing)], false));
    });

    test('没有挂着的事、或者挂着的都不是没了结的：不放 unsettled', () => {
        assert.deepEqual(run(turnOf([said('今天好累')])), []);
        assert.deepEqual(run(turnOf([said('今天好累')], [])), []);
    });

    test('危机、主动找他、只想一想的轮次照放（迁移前就不看这些）', () => {
        const history = [said('对不起')];
        for (const patch of [{ thinking: true }, { initiate: { note: '', topic: '' } }] satisfies Partial<Turn>[]) {
            assert.deepEqual(run(turnOf(history, [thing], patch)).map(p => p.slot), ['unsettled', 'warm']);
        }
        const crisis = turnOf(history, [thing]);
        (crisis.facts as TurnFacts).crisis = { level: 'high' } as TurnFacts['crisis'];
        assert.deepEqual(run(crisis).map(p => p.slot), ['unsettled', 'warm']);
    });
});
