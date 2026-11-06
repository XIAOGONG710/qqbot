import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { loadTierCard } from '../src/platform/contact.ts';
import { inCooldown, loadThreadsFrom, THREAD_COOLDOWN_DAYS, THREADS, threadStepsFor } from '../src/world/threads.ts';
import { worldAt } from '../src/world/world.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// ADR 0216：她那边的事有后续。她本人（11-02 ask-her）：拌嘴不过夜、淋雨第二天嗓子发紧、鸡毛蒜皮翻篇、别老丢
const pattern = syntheticCardPattern;
const FROM = '2026-11-03';
function worldOf(threadsFrom?: string) {
    const card = loadTierCard(pattern, 'boyfriend', { everydayLife: true, everydayFrom: FROM, worldDrama: true, ...(threadsFrom ? { threadsFrom } : {}) });
    return { world: card.character.herWorld!, schedule: card.character.schedule! };
}
const dayText = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** 每天结束时那天的事件 id（从 11-03 起 days 天） */
function daysOf(threadsFrom: string | undefined, days: number, start = new Date(2026, 10, 3)) {
    const { world, schedule } = worldOf(threadsFrom);
    return Array.from({ length: days }, (_, i) => {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const now = worldAt(world, schedule, new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 50));
        return { day: dayText(day), ids: now?.events.map(e => e.id) ?? [], events: now?.events ?? [] };
    });
}

describe('事有后续：表和掷骰', () => {
    test('昨天有表里的事才有后续；同一天的种子每次一样；一天最多一条；不认识的事没有后续', () => {
        const unit = (text: string) => (text.includes('rank') ? (text.includes('drama_row') ? 0.1 : 0.2) : 0.01);
        assert.deepEqual(threadStepsFor('2026-11-05', ['drama_row', 'drama_lost_thing', 'breakfast'], unit).map(s => s.id), ['thread_row_makeup']);
        assert.deepEqual(threadStepsFor('2026-11-05', ['breakfast', 'sunset'], unit), []);
        const miss = (text: string) => (text.includes('rank') ? 0.5 : 0.99);
        assert.deepEqual(threadStepsFor('2026-11-05', ['drama_row'], miss), [], '没落上就翻篇');
    });

    test('每一条后续都往收尾走（她本人：「别老弄些闹心的后续」）：感受只有松口气、累，没有难过 / 烦 / 担心', () => {
        for (const variants of Object.values(THREADS)) for (const step of variants) assert.ok(!step.feel || ['relief', 'tired', 'joy'].includes(step.feel.kind), step.id);
    });

    test('冷却期：来过的那几天里不再来；没写冷却的不管', () => {
        const history: Record<number, string[]> = { 3: ['drama_lost_thing'] };
        assert.equal(inCooldown('drama_lost_thing', k => history[k]), true);
        assert.equal(inCooldown('drama_lost_thing', () => undefined), false);
        assert.equal(inCooldown('drama_sunset', k => (k === 1 ? ['drama_sunset'] : undefined)), false);
        assert.equal(THREAD_COOLDOWN_DAYS.drama_lost_thing, 30, '「水卡那种别老丢」');
    });
});

describe('事有后续：接在世界里（真实的卡）', () => {
    const on = daysOf(FROM, 120);
    const off = daysOf(undefined, 120);

    test('每一条后续，前一天都真的发生了那件事；120 天里至少有几条', () => {
        const triggerOf = new Map(Object.entries(THREADS).flatMap(([trigger, variants]) => variants.map(v => [v.id, trigger] as const)));
        let n = 0;
        on.forEach((d, i) => {
            const follow = d.ids.filter(id => id.startsWith('thread_'));
            assert.ok(follow.length <= 1, `${d.day} 一天最多一条`);
            for (const id of follow) {
                n++;
                assert.ok(i > 0 && on[i - 1]!.ids.includes(triggerOf.get(id)!), `${d.day} ${id} 前一天没有 ${triggerOf.get(id)}`);
            }
        });
        assert.ok(n >= 3, `120 天只有 ${n} 条后续`);
    });

    test('冷却期在世界里生效：水卡丢了两次之间至少隔 30 天；没开时没有后续', () => {
        const lost = on.map((d, i) => (d.ids.includes('drama_lost_thing') ? i : -1)).filter(i => i >= 0);
        for (let k = 1; k < lost.length; k++) assert.ok(lost[k]! - lost[k - 1]! > 30, JSON.stringify(lost));
        assert.ok(off.every(d => d.ids.every(id => !id.startsWith('thread_'))));
    });

    test('已经过完的日子不改写：threadsFrom 之前的每一天，和没开时一模一样', () => {
        const later = daysOf('2026-11-20', 17);
        const plain = daysOf(undefined, 17);
        assert.deepEqual(later.map(d => d.ids), plain.map(d => d.ids));
    });

    test('同一天算两次一样（重启一致）', () => {
        assert.deepEqual(daysOf(FROM, 40).map(d => d.ids), on.slice(0, 40).map(d => d.ids));
    });
});

describe('事有后续：从哪天起', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    test('第一次开记下「明天」，以后都用这一天', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-threads-'));
        dirs.push(dir);
        const path = join(dir, 'threads-from.json');
        assert.equal(loadThreadsFrom(path, new Date(2026, 10, 3, 1, 0)), '2026-11-04');
        assert.equal(loadThreadsFrom(path, new Date(2026, 11, 25)), '2026-11-04');
        assert.match(readFileSync(path, 'utf8'), /"from":\s*"2026-11-04"/);
    });
});
