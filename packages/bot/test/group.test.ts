import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Turn } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { groupModule } from '../src/modules/group.ts';

// 私聊问群公开日程时，把流水线读好的 groupEcho 照原样放进 group 槽；这里不取、不判断其它条件。
const at = new Date('2026-11-20T20:00:00+08:00');
const turnOf = (patch: Partial<Turn> = {}): Turn => ({
    contact: { qq: 1, name: '阿明', tier: 'boyfriend' },
    at,
    history: [],
    thinking: false,
    facts: {},
    ...patch,
});
const run = (turn: Turn): Piece[] => groupModule().contribute!(turn) as Piece[];

describe('群日程回显模块（modules/group.ts）', () => {
    test('模块 id 是 group', () => {
        assert.equal(groupModule().id, 'group');
    });

    test('有 groupEcho：原样放进 group 槽', () => {
        assert.deepEqual(run(turnOf({ facts: { groupEcho: '这周六下午篮球，群里定了' } })), [
            { slot: 'group', text: '这周六下午篮球，群里定了' },
        ]);
    });

    test('没有 groupEcho：空数组', () => {
        assert.deepEqual(run(turnOf()), []);
    });

    test('groupEcho 是空串：falsy，不放', () => {
        assert.deepEqual(run(turnOf({ facts: { groupEcho: '' } })), []);
    });

    test('超长回显原样透传', () => {
        const long = '群日程'.repeat(1000);
        assert.deepEqual(run(turnOf({ facts: { groupEcho: long } })), [{ slot: 'group', text: long }]);
    });

    test('危机、只想一想、主动找他都不影响：照放（源码只认 groupEcho）', () => {
        const turn = turnOf({
            facts: { groupEcho: '群日程', crisis: { match: '不想活了', level: 'concern' } },
            thinking: true,
            initiate: { note: '想他了', topic: '近况' },
        });
        assert.deepEqual(run(turn), [{ slot: 'group', text: '群日程' }]);
    });
});
