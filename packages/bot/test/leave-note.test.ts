import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announceFallback, announcePrompt, awayNow, leaveAnnouncer, LIVE_CHAT_MS, shouldAnnounce } from '../src/life/leave-note.ts';

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

test('leaveAnnouncer 的「现在」按注入的时钟算（App 的 worldNow；模拟器是虚拟时钟），不看真实时钟', async () => {
    // 虚拟时间离真实时间好几年：她那边正在洗澡、他两分钟前还在聊；找一个落在「该说」那边的时段
    const virtual = new Date('2020-03-04T21:00:00+08:00').getTime();
    const start = Array.from({ length: 40 }, (_, i) => virtual - (5 + i) * 60_000)
        .find(s => shouldAnnounce({ span: { text: '洗澡', start: s, end: s + 25 * 60_000 }, at: virtual, lastMessageAt: virtual - 2 * 60_000, announcedStarts: [], saidToday: 0 }))!;
    const shower = [{ start: new Date(start), end: new Date(start + 25 * 60_000) }];
    const sent: string[] = [];
    const appended: string[] = [];
    const pausedAt: number[] = [];
    await leaveAnnouncer({
        owner: { qq: 1001, name: '他' },
        worldAt: () => world(shower),
        paused: (_qq, now) => { pausedAt.push(now); return false; },
        history: () => [{ role: 'user', content: '在干嘛', time: new Date(virtual - 2 * 60_000).toISOString(), messageId: 1 }],
        append: (_qq, message) => { appended.push(message.time); },
        send: async (_qq, text) => { sent.push(text); },
        generate: async () => '我去洗个澡',
        log: () => {},
        stopped: () => false,
        now: () => virtual,
    }).check();
    assert.deepEqual(pausedAt, [virtual], '危机暂停也按她那边的现在问');
    assert.deepEqual(sent, ['我去洗个澡']);
    assert.deepEqual(appended, [new Date(virtual).toISOString()], '记进聊天记录的时间也是她那边的');
});
