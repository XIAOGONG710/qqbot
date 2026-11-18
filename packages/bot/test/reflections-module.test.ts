import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { reflectionsModule, type ReflectionsOptions } from '../src/modules/reflections.ts';

// 她自己想一想的那几样（ADR 0336 第 6 步）：定时任务的先后、间隔、开的时机，以及「没有男朋友档就都不想」「停下之后不再起新的一拍」「上一拍没想完就跳过」。
describe('她自己想一想的那几样（reflections 模块）', () => {
    const owner = { qq: 1, name: '阿明', tier: 'boyfriend' as const };
    const character = { name: '小林', description: '{{char}}和{{user}}', books: [], schedule: undefined } as never;
    const base = (dataDir: string, extra: Partial<ReflectionsOptions> = {}): ReflectionsOptions => ({
        owner, character: () => character, contacts: () => [owner], dataDir, soulDir: () => dataDir,
        now: () => new Date('2026-11-18T10:00:00+08:00'), log: () => {}, stopped: () => false,
        generate: () => async () => '', history: () => [],
        ...extra,
    });
    const all = (): Partial<ReflectionsOptions> => ({
        selfPursuits: { base: () => () => [] },
        speechNotes: { corpus: () => [], feedback: () => ({}) as never },
        chatReview: true,
        feelingReview: { existing: () => [] },
        diaryInsights: { exportInsights: () => {} },
        readingTakes: { watched: () => [] },
        openQuestions: { ponder: async () => '' },
        herGuesses: { worldAt: () => undefined },
    });

    test('都开着：八样按迁移前 App 里的先后，都在 App 搭好时开；心境回想每 10 分钟，其余每 30 分钟', () => {
        const module = reflectionsModule(base('unused', all()));
        assert.equal(module.id, 'reflections');
        assert.deepEqual(module.schedules?.map(schedule => [schedule.every / 60_000, schedule.start]), [
            [30, 'built'], [30, 'built'], [30, 'built'], [10, 'built'], [30, 'built'], [30, 'built'], [30, 'built'], [30, 'built'],
        ]);
        assert.equal(module.contribute, undefined, '不进一轮回复');
    });

    test('没有男朋友档就一样都不想；开关没开的那样没有定时任务', () => {
        assert.deepEqual(reflectionsModule(base('unused', { ...all(), owner: undefined })).schedules, []);
        assert.equal(reflectionsModule(base('unused', { chatReview: true, feelingReview: { existing: () => [] } })).schedules?.length, 2);
    });

    test('停下之后不起新的一拍；上一拍没想完就跳过；想完（不管成没成）都给桌面写一份自我认识', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'reflections-'));
        try {
            let stopped = false;
            let exported = 0;
            const module = reflectionsModule(base(dir, { stopped: () => stopped, diaryInsights: { exportInsights: () => { exported++; } } }));
            const [tick] = module.schedules!;
            tick!.run();
            tick!.run();
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(exported, 1, '第二拍时第一拍还没想完，跳过');
            stopped = true;
            tick!.run();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(exported, 1, '停下之后不再想');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
