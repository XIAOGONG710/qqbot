// 热重载：cordis reset() 不等 dispose 的 Promise 就重新 apply，新实例要等上一个实例收尾放开数据目录再起（src/index.ts afterPendingStops）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterPendingStops, napcatReconnect, trackStop } from '../src/index.ts';

const later = () => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
};

test('NapCat 重复离线只排一次；恢复在线后取消，下一次断线从首档开始', async () => {
    const tasks = new Map<number, () => void>();
    let starts = 0;
    const retry = napcatReconnect(
        (fn, delay) => { tasks.set(delay, fn); return () => { tasks.delete(delay); }; },
        async () => { starts++; },
        () => {},
    );
    retry.offline('onebot:test');
    retry.offline('onebot:test');
    assert.deepEqual([...tasks.keys()], [5000]);
    retry.online('onebot:test');
    assert.equal(tasks.size, 0);
    assert.equal(starts, 0);
    retry.offline('onebot:test');
    assert.deepEqual([...tasks.keys()], [5000]);
});

test('NapCat 重连启动失败会继续退避，停用后取消余下的尝试', async () => {
    const tasks = new Map<number, () => void>();
    const retry = napcatReconnect(
        (fn, delay) => { tasks.set(delay, fn); return () => { tasks.delete(delay); }; },
        async () => { throw Error('合成连接失败'); },
        () => {},
    );
    retry.offline('onebot:test');
    const run = tasks.get(5000)!;
    tasks.delete(5000);
    run();
    await new Promise(done => setImmediate(done));
    assert.deepEqual([...tasks.keys()], [10000]);
    retry.dispose();
    assert.equal(tasks.size, 0);
});

test('没有在收尾的：当场起', () => {
    let started = 0;
    const result = afterPendingStops(() => ++started, () => true);
    assert.equal(result, 1);
    assert.equal(started, 1);
});

test('上一个还在收尾：等它结束再起；收尾失败也算结束', async () => {
    const first = later(), second = later();
    trackStop(first.promise);
    trackStop(second.promise);
    const waits: number[] = [];
    let started = 0;
    const result = afterPendingStops(() => ++started, () => true, count => waits.push(count));
    assert.ok(result instanceof Promise);
    assert.deepEqual(waits, [2]);
    first.resolve();
    await new Promise(done => setImmediate(done));
    assert.equal(started, 0, '还有一个没收完');
    second.reject(new Error('记忆写入失败'));
    assert.equal(await result, 1);
    // 收完的从登记里拿掉：下一次当场起
    assert.equal(afterPendingStops(() => 'now', () => true), 'now');
});

test('等的时候这个实例已经被停用：不起', async () => {
    const stop = later();
    trackStop(stop.promise);
    let started = 0;
    const result = afterPendingStops(() => ++started, () => false);
    stop.resolve();
    assert.equal(await result, undefined);
    assert.equal(started, 0);
});
