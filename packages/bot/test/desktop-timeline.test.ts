import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { desktopNowSource, desktopPresence, desktopProactiveHooks, lastDesktopTurnAt, OUTBOX_AWAY_MS, OUTBOX_DESKTOP_REASON, outboxDesktopBlock, type DesktopNowSource } from '../src/life/desktop-now.ts';
import { DESKTOP_PRESENCE_FILE, PRESENCE_KIND, PRESENCE_VERSION } from '../src/life/desktop-presence.ts';
import {
    desktopSessionId, desktopSessionRecords, desktopSessionSummary, durationText, endedSessions, recordDesktopSessions, sessionActions, type DesktopAction,
} from '../src/life/desktop-timeline.ts';
import { desktopLogId, desktopLogOps, desktopLogPath, type DesktopLogTurn } from '../src/memory/desktop-log.ts';
import { Timeline } from '../src/memory/timeline.ts';

// ADR 0347 第 3 层 B 块（desktopDay，方案 §2.2）：一段桌面会话记进时间线（只放时长和动作类别）、留话在他电脑前时先留着

const MIN = 60_000;
const t = (h: number, m = 0, day = 12) => new Date(2026, 10, day, h, m).getTime();
/** 一轮：他开口 1 分钟后她回完 */
const turn = (at: number, user = '帮我把这个报销单的金额核一下', assistant = '好，我一条一条对'): DesktopLogTurn => ({ at, userAt: at - MIN, user, assistant });
/** 从 from 到 to 每 20 分钟一轮（最后一轮正好在 to），同一段 */
const sitting = (from: number, to: number, first?: string): DesktopLogTurn[] => {
    const turns: DesktopLogTurn[] = [];
    for (let at = from; at < to; at += 20 * MIN) turns.push(turns.length || first === undefined ? turn(at) : turn(at, first));
    turns.push(turn(to));
    return turns;
};
const action = (at: number, kind: string, extra: Partial<DesktopAction> = {}): DesktopAction => ({ at: new Date(at).toISOString(), channel: 'desktop', kind, ...extra });
const lease = (startedAt: number, renewedAt: number, extra: Record<string, unknown> = {}) => ({
    kind: PRESENCE_KIND, version: PRESENCE_VERSION, session: 's-1', startedAt: new Date(startedAt).toISOString(), renewedAt: new Date(renewedAt).toISOString(), ttlMs: 5 * MIN, ...extra,
});
const source = (turns: DesktopLogTurn[], leaseValue?: unknown): DesktopNowSource => ({ turns: () => turns, lease: () => leaseValue });

describe('会话概述：只有时长和动作类别', () => {
    test('时长的说法', () => {
        assert.equal(durationText(3 * MIN), '一会儿');
        assert.equal(durationText(14 * MIN), '一会儿');
        assert.equal(durationText(38 * MIN), '约 40 分钟');
        assert.equal(durationText(60 * MIN), '约 1 小时');
        assert.equal(durationText(95 * MIN), '约 1 个半小时');
        assert.equal(durationText(115 * MIN), '约 2 小时');
        assert.equal(durationText(-5), '一会儿');
    });

    test('动作类别：只认这一段里 desktop 渠道做成了的，换成固定说法、去重、最多 3 种，不认识的放最后说「弄了点别的」', () => {
        const session = { start: t(14, 10), end: t(16, 5) };
        const entries: DesktopAction[] = [
            action(t(14, 30), 'search'), action(t(14, 40), 'web'), action(t(15), 'write'),
            action(t(15, 10), 'deploy_secret_thing'), action(t(15, 20), 'read', { ok: false }),
            { ...action(t(15, 30), 'comment'), channel: 'bilibili' },
            action(t(13), 'action'), action(t(16, 30), 'action'),
            action(t(15, 40), 'session', { id: desktopSessionId(t(14, 10)) }),
        ];
        assert.deepEqual(sessionActions(session, entries), ['查了资料', '写了东西', '弄了点别的']);
        assert.equal(desktopSessionSummary(session, entries), '在电脑上陪他待了约 2 小时（中间查了资料、写了东西、弄了点别的）');
        assert.equal(desktopSessionSummary(session), '在电脑上陪他待了约 2 小时');
        // 结束后 5 分钟内记的算这一段（插件记时间线和一轮结束不是同一刻）
        assert.deepEqual(sessionActions(session, [action(t(16, 9), 'memory_save')]), ['记下了一件事']);
    });

    test('概述里没有桌面原文（他的原话任意 8 个字都不出现），也不抄别的条目的 summary 和 kind', () => {
        const said = '帮我把这个报销单的金额核一下，路径是 D:\\私人\\发票';
        const turns = [turn(t(14, 10), said, '我看到了，第三张发票金额不对'), turn(t(14, 40), said, '改好了')];
        const entries = [{ ...action(t(14, 20), 'zz_custom'), summary: '把发票整理进了 D 盘的私人文件夹' }];
        const records = desktopSessionRecords({ turns, now: t(17, 30), entries });
        assert.equal(records.length, 1);
        const text = JSON.stringify(records.map(({ id, summary, kind, channel }) => ({ id, summary, kind, channel })));
        for (const source of [said, '我看到了，第三张发票金额不对', entries[0]!.summary]) {
            const chars = [...source];
            for (let i = 0; i + 8 <= chars.length; i++) assert.ok(!text.includes(chars.slice(i, i + 8).join('')), chars.slice(i, i + 8).join(''));
        }
        assert.ok(!text.includes('zz_custom'));
    });
});

describe('哪几段算结束了', () => {
    test('最后一轮以后 45 分钟没有新回合才算；24 小时以前结束的不补；未来的回合不信', () => {
        const turns = sitting(t(14, 10), t(16, 5));
        assert.equal(endedSessions({ turns, now: t(16, 30) }).length, 0);
        const ended = endedSessions({ turns, now: t(16, 50) });
        assert.equal(ended.length, 1);
        assert.equal(ended[0]!.start, t(14, 9));
        assert.equal(ended[0]!.end, t(16, 5));
        // 一天以后不再补
        assert.equal(endedSessions({ turns, now: t(16, 6, 13) + MIN }).length, 0);
        // 切成两段：中间隔了一个多小时
        assert.equal(endedSessions({ turns: [turn(t(10)), turn(t(14, 10))], now: t(14, 40) }).length, 1);
        assert.equal(endedSessions({ turns: [turn(t(10)), turn(t(14, 10))], now: t(15) }).length, 2);
        // 未来的回合不把会话拖住
        assert.equal(endedSessions({ turns: [...turns, turn(t(23))], now: t(17) }).length, 1);
    });

    test('租约还作数、而且是这一段结束之前开始的：这一场还没完，先不记；租约是之后另开的就照记', () => {
        const turns = sitting(t(14, 10), t(16, 5));
        assert.equal(endedSessions({ turns, now: t(17), lease: lease(t(14), t(16, 58)) }).length, 0);
        assert.equal(endedSessions({ turns, now: t(17), lease: lease(t(16, 55), t(16, 58)) }).length, 1);
        // 过期 / 结束的租约不管
        assert.equal(endedSessions({ turns, now: t(17), lease: lease(t(14), t(16, 30)) }).length, 1);
        assert.equal(endedSessions({ turns, now: t(17), lease: lease(t(14), t(16, 58), { ended: new Date(t(16, 59)).toISOString() }) }).length, 1);
    });
});

describe('记进时间线', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
    const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-desk-tl-')); dirs.push(dir); return dir; };

    test('id 是 desktop-session:<开始毫秒>，at 是开始；同一段只记一次（重启重算也一样）；日志只有起止时刻和分钟数', () => {
        const dir = tmp();
        let clock = new Date(t(17));
        const timeline = new Timeline(join(dir, 'timeline.jsonl'), () => clock);
        timeline.record({ id: 'dsh:dsh-timeline-1', at: new Date(t(14, 30)), channel: 'desktop', kind: 'search', summary: '查了一下天气' });
        const turns = sitting(t(14, 10), t(16, 5), '他的原话一二三四五六七八');
        const logs: string[] = [];
        assert.equal(recordDesktopSessions(timeline, { turns, now: t(17) }, m => logs.push(m)), 1);
        const entry = timeline.read().find(item => item.kind === 'session')!;
        assert.equal(entry.id, `desktop-session:${t(14, 9)}`);
        assert.equal(entry.at, new Date(t(14, 9)).toISOString());
        assert.equal(entry.channel, 'desktop');
        assert.equal(entry.summary, '在电脑上陪他待了约 2 小时（中间查了资料）');
        assert.deepEqual(logs, ['桌面：一段 14:09–16:05（约 116 分钟）记进时间线']);
        // 再算一次（重启）：不重复
        clock = new Date(t(18));
        assert.equal(recordDesktopSessions(new Timeline(join(dir, 'timeline.jsonl'), () => clock), { turns, now: t(18) }, m => logs.push(m)), 0);
        assert.equal(timeline.read().filter(item => item.kind === 'session').length, 1);
        assert.equal(logs.length, 1);
        // 连续性块（QQ 回复和念头）能看到这一条
        assert.match(timeline.promptLine(new Date(t(20)))!, /今天 14:09 在电脑上陪他待了约 2 小时（中间查了资料）/);
        assert.ok(!readFileSync(join(dir, 'timeline.jsonl'), 'utf8').includes('他的原话'));
    });

    test('时间线读不了：不抛，记一行', () => {
        const logs: string[] = [];
        const broken = { read: () => { throw new Error('时间线读取失败'); }, record: () => { throw new Error('不该写'); } };
        assert.equal(recordDesktopSessions(broken, { turns: [turn(t(14))], now: t(17) }, m => logs.push(m)), 0);
        assert.equal(logs.length, 1);
    });
});

describe('此刻他在不在电脑前 / 留话的闸', () => {
    test('租约优先、回合兜底；最后一轮的时刻不信未来的', () => {
        assert.equal(desktopPresence(source([turn(t(16))]), t(16, 5)).with, true);
        assert.equal(desktopPresence(source([turn(t(16))]), t(16, 11)).with, false);
        assert.equal(desktopPresence(source([turn(t(14))], lease(t(15), t(16, 8))), t(16, 10)).source, 'lease');
        assert.equal(lastDesktopTurnAt([turn(t(15)), turn(t(16)), turn(t(18))], t(17)), t(16));
        assert.equal(lastDesktopTurnAt([], t(17)), undefined);
        const hooks = desktopProactiveHooks(source([turn(t(16))]));
        assert.equal(hooks.desktopWith(t(16, 5)), true);
        assert.equal(hooks.lastDesktopAt(t(16, 5)), t(16));
        assert.equal(hooks.desktopTurns(t(16, 5)).length, 1);
    });

    test('留话：他在电脑前、离开不到 10 分钟都先留着（他就在电脑前），走了 10 分钟以上照常', () => {
        // 回合兜底：最后一轮 16:00，「在」到 16:10，之后就不挡
        assert.equal(outboxDesktopBlock(source([turn(t(16))]), t(16, 5)), OUTBOX_DESKTOP_REASON);
        assert.equal(outboxDesktopBlock(source([turn(t(16))]), t(16, 10)), OUTBOX_DESKTOP_REASON);
        assert.equal(outboxDesktopBlock(source([turn(t(16))]), t(16, 11)), undefined);
        // 租约：结束在 16:30，16:39 还挡，16:41 不挡
        const ended = lease(t(15), t(16, 28), { ended: new Date(t(16, 30)).toISOString() });
        assert.equal(outboxDesktopBlock(source([], lease(t(15), t(16, 28))), t(16, 30)), OUTBOX_DESKTOP_REASON);
        assert.equal(outboxDesktopBlock(source([], ended), t(16, 39)), OUTBOX_DESKTOP_REASON);
        assert.equal(outboxDesktopBlock(source([], ended), t(16, 30) + OUTBOX_AWAY_MS + MIN), undefined);
        // 什么都没有：不挡
        assert.equal(outboxDesktopBlock(source([]), t(16)), undefined);
    });
});

describe('从文件读', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

    test('读账本和租约；没有文件当没有；租约坏了只记一次、不记内容，恢复了再记一次', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-desk-now-'));
        dirs.push(root);
        const dataDir = join(root, 'data');
        const soulDir = join(root, 'soul');
        mkdirSync(soulDir, { recursive: true });
        const logs: string[] = [];
        const src = desktopNowSource({ dataDir, soulDir, log: m => logs.push(m) });
        assert.deepEqual(src.turns(t(16)), []);
        assert.equal(src.lease(), undefined);
        // 写一行账本（desktop-log 的格式）
        mkdirSync(join(dataDir, 'memory'), { recursive: true });
        const at = t(15, 50);
        const row = { v: 1, id: desktopLogId(at, '在吗', '在'), at: new Date(at).toISOString(), user: '在吗', assistant: '在' };
        writeFileSync(desktopLogPath(dataDir), `${JSON.stringify(row)}\n`);
        assert.deepEqual(src.turns(t(16)).map(item => item.at), [at]);
        assert.equal(outboxDesktopBlock(src, t(16)), OUTBOX_DESKTOP_REASON);
        // 租约
        writeFileSync(join(soulDir, DESKTOP_PRESENCE_FILE), JSON.stringify(lease(t(15), t(15, 58))));
        assert.equal(desktopPresence(src, t(16)).source, 'lease');
        writeFileSync(join(soulDir, DESKTOP_PRESENCE_FILE), '{坏了，他的秘密');
        assert.equal(src.lease(), undefined);
        assert.equal(src.lease(), undefined);
        assert.equal(logs.length, 1, logs.join('\n'));
        assert.ok(!logs[0]!.includes('秘密'));
        writeFileSync(join(soulDir, DESKTOP_PRESENCE_FILE), JSON.stringify(lease(t(15), t(15, 58))));
        assert.ok(src.lease());
        assert.equal(logs.length, 2, logs.join('\n'));
    });
});

test('账本缓存：同一分钟里文件没变不重读，换了分钟或文件变了再读', () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-desk-cache-'));
    try {
        const dataDir = join(root, 'data');
        mkdirSync(join(dataDir, 'memory'), { recursive: true });
        const at = t(15, 50);
        const row = (when: number) => JSON.stringify({ v: 1, id: desktopLogId(when, '在吗', '在'), at: new Date(when).toISOString(), user: '在吗', assistant: '在' });
        writeFileSync(desktopLogPath(dataDir), `${row(at)}\n`);
        let reads = 0;
        const ops = { ...desktopLogOps, readText: (path: string, maxBytes?: number) => { reads++; return desktopLogOps.readText(path, maxBytes); } };
        const src = desktopNowSource({ dataDir, soulDir: join(root, 'soul'), ops });
        src.turns(t(16)); src.turns(t(16) + 30_000);
        assert.equal(reads, 1);
        src.turns(t(16, 1));
        assert.equal(reads, 2);
        writeFileSync(desktopLogPath(dataDir), `${row(at)}\n${row(at + MIN)}\n`);
        assert.equal(src.turns(t(16, 1) + 10_000).length, 2);
        assert.equal(reads, 3);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
