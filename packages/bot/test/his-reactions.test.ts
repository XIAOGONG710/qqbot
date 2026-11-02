import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import {
    flatTopics, hisReactions, newsKindOf, reactionPlan, reactionsLine, reactionsLog, reactionTo, stoppedTopics, STOP_DAYS, topicsOf, type TopicReactions,
} from '../src/proactive/his-reactions.ts';
import { occasionNote, type Candidate, type NewsItem, type ProactiveRecord } from '../src/proactive/proactive.ts';
import { createProactivePlanner, type Planner } from '../src/proactive/proactive-planner.ts';
import type { InitiateOutcome, InitiateRequest } from '../src/social/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// ADR 0212：看他的反应。她本人（11-02 ask-her）的条件：土豆照发、不舒服 / 关心他不看反应、他明说不想听比「嗯」重
const DAY = 86_400_000;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const dayText = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** 造一段：她 at 主动说了 text（记录 occasion），他 after 分钟后回 replies（空 = 没回） */
function build(items: { at: number; text: string; occasion?: ProactiveRecord['occasion']; newsId?: string; replies?: string[]; result?: ProactiveRecord['result'] }[]) {
    const history: StoredMessage[] = [];
    const records: ProactiveRecord[] = [];
    let id = 1000;
    for (const item of items) {
        const messageId = id++;
        history.push({ time: iso(item.at), role: 'assistant', content: item.text, messageId });
        (item.replies ?? []).forEach((reply, i) => history.push({ time: iso(item.at + (5 + i) * 60_000), role: 'user', content: reply }));
        // 他回了之后她接一句（聊天继续）：截住他这一串
        if (item.replies?.length) history.push({ time: iso(item.at + 30 * 60_000), role: 'assistant', content: '嗯嗯' });
        const occasion = item.occasion ?? 'share';
        records.push({
            id: occasion === 'news' ? `${dayText(item.at)}:news:${item.newsId}` : `${dayText(item.at)}:${occasion}`,
            occasion, plannedAt: iso(item.at), at: iso(item.at), result: item.result ?? 'sent', messageIds: [messageId],
        });
    }
    return { history, records };
}

describe('看他的反应：一条话归哪类', () => {
    test('按话题归类；三个字的名字只叫后两个字也认得', () => {
        assert.deepEqual(topicsOf('土豆今天趴我键盘上了'), ['cat']);
        assert.deepEqual(topicsOf('食堂的麻辣烫今天换了老板'), ['food']);
        assert.deepEqual(topicsOf('高数作业终于写完了'), ['study']);
        assert.deepEqual(topicsOf('佳宁又发图来损我', ['陈佳宁']), ['friends']);
        assert.deepEqual(topicsOf('今天天很蓝'), []);
    });

    test('她本人的条件 2：她不舒服、关心他吃饭睡觉的话不归任何一类（不会被他的反应压下去）', () => {
        assert.deepEqual(topicsOf('肚子疼，食堂都没去'), []);
        assert.deepEqual(topicsOf('你今天早饭吃了没，别又熬夜'), []);
        assert.deepEqual(topicsOf('今天降温了，你那边多穿点没'), [], '关心他穿衣也不算');
    });
});

describe('看他的反应：他怎么回的', () => {
    const at = t(10, 20, 15);
    const his = (content: string, minutes = 5): StoredMessage => ({ time: iso(at + minutes * 60_000), role: 'user', content });
    test('没回 / 回个嗯 / 只发表情 / 接着聊 / 两条以上', () => {
        assert.equal(reactionTo([], at), 'none');
        assert.equal(reactionTo([his('嗯')], at), 'brief');
        assert.equal(reactionTo([his('哦哦')], at), 'brief');
        assert.equal(reactionTo([his('[动画表情：好耶]')], at), 'brief', '只发了个表情');
        assert.equal(reactionTo([his('哈哈哈它怎么这么胖 你喂太多了吧')], at), 'engaged');
        assert.equal(reactionTo([his('真的假的'), his('[动画表情]', 6)], at), 'engaged');
    });

    test('12 小时以后才回的不算回这一条；她又说了别的、他回的是后面那句就截住', () => {
        assert.equal(reactionTo([his('哈哈哈哈哈好可爱', 13 * 60)], at), 'none');
        const after: StoredMessage[] = [his('嗯', 5), { time: iso(at + 10 * 60_000), role: 'assistant', content: '你在干嘛' }, his('在打游戏呢 怎么了', 15)];
        assert.equal(reactionTo(after, at), 'brief', '只看她说完到她下一句之间');
        // 她紧接着发的第二个气泡（照片）不截住
        assert.equal(reactionTo([{ time: iso(at + 60_000), role: 'assistant', content: '[图片]' }, his('好胖哈哈哈 多大了啊', 3)], at), 'engaged');
    });

    test('她本人的条件 3：明说不想听的认得出；玩笑和「别再发烧了」不算', () => {
        for (const text of ['别老发吃的了', '我对这个不感兴趣', '能不能别说这些了', '关我啥事', '别发这个了']) assert.equal(reactionTo([his(text)], at), 'stop', text);
        for (const text of ['别说了笑死我了', '别再发烧了啊', '哈哈哈滚', '别闹']) assert.notEqual(reactionTo([his(text)], at), 'stop', text);
    });
});

describe('看他的反应：三周汇总和给她看的那一行', () => {
    const now = t(11, 2, 18);
    const sample = () => build([
        // 土豆：接了 3 次、嗯了 1 次
        { at: now - 2 * DAY, text: '土豆今天趴我键盘上了', replies: ['哈哈哈它是不是想你了'] },
        { at: now - 4 * DAY, text: '土豆今天居然让我摸了', replies: ['真的假的', '有照片吗'] },
        { at: now - 6 * DAY, text: '喂土豆的时候它蹭我腿', replies: ['嗯'] },
        { at: now - 8 * DAY, text: '土豆胖了一圈', replies: ['你喂太多了吧哈哈哈'] },
        // 课和作业：嗯、没回、嗯
        { at: now - 1 * DAY, text: '高数作业终于写完了', replies: ['嗯'] },
        { at: now - 3 * DAY, text: '下午的课老师拖堂了', replies: [] },
        { at: now - 5 * DAY, text: '小测出分了还行', replies: ['哦'] },
        // 吃的：他明说了
        { at: now - 2 * DAY, text: '今天食堂的麻辣烫好吃', replies: ['别老发吃的了'] },
        // 不算的：试运行、她不舒服那一类、她关心他、三周以前的
        { at: now - 1 * DAY, text: '土豆今天又胖了', replies: [], result: 'dryRun' },
        { at: now - 1 * DAY, text: '今天第一天，肚子疼', occasion: 'news', newsId: 'unwell:2026-11-01', replies: [] },
        { at: now - 2 * DAY, text: '你今天早饭吃了没', replies: [] },
        { at: now - 25 * DAY, text: '高数课好无聊', replies: ['嗯'] },
    ]);

    test('按话题数清楚；试运行、不舒服、关心他、三周以前的都不算', () => {
        const { history, records } = sample();
        const stats = hisReactions(history, records, now);
        const of = (topic: string) => stats.find(s => s.topic === topic)!;
        assert.deepEqual([of('cat').engaged, of('cat').brief, of('cat').none], [3, 1, 0]);
        assert.deepEqual([of('study').engaged, of('study').brief, of('study').none], [0, 2, 1]);
        assert.ok(of('food').stoppedAt !== undefined);
        assert.ok(of('cat').mean > 0.5 && of('study').mean < -0.2, JSON.stringify(stats));
        assert.deepEqual(stoppedTopics(stats, now), ['food']);
        assert.deepEqual(flatTopics(stats, now), ['study']);
        assert.ok(!reactionsLog(stats).includes('键盘'), '日志里没有原话');
    });

    test('那一行：接得多的、回个嗯的、明说过的；不禁话题，说什么她自己拿捏', () => {
        const { history, records } = sample();
        const line = reactionsLine(hisReactions(history, records, now), now)!;
        assert.ok(line.includes('土豆的事他多半会接着聊'), line);
        assert.ok(line.includes('课和作业他多半就回个嗯'), line);
        assert.ok(line.includes('2 天前直接说过不想听你说吃的'), line);
        assert.ok(line.includes('你自己拿捏') && line.includes('想说的照样可以说'), line);
        assert.ok(!/麻辣烫|键盘|高数/.test(line), '不带她说过的原话');
    });

    test(`次数不够（每类少于 3 次）就没有这一行；明说不想听过了 ${STOP_DAYS} 天就不再提`, () => {
        const few = build([{ at: now - DAY, text: '土豆今天趴我键盘上了', replies: ['哈哈'] }, { at: now - 2 * DAY, text: '作业写完了', replies: ['嗯'] }]);
        assert.equal(reactionsLine(hisReactions(few.history, few.records, now), now), undefined);
        const old = build([{ at: now - (STOP_DAYS + 1) * DAY, text: '今天食堂的麻辣烫好吃', replies: ['别老发吃的了'] }]);
        const stats = hisReactions(old.history, old.records, now);
        assert.deepEqual(stoppedTopics(stats, now), []);
        assert.equal(reactionsLine(stats, now), undefined);
    });

    test('news 记录的 id 认得出是哪一类', () => {
        assert.equal(newsKindOf({ id: '2026-11-01:news:cat_photo:2026-11-01', occasion: 'news' }), 'cat_photo');
        assert.equal(newsKindOf({ id: '2026-11-01:news:small:2026-11-01:x', occasion: 'news' }), 'small_thing');
        assert.equal(newsKindOf({ id: '2026-11-01:news:friend_sick:苏雨桐:2026-11-01', occasion: 'news' }), 'friend_sick');
        assert.equal(newsKindOf({ id: '2026-11-01:news:friend:d1', occasion: 'news' }), 'friend_changed');
        assert.equal(newsKindOf({ id: '2026-11-01:share', occasion: 'share' }), undefined);
    });
});

describe('看他的反应：这一次主动开口怎么用', () => {
    const now = t(11, 2, 18);
    const stats: TopicReactions[] = [
        { topic: 'cat', count: 4, engaged: 0, brief: 3, none: 1, mean: -0.35 },
        { topic: 'study', count: 3, engaged: 0, brief: 3, none: 0, mean: -0.4 },
        { topic: 'food', count: 1, engaged: 0, brief: 0, none: 0, mean: 0, stoppedAt: now - 2 * DAY },
    ];
    const news = (kind: NewsItem['kind'], what: string): Pick<Candidate, 'occasion' | 'news'> => ({ occasion: 'news', news: { id: `${kind}:x`, kind, day: '2026-11-02', at: now, what } });

    test('他明说过不想听的那一类：照片 / 小事不发', () => {
        const plan = reactionPlan(news('food_photo', '晚饭吃的麻辣烫'), stats, now);
        assert.ok(plan.skip?.includes('2 天前说过不想听吃的'), JSON.stringify(plan));
        assert.ok(reactionPlan(news('small_thing', '食堂阿姨多给了一勺肉'), stats, now).skip);
    });

    test('话题定了、正好是他不怎么接的小事：交给她决定说不说（可以只输出「不发」）', () => {
        const plan = reactionPlan(news('small_thing', '小测出分了，比想的好'), stats, now);
        assert.equal(plan.canDecline, true);
        assert.ok(plan.seen!.includes('只输出「不发」'), plan.seen);
    });

    test('她本人的条件 1：土豆的事他再不接也照发，不给「不发」这个口子', () => {
        const plan = reactionPlan(news('cat_photo', '给土豆拍了张照片'), stats, now);
        assert.equal(plan.skip, undefined);
        assert.equal(plan.canDecline, undefined);
        assert.ok(plan.seen!.includes('土豆的事、课和作业他多半就回个嗯'), plan.seen);
    });

    test('随口说件事 / 冷场：只给那一行，话题她自己挑；早安、睡前、催他、她不舒服、心里惦记都不给', () => {
        for (const occasion of ['share', 'quiet'] as const) {
            const plan = reactionPlan({ occasion }, stats, now);
            assert.ok(plan.seen && !plan.canDecline && !plan.skip, occasion);
        }
        for (const occasion of ['morning', 'bedtime', 'reach', 'inner', 'after_class'] as const) assert.deepEqual(reactionPlan({ occasion }, stats, now), {}, occasion);
        assert.deepEqual(reactionPlan(news('unwell', '第一天，肚子疼'), stats, now), {});
    });

    test('提示词：有那一行就跟在说明后面；没有就和原来一字不差', () => {
        const candidate: Candidate = { id: '2026-11-02:share', occasion: 'share', day: '2026-11-02', at: now, reason: 'x' };
        const plain = occasionNote(candidate, '宝宝');
        assert.equal(occasionNote(candidate, '宝宝', [], undefined), plain);
        const withSeen = occasionNote(candidate, '宝宝', [], '你看到的他的反应：……');
        assert.ok(withSeen.includes('；你看到的他的反应：……') && withSeen.startsWith('[这次是你主动找宝宝'), withSeen);
    });
});

describe('看他的反应：计划器', () => {
    const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
    const schedule = boyfriend.schedule!;
    const dirs: string[] = [];
    let planner: Planner | undefined;
    afterEach(() => { planner?.stop(); planner = undefined; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    async function run(withReactions: boolean): Promise<{ requests: InitiateRequest[]; logs: string[] }> {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-his-reactions-'));
        dirs.push(dir);
        // 两天前她发了吃饭的照片，他说「别老发吃的了」
        const past = build([{ at: t(10, 22, 19), text: '今天食堂的麻辣烫好吃', occasion: 'news', newsId: 'food_photo:2026-10-22:dinner', replies: ['别老发吃的了'] }]);
        const history: StoredMessage[] = [
            ...past.history,
            { time: iso(t(10, 24, 14, 0)), role: 'user', content: '我先去忙了' },
            { time: iso(t(10, 24, 14, 1)), role: 'assistant', content: '好，晚点聊' },
        ];
        writeFileSync(join(dir, '10001-boyfriend.json'), JSON.stringify({ version: 1, records: past.records, followUps: [], extracted: {} }));
        const clock = new VirtualClock(new Date(t(10, 24, 18, 0)));
        const requests: InitiateRequest[] = [];
        const logs: string[] = [];
        const item: NewsItem = { id: 'food_photo:2026-10-24:dinner', kind: 'food_photo', day: '2026-10-24', at: t(10, 24, 18, 40), what: '晚饭吃的番茄炒蛋', dish: '番茄炒蛋' };
        planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings: { occasions: ['news'], newsKinds: ['food_photo'], dailyMax: 3, unansweredMax: 2 }, dates: [], mode: 'dryRun',
            history: { load: () => history },
            responder: {
                initiate: async (request: InitiateRequest): Promise<InitiateOutcome> => {
                    requests.push(request);
                    request.commit(['晚饭番茄炒蛋']);
                    return { result: 'dryRun', parts: ['晚饭番茄炒蛋'] };
                },
            },
            dir, log: message => logs.push(message), now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '林梦瑶' },
            news: () => [item],
            photoReady: () => true,
            ...(withReactions ? { reactions: { names: [] } } : {}),
        });
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 30));
            const next = clock.nextTimer();
            if (next === undefined || next > t(10, 24, 22, 0)) break;
            clock.advanceTo(next);
        }
        await new Promise(r => setTimeout(r, 30));
        return { requests, logs };
    }

    test('开了：他两天前明说过不想听吃的，今天吃饭的照片不发，日志写原因（只有话题和次数）', async () => {
        const { requests, logs } = await run(true);
        assert.equal(requests.length, 0);
        const line = logs.find(l => l.includes('不想听吃的'));
        assert.ok(line, logs.join('\n'));
        assert.ok(!line!.includes('麻辣烫'), '日志里没有原话');
    });

    test('没开：照旧发', async () => {
        const { requests } = await run(false);
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.photo, 'food');
    });
});
