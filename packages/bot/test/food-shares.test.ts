import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { loadTierCard } from '../src/contact.ts';
import { dishOn } from '../src/menu.ts';
import {
    blockReason, candidatesOn, DEFAULT_NEWS_KINDS, newsKindsOf, occasionNote, untoldNews, withFoodShares,
    type Candidate, type NewsItem, type ProactiveInput,
} from '../src/proactive.ts';
import { FOOD_PHOTO_CHANCE, lastMealDish, worldAt, worldNews, type WorldNow } from '../src/world.ts';

// ADR 0128：吃饭时拍了张照片发给他（news 的新一类 food_photo，配置 foodPhotos，要 menu 和 photos）
const pattern = resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-{tier}.json');
const boyfriend = loadTierCard(pattern, 'boyfriend', { menu: true }).character;
const schedule = boyfriend.schedule!;
const endOf = (d: Date): WorldNow => worldAt(boyfriend.herWorld!, schedule, new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 30))!;
const days = Array.from({ length: 150 }, (_, i) => new Date(2026, 10, 2 + i));

describe('世界账：吃饭时拍的照片', () => {
    const hits = days.flatMap(d => worldNews(endOf(d), ['food_photo']).map(n => ({ d, n, now: endOf(d) })));

    test('约 FOOD_PHOTO_CHANCE 的顿数有；菜名就是账上那一顿的菜；时间在饭点开始后 6–18 分钟；同一天每次一样；默认没有', () => {
        const meals = days.reduce((n, d) => n + (endOf(d).routine?.meals.length ?? 0), 0);
        assert.ok(hits.length > meals * FOOD_PHOTO_CHANCE * 0.6 && hits.length < meals * FOOD_PHOTO_CHANCE * 1.4, `${meals} 顿里 ${hits.length} 顿`);
        for (const { n, now } of hits) {
            const meal = now.routine!.meals.find(m => n.id === `food_photo:${now.day}:${m.kind}`)!;
            assert.ok(meal, n.id);
            assert.equal(n.dish, meal.dish);
            assert.equal(n.dish, dishOn(now.day, meal.kind));
            assert.equal(n.what, `${meal.kind === 'lunch' ? '午饭' : '晚饭'}吃的${meal.dish}`);
            const minutes = (n.at.getTime() - meal.start.getTime()) / 60_000;
            assert.ok(minutes >= 6 && minutes <= 18, `${minutes}`);
        }
        assert.deepEqual(worldNews(hits[0]!.now, ['food_photo']), worldNews(hits[0]!.now, ['food_photo']));
        assert.equal(worldNews(hits[0]!.now, DEFAULT_NEWS_KINDS).length, 0);
    });

    test('没开 menu 的卡没有菜名，也就没有这一类', () => {
        const plain = loadTierCard(pattern, 'boyfriend').character;
        const any = days.slice(0, 40).some(d => worldNews(worldAt(plain.herWorld!, plain.schedule!, new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 30))!, ['food_photo']).length > 0);
        assert.equal(any, false);
    });

    test('lastMealDish：到了饭点的最后一顿；还没吃过就没有', () => {
        const day = new Date(2026, 10, 10);
        const now = endOf(day);
        const at = (h: number, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        assert.equal(lastMealDish(now, at(8)), undefined);
        assert.deepEqual(lastMealDish(now, at(15)), { kind: 'lunch', dish: dishOn('2026-11-10', 'lunch')! });
        assert.deepEqual(lastMealDish(now, at(19)), { kind: 'dinner', dish: dishOn('2026-11-10', 'dinner')! });
    });
});

describe('主动：吃饭时拍的照片', () => {
    const base = boyfriend.proactive!;
    const on = withFoodShares(base);

    test('withFoodShares：加上 news 时机和 food_photo 这一类，卡上原来的不动，重复加不叠', () => {
        assert.ok(on.occasions.includes('news'));
        assert.ok(newsKindsOf(on).includes('food_photo') && !newsKindsOf(base).includes('food_photo'));
        for (const kind of newsKindsOf(base)) assert.ok(newsKindsOf(on).includes(kind));
        assert.deepEqual(withFoodShares(on), on);
    });

    const item = (day: string): NewsItem => ({ id: `food_photo:${day}:lunch`, kind: 'food_photo', day, at: new Date(2026, 10, 17, 12, 20).getTime(), what: '午饭吃的兰州拉面', dish: '兰州拉面' });
    const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({ qq: 10001, schedule, settings: on, dates: [], history: [], records: [], mode: 'on', news: [item('2026-11-17')], ...patch });
    const candidate = (): Candidate => candidatesOn(new Date(2026, 10, 17), input()).find(c => c.occasion === 'news' && c.news?.kind === 'food_photo')!;

    test('说明：说是哪一顿、吃的什么，另起一行单独发照片，不要他回应，不问他想不想看', () => {
        const c = candidate();
        assert.ok(c, '有候选');
        assert.equal(c.news?.dish, '兰州拉面');
        const note = occasionNote(c, '宝宝');
        for (const phrase of ['午饭吃的兰州拉面', '拍了张照片', '另起一行单独发照片', '不要他回应', '别问他想不想看', '没写的细节不编']) assert.ok(note.includes(phrase), phrase);
        assert.doesNotMatch(note, /「[^」]*[！!]」/, '不给台词');
    });

    test('货架里没有这道菜的照片 / 这会儿不该发就不发（并问的是这道菜）；那之后聊过了不发；没说成的不留到后面', () => {
        const c = candidate();
        const asked: Array<[string, string | undefined]> = [];
        const ready = (answer: boolean) => (kind: 'cat' | 'food', _now: number, dish?: string) => { asked.push([kind, dish]); return answer; };
        const when = new Date(2026, 10, 17, 12, 40).getTime();
        assert.equal(blockReason(c, when, input({ photoReady: ready(false) })), '货架里没有这顿饭的照片，或者这会儿不该发照片');
        assert.deepEqual(asked.at(-1), ['food', '兰州拉面']);
        assert.equal(blockReason(c, when, input({ photoReady: ready(true) })), undefined);
        assert.equal(blockReason(c, when, input()), '货架里没有这顿饭的照片，或者这会儿不该发照片', '没给 photoReady = 没有货架');
        const chatted = [
            { time: new Date(2026, 10, 17, 12, 30).toISOString(), role: 'user' as const, content: '在吗', messageId: 1 },
            { time: new Date(2026, 10, 17, 12, 31).toISOString(), role: 'assistant' as const, content: '在呢', messageId: 2 },
        ];
        assert.equal(blockReason(c, new Date(2026, 10, 17, 13, 30).getTime(), input({ photoReady: ready(true), history: chatted })), '那之后聊过了');
        const bedtime = { id: '2026-11-17:bedtime', occasion: 'bedtime', day: '2026-11-17', at: new Date(2026, 10, 17, 23, 30).getTime(), reason: 'x' } as Candidate;
        assert.deepEqual(untoldNews(bedtime, bedtime.at, input()), []);
    });
});
