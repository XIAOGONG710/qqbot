import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { describeState, stateAt } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { describeWorld, occupationAt, worldAt } from '../src/world.ts';

const card = (tier: string) => loadCharacterCard(resolve(import.meta.dirname, `../../../characters/linmengyao/st/linmengyao-${tier}.json`));
const boyfriend = card('boyfriend');
const classmate = card('classmate');
const at = (text: string) => new Date(text);
const doing = (c: ReturnType<typeof card>, time: string) => occupationAt(worldAt(c.herWorld!, c.schedule!, at(time))!, at(time));

describe('此刻在做的事接上世界（ADR 0030）', () => {
    test('10-11 晚上：喂猫十分钟、和家里视频半小时、写完作业前一个半小时在赶，其余时间没有', () => {
        assert.equal(doing(boyfriend, '2026-10-11T18:58:00+08:00'), '在楼下喂土豆');
        assert.equal(doing(boyfriend, '2026-10-11T19:06:00+08:00'), undefined, '喂完十分钟后回到作息的空闲活动');
        assert.equal(doing(boyfriend, '2026-10-11T20:40:00+08:00'), '在和家里视频');
        assert.equal(doing(boyfriend, '2026-10-11T21:30:00+08:00'), '在赶Linux操作系统的作业，22:00 左右能写完');
        assert.equal(doing(boyfriend, '2026-10-11T22:10:00+08:00'), undefined, '写完了');
        assert.equal(doing(boyfriend, '2026-10-11T17:30:00+08:00'), undefined);
    });

    test('「你那边」里的视频：那半小时写「还在视频」，之后写「视频过了」', () => {
        const line = (time: string) => describeWorld(worldAt(boyfriend.herWorld!, boyfriend.schedule!, at(time))!, at(time))!;
        assert.match(line('2026-10-11T20:40:00+08:00'), /今晚 20:30 开始和家里视频，这会儿还在视频/);
        assert.match(line('2026-10-11T21:10:00+08:00'), /今晚 20:30 和家里视频过了/);
        assert.match(line('2026-10-11T20:00:00+08:00'), /今晚 20:30 要和家里视频/);
    });

    test('按这一档的卡：同学档看不到和家里视频、课名', () => {
        assert.equal(doing(classmate, '2026-10-11T20:40:00+08:00'), '在赶作业，22:00 左右能写完');
        assert.doesNotMatch(doing(classmate, '2026-10-11T21:30:00+08:00')!, /Linux/);
    });

    test('取了快递之后十五分钟在往回走', () => {
        const c = boyfriend;
        // 找 10 月里第一件当天取了的快递
        for (let d = 1; d <= 31; d++) {
            for (let m = 9 * 60; m < 23 * 60; m += 5) {
                const t = new Date(2026, 9, d, 0, m);
                const now = worldAt(c.herWorld!, c.schedule!, t);
                const picked = now?.parcels.find(p => p.status === 'picked_today');
                if (!picked) continue;
                assert.match(occupationAt(now!, picked.when)!, new RegExp(`刚去驿站取了快递（${picked.item}），在往回走`));
                return;
            }
        }
        assert.fail('10 月里没有取快递的日子');
    });

    test('状态行：空闲时被这件事替换；上课、睡觉不受影响', () => {
        const time = at('2026-10-11T20:40:00+08:00');
        const state = stateAt(boyfriend.schedule!, time);
        assert.equal(state.activity.kind, 'free');
        const busy = occupationAt(worldAt(boyfriend.herWorld!, boyfriend.schedule!, time)!, time)!;
        const line = describeState({ ...state, activity: { kind: 'free', text: busy } }, boyfriend.schedule!);
        assert.match(line, /在和家里视频/);
    });
});
