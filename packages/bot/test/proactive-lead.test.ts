import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import {
    candidatesOn, LEAD_NOTE, occasionNote, planFrom, withCatPhoto, withFoodShares, withInner, withReach, withSmallNews,
    type Candidate, type NewsItem, type ProactiveInput, type ProactiveRecord,
} from '../src/proactive/proactive.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// ADR 0133：主动发的话要有由头、有感觉、有话头；他没回的时候不再一条条报自己的小事
// （用户 10-23：「现在她主动发的信息很莫名其妙，没来由的突然发一个，感觉十分突兀」）
const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
let nextId = 1;
const user = (time: number, content = '在吗'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'user', content, messageId: nextId++ });
const her = (time: number, content = '早安'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'assistant', content, messageId: nextId++ });
const record = (id: string, at: number): ProactiveRecord => ({ id, occasion: id.split(':')[1] as ProactiveRecord['occasion'], plannedAt: new Date(at).toISOString(), at: new Date(at).toISOString(), result: 'sent' });
const settings = withFoodShares(withSmallNews(withCatPhoto(withInner(withReach(boyfriend.proactive!)))));
const day = new Date(2026, 10, 12);
const news = (kind: NewsItem['kind'], id: string, at: number): NewsItem => ({ id, kind, day: '2026-11-12', at, what: kind === 'food_photo' ? '午饭吃的兰州拉面' : '室友分了点零食，还挺好吃', ...(kind === 'food_photo' ? { dish: '兰州拉面' } : {}) });
const items = [news('small_thing', 'small:2026-11-12:ed_x', t(11, 12, 15, 0)), news('cat_photo', 'cat_photo:2026-11-12', t(11, 12, 15, 5)), news('food_photo', 'food_photo:2026-11-12:lunch', t(11, 12, 12, 20))];
const thoughts = [{ id: 'th-1', at: new Date(t(11, 12, 14, 0)).toISOString(), text: '室友今天分了零食', goes: 'tell' as const }, { id: 'th-2', at: new Date(t(11, 12, 14, 10)).toISOString(), text: '他今天去面试了不知道怎么样', goes: 'ask' as const }];
const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
    qq: 10001, schedule, settings, dates: [], history: [], records: [], mode: 'on', news: items, inner: thoughts, ...patch,
});
const kinds = (list: Candidate[]) => list.filter(c => c.occasion === 'news' || c.occasion === 'inner').map(c => (c.news ? c.news.kind : `inner-${c.inner!.goes}`));

describe('他一直没回：不再一条条报自己的小事', () => {
    test('她主动发的有一条他没回：小事 / 喂完土豆和吃饭拍的照片 / 心里惦记想告诉他的，都不排；想问他的还在', () => {
        const unanswered = { history: [user(t(11, 11, 22, 0)), her(t(11, 12, 10, 0), '早呀')], records: [record('2026-11-12:morning', t(11, 12, 10, 0))] };
        const plan = planFrom(t(11, 12, 10, 30), input(unanswered));
        const planned = kinds([...plan.upcoming, ...plan.yielded]);
        for (const light of ['small_thing', 'cat_photo', 'food_photo', 'inner-tell']) assert.ok(!planned.includes(light), `${light} 不该在他没回时排：${planned.join(',')}`);
        assert.ok(planned.includes('inner-ask'), '问他的还在');
    });

    test('他回了：照常排', () => {
        const answered = { history: [user(t(11, 12, 9, 0), '早'), her(t(11, 12, 9, 1), '早呀')], records: [] };
        const plan = planFrom(t(11, 12, 9, 30), input(answered));
        const planned = kinds(plan.upcoming);
        for (const light of ['small_thing', 'cat_photo', 'food_photo', 'inner-tell']) assert.ok(planned.includes(light), `${light}：${planned.join(',')}`);
    });
});

describe('说自己的事的几个时机共用“别写成汇报”', () => {
    const base = (patch: Partial<ProactiveInput> = {}) => candidatesOn(day, input({ history: [user(t(11, 12, 9, 0)), her(t(11, 12, 9, 1))], ...patch }));
    const note = (c: Candidate) => occasionNote(c, '宝宝');

    test('小事、土豆的照片、吃的照片、心里惦记（告诉他）都带 LEAD_NOTE；不再写“不要他回应”“像突然想起来”', () => {
        const list = base();
        for (const pick of [(c: Candidate) => c.news?.kind === 'small_thing', (c: Candidate) => c.news?.kind === 'cat_photo', (c: Candidate) => c.news?.kind === 'food_photo', (c: Candidate) => c.inner?.goes === 'tell']) {
            const c = list.find(pick);
            assert.ok(c, '有这个候选');
            const text = note(c!);
            assert.ok(text.includes(LEAD_NOTE), text);
            assert.ok(!/不要他回应|说完不用他回应|像突然想起来/.test(text), text);
        }
    });

    test('LEAD_NOTE 的内容：带自己的感觉、有由头、留话头、不问客套', () => {
        for (const phrase of ['别写成一句平平的汇报', '带上你自己的感觉', '给个由头', '接上面刚聊过的话头', '隔了几个小时的别翻出来', '先说你此刻的感觉再说事', '开头别老是同一种', '别照搬现成的套话', '留个能接的口子', '别问「在干嘛」「吃了吗」', '事实只能用上面写了的', '别添上面没写的小动作']) assert.ok(LEAD_NOTE.includes(phrase), phrase);
    });

    test('随口说件事 / 冷场也带；想问他的念头不带 LEAD_NOTE（它有自己的说法）', () => {
        const withShare = candidatesOn(new Date(2026, 10, 10), input({ history: [user(t(11, 9, 10, 0)), her(t(11, 9, 10, 1))], settings: { ...settings, occasions: [...settings.occasions, 'share', 'quiet'] } }));
        for (const occasion of ['share', 'quiet']) {
            const c = withShare.find(x => x.occasion === occasion);
            if (c) assert.ok(note(c).includes(LEAD_NOTE), occasion);
        }
        const ask = base().find(c => c.inner?.goes === 'ask')!;
        assert.ok(!note(ask).includes(LEAD_NOTE) && note(ask).includes('问得要让他看得懂你为什么问'));
    });
});

describe('催他：不借机汇报自己去了哪儿买了什么', () => {
    test('reach 的几种说法里没有“说你这会儿在做什么”', () => {
        const unanswered = { history: [user(t(11, 11, 22, 0)), her(t(11, 12, 10, 0), '早呀')], records: [record('2026-11-12:morning', t(11, 12, 10, 0))] };
        const reach = planFrom(t(11, 12, 12, 30), input(unanswered)).upcoming.find(c => c.occasion === 'reach');
        const texts = Array.from({ length: 24 }, (_, i) => occasionNote({ ...(reach ?? { id: '2026-11-12:reach:1', occasion: 'reach', day: '2026-11-12', at: 0, reason: 'x' }), id: `2026-11-12:reach:${i}`, reach: { count: i % 2 === 0 ? 1 : 2 } } as Candidate, '宝宝'));
        assert.ok(texts.every(text => !/说一句你这会儿在做什么/.test(text)));
        assert.ok(texts.some(text => /别报自己去了哪儿/.test(text)));
    });
});
