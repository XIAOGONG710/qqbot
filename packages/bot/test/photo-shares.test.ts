import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/history.ts';
import {
    blockReason, candidatesOn, DEFAULT_NEWS_KINDS, newsKindsOf, occasionNote, untoldNews, withCatPhoto,
    type Candidate, type NewsItem, type ProactiveInput,
} from '../src/proactive.ts';
import { createProactivePlanner, type Planner } from '../src/proactive-planner.ts';
import type { InitiateOutcome, InitiateRequest } from '../src/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { CAT_PHOTO_CHANCE, worldNews, type WorldNow } from '../src/world.ts';

// ADR 0110：喂完土豆见到它的日子里，有的天她拍了张照片发给他（news 的新一类 cat_photo，配置 photoShares）
const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const dayText = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const worldOf = (d: Date, cat: WorldNow['cat']): WorldNow => ({ day: dayText(d), atSchool: true, parcels: [], homework: [], events: [], ...(cat ? { cat } : {}) } as WorldNow);
const fedSeen = (d: Date, seen: boolean | 'unknown' = true) => worldOf(d, { name: '土豆', today: { fed: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 20, 50), ...(seen === 'unknown' ? {} : { seen }) }, yesterdayFed: true, foodDays: 5 });

describe('世界账：喂完土豆拍的照片', () => {
    test('只在喂了、见到的日子里，约 CAT_PHOTO_CHANCE 的天有；时间在喂完之后 8–25 分钟；同一天每次一样', () => {
        const days = Array.from({ length: 200 }, (_, i) => new Date(2026, 9, 1 + i));
        const hits = days.flatMap(d => worldNews(fedSeen(d), ['cat_photo']).map(n => ({ d, n })));
        assert.ok(hits.length > 200 * CAT_PHOTO_CHANCE * 0.6 && hits.length < 200 * CAT_PHOTO_CHANCE * 1.4, `200 天里 ${hits.length} 天`);
        for (const { d, n } of hits) {
            assert.equal(n.kind, 'cat_photo');
            assert.equal(n.id, `cat_photo:${dayText(d)}`);
            assert.equal(n.what, '给土豆拍了张照片');
            const minutes = (n.at.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate(), 20, 50).getTime()) / 60_000;
            assert.ok(minutes >= 8 && minutes <= 25, `${minutes}`);
        }
        assert.deepEqual(worldNews(fedSeen(hits[0]!.d), ['cat_photo']), worldNews(fedSeen(hits[0]!.d), ['cat_photo']));
    });

    test('没见到它 / 没喂 / 还没去 / 不去 / 没有猫：没有；没开这一类也没有', () => {
        const d = new Date(2026, 9, 8);
        const hitDay = (days: Date[]) => days.find(x => worldNews(fedSeen(x), ['cat_photo']).length > 0)!;
        const day = hitDay(Array.from({ length: 60 }, (_, i) => new Date(2026, 9, 1 + i)));
        assert.equal(worldNews(fedSeen(day, false), ['cat_photo']).length, 0, '没见到');
        assert.equal(worldNews(fedSeen(day, 'unknown'), ['cat_photo']).length, 0, '见没见到没记');
        assert.equal(worldNews(worldOf(day, { name: '土豆', today: { later: '20:30' }, yesterdayFed: true, foodDays: 5 }), ['cat_photo']).length, 0, '还没去');
        assert.equal(worldNews(worldOf(day, { name: '土豆', today: { skipped: 'rain' }, yesterdayFed: true, foodDays: 5 }), ['cat_photo']).length, 0, '下雨不去');
        assert.equal(worldNews(worldOf(day, undefined), ['cat_photo']).length, 0, '没有猫');
        assert.equal(worldNews(fedSeen(day), DEFAULT_NEWS_KINDS).length, 0, '默认只有相机');
        assert.ok(d);
    });
});

describe('主动：喂完土豆拍的照片', () => {
    test('withCatPhoto：加上 news 时机和 cat_photo 这一类，卡上原来的不动', () => {
        const base = boyfriend.proactive!;
        const on = withCatPhoto(base);
        assert.ok(on.occasions.includes('news'));
        assert.ok(newsKindsOf(on).includes('cat_photo'));
        for (const kind of newsKindsOf(base)) assert.ok(newsKindsOf(on).includes(kind));
        assert.ok(!newsKindsOf(base).includes('cat_photo'));
        assert.deepEqual(withCatPhoto(on), on, '重复加不叠');
    });

    const item = (day: string): NewsItem => ({ id: `cat_photo:${day}`, kind: 'cat_photo', day, at: t(10, 24, 21, 5), what: '给土豆拍了张照片' });
    const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
        qq: 10001, schedule, settings: withCatPhoto(boyfriend.proactive!), dates: [], history: [], records: [], mode: 'on', news: [item('2026-10-24')], ...patch,
    });
    const candidate = (): Candidate => candidatesOn(new Date(2026, 9, 24), input()).find(c => c.occasion === 'news' && c.news?.kind === 'cat_photo')!;

    test('说明：喂了、拍了照，另起一行单独发照片，那句话有由头和自己的感觉；货架里没有 / 这会儿不该发照片就不发；那之后聊过也不发', () => {
        const c = candidate();
        assert.ok(c, '有候选');
        const note = occasionNote(c, '宝宝');
        assert.ok(note.includes('拍了它一张照片') && note.includes('另起一行单独发照片') && note.includes('别写成一句平平的汇报') && !note.includes('不要他回应'), note);
        assert.equal(blockReason(c, c.at, input({ photoReady: () => true })), undefined);
        assert.match(blockReason(c, c.at, input())!, /货架里没有土豆的照片/, '没给 photoReady = 不发');
        assert.match(blockReason(c, c.at, input({ photoReady: () => false }))!, /货架里没有土豆的照片/);
        const chatted: StoredMessage[] = [{ time: new Date(t(10, 24, 21, 6)).toISOString(), role: 'user', content: '在吗' }, { time: new Date(t(10, 24, 21, 7)).toISOString(), role: 'assistant', content: '在' }];
        assert.ok(blockReason(c, t(10, 24, 22, 30), input({ photoReady: () => true, history: chatted })), '那之后聊过了');
    });

    test('“没说成的事”不会把这一类带进别的主动里（说了“拍了照片”却没有照片会穿帮）', () => {
        const c: Candidate = { id: '2026-10-24:bedtime', occasion: 'bedtime', day: '2026-10-24', at: t(10, 24, 23, 30), reason: 'x' };
        assert.deepEqual(untoldNews(c, t(10, 24, 23, 30), { news: [item('2026-10-24')], records: [], history: [] }), []);
    });

    const dirs: string[] = [];
    let planner: Planner | undefined;
    afterEach(() => { planner?.stop(); planner = undefined; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    test('计划器：发这一条时 initiate 带 photo: cat', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-share-'));
        dirs.push(dir);
        const clock = new VirtualClock(new Date(t(10, 24, 20, 30)));
        const requests: InitiateRequest[] = [];
        const history = [
            { time: new Date(t(10, 24, 14, 0)).toISOString(), role: 'user' as const, content: '我先去忙了' },
            { time: new Date(t(10, 24, 14, 1)).toISOString(), role: 'assistant' as const, content: '好，晚点聊' },
        ];
        planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings: { occasions: ['news'], newsKinds: ['cat_photo'], dailyMax: 3, unansweredMax: 2 }, dates: [], mode: 'dryRun',
            history: { load: () => history },
            responder: {
                initiate: async (request: InitiateRequest): Promise<InitiateOutcome> => {
                    requests.push(request);
                    request.commit(['喂完土豆啦']);
                    return { result: 'dryRun', parts: ['喂完土豆啦'] };
                },
            },
            dir, log: () => {}, now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '林梦瑶' },
            news: () => [item('2026-10-24')],
            photoReady: () => true,
        });
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 30));
            const next = clock.nextTimer();
            if (next === undefined || next > t(10, 24, 22, 0)) break;
            clock.advanceTo(next);
        }
        await new Promise(r => setTimeout(r, 30));
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.photo, 'cat');
        assert.ok(requests[0]!.note.includes('拍了它一张照片'));
    });
});
