import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LifeEvent } from '../src/life-events.ts';
import { photographyProgress, projectActivity } from '../src/projects.ts';

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
