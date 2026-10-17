import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/history.ts';
import { createProactivePlanner, type Planner } from '../src/proactive-planner.ts';
import type { InitiateRequest } from '../src/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import type { DayWeather } from '../src/weather.ts';
import { SENSITIVE_ON, useSensitiveSwitch } from '../src/sensitive.ts';

// 这个文件里的测试靠日志里的原文来断言模块的行为；日志默认不写原文的那条由 log-bodies.test.ts 管
useSensitiveSwitch(SENSITIVE_ON);

const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const msg = (time: number, role: 'user' | 'assistant', content: string): StoredMessage => ({ time: new Date(time).toISOString(), role, content });
const settled = () => new Promise(r => setTimeout(r, 30));

describe('主动消息：下雨了（ADR 0050，计划器）', () => {
    const dirs: string[] = [];
    const planners: Planner[] = [];
    afterEach(() => {
        for (const p of planners.splice(0)) p.stop();
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    /** 10-16（周五，下午 3 点后没课）：预报 15 点下雨；rains 决定到时候真下没下 */
    function setup(rains: boolean) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-rain-'));
        dirs.push(dir);
        const clock = new VirtualClock(new Date(t(10, 16, 14, 30)));
        const logs: string[] = [];
        const initiated: InitiateRequest[] = [];
        const history = [msg(t(10, 16, 9), 'user', '早'), msg(t(10, 16, 9, 1), 'assistant', '早呀')];
        const weather = (now: number): DayWeather => {
            const hour = new Date(now).getHours();
            const rainHours = rains ? [15, 16, 17].filter(h => h <= hour) : [];
            return { rain: rainHours.length > 0, low: 15, high: 22, real: true, rainHours, ...(hour < 15 ? { later: '预报 15 点后有雨', laterHour: 15 } : {}) };
        };
        const planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings: { occasions: ['weather'], dailyMax: 2, unansweredMax: 1 }, dates: [], mode: 'dryRun',
            history: { load: () => history },
            responder: { initiate: async request => { initiated.push(request); request.commit(['下雨了']); return { result: 'dryRun', parts: ['下雨了'] }; } },
            dir, log: m => logs.push(m), now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '林梦瑶' },
            weather: now => ({ day: '2026-10-16', weather: weather(now) }),
        });
        planners.push(planner);
        return { clock, logs, initiated };
    }

    async function runUntil(clock: VirtualClock, end: number) {
        for (let i = 0; i < 40 && clock.now() < end; i++) {
            await settled();
            const next = clock.nextTimer();
            if (next === undefined || next > end) break;
            clock.advanceTo(next);
        }
        await settled();
    }

    test('按预报排在 15 点后，真下了就发；有真实天气时计划器最多睡半小时', async () => {
        const { clock, logs, initiated } = setup(true);
        await settled();
        assert.ok(logs.some(l => /主动[^：]*：下一次 今天 15:(1\d|2[0-5]) 下雨（15:00 预报要下雨）/.test(l)), logs.join('\n'));
        assert.ok(clock.nextTimer()! <= t(10, 16, 15, 1), '半小时内会醒来重算');
        await runUntil(clock, t(10, 16, 16));
        assert.equal(initiated.length, 1, logs.join('\n'));
        assert.match(initiated[0]!.label, /^下雨/);
        assert.match(initiated[0]!.note, /你这边下雨了/);
    });

    test('预报的雨没下：过了点重算时候选就没了（或者到点核实没在下），不发', async () => {
        const { clock, logs, initiated } = setup(false);
        await runUntil(clock, t(10, 16, 16));
        assert.equal(initiated.length, 0);
        assert.ok(logs.some(l => l.includes('没在下雨') || l.includes('没有要发的')), logs.join('\n'));
    });
});
