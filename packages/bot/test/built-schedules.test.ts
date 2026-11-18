import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dreamsModule } from '../src/modules/dreams.ts';
import { dshStateModule } from '../src/modules/dsh-state.ts';
import { leaveNoteModule } from '../src/modules/leave-note.ts';
import { leaveAnnouncer } from '../src/life/leave-note.ts';

// 做梦那一拍、走开前说一声、DSH 状态导出（ADR 0336 第 6 步）：只有定时任务，都在 App 搭好时开；App 不给就不挂
describe('App 搭好时就开的那几个定时任务', () => {
    test('给了才有：做梦每 30 分钟、走开每 3 分钟、DSH 状态按给的间隔；都是 built', () => {
        const ran: string[] = [];
        const dreams = dreamsModule(() => ran.push('梦'));
        const leave = leaveNoteModule(async () => { ran.push('走开'); });
        const dsh = dshStateModule(() => ran.push('状态'), 5 * 60_000);
        assert.deepEqual([dreams, leave, dsh].map(module => module.schedules!.map(schedule => [schedule.every / 60_000, schedule.start])), [[[30, 'built']], [[3, 'built']], [[5, 'built']]]);
        for (const module of [dreams, leave, dsh]) module.schedules![0]!.run();
        assert.deepEqual(ran, ['梦', '走开', '状态']);
        assert.deepEqual([dreamsModule(undefined), leaveNoteModule(undefined), dshStateModule(undefined, 1)].map(module => module.schedules), [[], [], []]);
    });

    test('走开说一声：没有世界账、停下了、危机暂停时什么都不做', async () => {
        const seen: string[] = [];
        const base = {
            owner: { qq: 1, name: '阿明' }, paused: () => false, history: () => { seen.push('读聊天'); return []; },
            append: () => {}, send: async () => {}, generate: async () => '', log: () => {}, stopped: () => false,
        };
        await leaveAnnouncer(base).check();
        await leaveAnnouncer({ ...base, worldAt: () => undefined, stopped: () => true }).check();
        await leaveAnnouncer({ ...base, worldAt: () => undefined, paused: () => true }).check();
        assert.deepEqual(seen, []);
        await leaveAnnouncer({ ...base, worldAt: () => undefined }).check();
        assert.deepEqual(seen, ['读聊天'], '有世界账时才看（这一刻没有要走开的事，不发）');
    });
});
