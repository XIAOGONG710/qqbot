import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { assemblePrompt, type Piece } from '../src/interpreter/slots.ts';
import { FEWER_RULES_BASICS, fewerRules, isSceneExample, relaxStyle, RULE_SLOTS, useFewerRules } from '../src/language/fewer-rules.ts';
import { intentLineModule } from '../src/modules/intent-line.ts';
import { replyBasicsModule } from '../src/modules/reply-basics.ts';
import type { Turn } from '../src/interpreter/interpreter.ts';
import { runScenario } from './baseline/harness.ts';
import { SCENARIOS } from './baseline/scenarios.ts';

// 少规矩（ADR 0342，配置 fewerRules，默认关）：教她怎么说话的那些不放，她是谁、她的日子、保命和格式照旧；关着时一个字都不变
afterEach(() => useFewerRules(false));

const pieces: Piece[] = [
    { slot: 'portrait', text: '我现在的样子' },
    { slot: 'time', text: '[当前时间]' },
    { slot: 'state', text: '[你现在：在宿舍]' },
    { slot: 'groundNote', text: '（没人问就别主动说）' },
    { slot: 'shape', text: '[这一轮说话：每条不超过 14 个字]' },
    { slot: 'lastUser', text: '他最后说的是：「在吗」。先接这一句' },
];

const turnOf = (facts: Record<string, unknown>, extra: Partial<Turn> = {}) => ({ facts, history: [], at: new Date('2026-11-20T12:00:00Z'), ...extra }) as unknown as Turn;

describe('少规矩（fewerRules）', () => {
    test('默认关：槽一个不少', () => {
        assert.equal(fewerRules(), false);
        const { afterMain, afterHistory } = assemblePrompt(pieces);
        assert.deepEqual(afterMain, ['我现在的样子']);
        assert.match(afterHistory.at(-1)!, /没人问就别主动说/);
        assert.match(afterHistory.at(-1)!, /每条不超过 14 个字/);
    });

    test('开着：教她怎么说话的槽不放；事实和她自己写的「我现在的样子」照放', () => {
        useFewerRules(true);
        const { afterMain, afterHistory } = assemblePrompt(pieces);
        assert.deepEqual(afterMain, ['我现在的样子']);
        const now = afterHistory.at(-1)!;
        assert.match(now, /当前时间/);
        assert.match(now, /你现在：在宿舍/);
        assert.doesNotMatch(now, /别主动说|不超过 14 个字/);
        assert.ok(!RULE_SLOTS.has('portrait') && !RULE_SLOTS.has('state') && !RULE_SLOTS.has('time'));
    });

    test('危机回合：开着也整套照放（槽、「他最后说的是」、人称）', () => {
        useFewerRules(true);
        const now = assemblePrompt(pieces, { crisis: true }).afterHistory.at(-1)!;
        assert.match(now, /没人问就别主动说/);
        assert.match(now, /每条不超过 14 个字/);
        assert.match(now, /先接这一句/);
        const module = replyBasicsModule();
        const fresh = [{ role: 'user', content: '我不想活了', time: '2026-11-20T11:59:00Z' }];
        const slots = (module.contribute!(turnOf({ crisis: { level: 'high' } }, { history: fresh } as Partial<Turn>)) as Piece[]).map(piece => piece.slot);
        assert.ok(slots.includes('lastUser') && slots.includes('directAnswer'), slots.join(','));
        assert.equal(RULE_SLOTS.has('person'), false, '人称那句帮她读懂「我」「你」，不算教她怎么说话');
    });

    test('意图行：开着时不放，危机回合照放', () => {
        const module = intentLineModule();
        useFewerRules(true);
        assert.deepEqual(module.contribute!(turnOf({ intent: '[这一轮你想：先直接回答他刚问的，不另起话题]' })), []);
        assert.deepEqual(module.contribute!(turnOf({ intent: '[危机意图]', crisis: { level: 'high' } })), [{ slot: 'intent', text: '[危机意图]' }]);
        useFewerRules(false);
        assert.deepEqual(module.contribute!(turnOf({ intent: '[这一轮你想：先直接回答他刚问的，不另起话题]' })), [{ slot: 'intent', text: '[这一轮你想：先直接回答他刚问的，不另起话题]' }]);
    });

    test('「他最后说的是」：开着时不放；她主动找他时那句「那不是刚说的」照放', () => {
        const module = replyBasicsModule();
        const fresh = [{ role: 'user', content: '在吗', time: '2026-11-20T11:59:00Z' }];
        const stale = [{ role: 'user', content: '晚安', time: '2026-11-20T06:00:00Z' }];
        useFewerRules(true);
        const lastUser = (list: unknown) => (list as Piece[]).filter(piece => piece.slot === 'lastUser');
        assert.deepEqual(lastUser(module.contribute!(turnOf({}, { history: fresh } as Partial<Turn>))), []);
        const initiating = lastUser(module.contribute!(turnOf({}, { history: stale, initiate: {} } as unknown as Partial<Turn>)));
        assert.equal(initiating.length, 1);
        assert.match(initiating[0]!.text, /那不是刚说的/);
        useFewerRules(false);
        assert.equal(lastUser(module.contribute!(turnOf({}, { history: fresh } as Partial<Turn>))).length, 1, '关着时照旧放');
    });

    test('场景范例认得出来；只管风格的开关一并关掉', () => {
        assert.equal(isSceneExample({ content: '[场景参考·打招呼] 类似的话你可能会这样回：「在呢」' }), true);
        assert.equal(isSceneExample({ content: '楼下的猫叫团子饼' }), false);
        const relaxed = relaxStyle({ speechCheck: true, tailCap: true, texture: true, shape: true, candidates: 3, herFeelings: true });
        assert.equal(relaxed.speechCheck, false);
        assert.equal(relaxed.shape, false);
        assert.equal(relaxed.candidates, 1);
        assert.equal(relaxed.herFeelings, true, '不是风格的开关不动');
    });

    test('整机（合成角色，her-now 场景）：开着时提示词里没有那些规矩，有她的日子、保命和卡末尾那四句', async () => {
        const base = SCENARIOS.find(s => s.name === 'her-now')!;
        const plain = await runScenario(base);
        const relaxed = await runScenario({ ...base, config: { ...base.config, fewerRules: true } });
        // 关着时有、开着时没有的规矩
        for (const rule of ['先接这一句，别接更早的话', '别琢磨怎么接才好看', '没人问就别主动说你累了', '说话短，一条消息一两句']) {
            assert.ok(plain.includes(rule), `关着时有：${rule}`);
            assert.ok(!relaxed.includes(rule), `开着时没有：${rule}`);
        }
        // 开着时照旧有的：她的日子、承认是程序的那段、卡末尾那四句
        assert.match(relaxed, /\[你现在：/);
        assert.match(relaxed, /【被问是不是 AI】/);
        assert.ok(relaxed.includes(FEWER_RULES_BASICS.split('\n')[0]!));
        assert.ok(relaxed.includes('不编他说过的话'));
    });
});
