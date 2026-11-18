import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeHumanState, type HumanValues } from '../src/human-values.ts';
import type { Tier } from '../src/platform/config.ts';
import { contributeTurn, decideStage, type DecideCtx, type Turn, type TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { describeDevelopment, developmentSnapshot, type DevelopmentSnapshot } from '../src/life/development.ts';
import { describeHumanValues } from '../src/human-values.ts';
import { humanStateModule } from '../src/modules/human-state.ts';

// 真人数值（ADR 0222）和人格成长层（ADR 0251）迁成模块（ADR 0336）：行为基线里 29 个场景两行都有，
// 只想一想、没有数值、数值平平没有底色这几种由这里核对
describe('真人数值和人格成长层模块（ADR 0222 / 0251 / 0336）', () => {
    const at = new Date('2026-11-20T21:00:00+08:00');
    const calm: HumanValues = {
        at: at.toISOString(), energy: 70, hunger: 30, stress: 30, mood: 55, health: 90, loneliness: 40, confidence: 60, curiosity: 50,
        boredom: 30, motivation: 50, socialBattery: 60, selfEsteem: 60, openness: 60, satisfaction: 60, comfort: 70, frustration: 20,
        relationship: { intimacy: 60, trust: 60, familiarity: 60, attachment: 60, friction: 10 },
    };
    const tired: HumanValues = { ...calm, energy: 20, hunger: 85, relationship: { ...calm.relationship, intimacy: 80, trust: 70 } };
    const snapshot: DevelopmentSnapshot = {
        at: at.toISOString(),
        lifeArcs: [{ id: 'photography', progress: 40, evidence: 3, state: 'active', momentum: 'growing' }],
        autonomy: { mode: 'recover', reason: 'body', mayChangePlan: true, horizon: 'now' },
        relationship: { stage: 'secure', security: 80, closenessNeed: 60, repairReadiness: 70, pace: 'open' },
        emotion: { tone: 'steady', inertia: 'stable', source: 'mixed', carry: 'short' },
        tastes: [], creativeDrafts: [], sharedExperiences: [], reflections: [],
    };
    const turnOf = (facts: { humanValues?: HumanValues; development?: DevelopmentSnapshot }, patch: Partial<Turn> = {}, tier: Tier = 'boyfriend'): Turn => ({
        contact: { qq: 1, name: '阿明', tier }, at, history: [], thinking: false, facts: facts as TurnFacts, ...patch,
    });
    const run = (t: Turn) => humanStateModule().contribute!(t) as Piece[];

    test('两样都有：humanState、development 各放一行，写法同 describeHumanState / describeDevelopment', () => {
        const pieces = run(turnOf({ humanValues: tired, development: snapshot }));
        assert.deepEqual(pieces, [
            { slot: 'humanState', text: describeHumanState(tired, 'boyfriend')! },
            { slot: 'development', text: describeDevelopment(snapshot)! },
        ]);
        assert.match(pieces[0]!.text, /有点累，没什么劲；肚子明显饿了；跟他很亲近，信任是稳的/);
        assert.match(pieces[1]!.text, /最近持续在推进摄影；这会儿更适合先恢复状态/);
    });

    test('底色按这一档算：不是男朋友档没有「跟他很亲近」', () => {
        const [piece] = run(turnOf({ humanValues: tired }, {}, 'classmate'));
        assert.equal(piece!.text, describeHumanState(tired, 'classmate'));
        assert.doesNotMatch(piece!.text, /跟他/);
    });

    test('只想一想的轮次：两行都不放', () => {
        assert.deepEqual(run(turnOf({ humanValues: tired, development: snapshot }, { thinking: true })), []);
    });

    test('没有数值、没有快照（App 没有需要锚点或世界账、模拟器）：什么都不放', () => {
        assert.deepEqual(run(turnOf({})), []);
    });

    test('数值平平没有底色时只放成长那一行；只有其中一样时只放那一样', () => {
        assert.equal(describeHumanState(calm, 'boyfriend'), undefined);
        assert.deepEqual(run(turnOf({ humanValues: calm, development: snapshot })).map(p => p.slot), ['development']);
        assert.deepEqual(run(turnOf({ humanValues: tired })).map(p => p.slot), ['humanState']);
        assert.deepEqual(run(turnOf({ development: snapshot })).map(p => p.slot), ['development']);
    });

    test('危机、主动找他的轮次照放（迁移前就不看这些）', () => {
        const initiating = turnOf({ humanValues: tired, development: snapshot }, { initiate: { note: '', topic: '' } });
        assert.deepEqual(run(initiating).map(p => p.slot), ['humanState', 'development']);
        const crisis = turnOf({ humanValues: tired, development: snapshot });
        crisis.facts.crisis = { level: 'high' } as TurnFacts['crisis'];
        assert.deepEqual(run(crisis).map(p => p.slot), ['humanState', 'development']);
    });

    test('经槽位表拼：在「此刻」块里身体之后、没了结的事之前，底色在前', () => {
        const body: Piece = { slot: 'body', text: '[身体]' };
        const unsettled: Piece = { slot: 'unsettled', text: '[没了结]' };
        const others = { id: 'others', contribute: () => [unsettled, body] };
        const assembled = contributeTurn([others, humanStateModule()], turnOf({ humanValues: tired, development: snapshot }));
        assert.ok(!(assembled instanceof Promise));
        assert.deepEqual(assembled.afterHistory, [['[身体]', describeHumanState(tired, 'boyfriend'), describeDevelopment(snapshot), '[没了结]'].join('\n')]);
    });

    describe('算（decideAt.values，联系人流水线在 buildPrompt 开头原位调）', () => {
        const decide = (values: DecideCtx['values'], history: Turn['history'] = []) => {
            const lines: string[] = [];
            const turn = turnOf({}, { history });
            decideStage([humanStateModule()], 'values', turn, { history: () => [], log: line => lines.push(line), ...(values ? { values } : {}) });
            return { facts: turn.facts, lines };
        };

        test('没给数值的取法（模拟器、没有锚点）：什么都不写、不记日志', () => {
            const { facts, lines } = decide(undefined);
            assert.deepEqual(facts, {});
            assert.deepEqual(lines, []);
        });

        test('取法拿到这一轮的联系人、聊天记录和时刻；没有数值时不读世界账、不算成长层', () => {
            const seen: unknown[] = [];
            const history: Turn['history'] = [{ role: 'user', content: '在吗', time: at.toISOString() }];
            const { facts, lines } = decide({ humanValues: context => { seen.push(context); return undefined; }, worldEvents: () => { throw new Error('不该读世界账'); } }, history);
            assert.deepEqual(seen, [{ contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, history, at }]);
            assert.deepEqual(facts, {});
            assert.deepEqual(lines, []);
        });

        test('有数值：先记数值那一行，再按世界账的事件算成长层、记摘要；两样写进 facts', () => {
            const { facts, lines } = decide({ humanValues: () => tired, worldEvents: () => [] });
            assert.equal(facts.humanValues, tired);
            assert.deepEqual(facts.development, developmentSnapshot({ at, values: tired, history: [], events: [] }));
            assert.equal(lines[0], describeHumanValues(tired));
            assert.match(lines[1]!, /^人格成长层：人生线 \d+，关系 /);
            assert.equal(lines.length, 2);
        });

        test('成长层投影出错：记一行、不写成长层，数值照写', () => {
            const { facts, lines } = decide({ humanValues: () => tired, worldEvents: () => { throw new Error('账坏了'); } });
            assert.equal(facts.humanValues, tired);
            assert.equal(facts.development, undefined);
            assert.deepEqual(lines.slice(1), ['人格成长层：投影失败（账坏了）']);
        });
    });
});
