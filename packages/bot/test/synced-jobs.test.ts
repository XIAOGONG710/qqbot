import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { syncedJobsModule } from '../src/modules/synced-jobs.ts';

// 连上之后那几个定期活（ADR 0336 第 6 步）：给了哪样挂哪样；周报 1 小时，其余 30 分钟，只有 feed 开计时器前先跑一次。
const HALF = 30 * 60_000;

describe('连上后的定期活模块（modules/synced-jobs.ts）', () => {
    test('模块 id 是 synced-jobs', () => {
        assert.equal(syncedJobsModule({}).id, 'synced-jobs');
    });

    test('四个都给：按 weeklyReport → watching → feed → memes 的先后挂，间隔与 run 各自对上', () => {
        const jobs = {
            weeklyReport: () => {},
            watching: () => {},
            feed: () => {},
            memes: () => {},
        };
        const schedules = syncedJobsModule(jobs).schedules!;
        assert.equal(schedules.length, 4);
        assert.deepEqual(schedules.map(s => s.every), [2 * HALF, HALF, HALF, HALF]);
        assert.deepEqual(schedules.map(s => s.run), [jobs.weeklyReport, jobs.watching, jobs.feed, jobs.memes]);
        assert.deepEqual(schedules.map(s => s.runOnStart), [undefined, undefined, true, undefined]);
        assert.deepEqual(schedules.map(s => s.start), [undefined, undefined, undefined, undefined]);
    });

    test('每个 schedule 的 run 真的调用对应的那个 job', () => {
        const calls: string[] = [];
        const schedules = syncedJobsModule({
            weeklyReport: () => { calls.push('周报'); },
            watching: () => { calls.push('在看'); },
            feed: () => { calls.push(' feed '); },
            memes: () => { calls.push('梗'); },
        }).schedules!;
        for (const s of schedules) s.run();
        assert.deepEqual(calls, ['周报', '在看', ' feed ', '梗']);
    });

    test('空对象：一条都不挂', () => {
        assert.deepEqual(syncedJobsModule({}).schedules, []);
    });

    test('只给 weeklyReport：一条，间隔 1 小时，没有 runOnStart', () => {
        const run = () => {};
        const schedules = syncedJobsModule({ weeklyReport: run }).schedules!;
        assert.equal(schedules.length, 1);
        assert.equal(schedules[0]!.every, 2 * HALF);
        assert.equal(schedules[0]!.run, run);
        assert.equal(schedules[0]!.runOnStart, undefined);
    });

    test('只给 watching：一条，间隔 30 分钟', () => {
        const run = () => {};
        const schedules = syncedJobsModule({ watching: run }).schedules!;
        assert.equal(schedules.length, 1);
        assert.equal(schedules[0]!.every, HALF);
        assert.equal(schedules[0]!.run, run);
    });

    test('只给 feed：一条，间隔 30 分钟，runOnStart 为真', () => {
        const run = () => {};
        const schedules = syncedJobsModule({ feed: run }).schedules!;
        assert.equal(schedules.length, 1);
        assert.equal(schedules[0]!.every, HALF);
        assert.equal(schedules[0]!.run, run);
        assert.equal(schedules[0]!.runOnStart, true);
    });

    test('只给 memes：一条，间隔 30 分钟，没有 runOnStart', () => {
        const run = () => {};
        const schedules = syncedJobsModule({ memes: run }).schedules!;
        assert.equal(schedules.length, 1);
        assert.equal(schedules[0]!.every, HALF);
        assert.equal(schedules[0]!.run, run);
        assert.equal(schedules[0]!.runOnStart, undefined);
    });

    test('部分组合（weeklyReport + memes）：顺序仍是周报在前', () => {
        const weeklyReport = () => {};
        const memes = () => {};
        const schedules = syncedJobsModule({ memes, weeklyReport }).schedules!;
        assert.equal(schedules.length, 2);
        assert.deepEqual(schedules.map(s => s.run), [weeklyReport, memes]);
        assert.deepEqual(schedules.map(s => s.every), [2 * HALF, HALF]);
    });
});
