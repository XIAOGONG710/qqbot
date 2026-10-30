import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announceFallback, announcePrompt, awayNow, LIVE_CHAT_MS, shouldAnnounce } from '../src/life/leave-note.ts';

const at = new Date('2026-10-30T21:00:00+08:00');
const span = { text: '洗澡', start: at.getTime() - 5 * 60_000, end: at.getTime() + 20 * 60_000 };
const world = (shower: { start: Date; end: Date }[]) => ({ routine: { shower: { start: shower[0]!.start, end: shower[0]!.end } }, parcels: [], dates: [] }) as never;

// 用户 10-30：聊着聊着就去洗澡了，都不说一声
test('洗澡时段里 = 看不了消息', () => {
    const shower = [{ start: new Date(span.start), end: new Date(span.end) }];
    assert.equal(awayNow(world(shower), at)?.text, '洗澡');
    const later = new Date(at.getTime() + 40 * 60_000);
    assert.equal(awayNow(world(shower), later), undefined);
});

test('聊天在进行、今天没说满、这一段没说过 → 说一声（但也不是每次都说）', () => {
    const base = { span, at: at.getTime(), announcedStarts: [], saidToday: 0 };
    // 她说「别要求得太死」：一部分走开是按时间定死的「安静走」（见 QUIET_LEAVE_SHARE）；
    // 所以这里找一些 start 落在「该说」那边的时段来验规则，不去断言某一次具体说不说
    let announced = 0;
    for (let offset = 0; offset < 40; offset++) {
        const shifted = { ...span, start: span.start + offset * 60_000, end: span.end + offset * 60_000 };
        if (shouldAnnounce({ ...base, span: shifted, lastMessageAt: at.getTime() - 2 * 60_000 })) announced++;
    }
    assert.ok(announced > 0 && announced < 40, `应该有说也有不说（实际 ${announced}/40）`);
    assert.equal(shouldAnnounce({ ...base, lastMessageAt: at.getTime() - LIVE_CHAT_MS - 1 }), false, '他早就不聊了，不用报备');
    assert.equal(shouldAnnounce({ ...base, lastMessageAt: at.getTime(), announcedStarts: [span.start] }), false, '这一次已经说过');
    assert.equal(shouldAnnounce({ ...base, lastMessageAt: at.getTime(), saidToday: 3 }), false, '一天最多三次');
    assert.equal(shouldAnnounce({ ...base, lastMessageAt: undefined }), false, '没聊过就不说');
});

test('提示词要短、不要问句；兜底也像句人话', () => {
    const prompt = announcePrompt(span, '宝宝');
    assert.ok(prompt.system.includes('不超过 15 个字'));
    assert.ok(prompt.system.includes('不要问句'));
    assert.equal(announceFallback(span), '我去洗澡了，一会儿回来');
});
