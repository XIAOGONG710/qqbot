import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CATCH_UP_WINDOW_MS, findMissed, shouldCatchUp, type HistoryMessage } from '../src/backfill.ts';
import type { StoredMessage } from '../src/history.ts';

const SELF = 1024;
const PEER = 2048;
const t = (s: number) => new Date(s * 1000).toISOString();
const text = (s: string) => [{ type: 'text', data: { text: s } }];
// NapCat 返回的形状：对方发的 post_type message、sender 是对方；小号发的 message_sent、sender 是小号
const fromPeer = (id: number, time: number, s: string): HistoryMessage => ({ message_id: id, time, user_id: PEER, sender: { user_id: PEER }, message: text(s) });
const fromSelf = (id: number, time: number, s: string): HistoryMessage => ({ message_id: id, time, user_id: SELF, sender: { user_id: SELF }, message: text(s) });

describe('补回漏掉的消息', () => {
    const stored: StoredMessage[] = [
        { time: t(100), role: 'user', content: '在吗', messageId: 1 },
        { time: new Date(101_500).toISOString(), role: 'assistant', content: '在', messageId: 2 },
    ];

    test('运维提醒（外网断了 / 恢复了，用她的号发给用户）不是她说的话：补回时跳过，别的小号发的照补', () => {
        const fetched = [
            fromSelf(6, 300, '【运维提醒】12 分钟解析不了 api.deepseek.com：她连不上模型'),
            fromSelf(7, 301, '【运维提醒】外网恢复了（断了大约 30 分钟），她又能回话了。'),
            fromSelf(8, 302, '我回来了'),
        ];
        assert.deepEqual(findMissed(stored, fetched, SELF).map(m => m.content), ['我回来了']);
    });

    test('按消息 id 去重，只补比本地最后一条新的，按时间排好；小号发的算她说的', () => {
        const fetched = [
            fromPeer(1, 100, '在吗'),
            fromSelf(2, 101, '在'),
            fromPeer(5, 300, '睡了吗'),
            fromSelf(4, 200, '我先去洗澡'),
            fromPeer(3, 101, '同一秒发的'),
        ];
        assert.deepEqual(findMissed(stored, fetched, SELF), [
            { time: t(101), role: 'user', content: '同一秒发的', messageId: 3 },
            { time: t(200), role: 'assistant', content: '我先去洗澡', messageId: 4 },
            { time: t(300), role: 'user', content: '睡了吗', messageId: 5 },
        ]);
    });

    test('比本地最后一条旧的不补（bot 运行时小号在手机上发的，不会推给 bot）', () => {
        assert.deepEqual(findMissed(stored, [fromSelf(9, 50, '很早以前')], SELF), []);
    });

    test('换过档：只补换档之后的，归档掉的旧记录不会从 QQ 里再拉回来', () => {
        const fetched = [fromPeer(1, 10, '宝宝在吗'), fromSelf(2, 11, '在呀宝宝'), fromPeer(3, 30, '换档后的第一句')];
        assert.deepEqual(findMissed([], fetched, SELF, new Date(20_000)).map(m => m.content), ['换档后的第一句']);
        assert.deepEqual(findMissed([], fetched, SELF).map(m => m.content), ['宝宝在吗', '在呀宝宝', '换档后的第一句'], '没换过档照旧全补');
    });

    test('本地还没有记录时全部补上；转不出文字的消息跳过；表情转成占位符', () => {
        const fetched = [fromPeer(1, 10, '你好'), { ...fromPeer(2, 11, ''), message: [{ type: 'face', data: {} }] }, fromPeer(3, 12, '  ')];
        assert.deepEqual(findMissed([], fetched, SELF).map(m => m.content), ['你好', '[表情]']);
    });

    test('只有最后一条她的话之后还有对方的消息、且最新那条在窗口内才回', () => {
        const now = new Date(10_000_000_000);
        const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
        const answered: StoredMessage[] = [{ time: at(60_000), role: 'user', content: 'a' }, { time: at(30_000), role: 'assistant', content: 'b' }];
        assert.equal(shouldCatchUp(answered, now), false);
        assert.equal(shouldCatchUp([], now), false);

        const pending = [...answered, { time: at(CATCH_UP_WINDOW_MS + 60_000), role: 'user' as const, content: '很久以前' }];
        assert.equal(shouldCatchUp(pending, now), false);
        assert.equal(shouldCatchUp([...pending, { time: at(60_000), role: 'user', content: '刚才' }], now), true);
        assert.equal(CATCH_UP_WINDOW_MS, 3 * 60 * 60 * 1000);
    });
});
