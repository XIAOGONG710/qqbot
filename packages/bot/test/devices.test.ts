import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Turn } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { devicesModule, type DevicesModuleOptions } from '../src/modules/devices.ts';

// 设备菜单模块（ADR 0336 第 5 步）：只给 allowed、非危机、非内心的轮次；主动找他的轮次照样给。
const at = new Date('2026-11-20T20:00:00+08:00');
const turnOf = (patch: Partial<Turn> = {}): Turn => ({
    contact: { qq: 1, name: '阿明', tier: 'boyfriend' },
    at,
    history: [],
    thinking: false,
    facts: {},
    ...patch,
});
const crisis = { match: '不想活了', level: 'concern' as const };
const run = (options: DevicesModuleOptions, turn: Turn): Piece[] => devicesModule(options).contribute!(turn) as Piece[];

describe('设备菜单模块（modules/devices.ts）', () => {
    test('模块 id 是 devices', () => {
        assert.equal(devicesModule({ menu: () => '', allowed: () => true }).id, 'devices');
    });

    test('男朋友档、非危机、非内心：放 devices 槽，菜单原样；allowed 收到这一轮的 contact', () => {
        const contact = { qq: 42, name: '阿明', tier: 'boyfriend' as const };
        const turn = turnOf({ contact });
        let seen: unknown;
        let menuCalls = 0;
        const out = run({
            menu: () => { menuCalls++; return '[设备] 开灯/空调'; },
            allowed: c => { seen = c; return true; },
        }, turn);
        assert.deepEqual(out, [{ slot: 'devices', text: '[设备] 开灯/空调' }]);
        assert.equal(seen, contact);
        assert.equal(menuCalls, 1);
    });

    test('allowed 为 false：不放，菜单也不取', () => {
        let menuCalls = 0;
        const out = run({ menu: () => { menuCalls++; return '菜单'; }, allowed: () => false }, turnOf());
        assert.deepEqual(out, []);
        assert.equal(menuCalls, 0);
    });

    test('危机回合：不放，菜单也不取；allowed 先被问过', () => {
        let menuCalls = 0;
        let allowedCalls = 0;
        const out = run({
            menu: () => { menuCalls++; return '菜单'; },
            allowed: () => { allowedCalls++; return true; },
        }, turnOf({ facts: { crisis } }));
        assert.deepEqual(out, []);
        assert.equal(allowedCalls, 1);
        assert.equal(menuCalls, 0);
    });

    test('只想一想（thinking）：不放，菜单也不取', () => {
        let menuCalls = 0;
        const out = run({ menu: () => { menuCalls++; return '菜单'; }, allowed: () => true }, turnOf({ thinking: true }));
        assert.deepEqual(out, []);
        assert.equal(menuCalls, 0);
    });

    test('主动找他的轮次照样放', () => {
        const out = run({ menu: () => '设备', allowed: () => true }, turnOf({ initiate: { note: '想他了', topic: '近况' } }));
        assert.deepEqual(out, [{ slot: 'devices', text: '设备' }]);
    });

    test('菜单是空串：照样放一段空的', () => {
        assert.deepEqual(run({ menu: () => '', allowed: () => true }, turnOf()), [{ slot: 'devices', text: '' }]);
    });

    test('超长菜单原样透传', () => {
        const long = '设备'.repeat(2000);
        assert.deepEqual(run({ menu: () => long, allowed: () => true }, turnOf()), [{ slot: 'devices', text: long }]);
    });

    test('危机 + 只想一想 + 不允许：不放，菜单也不取', () => {
        let menuCalls = 0;
        const out = run(
            { menu: () => { menuCalls++; return '菜单'; }, allowed: () => false },
            turnOf({ facts: { crisis }, thinking: true }),
        );
        assert.deepEqual(out, []);
        assert.equal(menuCalls, 0);
    });
});
