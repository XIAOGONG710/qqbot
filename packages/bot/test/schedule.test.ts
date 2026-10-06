import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { describeState, inWeeks, parseSchedule, stateAt, type Schedule } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// 用转换器生成的真卡（ADR 0007 决策 1）：学期 2026-08-31（周一）起，国庆 10-01–10-07，10-10 调休没课
const cardPath = (tier: string) => resolve(import.meta.dirname, `../../../characters/linmengyao/st/linmengyao-${tier}.json`);
const boyfriend = loadCharacterCard(cardPath('boyfriend')).schedule!;
const classmate = loadCharacterCard(cardPath('classmate')).schedule!;
/** 本地时间 2026 年 */
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m);
const hm = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

describe('作息：某个时刻她在干什么', () => {
    test('国庆：整天没课，平时的点起；她在哪、他在哪用假期的说法', () => {
        const night = stateAt(boyfriend, t(10, 5, 3));
        assert.deepEqual(night.activity.kind === 'sleep' && hm(night.activity.until), '09:30');
        const afternoon = stateAt(boyfriend, t(10, 5, 14));
        assert.equal(afternoon.activity.kind, 'free');
        assert.equal(afternoon.holiday?.name, '国庆节');
        assert.equal(afternoon.where, '国庆节放假，没抢到回青岛的票，留在学校（你们说好以后放假一起走，这次你不难受）');
        assert.equal(afternoon.partner, '{{user}}回青岛过国庆了（放假前就说好的）');
        assert.equal(afternoon.nextClass, undefined);
        assert.equal(stateAt(classmate, t(10, 5, 14)).where, '国庆节放假，没回家，留在学校');
        assert.equal(stateAt(classmate, t(10, 5, 14)).partner, undefined);
    });

    test('00:00 到 02:00 算前一天的晚上：10-08 凌晨 1 点还在国庆假期里，活动是 10-07 晚上的', () => {
        const s = stateAt(boyfriend, t(10, 8, 1));
        assert.equal(s.activity.kind, 'free');
        assert.equal(s.holiday?.name, '国庆节');
        assert.deepEqual(s.activity, stateAt(boyfriend, t(10, 7, 22)).activity);
        assert.equal(stateAt(boyfriend, t(10, 8, 2)).activity.kind, 'sleep');
    });

    test('周一（第 7 周）：有早课 07:40 起；赶去上课、上课、课间、下午有课、晚上空闲', () => {
        const early = stateAt(boyfriend, t(10, 12, 7));
        assert.equal(early.activity.kind === 'sleep' && hm(early.activity.until), '07:40');

        const getUp = stateAt(boyfriend, t(10, 12, 7, 50));
        assert.equal(getUp.activity.kind, 'between');
        assert.equal(getUp.activity.kind === 'between' && hm(getUp.activity.next.start), '08:20');

        const linux = stateAt(boyfriend, t(10, 12, 8, 30));
        assert.equal(linux.activity.kind, 'class');
        if (linux.activity.kind !== 'class') return;
        assert.deepEqual({ ...linux.activity.lesson, start: hm(linux.activity.lesson.start), end: hm(linux.activity.lesson.end) },
            { kind: 'machine', name: 'Linux操作系统', room: '知行楼612', start: '08:20', end: '09:40' });
        assert.equal(linux.nextClass?.name, '大数据应用技术');
        assert.equal(linux.where, '在学校（济南），住宿舍');
        // 放完国庆 7 天内说他回来了，之后是平时的说法
        assert.equal(linux.partner, '{{user}}国庆放完假，已经回学校了');
        assert.equal(stateAt(boyfriend, t(10, 14, 20)).partner, '{{user}}国庆放完假，已经回学校了');
        assert.equal(stateAt(boyfriend, t(10, 15, 20)).partner, '{{user}}也在学校');
        assert.equal(stateAt(classmate, t(10, 12, 20)).partner, undefined);

        assert.equal(stateAt(boyfriend, t(10, 12, 9, 45)).activity.kind, 'between');
        const bigData = stateAt(boyfriend, t(10, 12, 10));
        assert.deepEqual(bigData.activity.kind === 'class' && [bigData.activity.lesson.kind, bigData.activity.lesson.room], ['hard', '知行楼303']);

        const noon = stateAt(boyfriend, t(10, 12, 12, 30));
        assert.equal(noon.activity.kind, 'free');
        assert.equal(noon.nextClass?.name, 'MySQL数据库应用');
        assert.equal(noon.nextClass && hm(noon.nextClass.start), '15:15');
        const mysql = stateAt(boyfriend, t(10, 12, 15, 20));
        assert.deepEqual(mysql.activity.kind === 'class' && mysql.activity.lesson.kind, 'hard');

        const evening = stateAt(boyfriend, t(10, 12, 20));
        assert.equal(evening.activity.kind, 'free');
        assert.equal(evening.nextClass, undefined);
    });

    test('转实训以后按机房课算，教室换成机房（大数据应用技术第 9 周起）', () => {
        const s = stateAt(boyfriend, t(11, 2, 10));
        assert.deepEqual(s.activity.kind === 'class' && [s.activity.lesson.name, s.activity.lesson.kind, s.activity.lesson.room],
            ['大数据应用技术', 'machine', '知行楼303（机房）']);
    });

    test('没有早课的日子 09:30 起；周日没课', () => {
        // 周二第一节是 3-4 节体育
        assert.deepEqual(((s) => s.activity.kind === 'sleep' && hm(s.activity.until))(stateAt(boyfriend, t(10, 13, 9))), '09:30');
        assert.equal(stateAt(boyfriend, t(10, 11, 10)).nextClass, undefined);
        assert.equal(stateAt(boyfriend, t(10, 11, 10)).activity.kind, 'free');
    });

    test('调休：10-10 补哪天没定，按没课；改成补周四就按周四的课', () => {
        assert.equal(stateAt(boyfriend, t(10, 10, 10)).activity.kind, 'free');
        const thursday: Schedule = { ...boyfriend, makeups: boyfriend.makeups.map(m => (m.date === '2026-10-10' ? { ...m, asDay: 4 } : m)) };
        const s = stateAt(thursday, t(10, 10, 10));
        assert.deepEqual(s.activity.kind === 'class' && s.activity.lesson.name, '数据结构');
    });

    test('学期外没有课', () => {
        const after = stateAt(boyfriend, new Date(2027, 0, 4, 10));
        assert.equal(after.outsideSemester, true);
        assert.equal(after.activity.kind, 'free');
        assert.equal(stateAt(boyfriend, t(8, 30, 10)).outsideSemester, true);
        assert.equal(stateAt(boyfriend, t(10, 12, 10)).outsideSemester, false);
    });

    test('同学档的卡没有课名和教室，上课的时间一样', () => {
        const s = stateAt(classmate, t(10, 12, 8, 30));
        assert.equal(s.activity.kind, 'class');
        if (s.activity.kind !== 'class') return;
        assert.equal(s.activity.lesson.name, undefined);
        assert.equal(s.activity.lesson.room, undefined);
        assert.equal(s.activity.lesson.kind, 'machine');
        assert.equal(hm(s.activity.lesson.end), '09:40');
        assert.equal(s.where, '在学校，住宿舍');
    });

    test('同一天同一时段的空闲活动固定，不随调用变化', () => {
        const a = stateAt(boyfriend, t(10, 5, 13));
        const b = stateAt(boyfriend, t(10, 5, 17));
        assert.deepEqual(a.activity, b.activity);
        assert.ok(a.activity.kind === 'free' && boyfriend.free.afternoon.includes(a.activity.text));
    });

    test('状态行：在哪、在干什么、他在哪；低档位没有课名、教室、城市和他', () => {
        const line = (s: Schedule, date: Date, woken = false) => describeState(stateAt(s, date), s, { woken });
        assert.match(line(boyfriend, t(10, 5, 14)), /^\[你现在：国庆节放假，没抢到回青岛的票，留在学校（你们说好以后放假一起走，这次你不难受）；[^；]+；他回青岛过国庆了（放假前就说好的）\]$/);
        assert.equal(line(boyfriend, t(10, 5, 3)), '[你现在：国庆节放假，没抢到回青岛的票，留在学校（你们说好以后放假一起走，这次你不难受）；在宿舍睡觉，09:30 起；他回青岛过国庆了（放假前就说好的）]');
        assert.equal(line(boyfriend, t(10, 5, 3), true), '[你现在：国庆节放假，没抢到回青岛的票，留在学校（你们说好以后放假一起走，这次你不难受）；在宿舍睡觉，被消息震醒了，迷迷糊糊的；他回青岛过国庆了（放假前就说好的）]');
        assert.equal(line(boyfriend, t(10, 12, 7, 50)), '[你现在：在学校（济南），住宿舍；刚起床，08:20 要上Linux操作系统；他国庆放完假，已经回学校了]');
        assert.equal(line(boyfriend, t(10, 12, 8, 30)),
            '[你现在：在学校（济南），住宿舍；在知行楼612上Linux操作系统（机房课，边敲代码边看手机），09:40 下课，偷偷看手机回消息，回得简短；他国庆放完假，已经回学校了]');
        assert.equal(line(boyfriend, t(10, 12, 9, 45)), '[你现在：在学校（济南），住宿舍；课间，09:55 接着上大数据应用技术；他国庆放完假，已经回学校了]');
        assert.match(line(boyfriend, t(10, 12, 12, 30)), /；[^；]+，今天 15:15 还有MySQL数据库应用；他国庆放完假，已经回学校了\]$/);
        // 水课、体育不提偷偷回
        assert.equal(line(boyfriend, t(9, 24, 19, 40)), '[你现在：在学校（济南），住宿舍；在知行楼303上Python数据分析（水课），20:00 下课；他也在学校]');
        assert.equal(line(classmate, t(10, 12, 8, 30)), '[你现在：在学校，住宿舍；在上课，09:40 下课，偷偷看手机回消息，回得简短]');
        assert.match(line(classmate, t(10, 12, 12, 30)), /^\[你现在：在学校，住宿舍；[^；]+，今天 15:15 还有课\]$/);
        assert.equal(line(classmate, t(10, 12, 9, 45)), '[你现在：在学校，住宿舍；课间，09:55 接着上课]');
        // 他在哪写称呼，不写「他」
        assert.equal(describeState(stateAt(boyfriend, t(10, 12, 9, 45)), boyfriend, { userName: '宝宝' }),
            '[你现在：在学校（济南），住宿舍；课间，09:55 接着上大数据应用技术；宝宝国庆放完假，已经回学校了]');
        assert.equal(describeState(stateAt(boyfriend, t(10, 5, 3)), boyfriend, { userName: '宝宝' }),
            '[你现在：国庆节放假，没抢到回青岛的票，留在学校（你们说好以后放假一起走，这次你不难受）；在宿舍睡觉，09:30 起；宝宝回青岛过国庆了（放假前就说好的）]');
    });

    test('周次写法', () => {
        assert.equal(inWeeks('1-16', 16), true);
        assert.equal(inWeeks('1-16', 17), false);
        assert.equal(inWeeks('1-2,4-16,18', 3), false);
        assert.equal(inWeeks('1-2,4-16,18', 18), true);
        assert.equal(inWeeks('9-12', 9), true);
    });

    test('卡上的作息写坏了报错', () => {
        const raw = JSON.parse(JSON.stringify(boyfriend)) as Record<string, unknown>;
        assert.throws(() => parseSchedule({ ...raw, sleep: '2:00' }, '卡'), /extensions.qqbot.schedule.sleep 格式不对/);
        assert.throws(() => parseSchedule({ ...raw, courses: [{ ...boyfriend.courses[0], slot: '5' }] }, '卡'), /slot 5 不在 periods 里/);
        assert.throws(() => parseSchedule({ ...raw, wake: { ...boyfriend.wake, earlySlot: '0' } }, '卡'), /earlySlot 0 不在 periods 里/);
        assert.deepEqual(parseSchedule(raw, '卡'), boyfriend);
    });
});
