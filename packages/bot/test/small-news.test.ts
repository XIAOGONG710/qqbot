import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { loadTierCard } from '../src/contact.ts';
import { EVERYDAY_EVENT_DEFS } from '../src/everyday.ts';
import type { StoredMessage } from '../src/history.ts';
import {
    blockReason, candidatesOn, DEFAULT_NEWS_KINDS, newsKindsOf, occasionNote, untoldNews, withSmallNews,
    type Candidate, type NewsItem, type ProactiveInput,
} from '../src/proactive.ts';
import { SMALL_TELL_CHANCE, SMALL_TELL_GROUPS, worldAt, worldNews, type WorldNow } from '../src/world.ts';

// ADR 0127：她会主动讲今天碰到的一件小事（news 的新一类 small_thing，配置 smallNews，要 everydayLife）
const pattern = resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-{tier}.json');
const boyfriend = loadTierCard(pattern, 'boyfriend', { everydayLife: true }).character;
const schedule = boyfriend.schedule!;
const dayText = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** 那一天快结束时的世界快照 */
const endOf = (d: Date): WorldNow => worldAt(boyfriend.herWorld!, schedule, new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 30))!;
const groups = new Map(EVERYDAY_EVENT_DEFS.map(def => [def.id, def.group] as const));
const days = Array.from({ length: 120 }, (_, i) => new Date(2026, 10, 2 + i));

describe('世界账：今天碰到的一件小事', () => {
    const hits = days.flatMap(d => worldNews(endOf(d), ['small_thing']).map(n => ({ d, n, now: endOf(d) })));

    test('120 天里有一部分天有（有小事的天里约一半）；一天最多一件；同一天每次一样；默认没有这一类', () => {
        assert.ok(hits.length >= 120 * SMALL_TELL_CHANCE * 0.35 && hits.length <= 120 * SMALL_TELL_CHANCE * 1.1, `120 天里 ${hits.length} 天`);
        for (const d of days) assert.ok(worldNews(endOf(d), ['small_thing']).length <= 1);
        assert.deepEqual(worldNews(hits[0]!.now, ['small_thing']), worldNews(hits[0]!.now, ['small_thing']));
        assert.equal(worldNews(hits[0]!.now, DEFAULT_NEWS_KINDS).length, 0);
    });

    test('挑的是当天发生过的、能讲的那几组（食堂、宿舍、同学……），不是天气 / 身体 / 学习 / 家里；时间在发生后 10–40 分钟', () => {
        for (const { n, now } of hits) {
            const event = now.events.find(e => n.id === `small:${now.day}:${e.id}`);
            assert.ok(event, n.id);
            assert.ok(SMALL_TELL_GROUPS.has(groups.get(event!.id) ?? ''), `${event!.id} 属于 ${groups.get(event!.id)}`);
            assert.equal(n.what, event!.text);
            const minutes = (n.at.getTime() - event!.at.getTime()) / 60_000;
            assert.ok(minutes >= 10 && minutes <= 40, `${minutes}`);
        }
        for (const group of ['weather', 'body', 'study', 'family']) assert.ok(!SMALL_TELL_GROUPS.has(group), group);
    });

    test('没开 everydayLife 的卡：没有小事，也就没有这一类', () => {
        const plain = loadTierCard(pattern, 'boyfriend').character;
        const any = days.some(d => worldNews(worldAt(plain.herWorld!, plain.schedule!, new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 30))!, ['small_thing']).length > 0);
        assert.equal(any, false);
    });
});

describe('主动：随口讲一件小事', () => {
    const base = boyfriend.proactive!;
    const on = withSmallNews(base);

    test('withSmallNews：加上 news 时机和 small_thing 这一类，卡上原来的不动，重复加不叠', () => {
        assert.ok(on.occasions.includes('news'));
        assert.ok(newsKindsOf(on).includes('small_thing') && !newsKindsOf(base).includes('small_thing'));
        for (const kind of newsKindsOf(base)) assert.ok(newsKindsOf(on).includes(kind));
        assert.deepEqual(withSmallNews(on), on);
    });

    const item = (day: string): NewsItem => ({ id: `small:${day}:ed_food_x`, kind: 'small_thing', day, at: new Date(2026, 10, 17, 19, 30).getTime(), what: '食堂二楼开了个新窗口，试了一份，还不错' });
    const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({ qq: 10001, schedule, settings: on, dates: [], history: [], records: [], mode: 'on', news: [item('2026-11-17')], ...patch });
    const candidate = (): Candidate => candidatesOn(new Date(2026, 10, 17), input()).find(c => c.occasion === 'news' && c.news?.kind === 'small_thing')!;

    test('说明：就说这一件、随口、不要他回应、不铺开、不编细节、不借这件事问他', () => {
        const c = candidate();
        assert.ok(c, '有候选');
        const note = occasionNote(c, '宝宝');
        for (const phrase of ['就说这一件', '像突然想起来的', '不要他回应', '别铺开讲', '没写的细节不编', '不要借这件事去问他什么']) assert.ok(note.includes(phrase), phrase);
        assert.doesNotMatch(note, /「[^」]*[！!]」/, '不给台词');
    });

    test('那之后聊过了就不单发；没说成的不留到后面的主动里说（过了就过了）', () => {
        const c = candidate();
        const chatted: StoredMessage[] = [
            { time: new Date(2026, 10, 17, 19, 45).toISOString(), role: 'user', content: '在吗', messageId: 1 },
            { time: new Date(2026, 10, 17, 19, 46).toISOString(), role: 'assistant', content: '在呢', messageId: 2 },
        ];
        assert.equal(blockReason(c, new Date(2026, 10, 17, 20, 30).getTime(), input({ history: chatted })), '那之后聊过了');
        const morning = { id: '2026-11-17:bedtime', occasion: 'bedtime', day: '2026-11-17', at: new Date(2026, 10, 17, 23, 30).getTime(), reason: 'x' } as Candidate;
        assert.deepEqual(untoldNews(morning, morning.at, input()), [], '小事不顺带留到睡前');
    });
});
