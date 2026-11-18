import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupLog } from '../src/social/group-chat.ts';
import { groupScheduleRecall, privateGroupScheduleRecall } from '../src/social/group-memory.ts';

test('私聊必须明确点出唯一群名，且只加载该群的公开事项', () => {
    const groups = [{ id: 101, name: '摄影群' }, { id: 102, name: '读书群' }];
    const loaded: number[] = [];
    const now = Date.parse('2026-11-18T11:00:00+08:00');
    const entries = [
        { content: '群活动15:30开始', from: 2 },
        { content: '活动16:30开始，先别告诉别人', from: 3 },
        { content: '小林说活动17:30开始', from: 4 },
    ].map((row, index) => ({ ...row, name: '同名', messageId: index + 1, time: '2026-11-17T10:00:00+08:00' }));
    const load = (group: number) => { loaded.push(group); return group === 101 ? entries : []; };
    const result = privateGroupScheduleRecall(load, groups, '「摄影群」昨天说活动几点开始？', now);
    assert.match(result ?? '', /15:30/);
    assert.doesNotMatch(result ?? '', /16:30|17:30|同名/);
    assert.equal(privateGroupScheduleRecall(load, groups, '昨天群里说了什么？', now), undefined);
    assert.equal(privateGroupScheduleRecall(load, groups, '摄影群和读书群昨天说了什么？', now), undefined);
    assert.equal(privateGroupScheduleRecall(load, groups, '摄影群挺有意思的', now), undefined);
    assert.equal(privateGroupScheduleRecall(load, [...groups, { id: 103, name: '摄影群' }], '摄影群昨天说了什么？', now), undefined);
    assert.deepEqual(loaded, [101]);
});

test('同群旧事项按发送者和群号独立查找，同名和同一活动均不会串', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-group-memory-'));
    try {
        const log = groupLog(dir);
        const yesterday = '2026-11-17T10:00:00+08:00';
        const today = '2026-11-18T10:00:00+08:00';
        const add = (group: number, from: number, time: string, content: string, messageId: number) =>
            log.append(group, { from, time, content, name: '同一个昵称', messageId });
        add(101, 1, yesterday, '群活动15:30开始', 11);
        add(101, 2, yesterday, '群活动19:15开始', 12);
        add(102, 1, yesterday, '群活动20:45开始', 11);
        add(102, 3, yesterday, '群活动21:00开始', 12);
        add(101, 1, yesterday, '小陈说活动16:30开始', 13);
        add(101, 1, yesterday, '群活动17:30开始，先别告诉别人', 14);
        add(101, 1, today, '群活动18:30开始', 15);

        const ask = (group: number, person: number, text = '@你 我昨天说活动几点开始？') =>
            groupScheduleRecall(log.load, group, person, text, Date.parse('2026-11-18T11:00:00+08:00'));
        const first = ask(101, 1) ?? '';
        assert.match(first, /15:30/);
        assert.doesNotMatch(first, /19:15|20:45|16:30|17:30|18:30/);
        assert.match(ask(101, 2) ?? '', /19:15/);
        assert.match(ask(102, 1) ?? '', /20:45/);
        assert.match(ask(102, 3) ?? '', /21:00/);
        assert.equal(ask(102, 2), undefined);
        assert.equal(ask(101, 1, '小陈昨天说活动几点开始？'), undefined);
        assert.equal(ask(101, 1, '我上周说活动几点开始？'), undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
