// 「此刻的她」（SELF.json，ADR 0347 第 2 层，方案 docs/plans/2026-11-22-same-her-layer2-self.md 四、1）：
// 快照（platform/contact.ts 的 snapshot）、槽位白名单、validUntil、拼 / 校验 / 写（life/self-export.ts）、刷新（modules/self-export.ts）。
// 只用合成角色（ADR 0333）。和 QQ 提示词一字不差的那一条在 app.test.ts（要整个 App）。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { NOW_SLOTS, SELF_SLOTS, selfPieces, type Piece } from '../src/interpreter/slots.ts';
import { useFewerRules } from '../src/language/fewer-rules.ts';
import { RULE_SLOTS } from '../src/language/fewer-rules.ts';
import { createContactResponder, loadTierCard } from '../src/platform/contact.ts';
import type { Contact } from '../src/platform/config.ts';
import { buildTurnModules } from '../src/platform/turn-modules.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import type { FeelingsReport } from '../src/emotion/feeling-export.ts';
import { isSelfExport, renderSelf, SELF_VALID_MS, selfValidUntil, writeSelfExport } from '../src/life/self-export.ts';
import type { State } from '../src/life/schedule.ts';
import { SELF_FILE, SELF_KIND, SELF_VERSION, type SelfPending } from '../src/life/self-types.ts';
import { selfExportModule } from '../src/modules/self-export.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

const dirs: string[] = [];
afterEach(() => {
    useFewerRules(false);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-self-')); dirs.push(dir); return dir; };

describe('槽位白名单（SELF_SLOTS）', () => {
    test('每个 SELF 槽都在 NOW_SLOTS 里，没有重复', () => {
        for (const slot of SELF_SLOTS) assert.ok((NOW_SLOTS as readonly string[]).includes(slot), slot);
        assert.equal(new Set(SELF_SLOTS).size, SELF_SLOTS.length);
    });

    test('selfPieces：只留 SELF 槽、按 NOW_SLOTS 排（同槽按给出的先后）；少规矩开着时丢 RULE_SLOTS 里的', () => {
        const pieces: Piece[] = [
            { slot: 'inner', text: '念头' }, { slot: 'intent', text: '意图' }, { slot: 'state', text: '你现在' },
            { slot: 'length', text: '长短' }, { slot: 'groundNote', text: '底子' }, { slot: 'days', text: '日子一' }, { slot: 'days', text: '日子二' },
        ];
        assert.deepEqual(selfPieces(pieces).map(piece => piece.text), ['日子一', '日子二', '你现在', '底子', '念头']);
        useFewerRules(true);
        assert.ok(RULE_SLOTS.has('groundNote'));
        assert.deepEqual(selfPieces(pieces).map(piece => piece.text), ['日子一', '日子二', '你现在', '念头']);
    });
});

describe('validUntil', () => {
    const at = new Date('2026-11-04T15:00:00+08:00');
    const lesson = (start: string, end: string) => ({ kind: 'water' as const, name: '高数', start: new Date(start), end: new Date(end) });
    const base = { where: '学校', outsideSemester: false };
    test('上课中 = 下课时刻；空闲且后面有课 = 上课时刻；课间 = 下一节开始；都没有 = at + 10 分钟', () => {
        const inClass: State = { ...base, activity: { kind: 'class', lesson: lesson('2026-11-04T14:30:00+08:00', '2026-11-04T15:05:00+08:00') } };
        assert.equal(selfValidUntil(inClass, at).toISOString(), new Date('2026-11-04T15:05:00+08:00').toISOString());
        const free: State = { ...base, activity: { kind: 'free', text: '在宿舍' }, nextClass: lesson('2026-11-04T15:08:00+08:00', '2026-11-04T15:50:00+08:00') };
        assert.equal(selfValidUntil(free, at).toISOString(), new Date('2026-11-04T15:08:00+08:00').toISOString());
        const between: State = { ...base, activity: { kind: 'between', afterClass: true, next: lesson('2026-11-04T15:02:00+08:00', '2026-11-04T15:40:00+08:00') } };
        assert.equal(selfValidUntil(between, at).toISOString(), new Date('2026-11-04T15:02:00+08:00').toISOString());
        const idle: State = { ...base, activity: { kind: 'free', text: '在宿舍' } };
        assert.equal(selfValidUntil(idle, at).getTime(), at.getTime() + SELF_VALID_MS);
        // 下一次变化在 10 分钟以后：仍是 at + 10 分钟
        const later: State = { ...base, activity: { kind: 'free', text: '在宿舍' }, nextClass: lesson('2026-11-04T16:00:00+08:00', '2026-11-04T16:45:00+08:00') };
        assert.equal(selfValidUntil(later, at).getTime(), at.getTime() + SELF_VALID_MS);
        assert.equal(selfValidUntil(undefined, at).getTime(), at.getTime() + SELF_VALID_MS);
        const sleeping: State = { ...base, activity: { kind: 'sleep', until: new Date('2026-11-04T15:03:00+08:00') } };
        assert.equal(selfValidUntil(sleeping, at).toISOString(), new Date('2026-11-04T15:03:00+08:00').toISOString());
    });
});

describe('拼、校验、写（life/self-export.ts）', () => {
    const at = new Date('2026-11-04T15:00:00+08:00');
    const pending: SelfPending[] = [{ id: 'inner:th-1', kind: 'inner', goes: 'tell', text: '今天的云好低', since: '2026-11-04T14:00:00+08:00' }];
    const pieces: Piece[] = [{ slot: 'state', text: '[你现在：在宿舍]' }];

    test('拼出来的格式对；危机暂停时攒着的整块不出、标 paused；她刚和他聊着不算在睡', () => {
        const self = renderSelf({ at, pieces, pending });
        assert.ok(isSelfExport(self));
        assert.equal(self.kind, SELF_KIND);
        assert.equal(self.version, SELF_VERSION);
        assert.equal(self.day, '2026-11-04');
        assert.deepEqual(self.lines, [{ slot: 'state', text: '[你现在：在宿舍]' }]);
        assert.deepEqual(self.pending, pending);
        assert.equal(self.paused, undefined);
        const paused = renderSelf({ at, pieces, pending, paused: true });
        assert.deepEqual([paused.pending, paused.paused], [[], 'crisis']);
        assert.ok(isSelfExport(paused));
        const sleep: State = { where: '学校', outsideSemester: false, activity: { kind: 'sleep', until: new Date('2026-11-04T16:00:00+08:00') } };
        assert.equal(renderSelf({ at, pieces, state: sleep }).asleep, true);
        assert.equal(renderSelf({ at, pieces, state: sleep, lastChatAt: at.getTime() - 60_000 }).asleep, false);
        // 攒着的最多 4 件；坏的一件不放
        const many = Array.from({ length: 6 }, (_, i) => ({ ...pending[0]!, id: `inner:th-${i}` }));
        assert.equal(renderSelf({ at, pieces, pending: [...many, { id: '', kind: 'inner', text: 'x', since: 'x' } as SelfPending] }).pending.length, 4);
    });

    test('校验：kind / version / 时间 / 行 / 攒着的不对都不认', () => {
        const good = renderSelf({ at, pieces, pending });
        for (const bad of [
            { ...good, kind: 'qq-feelings' }, { ...good, version: 2 }, { ...good, validUntil: good.at }, { ...good, generatedAt: 'x' },
            { ...good, lines: [{ slot: 'state' }] }, { ...good, pending: [{ ...pending[0], kind: 'other' }] }, { ...good, paused: 'crisis' },
        ]) assert.equal(isSelfExport(bad), false, JSON.stringify(bad).slice(0, 80));
        assert.equal(isSelfExport(null), false);
    });

    test('写：原子写能读回；内容没变、不到 5 分钟不重写（mtime 不变），变了或超过 5 分钟才写；格式不对抛错不写', () => {
        const path = join(tmp(), SELF_FILE);
        assert.equal(writeSelfExport(path, renderSelf({ at, pieces, pending })), true);
        const first = readFileSync(path, 'utf8');
        assert.ok(isSelfExport(JSON.parse(first)));
        const mtime = statSync(path).mtimeMs;
        assert.equal(writeSelfExport(path, renderSelf({ at: new Date(at.getTime() + 60_000), pieces, pending })), false, '没变、一分钟内不重写');
        assert.equal(readFileSync(path, 'utf8'), first);
        assert.equal(statSync(path).mtimeMs, mtime);
        assert.equal(writeSelfExport(path, renderSelf({ at: new Date(at.getTime() + 60_000), pieces: [{ slot: 'state', text: '[你现在：在食堂]' }], pending })), true, '变了就写');
        assert.equal(writeSelfExport(path, renderSelf({ at: new Date(at.getTime() + 7 * 60_000), pieces: [{ slot: 'state', text: '[你现在：在食堂]' }], pending })), true, '超过 5 分钟重写时间戳');
        assert.throws(() => writeSelfExport(path, { ...renderSelf({ at, pieces }), kind: 'x' } as never));
        // 坏的旧文件：照写新的
        writeFileSync(path, '{坏了');
        assert.equal(writeSelfExport(path, renderSelf({ at, pieces })), true);
        assert.ok(isSelfExport(JSON.parse(readFileSync(path, 'utf8'))));
    });
});

describe('快照（platform/contact.ts 的 snapshot）', () => {
    const he: Contact = { qq: 10001, name: '宝宝', tier: 'boyfriend' };
    const at = new Date('2026-11-04T15:00:00+08:00');
    const store = new Map<number, StoredMessage[]>();
    const pipeline = (logs: string[], reports: FeelingsReport[]) => {
        const log = (line: string) => logs.push(line);
        const history = (qq: number) => store.get(qq) ?? [];
        const turnModules = buildTurnModules({
            log, now: () => at.getTime(), history, contacts: () => [he], worldState: () => undefined, appointmentsAt: () => undefined, promises: () => undefined,
            schedule: true, herDays: true, grievance: false, lagTail: false, lifeInPrompt: false, intent: {},
            innerLine: () => '[你最近心里在想的：合成的念头]',
        });
        return createContactResponder({
            contact: he, card: loadTierCard(syntheticCardPattern, 'boyfriend'),
            llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
            prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
            history: { load: qq => history(qq), append: (qq, message) => { store.set(qq, [...history(qq), message]); } },
            send: async () => 1, log, now: () => at.getTime(), contacts: [he],
            schedule: true, herDays: true, herFeelings: true,
            moments: () => [{ id: 'quiz', at: new Date(at.getTime() - 3_600_000).toISOString(), kind: 'sad', strength: 3, cause: '小测没考好' }],
            onFeelings: report => reports.push(report),
            selfNote: () => '[你在 QQ 上：合成的签名]',
            promises: {
                describe: () => '[你答应过他：周五一起吃饭]',
                openLoops: () => ({ waiting: [], unanswered: [], unsettled: [{ what: '说好的电影没看成' }] }) as never,
            },
            turnModules,
        });
    };

    test('段落都在 SELF_SLOTS 里、按 NOW_SLOTS 排；同一时刻两次逐字相同；心境是中性版；不交给 onFeelings、不记那几行日志', async () => {
        // 他刚在道歉、关心她：QQ 这一句会有余温行、心境「绷不住」的写法；SELF 里都不要
        store.set(he.qq, [
            { role: 'user', content: '对不起，昨天是我不好', time: new Date(at.getTime() - 120_000).toISOString() },
            { role: 'user', content: '你怎么了，还好吗', time: new Date(at.getTime() - 60_000).toISOString() },
        ]);
        const logs: string[] = [];
        const reports: FeelingsReport[] = [];
        const responder = pipeline(logs, reports);
        const first = await responder.snapshot(at);
        const second = await responder.snapshot(at);
        assert.deepEqual(second, first, '同一时刻两次快照逐字相同');
        const slots = first.pieces.map(piece => piece.slot);
        for (const slot of slots) assert.ok((SELF_SLOTS as readonly string[]).includes(slot), `不该有 ${slot}`);
        const index = slots.map(slot => (NOW_SLOTS as readonly string[]).indexOf(slot));
        assert.deepEqual(index, [...index].sort((a, b) => a - b), '先后照 NOW_SLOTS');
        // 该有的都有：你现在、心境、念头、答应的、没了结的
        for (const slot of ['state', 'feeling', 'inner', 'promised', 'unsettled']) assert.ok(slots.includes(slot as never), `缺 ${slot}`);
        // 不在白名单里的（她在 QQ 上的样子、心境的节奏、余温）不进来
        for (const slot of ['selfNote', 'pace', 'warm', 'time', 'intent', 'length']) assert.ok(!slots.includes(slot as never), `混进了 ${slot}`);
        const feeling = first.pieces.find(piece => piece.slot === 'feeling')!.text;
        assert.match(feeling, /小测没考好/);
        assert.doesNotMatch(feeling, /一直在忍|这么一问/, '中性版：桌面上没有人正好在关心她');
        assert.equal(reports.length, 0, 'App 的 onFeelings 不能被快照调（它改 lastFeelings）');
        assert.ok(first.facts.state && first.facts.schedule && first.facts.felt?.length);
        for (const quiet of [/此刻在做/, /提示词里放了她最近的念头/, /情绪余温/, /时间块里提醒了她答应的事/, /挂着的事/, /心境：/]) {
            assert.ok(!logs.some(line => quiet.test(line)), `不该记：${quiet}（${logs.join(' | ')}）`);
        }
    });

    test('少规矩开着：SELF 里也没有 groundNote（和 assemblePrompt 同一张表）', async () => {
        store.set(he.qq, []);
        const responder = pipeline([], []);
        assert.ok((await responder.snapshot(at)).pieces.some(piece => piece.slot === 'groundNote'));
        useFewerRules(true);
        assert.ok(!(await responder.snapshot(at)).pieces.some(piece => piece.slot === 'groundNote'));
    });
});

describe('刷新（modules/self-export.ts）', () => {
    const timers = () => {
        let now = 0;
        const pending: { at: number; fn: () => void; id: number }[] = [];
        let seq = 0;
        return {
            now: () => now,
            after: (fn: () => void, ms: number) => { const timer = { at: now + ms, fn, id: ++seq }; pending.push(timer); return timer; },
            cancel: (timer: unknown) => { const at = pending.indexOf(timer as never); if (at >= 0) pending.splice(at, 1); },
            advance: async (ms: number) => {
                now += ms;
                for (const timer of pending.filter(t => t.at <= now).sort((a, b) => a.at - b.at)) { pending.splice(pending.indexOf(timer), 1); timer.fn(); }
                for (let i = 0; i < 5; i++) await Promise.resolve();
            },
            count: () => pending.length,
        };
    };

    test('开关关着：没有定时任务，回完一条也不写', () => {
        const clock = timers();
        const module = selfExportModule({ every: 300_000, ...clock });
        assert.deepEqual(module.schedules, []);
        module.refreshSoon();
        assert.equal(clock.count(), 0);
    });

    test('开着：搭好就写一次；validUntil 到点再写；回完一条稍后写一次（一串只写一次）；停下之后不再写', async () => {
        const clock = timers();
        let runs = 0;
        const module = selfExportModule({ every: 300_000, ...clock, settleMs: 3_000, exportSelf: async () => { runs++; return clock.now() + 120_000; } });
        assert.equal(module.schedules?.length, 1);
        assert.equal(module.schedules![0]!.runOnStart, true);
        assert.equal(module.schedules![0]!.start, 'built');
        module.schedules![0]!.run();
        await clock.advance(0);
        assert.equal(runs, 1);
        await clock.advance(121_000);
        assert.equal(runs, 2, 'validUntil 到点再写');
        module.refreshSoon();
        module.refreshSoon();
        await clock.advance(3_000);
        assert.equal(runs, 3, '一串气泡只写一次');
        module.stop?.();
        await clock.advance(1_000_000);
        module.schedules![0]!.run();
        await clock.advance(0);
        assert.equal(runs, 3, '停下之后不再写');
    });
});

// 「这两天自己在做的」进 SELF（ADR 0347 第 2 层，ownDays）：soul 模块在快照里只给 selfThread，别的一样都不取（首轮铺底取一次就用掉）
describe('soul 模块在快照里', () => {
    test('只放 selfThread；拒绝过的 / 评价 / 生活 / 首轮铺底都不取；不是快照时照旧', async () => {
        const { soulModule } = await import('../src/modules/soul.ts');
        const called: string[] = [];
        const soul = soulModule({
            selfThread: () => '[你这两天自己在做的：昨天英语作业写完了]',
            refusals: () => { called.push('refusals'); return '拒绝过'; },
            rating: () => { called.push('rating'); return '评价'; },
            life: () => { called.push('life'); return '生活'; },
            wake: () => { called.push('wake'); return '铺底'; },
        });
        const turn = { contact: { qq: 1, name: '他', tier: 'boyfriend' }, facts: {} } as unknown as Parameters<NonNullable<typeof soul.contribute>>[0];
        const snap = await soul.contribute!({ ...turn, snapshot: true } as typeof turn);
        assert.deepEqual(snap.map(piece => piece.slot), ['selfThread']);
        assert.deepEqual(called, [], '快照不碰别的来源');
        const normal = await soul.contribute!(turn);
        assert.deepEqual(normal.map(piece => piece.slot), ['selfThread', 'refusal', 'rating', 'life', 'wake']);
    });
});
