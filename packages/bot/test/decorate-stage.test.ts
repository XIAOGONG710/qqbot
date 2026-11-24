import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DECORATE_STAGES, createInterpreter, decorateStages, type DecorateCtx, type Module, type Turn } from '../src/interpreter/interpreter.ts';
import { maybeTypo, RECALL_SHARE } from '../src/language/expression.ts';
import { typoModule } from '../src/modules/decorate.ts';

// 修饰顺序表（ADR 0336「生成之后那一段」第 11 步）：行为基线逐字不变（打错字补「*对的词」）；这里核对表本身和打错字的模块。
// 原来排在前面的质感（texture）随 fewerRules 转正删了（2026-11-24，减法单子 二.1）
const turnOf = (facts: Turn['facts'] = {}): Turn => ({ contact: { qq: 7, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T20:00:00+08:00'), history: [], thinking: false, facts });
const ctxOf = (original: readonly string[], extra: Partial<DecorateCtx> = {}): DecorateCtx & { lines: string[] } => {
    const lines: string[] = [];
    return { original, maxBubbles: 3, canRecall: false, log: line => lines.push(line), lines, ...extra };
};

describe('修饰顺序表（ADR 0336 第 11 步）', () => {
    test('只剩打错字', () => {
        assert.deepEqual([...DECORATE_STAGES], ['typo']);
    });

    test('同一位置按注册顺序；没挂模块原样返回同一个数组；撤回改口的打算带出来', () => {
        const late: Module = { id: 'late', decorateAt: { typo: parts => ({ parts: [...parts, 'c'], recall: { index: 0, wrong: '错', fix: '对', afterMs: 1 } }) } };
        const early: Module = { id: 'early', decorateAt: { typo: parts => [...parts, 'b'] } };
        const parts = ['稿'];
        assert.deepEqual(decorateStages([early, late], parts, turnOf(), ctxOf(parts)), { parts: ['稿', 'b', 'c'], recall: { index: 0, wrong: '错', fix: '对', afterMs: 1 } });
        assert.deepEqual(decorateStages([early], parts, turnOf(), ctxOf(parts)), ['稿', 'b']);
        assert.equal(decorateStages([], parts, turnOf(), ctxOf(parts)), parts);
    });

    test('只挂了 decorateAt 的模块也交给联系人流水线（createInterpreter 不筛掉它）', () => {
        const interpreter = createInterpreter({ modules: [typoModule()], exec: { every: () => 0 as never, cancel: () => {} } });
        assert.deepEqual(interpreter.turnModules.map(module => module.id), ['typo']);
    });
});

describe('打错字的模块（modules/decorate.ts）', () => {
    const samples = Array.from({ length: 300 }, (_, i) => [`我觉得应该可以的 ${i}`, '你今天怎么样']);

    test('打错字：和直接调 maybeTypo 一样；能撤回时带撤回改口的打算，不能时不带', () => {
        let typos = 0, recalls = 0;
        for (const parts of samples) {
            for (const canRecall of [false, true]) {
                const ctx = ctxOf(parts, { canRecall });
                const out = decorateStages([typoModule()], parts, turnOf(), ctx);
                const direct = maybeTypo(parts, `7 ${parts.join('|')}`, 3, canRecall ? RECALL_SHARE : 0);
                assert.deepEqual(out, direct.recall ? { parts: direct.parts, recall: direct.recall } : direct.parts);
                assert.deepEqual(ctx.lines, direct.note ? [`打错字：${direct.note}`] : []);
                typos += direct.note ? 1 : 0;
                recalls += direct.recall ? 1 : 0;
                if (!canRecall) assert.equal(direct.recall, undefined);
            }
        }
        assert.ok(typos > 0, '样本里至少有一条真的打错了字');
        assert.ok(recalls > 0, '能撤回时至少有一条改成撤回重发');
    });

    test('打错字：危机回合不打', () => {
        const parts = samples.find(sample => maybeTypo(sample, `7 ${sample.join('|')}`, 3, 0).note)!;
        assert.equal(decorateStages([typoModule()], parts, turnOf({ crisis: { level: 'high' } as NonNullable<Turn['facts']['crisis']> }), ctxOf(parts)), parts);
    });
});
