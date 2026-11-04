import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { consumeDshTimelineInbox, consumeDshWorldInbox } from '../src/memory/dsh-inbox.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { Timeline } from '../src/memory/timeline.ts';
import type { WorldState } from '../src/world/world.ts';

describe('DSH 收件箱', () => {
    const dirs: string[] = [];
    const originalRename = fileOps.renameSync;
    afterEach(() => {
        fileOps.renameSync = originalRename;
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    test('时间线只收脱敏合格行，并按 id 幂等', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-dsh-inbox-'));
        dirs.push(dir);
        const inbox = join(dir, 'timeline-inbox.jsonl');
        const state = join(dir, 'timeline-state.json');
        writeFileSync(inbox, [
            JSON.stringify({ id: 'dsh-timeline-1', at: '2026-11-02T23:55:00.000Z', kind: 'action', summary: '整理了桌面文件' }),
            JSON.stringify({ id: 'dsh-timeline-1', at: '2026-11-02T23:56:00.000Z', kind: 'action', summary: '重复的不应再进' }),
            JSON.stringify({ id: 'bad', at: '2026-11-02T23:57:00.000Z', kind: 'action', summary: 'id 太短' }),
            JSON.stringify({ id: 'dsh-timeline-unsafe', at: '2026-11-02T23:58:00.000Z', kind: 'action', summary: '打开 C:\\Users\\XG\\secret.txt' }),
            '{坏行',
        ].join('\n') + '\n');
        const timeline = new Timeline(join(dir, 'timeline.jsonl'));
        const now = new Date('2026-11-03T00:00:00.000Z');
        assert.equal(consumeDshTimelineInbox(inbox, state, now, timeline, () => undefined), 1);
        assert.equal(consumeDshTimelineInbox(inbox, state, now, timeline, () => undefined), 0);
        assert.deepEqual(timeline.read().map(entry => ({ channel: entry.channel, summary: entry.summary })), [{ channel: 'desktop', summary: '整理了桌面文件' }]);
    });

    test('世界事件只收白名单和时间窗内的行，交给世界账而不是直接改文件', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-dsh-world-inbox-'));
        dirs.push(dir);
        const inbox = join(dir, 'world-inbox.jsonl');
        const state = join(dir, 'world-state.json');
        writeFileSync(inbox, [
            JSON.stringify({ id: 'dsh-world-1', at: '2026-11-02T23:55:00.000Z', kind: 'study', result: 'succeeded', subject: '复习' }),
            JSON.stringify({ id: 'dsh-world-2', at: '2026-11-02T23:56:00.000Z', kind: 'run_shell', result: 'succeeded' }),
            JSON.stringify({ id: 'dsh-world-3', at: '2026-11-03T00:02:00.000Z', kind: 'rest', result: 'succeeded' }),
        ].join('\n') + '\n');
        const drafts: unknown[] = [];
        const world = { recordEvents: (items: unknown[]) => drafts.push(...items) } as unknown as WorldState;
        const now = new Date('2026-11-03T00:00:00.000Z');
        assert.equal(consumeDshWorldInbox(inbox, state, now, world, () => undefined), 1);
        assert.equal(consumeDshWorldInbox(inbox, state, now, world, () => undefined), 0);
        assert.deepEqual(drafts, [{ id: 'dsh:dsh-world-1', kind: 'study', at: '2026-11-02T23:55:00.000Z', source: 'external', result: 'succeeded', subject: '复习' }]);
    });

    test('相机基金用途只随 receive_money 进入世界账，不开放任意资金目标', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-dsh-camera-fund-'));
        dirs.push(dir);
        const inbox = join(dir, 'world-inbox.jsonl');
        const state = join(dir, 'world-state.json');
        writeFileSync(inbox, [
            JSON.stringify({ id: 'dsh-world-camera', at: '2026-11-02T23:55:00.000Z', kind: 'receive_money', result: 'succeeded', amount: 2_000, forCamera: true }),
            JSON.stringify({ id: 'dsh-world-bad-target', at: '2026-11-02T23:56:00.000Z', kind: 'study', result: 'succeeded', forCamera: true }),
            JSON.stringify({ id: 'dsh-world-no-amount', at: '2026-11-02T23:57:00.000Z', kind: 'receive_money', result: 'succeeded', forCamera: true }),
        ].join('\n') + '\n');
        const drafts: unknown[] = [];
        const world = { recordEvents: (items: unknown[]) => drafts.push(...items) } as unknown as WorldState;
        assert.equal(consumeDshWorldInbox(inbox, state, new Date('2026-11-03T00:00:00.000Z'), world, () => undefined), 1);
        assert.deepEqual(drafts, [{
            id: 'dsh:dsh-world-camera', kind: 'receive_money', at: '2026-11-02T23:55:00.000Z', source: 'external',
            result: 'succeeded', amount: 2_000, target: 'camera_fund',
        }]);
    });

    test('容差范围内的未来事件先停在原行，到时后再落账，不因世界账静默拒收而永久丢失', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-dsh-world-clock-skew-'));
        dirs.push(dir);
        const inbox = join(dir, 'world-inbox.jsonl');
        const state = join(dir, 'world-state.json');
        writeFileSync(inbox, [
            JSON.stringify({ id: 'dsh-world-skew', at: '2026-11-03T00:00:30.000Z', kind: 'rest', result: 'succeeded' }),
            JSON.stringify({ id: 'dsh-world-after-skew', at: '2026-11-03T00:00:20.000Z', kind: 'study', result: 'succeeded' }),
        ].join('\n') + '\n');
        const drafts: unknown[] = [];
        const world = { recordEvents: (items: unknown[]) => drafts.push(...items) } as unknown as WorldState;

        assert.equal(consumeDshWorldInbox(inbox, state, new Date('2026-11-03T00:00:00.000Z'), world, () => undefined), 0);
        assert.deepEqual(drafts, []);
        assert.equal(existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).line : 0, 0, '游标停在未来事件原行');

        assert.equal(consumeDshWorldInbox(inbox, state, new Date('2026-11-03T00:00:31.000Z'), world, () => undefined), 2);
        assert.deepEqual(drafts.map(item => (item as { id: string }).id), ['dsh:dsh-world-skew', 'dsh:dsh-world-after-skew']);
    });

    test('超过去重窗口后仍按收件箱游标只处理新追加的行', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-dsh-inbox-cursor-'));
        dirs.push(dir);
        const inbox = join(dir, 'world-inbox.jsonl');
        const state = join(dir, 'world-state.json');
        const at = '2026-11-02T23:55:00.000Z';
        writeFileSync(inbox, `${Array.from({ length: 2_005 }, (_, i) => JSON.stringify({ id: `dsh-world-${String(i).padStart(4, '0')}`, at, kind: 'rest', result: 'succeeded' })).join('\n')}\n`);
        const drafts: unknown[] = [];
        const world = { recordEvents: (items: unknown[]) => drafts.push(...items) } as unknown as WorldState;
        const now = new Date('2026-11-03T00:00:00.000Z');
        assert.equal(consumeDshWorldInbox(inbox, state, now, world, () => undefined), 2_005);
        writeFileSync(inbox, `${readFileSync(inbox, 'utf8')}\n${JSON.stringify({ id: 'dsh-world-new', at, kind: 'rest', result: 'succeeded' })}\n`);
        assert.equal(consumeDshWorldInbox(inbox, state, now, world, () => undefined), 1);
        assert.equal(drafts.length, 2_006);
        assert.equal((drafts.at(-1) as { id: string }).id, 'dsh:dsh-world-new');
    });

    test('合格事件落账失败时停在该行，下轮按顺序重试而不丢后续事件', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-dsh-inbox-retry-'));
        dirs.push(dir);
        const inbox = join(dir, 'world-inbox.jsonl');
        const state = join(dir, 'world-state.json');
        const at = '2026-11-02T23:55:00.000Z';
        writeFileSync(inbox, [
            '{坏行',
            JSON.stringify({ id: 'dsh-world-retry', at, kind: 'study', result: 'succeeded' }),
            JSON.stringify({ id: 'dsh-world-after', at, kind: 'rest', result: 'succeeded' }),
        ].join('\n') + '\n');
        const drafts: unknown[] = [];
        let fail = true;
        const world = { recordEvents: (items: unknown[]) => {
            if (fail) { fail = false; throw new Error('temporary write failure'); }
            drafts.push(...items);
        } } as unknown as WorldState;
        const now = new Date('2026-11-03T00:00:00.000Z');
        assert.equal(consumeDshWorldInbox(inbox, state, now, world, () => undefined), 0);
        assert.deepEqual(drafts, [], '失败行之后的事件不能越过它先提交');
        assert.equal(consumeDshWorldInbox(inbox, state, now, world, () => undefined), 2);
        assert.deepEqual(drafts.map(item => (item as { id: string }).id), ['dsh:dsh-world-retry', 'dsh:dsh-world-after']);
        assert.equal(consumeDshWorldInbox(inbox, state, now, world, () => undefined), 0);
    });

    test('时间线已追加但游标写盘失败时，重试不会留下重复事件', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-dsh-timeline-state-retry-'));
        dirs.push(dir);
        const inbox = join(dir, 'timeline-inbox.jsonl');
        const state = join(dir, 'timeline-state.json');
        writeFileSync(inbox, `${JSON.stringify({ id: 'dsh-timeline-retry', at: '2026-11-02T23:55:00.000Z', kind: 'action', summary: '整理了桌面文件' })}\n`);
        const timeline = new Timeline(join(dir, 'timeline.jsonl'));
        const now = new Date('2026-11-03T00:00:00.000Z');
        fileOps.renameSync = (() => { throw new Error('state disk full'); }) as typeof fileOps.renameSync;
        assert.throws(() => consumeDshTimelineInbox(inbox, state, now, timeline, () => undefined), /state disk full/);
        assert.equal(timeline.read().length, 1, '事件本身已经落进时间线');
        fileOps.renameSync = originalRename;
        assert.equal(consumeDshTimelineInbox(inbox, state, now, timeline, () => undefined), 1);
        assert.deepEqual(timeline.read().map(item => [item.id, item.summary]), [['dsh:dsh-timeline-retry', '整理了桌面文件']]);
        assert.equal(consumeDshTimelineInbox(inbox, state, now, timeline, () => undefined), 0);
    });
});
