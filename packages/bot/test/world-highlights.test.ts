import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { worldHighlights } from '../src/world/highlights.ts';
import type { WorldNow } from '../src/world/world.ts';

const at = (hour: number, minute = 0) => new Date(2026, 10, 4, hour, minute);

function world(patch: Partial<WorldNow> = {}): WorldNow {
    return { day: '2026-11-04', atSchool: true, parcels: [], homework: [], events: [], ...patch };
}

describe('控制台的「今天发生」', () => {
    test('只取已经发生的事实，按时间倒序并限制条数', () => {
        const result = worldHighlights(world({
            cat: { name: '土豆', today: { fed: at(18, 20), seen: true }, yesterdayFed: true, foodDays: 4 },
            routine: { meals: [
                { kind: 'lunch', start: at(12), end: at(12, 30), where: 'canteen', dish: '番茄鸡蛋面' },
                { kind: 'dinner', start: at(19), end: at(19, 30), where: 'canteen', dish: '米饭' },
            ] },
            parcels: [{ item: '相机背带', status: 'picked_today', when: at(17, 40) }],
            homework: [{ course: '高数', due: at(23), done: true, doneAt: at(16) }],
            events: [
                { id: 'past', text: '苏雨桐请她喝了奶茶', at: at(15) },
                { id: 'future', text: '晚上才会发生', at: at(21) },
            ],
        }), at(18, 30), 3);

        assert.deepEqual(result.map(item => item.text), ['喂过土豆，也见到它了', '取了相机背带', '高数作业写完了']);
        assert.ok(result.every(item => Date.parse(item.at) <= at(18, 30).getTime()));
    });

    test('相同文字只显示一次；没有世界账、非法条数或只有未来事实时为空', () => {
        const duplicate = worldHighlights(world({ events: [
            { id: 'a', text: '买了瓶水', at: at(10) },
            { id: 'b', text: '买了瓶水', at: at(11) },
        ] }), at(12));
        assert.deepEqual(duplicate.map(item => item.text), ['买了瓶水']);
        assert.deepEqual(worldHighlights(undefined, at(12)), []);
        assert.deepEqual(worldHighlights(world(), at(12), 0), []);
        assert.deepEqual(worldHighlights(world({ events: [{ id: 'later', text: '还没发生', at: at(13) }] }), at(12)), []);
    });
});
