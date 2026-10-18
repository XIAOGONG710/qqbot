import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createNetWatch } from '../../../scripts/net-watch.mjs';

const MIN = 60_000;
/** 一分钟一次地喂一串结果（'1' 通、'0' 不通），返回每次的事件 */
function feed(watch: ReturnType<typeof createNetWatch>, pattern: string, from = 0) {
    return [...pattern].map((ch, i) => watch.push(ch === '1', from + i * MIN));
}

describe('外网滑动窗口（net-watch）', () => {
    test('一直通：什么都不报', () => {
        const events = feed(createNetWatch(), '1'.repeat(30));
        assert.ok(events.every(e => e === undefined));
    });

    test('连续不通：凑满 10 次且 7 次以上不通时报一次「断」，之后不再重复报', () => {
        const watch = createNetWatch();
        const events = feed(watch, '0'.repeat(25));
        const downs = events.filter(e => e?.kind === 'down');
        assert.equal(downs.length, 1);
        assert.equal(events.findIndex(e => e?.kind === 'down'), 9, '第 10 次检查时报');
        assert.deepEqual(downs[0], { kind: 'down', bad: 10, minutes: 9 });
        assert.equal(watch.alerted, true);
    });

    test('10-18 那种时好时坏（大半不通、偶尔通）：连续计数凑不齐，窗口能报', () => {
        // 10 次里 8 次不通，穿插着通
        const events = feed(createNetWatch(), '0010100110000100000');
        const down = events.find(e => e?.kind === 'down');
        assert.ok(down, '该报断');
        assert.ok(down.bad >= 7);
    });

    test('偶尔抖一下不报：10 次里不到 7 次不通', () => {
        const events = feed(createNetWatch(), '0101010101010101010101010101'.slice(0, 28));
        assert.ok(events.every(e => e === undefined));
        const flaky = feed(createNetWatch(), '1101101101101101101101');
        assert.ok(flaky.every(e => e === undefined));
    });

    test('断了以后：最近 5 次都通才报「恢复」，中间又断一次要重新数；恢复只报一次', () => {
        const watch = createNetWatch();
        const events = feed(watch, '0'.repeat(10) + '1110111' + '1'.repeat(10));
        const ups = events.filter(e => e?.kind === 'up');
        assert.equal(ups.length, 1);
        // 第 10 次（下标 9）报断；之后 1110111：下标 13 的 0 打断了前面的三次通；恢复要等那个 0 之后连着 5 次通（下标 14–18）
        assert.equal(events.findIndex(e => e?.kind === 'up'), 18);
        assert.deepEqual(ups[0], { kind: 'up', minutes: 18 });
        assert.equal(watch.alerted, false);
    });

    test('恢复后可以再报下一次断', () => {
        const watch = createNetWatch();
        const events = feed(watch, '0'.repeat(10) + '1'.repeat(10) + '0'.repeat(10));
        assert.deepEqual(events.filter(e => e).map(e => e!.kind), ['down', 'up', 'down']);
    });

    test('断了多久：从窗口里最早的不通那次算起', () => {
        const watch = createNetWatch();
        // 前 5 次通，后面不通；窗口满 10 次时 7 次不通 → 报断，断了的起点是第 6 次
        const events = feed(watch, '11111' + '0'.repeat(10));
        const down = events.find(e => e?.kind === 'down')!;
        const index = events.findIndex(e => e?.kind === 'down');
        assert.equal(index, 11, '第 12 次检查：窗口里有 7 次不通');
        assert.equal(down.minutes, Math.round((index - 5) ), '从第 6 次起算');
        const up = feed(watch, '1'.repeat(5), 15 * MIN).find(e => e?.kind === 'up')!;
        assert.ok(up.minutes >= 10);
    });
});
