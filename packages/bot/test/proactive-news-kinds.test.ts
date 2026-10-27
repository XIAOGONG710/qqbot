import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { bodyAt, type Body } from '../src/body.ts';
import type { StoredMessage } from '../src/history.ts';
import {
    blockReason, candidateLabel, candidatesOn, newsKindsOf, NEWS_KINDS, occasionNote, parseProactive, planFrom, unansweredCount, untoldNews, usedOn,
    type NewsItem, type ProactiveInput, type ProactiveRecord,
} from '../src/proactive.ts';
import { newsFrom } from '../src/proactive-planner.ts';
import { wakeOn } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { unwellNews, worldNews, type FriendDate, type WorldNow } from '../src/world/world.ts';

// ADR 0064：她账里的事成为开口的理由（事件类：买到相机、24 小时内到期的作业写完了、一段不舒服的第一天）
const cardPath = (tier: string) => resolve(import.meta.dirname, `../../../characters/linmengyao/st/linmengyao-${tier}.json`);
const boyfriend = loadCharacterCard(cardPath('boyfriend'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0, year = 2026) => new Date(year, month - 1, day, h, m).getTime();
const day = (month: number, d: number, year = 2026) => new Date(year, month - 1, d);
let nextId = 1;
const user = (time: number, content = '在吗'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'user', content, messageId: nextId++ });
const her = (time: number, content = '嗯'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'assistant', content, messageId: nextId++ });
const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
    qq: 10001, schedule, settings: { ...boyfriend.proactive!, occasions: boyfriend.proactive!.occasions.filter(o => o !== 'share'), dailyMax: 2 }, dates: boyfriend.dates, history: [], records: [], mode: 'on', ...patch,
});
const record = (id: string, at: number, result: ProactiveRecord['result'] = 'sent', extra: Partial<ProactiveRecord> = {}): ProactiveRecord => ({
    id, occasion: id.split(':')[1] as ProactiveRecord['occasion'], plannedAt: new Date(at).toISOString(), at: new Date(at).toISOString(), result, ...extra,
});

const homework = (course: string, doneAt: number, due: number, done = true) => ({ course, due: new Date(due), done, doneAt: new Date(doneAt) });
const snapshot = (hw: WorldNow['homework'] = []): WorldNow => ({ day: '2026-10-14', atSchool: true, parcels: [], events: [], homework: hw });

describe('事件类：作业写完了（ADR 0064 决策 3）', () => {
    test('24 小时内到期、已经写完的：了结的时刻是写完的时刻，id 按她写完的那一天，课名跟着看得到的档位', () => {
        const done = t(10, 14, 22);
        const [item, ...rest] = worldNews(snapshot([homework('数据结构', done, t(10, 15, 8))]), ['homework_done']);
        assert.equal(rest.length, 0);
        assert.deepEqual(item, { id: 'homework:2026-10-14', kind: 'homework_done', at: new Date(done), what: '把数据结构的作业写完了' });
        // 看不到课名的档位（WorldNow 里 course 是空的）不写课名
        assert.equal(worldNews(snapshot([homework('', done, t(10, 15, 8))]), ['homework_done'])[0]!.what, '把作业写完了');
    });

    test('早早写完的（离交还远）、还没写完的不算；刚好 24 小时算，多一毫秒不算', () => {
        const kinds = ['homework_done'] as const;
        assert.deepEqual(worldNews(snapshot([homework('数据结构', t(10, 11, 21, 30), t(10, 18, 8))]), kinds), [], '早早写完');
        assert.deepEqual(worldNews(snapshot([homework('数据结构', t(10, 14, 22), t(10, 15, 8), false)]), kinds), [], '还没写完');
        assert.equal(worldNews(snapshot([homework('数据结构', t(10, 14, 8), t(10, 15, 8))]), kinds).length, 1, '刚好 24 小时');
        assert.equal(worldNews(snapshot([homework('数据结构', t(10, 14, 8) - 1, t(10, 15, 8))]), kinds).length, 0, '多一毫秒');
    });

    test('同一天写完的几份并成一件', () => {
        const kinds = ['homework_done'] as const;
        const two = worldNews(snapshot([homework('数据结构', t(10, 14, 21), t(10, 15, 8)), homework('MySQL数据库应用', t(10, 14, 22), t(10, 15, 10))]), kinds);
        assert.equal(two.length, 1);
        assert.equal(two[0]!.what, '把数据结构、MySQL数据库应用的作业写完了');
        assert.equal(two[0]!.at.getTime(), t(10, 14, 22), '取最晚的那份');
        assert.equal(worldNews(snapshot([homework('', t(10, 14, 21), t(10, 15, 8)), homework('', t(10, 14, 22), t(10, 15, 10))]), kinds)[0]!.what, '把 2 份作业都写完了');
        const nextDay = worldNews(snapshot([homework('数据结构', t(10, 14, 22), t(10, 15, 8)), homework('英语', t(10, 15, 22), t(10, 16, 8))]), kinds);
        assert.deepEqual(nextDay.map(n => n.id), ['homework:2026-10-14', 'homework:2026-10-15'], '不同的天各一件');
    });

    test('卡上没开这一类（不传 kinds）时和 ADR 0057 一样只有相机', () => {
        const now = snapshot([homework('数据结构', t(10, 14, 22), t(10, 15, 8))]);
        assert.deepEqual(worldNews(now), []);
        assert.deepEqual(worldNews(now, []), []);
        assert.equal(worldNews(now, ['camera', 'homework_done']).length, 1);
    });
});

describe('事件类：一段不舒服的第一天（ADR 0064 决策 3 + 确认记录 1）', () => {
    const period = (detail: boolean): Body => ({ period: { first: '2026-10-13', cycle: [28, 28], days: 5, crampsChance: 1, detail } });
    const news = (body: Body, d: Date) => unwellNews(d, schedule, time => bodyAt(body, schedule, time));

    test('痛经头一天说一次：了结的时刻是起床；第二天（还在疼）、之前一天、不疼的日子都没有', () => {
        const [item, ...rest] = news(period(true), day(10, 13));
        assert.equal(rest.length, 0);
        assert.deepEqual(item, { id: 'unwell:2026-10-13', kind: 'unwell', at: wakeOn(schedule, day(10, 13)), what: '肚子疼得厉害（生理期）' });
        assert.deepEqual(news(period(true), day(10, 14)), [], '第二天还疼，不再主动说');
        assert.deepEqual(news(period(true), day(10, 12)), [], '之前一天不是生理期');
        assert.deepEqual(news(period(true), day(10, 16)), [], '生理期的第四天不疼');
        assert.deepEqual(news({ period: { ...period(true).period!, crampsChance: 0 } }, day(10, 13)), [], '这个周期不痛经');
    });

    test('说得出口的程度跟着档位：生理期细节只给 detail 的', () => {
        assert.equal(news(period(false), day(10, 13))[0]!.what, '身上不太舒服，只想躺着');
        assert.doesNotMatch(news(period(false), day(10, 13))[0]!.what, /生理期|肚子/);
    });

    test('感冒：头一天说一次，之后几天不说', () => {
        const body: Body = { cold: { perMonth: 6, days: 3 } };
        let first: Date | undefined;
        for (let n = 0; n < 200 && !first; n++) {
            const d = day(10, 1 + n);
            if (news(body, d).length) first = d;
        }
        assert.ok(first, '200 天里总有一次');
        assert.equal(news(body, first!)[0]!.what, '有点感冒，嗓子疼');
        assert.deepEqual(news(body, new Date(first!.getFullYear(), first!.getMonth(), first!.getDate() + 1)), []);
        assert.deepEqual(news(body, new Date(first!.getFullYear(), first!.getMonth(), first!.getDate() - 1)), []);
    });

    test('同样的输入同样的输出（重启一致）', () => {
        assert.deepEqual(news(period(true), day(10, 13)), news(period(true), day(10, 13)));
    });
});

describe('newsFrom：把世界和身体变成排候选用的事（ADR 0064）', () => {
    const done = t(10, 14, 22);
    const withHomework = snapshot([homework('数据结构', done, t(10, 15, 8))]);
    /** 她今天（10-14）最后一刻的快照里有作业写完了；别的时候没有（交作业的课一过，作业就不在世界快照里了） */
    const worldAt = (asked: Date[] = []) => (time: Date): WorldNow | undefined => {
        asked.push(time);
        return time.getDate() === 14 && time.getHours() === 23 ? withHomework : snapshot();
    };

    test('看她今天、明天的最后一刻，再加明天这一刻；开了的类才有', () => {
        const asked: Date[] = [];
        const items = newsFrom(worldAt(asked), schedule, { kinds: ['camera', 'homework_done'] })(t(10, 14, 15));
        assert.deepEqual(items, [{ id: 'homework:2026-10-14', kind: 'homework_done', day: '2026-10-14', at: done, what: '把数据结构的作业写完了' }]);
        assert.deepEqual(asked.map(d => `${d.getDate()} ${d.getHours()}:${d.getMinutes()}`), ['14 23:59', '15 23:59', '15 15:0']);
    });

    test('没开作业这一类（默认只有相机）就没有；离今天、明天远的日子没有', () => {
        assert.deepEqual(newsFrom(worldAt(), schedule)(t(10, 14, 15)), []);
        assert.deepEqual(newsFrom(worldAt(), schedule, { kinds: ['homework_done'] })(t(10, 11, 15)), [], '三天以后的事现在不排');
    });

    test('不舒服：要开这一类、又给了身体才有', () => {
        const body: Body = { period: { first: '2026-10-14', cycle: [28, 28], days: 5, crampsChance: 1, detail: true } };
        const bodyOf = (time: Date) => bodyAt(body, schedule, time);
        const items = newsFrom(worldAt(), schedule, { kinds: ['unwell'], bodyAt: bodyOf })(t(10, 14, 7));
        assert.deepEqual(items.map(n => [n.id, n.kind, n.day]), [['unwell:2026-10-14', 'unwell', '2026-10-14']]);
        assert.deepEqual(newsFrom(worldAt(), schedule, { kinds: ['unwell'] })(t(10, 14, 7)), [], '没给身体');
        assert.deepEqual(newsFrom(worldAt(), schedule, { kinds: ['camera'], bodyAt: bodyOf })(t(10, 14, 7)), [], '没开这一类');
        // 晚上过了零点、她的这一天还没结束：还是 10-14 的事，不是 10-15 的
        assert.deepEqual(newsFrom(worldAt(), schedule, { kinds: ['unwell'], bodyAt: bodyOf })(t(10, 15, 0, 30)).map(n => n.id), ['unwell:2026-10-14']);
    });

    test('同一件事在几个快照里都看得到时只算一件，以先看到的为准', () => {
        const trip = { start: new Date(t(10, 14, 14)), end: new Date(t(10, 14, 16, 30)), where: '科技市场', what: '相机', price: 1, state: 'planned' as const };
        const both = (): WorldNow => ({ ...withHomework, cameraFund: { saved: 0, goal: 0, camera: trip } });
        const items = newsFrom(() => both(), schedule, { kinds: ['camera', 'homework_done'] })(t(10, 14, 15));
        assert.deepEqual(items.map(n => n.id).sort(), ['camera', 'homework:2026-10-14']);
    });
});

describe('事件类：闺蜜的约变了（ADR 0061 第 2 步，friend_changed）', () => {
    const date = (patch: Partial<FriendDate> = {}): FriendDate => ({
        id: '2026-12-04:su_yutong:canteen', kind: 'canteen', person: { id: 'su_yutong', name: '苏雨桐', relation: '同专业的朋友' }, what: '下课一起去食堂吃饭', doing: '在食堂和苏雨桐吃饭',
        askedAt: new Date(t(12, 4, 9, 53)), start: new Date(t(12, 4, 12, 2)), minutes: 45, outcome: 'cancelled', knownAt: new Date(t(12, 4, 10, 32)),
        reason: '临时被老师叫去帮忙', held: false, ...patch,
    });
    const snap = (...dates: FriendDate[]): WorldNow => ({ ...snapshot(), day: '2026-12-04', dates });
    const newsOf = (candidates: ReturnType<typeof candidatesOn>) => candidates.filter(c => c.occasion === 'news');

    test('临时去不了了：了结的时刻 = 她得知的时刻，id 带约的 id，原因按档位裁过的写上', () => {
        assert.deepEqual(worldNews(snap(date()), ['friend_changed']), [{
            id: 'friend:2026-12-04:su_yutong:canteen', kind: 'friend_changed', at: new Date(t(12, 4, 10, 32)),
            what: '苏雨桐约好 12:02 下课一起去食堂吃饭，她临时去不了了（临时被老师叫去帮忙）',
        }]);
        // 没有原因（私事、这一档说不出口）就不写原因，不编
        assert.equal(worldNews(snap(date({ reason: undefined })), ['friend_changed'])[0]!.what, '苏雨桐约好 12:02 下课一起去食堂吃饭，她临时去不了了');
    });

    test('改到很晚（至少一小时）算；只晚一会儿、迟到、她自己推掉的、还没得知的、不是今天的不算；没开这一类就没有', () => {
        const moved = (minutes: number) => date({ outcome: 'moved', actualStart: new Date(t(12, 4, 12, 2) + minutes * 60_000), held: true, reason: undefined });
        assert.equal(worldNews(snap(moved(90)), ['friend_changed'])[0]!.what, '苏雨桐约好 12:02 下课一起去食堂吃饭，她说改到 13:32');
        assert.deepEqual(worldNews(snap(moved(30)), ['friend_changed']), []);
        assert.deepEqual(worldNews(snap(date({ outcome: 'late', actualStart: new Date(t(12, 4, 12, 10)), held: true })), ['friend_changed']), []);
        assert.deepEqual(worldNews(snap(date({ declined: '作业还没写完', declinedAt: new Date(t(12, 4, 9, 53)) })), ['friend_changed']), []);
        const { knownAt: _known, ...unknown } = date();
        assert.deepEqual(worldNews(snap(unknown as FriendDate), ['friend_changed']), []);
        assert.deepEqual(worldNews({ ...snap(date()), day: '2026-12-05' }, ['friend_changed']), []);
        assert.deepEqual(worldNews(snap(date())), [], '不传 kinds = 只有相机');
        assert.deepEqual(worldNews(snap(date()), ['camera', 'homework_done']), []);
    });

    test('说明：只说这一件、不要他回应或安慰、不编没写的原因；排在别的类后面', () => {
        const item: NewsItem = { id: 'friend:x', kind: 'friend_changed', day: '2026-12-04', at: t(12, 4, 10, 32), what: '苏雨桐约好 12:02 下课一起去食堂吃饭，她临时去不了了（临时被老师叫去帮忙）' };
        const text = occasionNote(newsOf(candidatesOn(day(12, 4), input({ news: [item] })))[0]!, '宝宝');
        assert.match(text, /你刚得知苏雨桐约好 12:02 下课一起去食堂吃饭，她临时去不了了（临时被老师叫去帮忙），想跟宝宝说一声/);
        assert.match(text, /不要他回应或安慰你/);
        assert.match(text, /没写的原因和细节不编/);
        assert.match(text, /不抱怨对方没找你、没回你/);
        assert.doesNotMatch(text, /「[^」]*[！!]」/, '不给台词');
        assert.ok(NEWS_KINDS.indexOf('friend_changed') > NEWS_KINDS.indexOf('unwell'), '优先级最低');
    });
});

describe('事件类：闺蜜病了的头一天（friend_sick）', () => {
    const people = (day: number, of = 3): WorldNow['people'] => [{ name: '苏雨桐', relation: '大学同专业，济南人，不是室友', states: [{ kind: 'sick', day, of }] }];
    const snap = (day: number): WorldNow => ({ ...snapshot(), day: '2026-12-04', people: people(day) });

    test('头一天才有：上午 9:00–11:30 她得知，同一天同一个人每次一样；第二天起不再单发', () => {
        const [item, ...rest] = worldNews(snap(1), ['friend_sick']);
        assert.equal(rest.length, 0);
        assert.equal(item!.id, 'friend_sick:苏雨桐:2026-12-04');
        assert.equal(item!.kind, 'friend_sick');
        assert.equal(item!.what, '苏雨桐感冒了');
        assert.ok(item!.at.getTime() >= t(12, 4, 9) && item!.at.getTime() <= t(12, 4, 11, 30), item!.at.toString());
        assert.equal(worldNews(snap(1), ['friend_sick'])[0]!.at.getTime(), item!.at.getTime());
        assert.deepEqual(worldNews(snap(2), ['friend_sick']), []);
        assert.deepEqual(worldNews(snap(3), ['friend_sick']), []);
    });

    test('忙、回家不算；没开这一类就没有；看不到这个人（没有 people）就没有', () => {
        const busy: WorldNow = { ...snapshot(), day: '2026-12-04', people: [{ name: '陈佳宁', relation: '高中同班，死党', states: [{ kind: 'busy', day: 1, of: 2, label: '有考试' }, { kind: 'home' }] }] };
        assert.deepEqual(worldNews(busy, ['friend_sick']), []);
        assert.deepEqual(worldNews(snap(1)), [], '不传 kinds = 只有相机');
        assert.deepEqual(worldNews(snap(1), ['camera', 'homework_done', 'unwell', 'friend_changed']), []);
        assert.deepEqual(worldNews({ ...snapshot(), day: '2026-12-04' }, ['friend_sick']), []);
    });

    test('说明：只说这一件、不要他回应或安慰、病情和做了什么没写的不编；排在最后', () => {
        const item: NewsItem = { id: 'friend_sick:苏雨桐:2026-12-04', kind: 'friend_sick', day: '2026-12-04', at: t(12, 4, 10, 10), what: '苏雨桐感冒了' };
        const text = occasionNote(candidatesOn(day(12, 4), input({ news: [item] })).filter(c => c.occasion === 'news')[0]!, '宝宝');
        assert.match(text, /你刚得知苏雨桐感冒了，想跟宝宝说一声/);
        assert.match(text, /不要他回应或安慰你/);
        assert.match(text, /那一行里没写的不编/);
        assert.doesNotMatch(text, /「[^」]*[！!]」/, '不给台词');
        assert.equal(NEWS_KINDS.at(-1), 'food_photo', '新加的一类（ADR 0128）排在最后；small_thing（ADR 0127）、cat_photo（ADR 0110）在它前面');
        assert.equal(NEWS_KINDS.at(-2), 'small_thing');
        assert.equal(NEWS_KINDS.at(-3), 'cat_photo');
        assert.equal(NEWS_KINDS.at(-4), 'friend_sick');
    });
});

describe('主动消息里的事件类：优先级、说明、日志（ADR 0064 决策 4、5、7）', () => {
    const item = (kind: NewsItem['kind'], id: string, at: number, what: string): NewsItem => ({ id, kind, day: '2026-10-14', at, what });
    const camera = item('camera', 'camera', t(10, 14, 16, 30), '在山大路科技市场买到了二手相机');
    const hw = item('homework_done', 'homework:2026-10-14', t(10, 14, 22), '把数据结构的作业写完了');
    const sick = item('unwell', 'unwell:2026-10-14', t(10, 14, 7, 40), '肚子疼得厉害（生理期）');
    const newsOf = (candidates: ReturnType<typeof candidatesOn>) => candidates.filter(c => c.occasion === 'news');

    test('一件一条，id 带事情的 id；日志的说法带事件类和 id', () => {
        const list = newsOf(candidatesOn(day(10, 14), input({ news: [camera, hw, sick] })));
        assert.deepEqual(list.map(c => c.id).sort(), ['2026-10-14:news:camera', '2026-10-14:news:homework:2026-10-14', '2026-10-14:news:unwell:2026-10-14']);
        const label = candidateLabel(list.find(c => c.news?.kind === 'homework_done')!);
        assert.match(label, /^她那边的事\[homework_done homework:2026-10-14\]（把数据结构的作业写完了）$/);
    });

    test('一天只剩一条时：相机 > 作业写完 > 不舒服；排不上的让给优先的，之后走「顺带说」', () => {
        const spent = [record('2026-10-14:morning', t(10, 14, 9))];
        const history = [user(t(10, 14, 9, 5)), her(t(10, 14, 9, 6))];
        const pick = (news: NewsItem[]) => planFrom(t(10, 14, 6), input({ news, records: spent, history }));
        assert.deepEqual(pick([sick, hw, camera]).upcoming.map(c => c.news?.kind), ['camera']);
        assert.deepEqual(pick([sick, hw]).upcoming.map(c => c.news?.kind), ['homework_done']);
        assert.deepEqual(pick([sick]).upcoming.map(c => c.news?.kind), ['unwell']);
        const plan = pick([sick, hw, camera]);
        assert.deepEqual(plan.yielded.filter(c => c.occasion === 'news').map(c => c.news!.kind).sort(), ['homework_done', 'unwell']);
        // 让出去的那几件在后面的问候里顺带说（untoldNews）
        const bedtime = candidatesOn(day(10, 14), input({ news: [hw] })).find(c => c.occasion === 'bedtime')!;
        assert.deepEqual(untoldNews(bedtime, t(10, 14, 23, 30), input({ news: [hw], history, records: spent })), [hw]);
    });

    test('说明：只给事实和方向；作业不要他回应或夸；不舒服不是求安抚；每一类都不抱怨', () => {
        const note = (c: NewsItem) => occasionNote(newsOf(candidatesOn(day(10, 14), input({ news: [c] })))[0]!, '宝宝');
        assert.match(note(camera), /你刚在山大路科技市场买到了二手相机，想第一时间告诉宝宝/);
        assert.match(note(hw), /你刚把数据结构的作业写完了，想跟宝宝说一声.*不要他回应或夸你/);
        assert.match(note(sick), /你今天肚子疼得厉害（生理期），想跟宝宝说一声.*不是要他哄你、关心你，也不要他回应/);
        for (const c of [camera, hw, sick]) {
            assert.match(note(c), /不抱怨对方没找你、没回你/);
            assert.doesNotMatch(note(c), /「[^」]*[！!]」/, '不给台词');
        }
    });

    test('到点：那件事没发生不发；那之后聊过不发（每一类一样）', () => {
        const [c] = newsOf(candidatesOn(day(10, 14), input({ news: [hw] })));
        assert.equal(blockReason(c!, c!.at, input({ news: [] })), '那件事没发生');
        assert.equal(blockReason(c!, c!.at, input({ news: [hw], history: [user(t(10, 14, 22, 2)), her(t(10, 14, 22, 3))] })), '那之后聊过了');
    });

    test('卡上写 newsKinds：没写 = 只有相机；写了的认；写错的报错', () => {
        const base = { occasions: ['news'], dailyMax: 2, unansweredMax: 1 };
        assert.deepEqual(newsKindsOf(parseProactive(base, '卡')), ['camera']);
        assert.deepEqual(parseProactive({ ...base, newsKinds: ['camera', 'homework_done'] }, '卡').newsKinds, ['camera', 'homework_done']);
        assert.equal('newsKinds' in parseProactive(base, '卡'), false);
        assert.throws(() => parseProactive({ ...base, newsKinds: ['camera', 'bogus'] }, '卡'), /newsKinds 应为 camera \/ homework_done \/ unwell/);
        assert.throws(() => parseProactive({ ...base, newsKinds: 'camera' }, '卡'), /newsKinds/);
        assert.deepEqual([...NEWS_KINDS], ['camera', 'homework_done', 'unwell', 'friend_changed', 'friend_sick', 'cat_photo', 'small_thing', 'food_photo']);
    });
});

describe('发送出错但前几个气泡已发出（ADR 0011 核对，10-12）：和发了一样算', () => {
    const sent = record('2026-10-14:morning', t(10, 14, 9), 'sent', { messageIds: [1] });
    const partial = record('2026-10-14:after_class', t(10, 14, 12), 'failed', { reason: '发送失败：timeout', messageIds: [2] });
    const none = record('2026-10-14:quiet', t(10, 14, 15), 'failed', { reason: '发送失败：timeout' });

    test('占每天的上限，也算「她发的他没回」；一个都没发出去的不算', () => {
        assert.equal(usedOn('2026-10-14', [sent, partial, none]), 2);
        assert.equal(unansweredCount({ history: [], records: [sent, partial, none], mode: 'on' }), 2);
        // 试运行里「发了一半」没有意义，不算
        assert.equal(unansweredCount({ history: [], records: [partial], mode: 'dryRun' }), 0);
        const c = candidatesOn(day(10, 14), input()).find(x => x.occasion === 'bedtime')!;
        assert.equal(blockReason(c, c.at, input({ records: [sent, partial] })), '今天已经主动了 2 条');
        assert.notEqual(blockReason(c, c.at, input({ records: [sent, none] })), '今天已经主动了 2 条');
    });

    test('发了一半的那件事不再算「没说成」', () => {
        const news = record('2026-10-14:news:camera', t(10, 14, 16, 40), 'failed', { reason: '发送失败：timeout', messageIds: [3] });
        const camera: NewsItem = { id: 'camera', kind: 'camera', day: '2026-10-14', at: t(10, 14, 16, 30), what: '买到了相机' };
        const bedtime = candidatesOn(day(10, 14), input({ news: [camera] })).find(c => c.occasion === 'bedtime')!;
        const history = [user(t(10, 14, 11)), her(t(10, 14, 11, 1))];
        assert.deepEqual(untoldNews(bedtime, bedtime.at, input({ news: [camera], history, records: [news] })), []);
        assert.deepEqual(untoldNews(bedtime, bedtime.at, input({ news: [camera], history, records: [{ ...news, messageIds: undefined }] })), [camera]);
    });
});
