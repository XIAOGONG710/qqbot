import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { BiliAccount } from '../src/bilibili-account.ts';
import type { AuditEntry } from '../src/device-actions.ts';
import { clip, Timeline, timelineAccount, timelineFromDevice, whenText } from '../src/timeline.ts';

// ADR 0159：QQ 以外的地方她做过什么，QQ 聊天里也记得
describe('跨渠道时间线', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const make = () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-timeline-'));
        dirs.push(dir);
        const path = join(dir, 'x', 'timeline.jsonl');
        return { path, timeline: new Timeline(path, () => new Date(2026, 9, 26, 12, 0)) };
    };
    const at = (h: number, m = 0, day = 26) => new Date(2026, 9, day, h, m);

    test('clip 去掉换行、截到上限；whenText 说今天 / 昨天 / 前天', () => {
        assert.equal(clip('a\n  b', 10), 'a b');
        assert.equal([...clip('一二三四五六七八九十', 5)].length, 5);
        assert.equal(whenText(at(22, 8), at(23, 0)), '今天 22:08');
        assert.equal(whenText(at(20, 10, 25), at(1, 0)), '昨天 20:10');
        assert.equal(whenText(at(9, 5, 24), at(1, 0)), '前天 09:05');
    });

    test('记一行读一行；摘要不含原文（超长的被截）；只取窗口内最近几条；没有就没有这段话', () => {
        const { timeline } = make();
        assert.equal(timeline.promptLine(at(12)), undefined);
        timeline.record({ at: at(1, 0, 24), channel: 'bilibili', kind: 'comment', summary: '三天前的' });
        timeline.record({ at: at(8, 30), channel: 'bilibili', kind: 'watch', summary: '在 B 站看了一条视频（BV1xx）' });
        timeline.record({ at: at(10, 0), channel: 'device', kind: 'notify', summary: '在他的电脑上弹了一条通知' });
        timeline.record({ at: at(11, 0), channel: 'web', kind: 'search', summary: '查了一个问题：' + '很长'.repeat(60) });
        const recent = timeline.recent(at(12));
        assert.deepEqual(recent.map(e => e.channel), ['bilibili', 'device', 'web']);
        assert.ok(recent[2]!.summary.length <= 80);
        const line = timeline.promptLine(at(12))!;
        assert.match(line, /今天 08:30 在 B 站看了一条视频/);
        assert.match(line, /别编/);
        assert.match(line, /他追问你就说记不太清/);
        assert.doesNotMatch(line, /三天前/);
    });

    test('没做成的标出来；坏行和不认识的渠道跳过；文件太长时只留最近的', () => {
        const { timeline, path } = make();
        timeline.record({ at: at(9), channel: 'bilibili', kind: 'comment', summary: '想在 B 站评论，没成', ok: false });
        appendFileSync(path, '{坏了\n{"at":"2026-10-26T01:00:00Z","channel":"未知","kind":"x","summary":"x"}\n');
        assert.equal(timeline.read().length, 1);
        assert.match(timeline.promptLine(at(12))!, /没做成/);
        const long = Array.from({ length: 2100 }, (_, i) => JSON.stringify({ at: at(9).toISOString(), channel: 'web', kind: 'search', summary: `第 ${i} 条` })).join('\n') + '\n';
        writeFileSync(path, long);
        timeline.record({ at: at(10), channel: 'web', kind: 'search', summary: '最新' });
        const lines = readFileSync(path, 'utf8').trim().split('\n');
        assert.equal(lines.length, 1500);
        assert.match(lines.at(-1)!, /最新/);
    });

    test('设备：只有真的执行了 / 没做成的才记，待批准、被拒、限流不算做过', () => {
        const { timeline } = make();
        const feed = timelineFromDevice(timeline);
        const entry = (decision: AuditEntry['decision'], action = 'notify'): AuditEntry => ({ at: Date.now(), source: 'model', action, target: 'computer', decision });
        for (const d of ['pending', 'declined', 'limited', 'rejected', 'duplicate', 'dryRun'] as const) feed(entry(d));
        assert.equal(timeline.read().length, 0);
        feed(entry('executed'));
        feed(entry('failed', 'volume'));
        const [a, b] = timeline.read();
        assert.match(a!.summary, /他的电脑上弹了一条通知/);
        assert.equal(b!.ok, false);
    });

    test('B 站账号：评论 / 回复 / 私信 / 看视频成功或失败都记；失败时错误照样抛；别的方法原样转发', async () => {
        const { timeline } = make();
        let fail = false;
        const raw = {
            name: '梦瑶不熬夜', mid: 1,
            postComment: async () => { if (fail) throw new Error('风控'); return { rpid: '9' }; },
            postReply: async () => ({ rpid: '8' }),
            sendDm: async () => undefined,
            subtitle: async () => ({ status: 'none' as const }),
            search: async () => [],
        } as unknown as BiliAccount;
        const account = timelineAccount(raw, timeline);
        assert.equal(account.name, '梦瑶不熬夜');
        assert.deepEqual(await account.postComment({ aid: 1, bvid: 'BV1abc', text: '这是评论的原文不能进时间线' }), { rpid: '9' });
        await account.postReply({ aid: 1, root: '1', parent: '2', to: { name: '某位UP主', uid: 5 }, text: '回复原文' });
        await account.sendDm({ uid: 5, text: '私信原文' });
        await account.subtitle({ bvid: 'BV1xyz' });
        fail = true;
        await assert.rejects(() => account.postComment({ aid: 1, bvid: 'BV1abc', text: 'x' }), /风控/);
        assert.deepEqual(await account.search('x'), []);
        const entries = timeline.read();
        assert.deepEqual(entries.map(e => e.kind), ['comment', 'reply', 'dm', 'watch', 'comment']);
        assert.equal(entries[4]!.ok, false);
        assert.ok(!JSON.stringify(entries).includes('原文'), '评论 / 私信原文不进时间线');
    });
});
