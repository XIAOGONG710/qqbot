import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 常驻的她的作息判断（scripts/her-schedule.mjs）。
// ADR 0347 第 1 层：她睡没睡只看 QQ 写的 NOW.md（`<!-- asleep: yes|no -->`），NOW.md 不新鲜才退回 23–07 夜里。

const root = fileURLToPath(new URL('../../..', import.meta.url));
interface Schedule {
    localDay: (at?: Date) => string;
    isNightHour: (hour: number) => boolean;
    nowFreshText: (text: string | undefined, now?: Date) => string | null;
    herAsleep: (input: { nowText: string | undefined; now?: Date }) => boolean;
    sleepDue: (input: { now: Date; lastSleepDay?: string; offline?: boolean }) => boolean;
    wakeDue: (input: { now: Date; roll: number; asleep?: boolean; offline?: boolean; chance?: number }) => boolean;
}
const schedule = await import(pathToFileURL(join(root, 'scripts/her-schedule.mjs')).href) as Schedule;
const at = (h: number, m = 0) => new Date(2026, 9, 29, h, m);
/** 和 now-export.ts 一样的格式：生成时间那一行，紧跟着 asleep 那一行 */
const nowMd = (generated: Date, asleep?: 'yes' | 'no') => [
    '<!-- 生成的，别手改：QQ 这边每 10 分钟重写一次；来源是作息 + 世界 + 心境 -->',
    `<!-- generated-at: ${generated.toISOString()} -->`,
    ...(asleep ? [`<!-- asleep: ${asleep} -->`] : []),
    '',
    '在宿舍看书',
    '',
].join('\n');

describe('她睡没睡（herAsleep）：新鲜的 NOW.md 说了算，否则按夜里兜底', () => {
    test('新鲜且写了 yes：睡着，白天也是（午睡）', () => {
        assert.equal(schedule.herAsleep({ nowText: nowMd(at(14, 0), 'yes'), now: at(14, 5) }), true);
    });

    test('新鲜且写了 no：醒着，夜里也是（她还没睡）', () => {
        assert.equal(schedule.herAsleep({ nowText: nowMd(at(23, 30), 'no'), now: at(23, 40) }), false);
        assert.equal(schedule.herAsleep({ nowText: nowMd(at(4, 0), 'no'), now: at(4, 29) }), false);
    });

    test('过期（超过 30 分钟）：不信 NOW.md，按 23–07 算', () => {
        assert.equal(schedule.herAsleep({ nowText: nowMd(at(13, 0), 'yes'), now: at(13, 31) }), false, '白天：醒着');
        assert.equal(schedule.herAsleep({ nowText: nowMd(at(2, 0), 'no'), now: at(2, 31) }), true, '夜里：睡着');
        assert.equal(schedule.herAsleep({ nowText: nowMd(at(13, 0), 'yes'), now: at(13, 30) }), true, '正好 30 分钟还算新鲜');
    });

    test('没有 NOW.md：按 23–07 算', () => {
        assert.equal(schedule.herAsleep({ nowText: undefined, now: at(3) }), true);
        assert.equal(schedule.herAsleep({ nowText: undefined, now: at(15) }), false);
        assert.equal(schedule.herAsleep({ nowText: '', now: at(23) }), true);
    });

    test('生成时间在未来超过 60 秒：不信，按 23–07 算；60 秒以内的时钟误差还认', () => {
        assert.equal(schedule.herAsleep({ nowText: nowMd(at(15, 2), 'yes'), now: at(15, 0) }), false);
        assert.equal(schedule.herAsleep({ nowText: nowMd(new Date(at(15, 0).getTime() + 30_000), 'yes'), now: at(15, 0) }), true);
    });

    test('新鲜但没有 asleep 那一行（老格式）/ 没有生成时间：按 23–07 算', () => {
        assert.equal(schedule.herAsleep({ nowText: nowMd(at(15, 0)), now: at(15, 1) }), false);
        assert.equal(schedule.herAsleep({ nowText: nowMd(at(1, 0)), now: at(1, 1) }), true);
        assert.equal(schedule.herAsleep({ nowText: '<!-- asleep: yes -->\n现在 15:00，我在发呆', now: at(15, 1) }), false, '没有生成时间就是不新鲜');
    });

    test('nowFreshText：新鲜就原样返回（去首尾空白），否则 null', () => {
        const text = nowMd(at(10, 0), 'no');
        assert.equal(schedule.nowFreshText(text, at(10, 10)), text.trim());
        assert.equal(schedule.nowFreshText(text, at(10, 31)), null);
        assert.equal(schedule.nowFreshText(undefined, at(10, 0)), null);
        assert.equal(schedule.nowFreshText('<!-- generated-at: 坏了 -->', at(10, 0)), null);
    });
});

describe('作息判断（her-schedule）：原来睡眠整合白天也触发、醒来不看钟点', () => {
    test('睡眠整合 03:00 之后到当天 21:00 都行（夜里没做成就白天补），且每个本地日一次', () => {
        assert.equal(schedule.sleepDue({ now: at(2, 59) }), false);
        assert.equal(schedule.sleepDue({ now: at(3, 0) }), true);
        assert.equal(schedule.sleepDue({ now: at(6, 59) }), true);
        assert.equal(schedule.sleepDue({ now: at(7, 0) }), true, '10-30 起 7 点以后也能补做（原来只到 7 点，笔记本一睡就永远漏）');
        assert.equal(schedule.sleepDue({ now: at(14, 0) }), true, '第二天白天补');
        assert.equal(schedule.sleepDue({ now: at(20, 59) }), true);
        assert.equal(schedule.sleepDue({ now: at(21, 0) }), false, '太晚了不补，等第二天');
        assert.equal(schedule.sleepDue({ now: at(4, 0), lastSleepDay: '2026-10-29' }), false, '今天已经整合过');
        assert.equal(schedule.sleepDue({ now: at(4, 0), lastSleepDay: '2026-10-28' }), true, '昨天的不算今天的');
        assert.equal(schedule.sleepDue({ now: at(4, 0), offline: true }), false, '她自己离开电脑时不做');
    });

    test('随机醒来：夜里不醒（QQ 说她醒着也不醒）、她睡着不醒、离开电脑不醒；白天按概率', () => {
        for (const hour of [23, 0, 3, 6]) {
            assert.equal(schedule.wakeDue({ now: at(hour), roll: 0 }), false, `${hour} 点`);
            assert.equal(schedule.wakeDue({ now: at(hour), roll: 0, asleep: false }), false, `${hour} 点，她还醒着也不起来用整机权限做事`);
        }
        assert.equal(schedule.wakeDue({ now: at(7), roll: 0.1 }), true);
        assert.equal(schedule.wakeDue({ now: at(15), roll: 0.1 }), true);
        assert.equal(schedule.wakeDue({ now: at(15), roll: 0.5 }), false);
        assert.equal(schedule.wakeDue({ now: at(15), roll: 0.1, asleep: true }), false, '白天在睡（午睡），也不起来');
        assert.equal(schedule.wakeDue({ now: at(15), roll: 0.1, offline: true }), false);
    });

    test('本地日期，不是 UTC：本地 00:30 还是今天', () => {
        assert.equal(schedule.localDay(new Date(2026, 9, 29, 0, 30)), '2026-10-29');
        assert.equal(schedule.localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    });
});
