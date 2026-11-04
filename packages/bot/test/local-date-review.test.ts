import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { localDate } from '../src/local-date.ts';

test('本地数字日期保留 0000/0099 年和公历闰日，支持日月跨年归一化', () => {
    const leap = localDate(0, 1, 29, 12, 34, 56, 789);
    assert.deepEqual([leap.getFullYear(), leap.getMonth(), leap.getDate(), leap.getHours(), leap.getMinutes(), leap.getSeconds(), leap.getMilliseconds()], [0, 1, 29, 12, 34, 56, 789]);
    const next = localDate(99, 11, 32);
    assert.deepEqual([next.getFullYear(), next.getMonth(), next.getDate()], [100, 0, 1]);
    const previous = localDate(100, 0, 0);
    assert.deepEqual([previous.getFullYear(), previous.getMonth(), previous.getDate()], [99, 11, 31]);
});

test('现代日期保持原有日/月/时钟溢出和 DST 构造结果', () => {
    for (const year of [1900, 2000, 2011, 2024, 2026, 2100, 9999]) {
        for (const month of [-1, 0, 1, 2, 9, 10, 11, 12]) {
            for (const day of [0, 1, 8, 29, 30, 31, 32]) {
                for (const hour of [-1, 0, 1, 2, 3, 23, 24, 25]) {
                    assert.equal(localDate(year, month, day, hour, 15, 20, 42).getTime(), new Date(year, month, day, hour, 15, 20, 42).getTime());
                }
            }
        }
    }
});

test('不把无效数值转成可用时间', () => {
    for (const args of [[NaN, 0], [Infinity, 0], [2026, Infinity], [2026, 0, Infinity], [2026, 0, 1, NaN]]) {
        assert.ok(Number.isNaN(localDate(args[0]!, args[1]!, args[2], args[3]).getTime()));
    }
    assert.ok(Number.isNaN(localDate(2026, 0, undefined).getTime()));
    assert.ok(Number.isNaN(localDate(2026, 0, 1, undefined).getTime()));
});

test('上海、UTC、纽约 DST 及 Apia 整日跳过均保持日历构造契约', () => {
    const moduleUrl = new URL('../src/local-date.ts', import.meta.url).href;
    const code = `import assert from 'node:assert/strict';
        import { localDate } from ${JSON.stringify(moduleUrl)};
        for (const [y,m,d] of [[0,1,29],[99,11,31],[100,0,1]]) {
            const text = String(y).padStart(4,'0')+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0')+'T12:00:00';
            assert.equal(localDate(y,m,d,12).getTime(),new Date(text).getTime());
        }
        for (const [y,m,d] of [[2011,11,30],[2026,2,8],[2026,10,1]]) {
            for (const h of [-1,0,1,2,3,23,24,25]) assert.equal(localDate(y,m,d,h).getTime(),new Date(y,m,d,h).getTime());
        }`;
    for (const TZ of ['Asia/Shanghai', 'UTC', 'America/New_York', 'Pacific/Apia']) {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' });
        assert.equal(result.status, 0, `${TZ}: ${result.stderr}`);
    }
});
