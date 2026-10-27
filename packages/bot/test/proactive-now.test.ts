import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import { CRISIS_PAUSE_REASON, PENDING_REASON } from '../src/proactive/proactive.ts';
import { createProactivePlanner, type Planner } from '../src/proactive/proactive-planner.ts';
import type { InitiateRequest } from '../src/social/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { SENSITIVE_ON, useSensitiveSwitch } from '../src/platform/sensitive.ts';

useSensitiveSwitch(SENSITIVE_ON);

const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const msg = (time: number, role: 'user' | 'assistant', content: string): StoredMessage => ({ time: new Date(time).toISOString(), role, content });

// ADR 0156：他发「/主动」，让她现在就主动找他一次
describe('/主动：让她现在找他', () => {
    const dirs: string[] = [];
    const planners: Planner[] = [];
    afterEach(() => {
        for (const p of planners.splice(0)) p.stop();
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    function setup(history: StoredMessage[], options: { crisis?: boolean; at?: number } = {}) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-now-'));
        dirs.push(dir);
        const clock = new VirtualClock(new Date(options.at ?? t(10, 25, 23, 50)));
        const logs: string[] = [];
        const requests: InitiateRequest[] = [];
        const planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings: { occasions: ['morning'], dailyMax: 3, unansweredMax: 2 }, dates: [], mode: 'on',
            history: { load: () => history },
            responder: {
                initiate: async (request: InitiateRequest) => {
                    requests.push(request);
                    request.commit(['刚想起一件事']);
                    return { result: 'sent', parts: ['刚想起一件事'], messageIds: [1] };
                },
            },
            dir, log: m => logs.push(m), now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '林梦瑶' },
            ...(options.crisis ? { crisisPaused: () => true } : {}),
        });
        planners.push(planner);
        return { planner, requests, logs };
    }

    test('夜里、一小时内聊过、上一条主动消息他还没回：这些闸都不管，直接交给回复器，说明是「想起一件自己的小事」', async () => {
        // 23:50，22:08 她主动发了一条、他没回；23:30 又有过一来一回
        const history = [msg(t(10, 25, 22, 8), 'assistant', 'Linux 作业终于写完了'), msg(t(10, 25, 23, 30), 'user', '嗯'), msg(t(10, 25, 23, 31), 'assistant', '睡不着')];
        const { planner, requests, logs } = setup(history);
        assert.equal(await planner.fireNow(), undefined);
        assert.equal(requests.length, 1, logs.join('\n'));
        assert.match(requests[0]!.note, /你想起一件自己的小事/);
        assert.equal(requests[0]!.dryRun, false);
        assert.ok(logs.some(l => l.includes('他让她现在找他')), logs.join('\n'));
        assert.ok(logs.some(l => l.includes('主动找他') && l.includes('刚想起一件事')), logs.join('\n'));
    });

    test('他最近说过想伤害自己的话：不发，说原因', async () => {
        const { planner, requests } = setup([msg(t(10, 25, 20, 0), 'user', '嗯')], { crisis: true });
        assert.equal(await planner.fireNow(), CRISIS_PAUSE_REASON);
        assert.equal(requests.length, 0);
    });

    test('他有没回的消息：不发（回复就好）', async () => {
        const { planner, requests } = setup([msg(t(10, 25, 23, 40), 'assistant', '睡不着'), msg(t(10, 25, 23, 49), 'user', '在吗')]);
        assert.equal(await planner.fireNow(), PENDING_REASON);
        assert.equal(requests.length, 0);
    });
});
