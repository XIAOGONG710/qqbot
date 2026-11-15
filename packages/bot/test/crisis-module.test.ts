import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assessTurn, type Turn } from '../src/interpreter/interpreter.ts';
import { crisisInHistory } from '../src/emotion/crisis.ts';
import { grievanceNow, ignoredNow } from '../src/emotion/grievance.ts';
import { crisisModule } from '../src/modules/crisis.ts';

// 危机信号和小别扭的起因（ADR 0336「判断那一串」第 6 步）：行为基线 crisis、closeness 等场景逐字不变；这里核对模块的条件——结果和直接调纯函数一样
const NOW = Date.parse('2026-11-20T20:00:00+08:00');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const crisisChat: Turn['history'] = [{ role: 'assistant', content: '在呢', time: at(-10) }, { role: 'user', content: '我不想活了', time: at(-1) }];
// 她发了几条他一直没回，隔了四天他才来
const awayChat: Turn['history'] = [
    { role: 'user', content: '晚安', time: at(-6 * 24 * 60) }, { role: 'assistant', content: '晚安', time: at(-6 * 24 * 60 + 1) },
    { role: 'assistant', content: '今天好累', time: at(-5 * 24 * 60) }, { role: 'assistant', content: '你在忙吗', time: at(-4 * 24 * 60) },
    { role: 'user', content: '在吗', time: at(-1) },
];
const run = (history: Turn['history'], options: { grievance?: boolean } = {}, extra: Partial<Turn> = {}) => {
    const lines: string[] = [];
    const turn: Turn = { contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date(NOW), history, thinking: false, facts: {}, ...extra };
    const done = assessTurn([crisisModule({ ...options, log: line => lines.push(line) })], turn);
    assert.equal(done, undefined, '同步，不多等一个微任务');
    return { facts: turn.facts, lines };
};

describe('危机信号和小别扭的起因（modules/crisis.ts）', () => {
    test('危机信号：和直接调 crisisInHistory 一样，记一行不带内容的日志；主动找他时不算', () => {
        const hit = crisisInHistory(crisisChat);
        assert.ok(hit, '样例确实是危机');
        const out = run(crisisChat);
        assert.deepEqual(out.facts.crisis, hit);
        assert.deepEqual(out.lines, [`[1] 危机信号：按 ${hit.level} 级辅助响应处理（日志不记内容）`]);
        const initiating = run(crisisChat, {}, { initiate: { note: '想他了' } as NonNullable<Turn['initiate']> });
        assert.deepEqual(initiating, { facts: {}, lines: [] });
    });

    test('平常的话：什么都不写', () => {
        assert.deepEqual(run([{ role: 'user', content: '今天去图书馆了', time: at(-1) }], { grievance: true }), { facts: {}, lines: [] });
    });

    test('小别扭的起因：开了才算，结果和直接调纯函数一样；只算男朋友档，主动找他、危机时没有', () => {
        const expected = grievanceNow(awayChat) ?? ignoredNow(awayChat);
        assert.ok(expected, '样例确实隔了好几天');
        assert.deepEqual(run(awayChat, { grievance: true }).facts.grievance, expected);
        assert.equal(run(awayChat).facts.grievance, undefined, '没开');
        assert.equal(run(awayChat, { grievance: true }, { contact: { qq: 2, name: '小周', tier: 'classmate' } }).facts.grievance, undefined);
        assert.equal(run(awayChat, { grievance: true }, { initiate: { note: '想他了' } as NonNullable<Turn['initiate']> }).facts.grievance, undefined);
        const both = run([...awayChat.slice(0, -1), { role: 'user', content: '我不想活了', time: at(-1) }], { grievance: true });
        assert.ok(both.facts.crisis);
        assert.equal(both.facts.grievance, undefined, '危机回合不闹别扭');
    });
});
