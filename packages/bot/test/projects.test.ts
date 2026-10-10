import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LifeEvent } from '../src/life-events.ts';
import { describeRecentPhotography, photographyProgress, projectActivity, recentPhotography } from '../src/projects.ts';

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
            event('a', '2026-10-12T06:00:00.000Z', '2026-10-12T07:00:00.000Z'),
            event('b', '2026-10-12T08:00:00.000Z', '2026-10-12T08:30:00.000Z', 'interrupted'),
            event('c', '2026-10-12T09:00:00.000Z', '2026-10-12T09:00:00.000Z', 'failed'),
        ];
        assert.deepEqual(photographyProgress(events), {
            id: 'photography_growth', title: '摄影成长', sessions: 2, minutes: 90,
            lastAt: '2026-10-12T08:30:00.000Z', recentSteps: ['修昨天拍的片子'],
        });
        assert.deepEqual(photographyProgress(events), photographyProgress(events));
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
});
