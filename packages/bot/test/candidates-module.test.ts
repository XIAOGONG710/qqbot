import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { candidatePlan, createInterpreter, type Module, type Turn } from '../src/interpreter/interpreter.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { candidatesModule } from '../src/modules/candidates.ts';
import { parseCharacterCard } from '../src/st/card.ts';

// 挑候选的模块（ADR 0336「生成之后那一段」第 10 步）：行为基线 candidates 场景逐字不变；这里核对模块本身——什么时候挑、规则从哪来、怎么挑
const CARE = '先接住他此刻的情绪';
const card = parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红', extensions: { qqbot: { banned: ['秘密'] } } } });
const turnOf = (facts: Turn['facts'] = {}, extra: Partial<Turn> = {}): Turn => ({
    contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T20:00:00+08:00'),
    history: [{ role: 'assistant', content: '在呢' }, { role: 'user', content: '今天被导师骂了' }, { role: 'user', content: '我家猫团子也不理我' }],
    thinking: false, card, facts, ...extra,
});
const noHistory = (): StoredMessage[] => [];

describe('挑候选的模块（modules/candidates.ts）', () => {
    test('他难过 / 亲密话 / 收尾的意图行才挑，各自的句数上限；别的意图、没有意图不挑', () => {
        const module = candidatesModule({ count: 3, history: noHistory });
        for (const [intent, kind, maxLines] of [[CARE, 'care', 2], ['只接他刚说的你们两个人的事', 'bid', 3], ['顺着他的话收尾', 'ending', 2]] as const) {
            const turn = turnOf({ intent: `[${intent}，别的不说]` });
            assert.deepEqual(module.contribute!(turn), []);
            assert.equal(turn.facts.pick?.kind, kind);
            assert.equal(turn.facts.pick?.maxLines, maxLines);
            assert.equal(module.candidates!(turn)?.count, 3);
        }
        for (const facts of [{ intent: '[先直接回答他的问题]' }, {}]) {
            const turn = turnOf(facts);
            assert.deepEqual(module.contribute!(turn), []);
            assert.equal(turn.facts.pick, undefined);
            assert.equal(module.candidates!(turn), undefined);
        }
    });

    test('主动找他、配置不大于 1 时不挑', () => {
        const initiating = turnOf({ intent: CARE }, { initiate: { note: '想他了' } as NonNullable<Turn['initiate']> });
        candidatesModule({ count: 3, history: noHistory }).contribute!(initiating);
        assert.equal(initiating.facts.pick, undefined);
        const single = turnOf({ intent: CARE });
        const off = candidatesModule({ count: 1, history: noHistory });
        off.contribute!(single);
        assert.equal(off.candidates!(single), undefined);
    });

    test('规则：他这次说的、卡上的禁用词和书面词、她自己的东西（猫的名字来自她那边）', () => {
        const turn = turnOf({ intent: CARE, world: { cat: { name: '团子' } } as NonNullable<Turn['facts']['world']> });
        candidatesModule({ count: 3, history: noHistory }).contribute!(turn);
        const rules = turn.facts.pick!;
        assert.equal(rules.heard, '今天被导师骂了\n我家猫团子也不理我');
        assert.ok(rules.banned.includes('秘密'));
        assert.ok(rules.banned.length > 1, '还有医书里的词、书面腔');
        assert.equal(rules.own[0], '团子');
        assert.ok(rules.own.includes('相机') && rules.own.includes('追剧'));
        assert.equal(rules.speech, undefined, '没开 speechCheck 不查说话的毛病');
    });

    test('开了 speechCheck 才读聊天记录，读的是这个联系人的', () => {
        const asked: number[] = [];
        const history = (qq: number): StoredMessage[] => { asked.push(qq); return []; };
        const off = turnOf({ intent: CARE });
        candidatesModule({ count: 3, history }).contribute!(off);
        assert.deepEqual(asked, []);
        const on = turnOf({ intent: CARE });
        candidatesModule({ count: 3, speechCheck: true, history }).contribute!(on);
        assert.deepEqual(asked, [1]);
        assert.ok(on.facts.pick?.speech);
    });

    test('choose：挑扣分最少的、一样少挑先生成的，记一行日志', () => {
        const module = candidatesModule({ count: 3, history: noHistory });
        const turn = turnOf({ intent: CARE });
        module.contribute!(turn);
        const lines: string[] = [];
        const plan = module.candidates!(turn)!;
        // 第 1 个 3 句还叮嘱作息、第 3 个约「写完跟我说一声」
        assert.equal(plan.choose(['别难过了\n早点睡\n明天就好了', '抱抱\n怎么回事呀', '抱抱\n写完跟我说一声'], line => lines.push(line)), 1);
        assert.equal(lines.length, 1);
        assert.match(lines[0]!, /^候选 3 个，挑第 2 个/);
        assert.equal(plan.choose(['抱抱', '怎么了'], () => {}), 0);
    });

    test('candidatePlan：第一个有打算的模块说了算；只实现 candidates 的模块不被解释器筛掉', () => {
        const none: Module = { id: 'none', candidates: () => undefined };
        const two: Module = { id: 'two', candidates: () => ({ count: 2, choose: () => 1 }) };
        const five: Module = { id: 'five', candidates: () => ({ count: 5, choose: () => 0 }) };
        assert.equal(candidatePlan([none, two, five], turnOf())?.count, 2);
        assert.equal(candidatePlan([none], turnOf()), undefined);
        assert.equal(candidatePlan([], turnOf()), undefined);
        const interpreter = createInterpreter({ modules: [two], exec: { every: () => 0 as never, cancel: () => {} } });
        assert.deepEqual(interpreter.turnModules.map(module => module.id), ['two']);
    });
});
