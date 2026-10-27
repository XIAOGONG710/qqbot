import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { asleepSince, isBedtimeLine, nightOf, saidBedtimes } from '../src/bedtime.ts';
import type { BotConfig } from '../src/config.ts';
import { loadTierCard } from '../src/contact.ts';
import type { StoredMessage } from '../src/history.ts';
import { blockReason, type ProactiveInput } from '../src/proactive.ts';
import { whenSeen } from '../src/social/reply-timing.ts';
import { runScenario } from '../src/sim/runner.ts';
import { loadScenario, parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const cards = (tier: string) => loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), tier as 'boyfriend');
const boyfriendCard = cards('boyfriend');
const schedule = boyfriendCard.character.schedule!;
const at = (text: string) => new Date(`${text}+08:00`);
const her = (time: string, content: string): StoredMessage => ({ time: at(time).toISOString(), role: 'assistant', content });
const him = (time: string, content: string, messageId = 1): StoredMessage => ({ time: at(time).toISOString(), role: 'user', content, messageId });
const llm: BotConfig['llm'] = {
    baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {},
};
const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };

describe('她说「睡了」就是去睡了（ADR 0042）', () => {
    test('只认她说自己这就去睡：问句、说他、说过去、午睡、只说晚安都不算', () => {
        for (const line of ['睡了，晚安', '我先睡了', '那我先睡了', '困了\n睡了', '不聊了睡了', '睡觉去了', '我去睡觉了', '睡啦晚安', '睡了睡了，晚安', '嗯 我也睡了', '滚去睡了[困]', '晚安，睡了']) {
            assert.equal(isBedtimeLine(line), true, line);
        }
        for (const line of ['你睡了吗', '睡了没', '睡了？', '还没睡', '我不睡了', '你快去睡吧', '早点睡', '去睡吧', '晚安', '昨晚三点才睡', '早就睡了', '睡了一下午', '睡了一觉起来好多了', '他以为我睡了', '我睡不着']) {
            assert.equal(isBedtimeLine(line), false, line);
        }
    });

    test('那一晚：22:30 起说的算，睡到那一晚该起的时候；白天、21:00 说的不算', () => {
        const night = nightOf(schedule, at('2026-10-09T00:32:00'))!;
        assert.equal(night.bed.getTime(), at('2026-10-09T02:00:00').getTime());
        assert.equal(night.from.getTime(), at('2026-10-08T22:30:00').getTime());
        assert.equal(nightOf(schedule, at('2026-10-08T21:00:00')), undefined);
        assert.equal(nightOf(schedule, at('2026-10-09T15:00:00')), undefined);
        // 02:00 以后、起床之前还是这一晚
        assert.equal(nightOf(schedule, at('2026-10-09T05:00:00'))!.bed.getTime(), night.bed.getTime());
    });

    test('线上 10-09：00:32 跟男朋友说「睡了，晚安」，01:40 起她就在睡——对同学也一样；按回复的最后一条算；第二天白天不算', () => {
        const boyfriend = [him('2026-10-09T00:31:00', '还不睡？'), her('2026-10-09T00:32:00', '困了'), her('2026-10-09T00:32:02', '睡了，晚安'), him('2026-10-09T00:33:00', '晚安')];
        const classmate = [her('2026-10-08T15:00:00', '我先睡了'), him('2026-10-09T01:40:00', '睡觉呢', 2)];
        const said = saidBedtimes([boyfriend, classmate], schedule, at('2026-10-08T00:00:00').getTime());
        assert.deepEqual(said, [at('2026-10-09T00:32:02').getTime()], '下午说的「我先睡了」是午睡，不算');
        const asleep = asleepSince(schedule, said, at('2026-10-09T01:40:00'))!;
        assert.equal(asleep.since.getTime(), at('2026-10-09T00:32:02').getTime());
        assert.ok(asleep.until.getTime() >= at('2026-10-09T07:40:00').getTime());
        assert.equal(asleepSince(schedule, said, at('2026-10-09T00:20:00')), undefined, '说之前还醒着');
        assert.equal(asleepSince(schedule, said, at('2026-10-09T12:00:00')), undefined, '起了');
        assert.equal(asleepSince(schedule, said, at('2026-10-09T23:30:00')), undefined, '下一晚要重新说');

        // 什么时候看到：同学 01:40 的消息起床后才看到（原来按 02:00 睡，28 秒就回了）
        const seen = whenSeen(classmate, at('2026-10-09T01:40:00').getTime(), {
            schedule, wakeable: false, asleep: now => {
                const a = asleepSince(schedule, said, new Date(now));
                return a && { since: a.since.getTime(), until: a.until.getTime() };
            },
        })!;
        assert.equal(seen.reason, '说了睡了，在睡觉，起床后看到');
        assert.ok(seen.at >= asleep.until.getTime());
        // 不传 asleep 就照旧：02:00 前醒着
        assert.notEqual(whenSeen(classmate, at('2026-10-09T01:40:00').getTime(), { schedule, wakeable: false })!.reason, '说了睡了，在睡觉，起床后看到');
    });

    test('男朋友说完「睡了」以后连着发照样能吵醒，一晚从她说完那一刻算；她回过一次就不再吵醒', () => {
        const base = [her('2026-10-09T00:32:00', '睡了，晚安')];
        const asleep = (now: number) => {
            const a = asleepSince(schedule, saidBedtimes([base], schedule, 0), new Date(now));
            return a && { since: a.since.getTime(), until: a.until.getTime() };
        };
        const burst = [...base, him('2026-10-09T01:00:00', '宝宝', 1), him('2026-10-09T01:00:20', '宝宝', 2), him('2026-10-09T01:00:40', '醒醒', 3)];
        const woken = whenSeen(burst, at('2026-10-09T01:00:40').getTime(), { schedule, wakeable: true, asleep })!;
        assert.equal(woken.woken, true);
        const one = [...base, him('2026-10-09T01:00:00', '睡了吗', 1)];
        assert.equal(whenSeen(one, at('2026-10-09T01:00:00').getTime(), { schedule, wakeable: true, asleep })!.reason, '说了睡了，在睡觉，起床后看到');
        const replied = [...burst, her('2026-10-09T01:01:00', '嗯？'), him('2026-10-09T01:05:00', '没事', 4), him('2026-10-09T01:05:10', '睡吧', 5), him('2026-10-09T01:05:20', '晚安', 6)];
        assert.notEqual(whenSeen(replied, at('2026-10-09T01:05:20').getTime(), { schedule, wakeable: true, asleep })!.woken, true);
    });

    test('说过睡了就不主动找人（主动消息）', () => {
        const input: ProactiveInput = {
            qq: 10001, schedule, settings: boyfriendCard.character.proactive!, dates: boyfriendCard.character.dates, history: [], records: [], mode: 'on',
            asleep: now => now >= at('2026-10-08T23:10:00').getTime(),
        };
        const candidate = { id: '2026-10-08:bedtime', occasion: 'bedtime' as const, day: '2026-10-08', at: at('2026-10-08T23:30:00').getTime(), reason: '睡前' };
        assert.equal(blockReason(candidate, candidate.at, input), '她说过睡了');
        assert.notEqual(blockReason(candidate, candidate.at, { ...input, asleep: () => false }), '她说过睡了');
    });

    test('模拟：同学 01:40 找她，她 00:32 跟男朋友说过睡了——起床以后才回，提示词里她在睡觉', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-bedtime-'));
        try {
            const scenario = parseScenario({
                name: '说了睡了', tier: 'classmate', start: '2026-10-09T01:40:00+08:00', memory: false,
                others: [{ name: '男朋友', tier: 'boyfriend', history: [
                    { time: '2026-10-09T00:31:00+08:00', role: 'user', content: '还不睡？' },
                    { time: '2026-10-09T00:32:00+08:00', role: 'assistant', content: '困了' },
                    { time: '2026-10-09T00:32:02+08:00', role: 'assistant', content: '睡了，晚安' },
                ] }],
                steps: [{ say: '睡觉呢' }, { check: { noReply: true, log: '说了睡了，在睡觉，起床后看到' } }, { wait: 'reply' }, { check: { replyAfter: '5h' } }],
            });
            const generate = async () => '刚醒';
            const result = await runScenario(scenario, { runId: 'bed', dataDir: dir, card: cards('classmate'), llm, prompt, herDays: true, generate });
            assert.deepEqual(result.steps.flatMap(s => s.checks).filter(c => !c.ok), []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('场景文件（假模型）：男朋友一条吵不醒、隔 3 分钟被吵醒，状态行写被震醒；同学档起床后才回', async () => {
        for (const [name, tier] of [['bedtime-said-boyfriend', 'boyfriend'], ['bedtime-said-classmate', 'classmate']] as const) {
            const dir = mkdtempSync(join(tmpdir(), `qqbot-${name}-`));
            try {
                const scenario = loadScenario(join(repoRoot, `packages/bot/sim/${name}.json`));
                const result = await runScenario(scenario, { runId: name, dataDir: dir, card: cards(tier), llm, prompt, herDays: true, generate: async () => '嗯…' });
                assert.deepEqual(result.steps.flatMap(s => s.checks).filter(c => !c.ok), [], name);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });
});
