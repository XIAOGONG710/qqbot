import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timelineAccount, type Timeline } from '../src/memory/timeline.ts';
import type { BiliAccount } from '../src/bilibili/bilibili-account.ts';
const wrap = timelineAccount as (account: BiliAccount, timeline: Timeline, options: { acceptRead: () => boolean }) => BiliAccount;
for (const failed of [false, true]) test(`已停读取的字幕${failed ? '失败' : '成功'}不晚写时间线，但真实结果仍返调用方`, async () => {
    let release!: (value: unknown) => void, reject!: (reason: Error) => void, allowed = true; const records: unknown[] = [];
    const held = new Promise((done, fail) => { release = done; reject = fail; });
    const account = wrap({ subtitle: () => held } as unknown as BiliAccount, { record: (entry: unknown) => records.push(entry) } as unknown as Timeline, { acceptRead: () => allowed });
    const result = account.subtitle({ bvid: 'BVsynthetic' } as never); const observed = result.then(value => ({ value }), error => ({ error }));
    allowed = false; const marker = new Error('SYNTHETIC_SUBTITLE_FAILURE'); if (failed) reject(marker); else release({ status: 'none' });
    const settled = await observed; assert.equal(records.length, 0);
    if (failed) { assert.ok('error' in settled); assert.equal(settled.error, marker); } else { assert.ok('value' in settled); assert.deepEqual(settled.value, { status: 'none' }); }
});
test('字幕读取关闭不丢已派评论写入成功ACK的时间线事实', async () => {
    let release!: (value: unknown) => void; const records: unknown[] = [], held = new Promise(done => { release = done; });
    const account = wrap({ postComment: () => held } as unknown as BiliAccount, { record: (entry: unknown) => records.push(entry) } as unknown as Timeline, { acceptRead: () => false });
    const result = account.postComment({ bvid: 'BVsynthetic', text: '合成评论' } as never); release({ rpid: 123 }); await result; assert.equal(records.length, 1);
});


test('字幕时间线包装保留单次读取signal和原account接收者', async () => {
    const controller = new AbortController(); let seen: AbortSignal | undefined, same = false;
    const raw = { subtitle(_video: unknown, signal?: AbortSignal) { same = this === raw; seen = signal; return Promise.resolve({ status: 'none' }); } };
    const wrapped = wrap(raw as unknown as BiliAccount, { record() {} } as unknown as Timeline, { acceptRead: () => true });
    await wrapped.subtitle({ bvid: 'BVsynthetic' } as never, controller.signal);
    assert.equal(seen, controller.signal); assert.equal(same, true);
});
