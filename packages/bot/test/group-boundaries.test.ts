import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupBoundary, groupBoundaryAllows } from '../src/social/group-boundaries.ts';
import type { GroupEntry } from '../src/social/group-chat.ts';

const at = Date.parse('2026-11-28T10:00:00Z');
const hour = 3_600_000;
const line = (from: number, messageId: number, content: string, past = 0, replyTo?: number): GroupEntry => ({
    from, messageId, content, time: new Date(at - past).toISOString(), name: '合成群友',
    ...(from === 9 ? { mine: true } : {}), ...(replyTo === undefined ? {} : { replyTo }),
});

test('同一邀请，熟人可以轻轻接梗，陌生人保持正常分寸', () => {
    const evidence = [line(1, 10, '聊摄影', 25 * hour), line(9, 11, '聊聊吧', 25 * hour, 10),
        line(1, 12, '又见面了', hour), line(9, 13, '好巧', hour, 12)];
    const known = groupBoundary(evidence, line(1, 14, '来逗我两句'), 'mentioned');
    const stranger = groupBoundary(evidence, line(2, 15, '来逗我两句'), 'mentioned');
    assert.equal(known, 'playful');
    assert.equal(stranger, 'unfamiliar');
    assert.equal(groupBoundaryAllows('叫声姐姐听听', known), true);
    assert.equal(groupBoundaryAllows('叫声姐姐听听', stranger), false);
    assert.equal(groupBoundary(evidence, line(1, 16, '[引用：来逗我两句]嗯。'), 'mentioned', '嗯。'), 'familiar');
});

test('没接住玩笑立即收住，围观者的反应不能替当事人表示欢迎', () => {
    const evidence = [line(1, 10, '聊摄影', 25 * hour), line(9, 11, '聊聊吧', 25 * hour, 10),
        line(1, 12, '来逗我两句', 60_000), line(9, 13, '叫声姐姐听听', 60_000, 12), line(2, 14, '笑死，继续')];
    const boundary = groupBoundary(evidence, line(1, 15, '嗯。', 0, 13), 'mentioned');
    assert.equal(boundary, 'stop');
    assert.equal(groupBoundaryAllows('别装了，再叫一声', boundary), false);
    assert.equal(groupBoundaryAllows('好，刚才那句揭过。你照片拍好了吗？', boundary), true);
    assert.equal(groupBoundaryAllows('我们刚才私聊吵架了', 'playful'), false);
});

test('熟人直接回撩才继续，没接就翻篇，不讨下次的回应', () => {
    const history = [line(1, 10, '聊摄影', 25 * hour), line(9, 11, '聊聊吧', 25 * hour, 10),
        line(1, 12, '都回来吃饭', 60_000), line(9, 17, '说定了', 60_000, 12)];
    const evidence: GroupEntry[] = [...history, { ...line(9, 13, '我那份可得单独留', 60_000, 12), playful: true }];
    assert.equal(groupBoundary(evidence, line(1, 14, '那我怎么哄你？', 0, 13), 'mentioned', undefined, true), 'reciprocal');
    assert.equal(groupBoundary(evidence, line(1, 15, '嗯。', 0, 13), 'mentioned', undefined, true), 'stop');
    assert.equal(groupBoundary(evidence, line(2, 16, '那我怎么哄你？', 0, 13), 'mentioned', undefined, true), 'unfamiliar');
    assert.equal(groupBoundary(history, line(1, 18, '都回来吃饭'), 'topic', undefined, true), 'light');
    assert.equal(groupBoundaryAllows('新来的先交个底，你想被逗哪方面？', 'unfamiliar'), false);
    assert.equal(groupBoundaryAllows('这句先记账，下次你得还我。', 'stop'), false);
    assert.equal(groupBoundaryAllows('好，聊照片。', 'stop'), true);
});
