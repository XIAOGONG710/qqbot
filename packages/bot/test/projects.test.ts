import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ReadingBook } from '../src/her-days.ts';
import type { LifeEvent } from '../src/life-events.ts';
import { activeProjects, chooseProject, describeRecentPhotography, photographyProgress, projectActivity, projectPortfolio, recentPhotography } from '../src/projects.ts';
import type { Schedule } from '../src/schedule.ts';
import type { WorldNow } from '../src/world.ts';

const event = (id: string, start: string, end: string, result: LifeEvent['result'] = 'succeeded'): LifeEvent => ({
    id, actor: 'linmengyao', kind: 'work_on_project', day: '2026-10-12',
    startedAt: start, endedAt: end, source: 'simulation', result,
    subject: '修昨天拍的片子', target: 'photography_growth',
});

describe('长期项目从事实账派生（ADR 0044）', () => {
    test('只把摄影成长活动映射成项目，普通娱乐不伪装成进展', () => {
        assert.equal(projectActivity('打独立游戏'), undefined);
        assert.equal(projectActivity('刷手机刷到忘了时间'), undefined);
        assert.equal(projectActivity('刷摄影区'), undefined, '刷着看是休闲，不算在练');
        assert.deepEqual(projectActivity('修昨天拍的片子'), { id: 'photography_growth', title: '摄影成长', step: '修昨天拍的片子' });
        // 买了相机以后（ADR 0053）
        for (const text of ['拿新相机去校园里拍', '研究新相机的设置', '在宿舍研究新相机的设置']) assert.equal(projectActivity(text)?.id, 'photography_growth', text);
        assert.equal(projectActivity('攒钱买相机'), undefined);
    });

    test('成功和被打断前的真实投入都算，失败候选不算；重算不另造状态', () => {
        const events = [
            event('b', '2026-10-12T08:00:00.000Z', '2026-10-12T08:30:00.000Z', 'interrupted'),
            event('a', '2026-10-12T06:00:00.000Z', '2026-10-12T07:00:00.000Z'),
            event('c', '2026-10-12T09:00:00.000Z', '2026-10-12T09:00:00.000Z', 'failed'),
        ];
        assert.deepEqual(photographyProgress(events), {
            id: 'photography_growth', title: '摄影成长', sessions: 2, minutes: 90,
            lastAt: '2026-10-12T08:30:00.000Z', recentSteps: ['修昨天拍的片子'],
        });
        assert.deepEqual(photographyProgress(events), photographyProgress(events));
    });
});

describe('B 阶段项目组合（期限、资源、阻碍和暂停）', () => {
    const schedule: Schedule = {
        sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: '1' },
        periods: { '1': { start: '08:00', end: '09:40' } }, semester: { start: '2026-09-07', weeks: 20 },
        holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
        free: { morning: ['刷手机'], afternoon: ['修片'], evening: ['看书'], afternoonFrom: '12:00', eveningFrom: '18:00' },
        where: '在学校',
    };
    const book = (id: string, state: ReadingBook['progress']['state'], max?: number): ReadingBook => ({
        id, title: id, aliases: [], author: '作者', kind: '小说', platform: '电子书', status: '连载中',
        progress: { startDay: '2026-10-01', start: 1, everyDays: 1, amount: 1, unit: '章', ...(max === undefined ? {} : { max }), state },
        attitude: '', unreadKeywords: [], nodes: [],
    });
    const now = new Date(2026, 9, 12, 12, 0);
    const world: WorldNow = {
        day: '2026-10-12', atSchool: true, parcels: [], events: [],
        homework: [
            { course: '数据库', due: new Date(2026, 9, 13, 8, 0), done: false, doneAt: new Date(2026, 9, 12, 22, 0) },
            { course: '英语', due: new Date(2026, 9, 15, 8, 0), done: true, doneAt: new Date(2026, 9, 12, 10, 30) },
        ],
        cameraFund: {
            saved: 4500, goal: 4500,
            camera: { start: new Date(2026, 9, 11, 14), end: new Date(2026, 9, 11, 16, 30), where: '科技市场', what: '索尼 a6100', price: 4280, state: 'bought' },
        },
    };

    test('三种项目只从现有事实投影；相机基金买完后不再冒充活跃项目', () => {
        const items = projectPortfolio({
            events: [event('photo', '2026-10-11T08:00:00.000Z', '2026-10-11T09:00:00.000Z')],
            world, schedule, books: [book('在读', 'reading'), book('放下', 'put_down')], now,
        });
        assert.equal(items.some(item => /相机基金/.test(item.title)), false);
        assert.deepEqual(items.map(item => [item.kind, item.status]), [
            ['course', 'active'], ['photography', 'active'], ['reading', 'active'], ['course', 'completed'], ['reading', 'paused'],
        ]);
        const photography = items.find(item => item.kind === 'photography')!;
        assert.deepEqual(photography.resources, ['索尼 a6100']);
        assert.match(photography.nextStep!, /拿相机出去拍|整理/);
        assert.equal(items.find(item => item.id === 'reading:放下')?.obstacle, '自己放下了，暂时不继续');
    });

    test('截止时间压过柔性成长；排序相同输入可重放，暂停和完成的不参与候选', () => {
        const portfolio = projectPortfolio({ events: [], world, schedule, books: [book('在读', 'reading'), book('放下', 'put_down')], now });
        const active = activeProjects(portfolio);
        assert.equal(active[0]!.title, '数据库作业');
        assert.deepEqual(active.map(item => item.status), active.map(() => 'active'));
        assert.deepEqual(activeProjects(portfolio).map(item => item.id), active.map(item => item.id));
        assert.equal(active.some(item => item.title === '英语作业' || item.id === 'reading:放下'), false);
    });

    test('共享项目决策只让三天内课程作业抢占空闲，输出同时供状态行和执行器使用', () => {
        const choice = chooseProject({ events: [], world, schedule, books: [book('在读', 'reading')], now })!;
        assert.equal(choice.project.title, '数据库作业');
        assert.equal(choice.text, '在赶数据库作业');
        assert.deepEqual(choice.action, { kind: 'study', subject: '数据库作业' });
        assert.equal(choice.until?.getTime(), world.homework[0]!.doneAt.getTime());

        const later = { ...world, homework: [{ ...world.homework[0]!, due: new Date(2026, 9, 20, 8, 0) }] };
        assert.equal(chooseProject({ events: [], world: later, schedule, books: [book('在读', 'reading')], now }), undefined,
            '较远的作业、摄影和阅读仍由原计划决定，不能吞掉全部空闲');
    });
});

describe('最近几天的摄影练习进提示词（lifeInPrompt）', () => {
    const work = (start: string, minutes: number, subject = '修昨天拍的片子'): LifeEvent => {
        const s = new Date(`${start}+08:00`);
        return {
            id: `life:${s.toISOString()}:work_on_project`, actor: 'linmengyao', kind: 'work_on_project', day: start.slice(0, 10),
            startedAt: s.toISOString(), endedAt: new Date(s.getTime() + minutes * 60_000).toISOString(), source: 'simulation', result: 'succeeded',
            subject, target: 'photography_growth',
        };
    };
    const now = new Date('2026-10-14T20:00:00+08:00');
    test('只数三天里落了账的；没练就没有这一行', () => {
        assert.equal(recentPhotography([work('2026-10-10T15:00:00', 120)], now), undefined, '四天前的不算');
        const practice = recentPhotography([work('2026-10-12T15:00:00', 40, '拿新相机去校园里拍'), work('2026-10-13T20:30:00', 80, '研究新相机的设置'), work('2026-10-15T09:00:00', 60)], now)!;
        assert.deepEqual([practice.sessions, practice.days, practice.minutes, practice.steps], [2, 2, 120, ['拿新相机去校园里拍', '研究新相机的设置']], '还没到的不算');
        assert.equal(describeRecentPhotography(practice, now), '[你这几天拍照修图（你自己过的日子，账上记着的；用不用、怎么说你自己定，没写的别编）：3 天里有 2 天在弄（拿新相机去校园里拍、研究新相机的设置）；上一回是昨天晚上]');
    });
    test('按天说，不报总时长；同一天几回算一天', () => {
        const practice = recentPhotography([work('2026-10-14T13:00:00', 240), work('2026-10-14T18:00:00', 90, '研究新相机的设置')], now)!;
        assert.equal(practice.days, 1);
        const line = describeRecentPhotography(practice, now);
        assert.match(line, /3 天里有 1 天在弄（修昨天拍的片子、研究新相机的设置）；上一回是今天/);
        assert.doesNotMatch(line, /小时|分钟/);
    });
    test('今天 / 昨天按她的作息日（02:00 前算前一天）：零点后她还没睡，头天晚上弄的是「今天晚上」；后半夜弄的第二天说「昨天晚上」', () => {
        const sleepAt2 = { sleep: '02:00' } as Schedule;
        const evening = recentPhotography([work('2026-10-14T20:30:00', 100, '修昨天拍的片子')], new Date('2026-10-15T00:10:00+08:00'), 3, sleepAt2)!;
        assert.match(describeRecentPhotography(evening, new Date('2026-10-15T00:10:00+08:00'), sleepAt2), /上一回是今天晚上]$/);
        assert.match(describeRecentPhotography(evening, new Date('2026-10-15T00:10:00+08:00')), /上一回是昨天晚上]$/, '不给作息还是日历日');
        const late = recentPhotography([work('2026-10-14T23:50:00', 50, '把新相机拍的照片导出来修')], new Date('2026-10-15T10:00:00+08:00'), 3, sleepAt2)!;
        assert.match(describeRecentPhotography(late, new Date('2026-10-15T10:00:00+08:00'), sleepAt2), /上一回是昨天晚上]$/, '00:40 弄完的，第二天说昨天晚上');
    });
});
