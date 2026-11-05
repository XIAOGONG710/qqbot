import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import type { ProactiveRecord, ProactiveSettings, RescheduleItem } from '../src/proactive/proactive.ts';
import { PromiseStateUnavailable } from '../src/life/promise-state.ts';
import { createProactivePlanner, type Planner } from '../src/proactive/proactive-planner.ts';
import type { InitiateOutcome, InitiateRequest } from '../src/social/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { SENSITIVE_ON, useSensitiveSwitch } from '../src/platform/sensitive.ts';
import { syntheticCardPath } from './fixtures/card.ts';

// 这个文件里的测试靠日志里的原文来断言模块的行为；日志默认不写原文的那条由 log-bodies.test.ts 管
useSensitiveSwitch(SENSITIVE_ON);

const boyfriend = loadCharacterCard(syntheticCardPath('boyfriend'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const msg = (time: number, role: 'user' | 'assistant', content: string): StoredMessage => ({ time: new Date(time).toISOString(), role, content });
const settled = () => new Promise(r => setTimeout(r, 30));

// 10-11 下午虚拟机解析不了外网，16:35 买到相机那条生成失败，「不再试」，那天就没说成
describe('主动消息：没连上模型过一会儿再试（10-11 相机那条）', () => {
    const dirs: string[] = [];
    const planners: Planner[] = [];
    afterEach(() => {
        for (const p of planners.splice(0)) p.stop();
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    const camera = { id: 'camera', kind: 'camera' as const, day: '2026-10-11', at: t(10, 11, 16, 30), what: '在城南的二手相机店买到了一台胶片机' };
    const unreachable: InitiateOutcome = { result: 'failed', reason: '生成失败：模型接口请求失败（ENOTFOUND：getaddrinfo ENOTFOUND api.deepseek.com）', unreachable: true };

    /** outcomes：每次到点依次返回；用完了就照常试运行。occasions 默认只开她那边的事 */
    function setup(outcomes: InitiateOutcome[], occasions: ProactiveSettings['occasions'] = ['news'], reschedule?: () => RescheduleItem[]) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-retry-'));
        dirs.push(dir);
        const clock = new VirtualClock(new Date(t(10, 11, 16)));
        const logs: string[] = [];
        const tried: number[] = [];
        const notes: string[] = [];
        const history = [msg(t(10, 11, 11), 'user', '我写代码去了'), msg(t(10, 11, 11, 1), 'assistant', '去吧')];
        const planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings: { occasions, dailyMax: 3, unansweredMax: 2 }, dates: [], mode: 'dryRun',
            history: { load: () => history },
            responder: {
                initiate: async (request: InitiateRequest) => {
                    tried.push(clock.now());
                    notes.push(request.note);
                    const next = outcomes.shift();
                    if (next) return next;
                    request.commit(['我买到相机啦']);
                    return { result: 'dryRun', parts: ['我买到相机啦'] };
                },
            },
            dir, log: m => logs.push(m), now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '测试角色' },
            news: () => [camera],
            ...(reschedule ? { reschedule } : {}),
        });
        planners.push(planner);
        const records = () => (JSON.parse(readFileSync(join(dir, '10001-boyfriend.json'), 'utf8')) as { records: ProactiveRecord[] }).records;
        return { clock, logs, tried, notes, records, planner };
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

    test('第一次没连上：15 分钟后再试，连上了照常说', async () => {
        const { clock, logs, tried, records } = setup([unreachable]);
        await runUntil(clock, t(10, 11, 18));
        assert.equal(tried.length, 2, logs.join('\n'));
        // 虚拟时钟偶尔多走 1 毫秒
        assert.ok(Math.abs(tried[1]! - tried[0]! - 15 * 60_000) < 1000, `${tried[1]! - tried[0]!}`);
        assert.ok(logs.some(l => /没连上模型（第 1 次），\d\d:\d\d 再试/.test(l)), logs.join('\n'));
        assert.ok(logs.some(l => l.includes('本来要说：我买到相机啦')), logs.join('\n'));
        assert.equal(records().find(r => r.occasion === 'news')?.result, 'dryRun');
    });

    test('一直连不上：一共试 3 次就不再试', async () => {
        const { clock, logs, tried, records } = setup([unreachable, unreachable, unreachable, unreachable]);
        await runUntil(clock, t(10, 11, 20));
        assert.equal(tried.length, 3, logs.join('\n'));
        assert.ok(logs.some(l => l.includes('出错，不再试（没连上模型 3 次）')), logs.join('\n'));
        const last = records().find(r => r.occasion === 'news')!;
        assert.equal(last.result, 'failed');
        assert.equal(last.retryAt, undefined);
    });

    test('别的错（模型回了但不对、发送失败）照旧不再试', async () => {
        const { clock, logs, tried } = setup([{ result: 'failed', reason: '生成失败：模型接口返回 400：bad request' }]);
        await runUntil(clock, t(10, 11, 18));
        assert.equal(tried.length, 1, logs.join('\n'));
        assert.ok(logs.some(l => /出错，不再试：生成失败/.test(l)), logs.join('\n'));
    });

    // DSH 10-15 复核的 0066 问题 0：约定来源读不到时 reschedule 会抛 PromiseStateUnavailable，原来一路冒到 loop().catch → halt()，这个联系人的主动消息全停
    test('约定来源暂时读不到：只是这段不排改约，别的主动消息照旧发，来源回来后恢复', async () => {
        let readable = false;
        const { clock, logs, tried, records } = setup([], ['news'], () => {
            if (!readable) throw new PromiseStateUnavailable('约定来源不可用，不能将未知约定当成空日历继续安排');
            return [];
        });
        await runUntil(clock, t(10, 11, 18));
        assert.equal(tried.length, 1, logs.join('\n'));
        assert.equal(records().find(r => r.occasion === 'news')?.result, 'dryRun');
        assert.ok(logs.some(l => l.includes('约定来源暂时读不到')), logs.join('\n'));
        assert.ok(!logs.some(l => l.includes('主动消息状态处理失败')), logs.join('\n'));
        assert.equal(logs.filter(l => l.includes('约定来源暂时读不到')).length, 1, '同一段不可用只记一次');
        readable = true;
        await runUntil(clock, t(10, 12, 12));
        assert.ok(logs.some(l => l.includes('约定来源又读得到了')), logs.join('\n'));
        assert.ok(!logs.some(l => l.includes('主动消息状态处理失败')), logs.join('\n'));
    });

    // DSH 10-15 复核 0064 问题 2、3：发了一半就出错的，日志里要说清楚；状态页「今天第 N 条」和卡额度同口径
    test('发了一半就出错：额度按已发算，状态页的今天条数一致，日志写明后面的没发出去', async () => {
        const { clock, logs, tried, records, planner } = setup([{ result: 'failed', reason: '发送失败：timeout', messageIds: [3] }]);
        await runUntil(clock, t(10, 11, 18));
        const dump = logs.join('\n');
        assert.equal(tried.length, 1, dump);
        const last = records().find(r => r.occasion === 'news')!;
        assert.equal(last.result, 'failed');
        assert.deepEqual(last.messageIds, [3]);
        assert.equal(planner.status().today, 1, '状态页：今天第 1 条');
        assert.ok(logs.some(l => l.includes('只发出去了 1 条，后面的没发出去：按已发算')), dump);
    });

    test('一直连不上、那之后也没聊过：睡前那条顺带说买到了相机（ADR 0057 调整）', async () => {
        const { clock, logs, tried, notes, records } = setup([unreachable, unreachable, unreachable], ['news', 'bedtime']);
        await runUntil(clock, t(10, 12, 1));
        assert.equal(tried.length, 4, logs.join('\n'));
        assert.doesNotMatch(notes[0]!, /还没跟阿明说过/);
        assert.match(notes[3]!, /道个晚安；你今天在城南的二手相机店买到了一台胶片机，还没跟阿明说过/);
        assert.ok(logs.some(l => l.includes('睡前（准备睡了）顺带说没说成的事：在城南的二手相机店买到了')), logs.join('\n'));
        assert.equal(records().find(r => r.occasion === 'bedtime')?.result, 'dryRun');
    });
});
