import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fillTimes, hasHistory, importGroupHistory, parseGroupHistory } from '../src/social/group-import.ts';
import { groupLog } from '../src/social/group-chat.ts';
import { groupPeople } from '../src/social/group-people.ts';

// 2026-11-14：她进群之前的那段聊天要导进去，不然一开口就不像在这个群里待过
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-import-')); dirs.push(dir); return dir; };

describe('导入群聊记录', () => {
    test('三种一行一条的格式都认', () => {
        const lines = parseGroupHistory([
            '[2026-11-01 20:13] 老王: 周六打球来不来',
            '2026-11-02 21:00 陈陈：我去',
            '阿明：你俩够了',
            '{"time":"2026-11-03T10:00:00+08:00","from":30001,"name":"老王","content":"在吗"}',
        ].join('\n'));
        assert.equal(lines.length, 4);
        assert.equal(lines[0]!.name, '老王');
        assert.equal(lines[0]!.content, '周六打球来不来');
        assert.equal(lines[0]!.time, new Date('2026-11-01T20:13:00+08:00').toISOString(), '按北京时间解析');
        assert.equal(lines[2]!.name, '阿明');
        assert.equal(lines[3]!.from, 30001);
    });

    test('QQ 导出的两行一条：头一行时间+昵称(QQ)，下一行内容', () => {
        const lines = parseGroupHistory([
            '2026-11-01 20:13:02 老王(123456)',
            '周六打球来不来',
            '2026-11-01 20:14:00 陈陈(654321)',
            '我去',
            '',
        ].join('\n'));
        assert.equal(lines.length, 2);
        assert.equal(lines[0]!.from, 123456);
        assert.equal(lines[0]!.content, '周六打球来不来');
        assert.equal(lines[1]!.content, '我去');
    });

    test('没写时间的往前铺，最后一条离现在最近', () => {
        const now = Date.parse('2026-11-14T12:00:00+08:00');
        const filled = fillTimes(parseGroupHistory('老王：一\n陈陈：二\n阿明：三'), now);
        assert.equal(filled[2]!.time, new Date(now - 3 * 60_000).toISOString());
        assert.equal(filled[1]!.time, new Date(now - 6 * 60_000).toISOString());
        assert.equal(filled[0]!.time, new Date(now - 9 * 60_000).toISOString());
    });

    test('导进去：进群记录、认下人头、她说过的话标 mine；重启还在', () => {
        const dir = tmp();
        const lines = parseGroupHistory([
            '2026-11-01 20:13 老王：周六打球来不来',
            '2026-11-01 20:14 繁星：我来我来',
            '2026-11-01 20:15 陈陈：带我一个',
        ].join('\n'));
        const result = importGroupHistory({ groupId: 555, lines, dataDir: dir, selfQq: 2561299676, selfName: '繁星' });
        assert.equal(result.added, 3);
        assert.equal(result.people, 2, '她自己不算「认得的人」');
        const entries = groupLog(dir).load(555);
        assert.equal(entries.length, 3);
        assert.ok(entries.every(entry => entry.history === true));
        assert.equal(entries[1]!.mine, true);
        assert.equal(entries[1]!.from, 2561299676);
        assert.ok(hasHistory(dir, 555));
        // 成员底账：老王、陈陈认下了，她自己没有
        const people = groupPeople(dir).load(555);
        assert.deepEqual(people.map(person => person.names[0]).sort(), ['陈陈', '老王'].sort());
        // 再导同一条不会重复记两份？导入是按文件覆盖写，同一条记录再加一次也只多一条旧记录（不去重是故意的：宁可多一段上下文）
        assert.equal(groupPeople(dir).load(555).find(person => person.names[0] === '老王')!.msgs, 1);
    });

    test('没有导过就是没有以前的记录', () => {
        const dir = tmp();
        assert.equal(hasHistory(dir, 555), false);
        groupLog(dir).append(555, { time: '2026-11-14T10:00:00+08:00', from: 1, name: 'a', content: 'hi', messageId: 1 });
        assert.equal(hasHistory(dir, 555), false, '实时记的不算历史');
    });
});
