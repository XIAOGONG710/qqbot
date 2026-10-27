import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    createVideoBrowsing, fetchHotComments, fetchPopular, pickVideo, suitable, videoNote, videoPlan, VIDEO_CHANCE, VIDEO_MIN_GAP_MS, type BiliFetch, type BiliVideo,
} from '../src/bilibili/bilibili.ts';
import type { InitiateOutcome, InitiateRequest } from '../src/social/responder.ts';
import { formatDate, herDay } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const schedule = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json')).schedule!;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-bili-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const video = (overrides: Partial<BiliVideo> = {}): BiliVideo => ({
    bvid: 'BV1Jonu6mEwN', aid: 1, title: '每一位认真谋生的人都值得被仰望', desc: '-', owner: '李炮炮儿', category: '搞笑', views: 680000, likes: 72000, duration: 369,
    link: 'https://www.bilibili.com/video/BV1Jonu6mEwN', ...overrides,
});
const reply = (body: unknown): Awaited<ReturnType<BiliFetch>> => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const at = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const dayOf = (t: number) => formatDate(herDay(schedule, new Date(t)));
const isWeekend = (t: number) => new Date(t).getDay() === 0 || new Date(t).getDay() === 6;

describe('刷 B 站：读公开接口（ADR 0084）', () => {
    test('热门榜：取标题、UP 主、分区、播放、时长，拼出链接；坏条目跳过；code 不是 0 就报错', async () => {
        const list = [
            { bvid: 'BV1Jonu6mEwN', aid: 11, title: '一条视频', desc: '简介', owner: { name: '某 UP' }, tname: '日常', stat: { view: 1000, like: 50 }, duration: 100 },
            { bvid: '坏的', aid: 12, title: 'x', tname: '日常' },
            { bvid: 'BV1abcdefghi', aid: 13, title: '', tname: '日常' },
        ];
        const urls: string[] = [];
        const videos = await fetchPopular(async url => { urls.push(url); return reply({ code: 0, data: { list } }); }, 2);
        assert.equal(urls.length, 2, '两页');
        assert.match(urls[0]!, /popular\?ps=20&pn=1/);
        assert.deepEqual(videos.map(v => v.bvid), ['BV1Jonu6mEwN', 'BV1Jonu6mEwN']);
        assert.equal(videos[0]!.link, 'https://www.bilibili.com/video/BV1Jonu6mEwN');
        await assert.rejects(fetchPopular(async () => reply({ code: -352, message: '风控' })), /-352/);
        await assert.rejects(fetchPopular(async () => ({ ok: false, status: 503, text: async () => '' })), /503/);
    });

    test('热评：去表情括号、@、网址、太短太长的，取前 n 条', async () => {
        const replies = ['哈哈哈哈这也太真实了吧', '@某人 快来看', '看这个 https://x.com/a', '好', '很长'.repeat(40), '[doge]笑死我了，每次都是这样', '第三条正常的评论内容', '第四条也正常的评论内容']
            .map(message => ({ content: { message } }));
        const comments = await fetchHotComments(async () => reply({ code: 0, data: { replies } }), 1, 3);
        assert.deepEqual(comments, ['哈哈哈哈这也太真实了吧', '笑死我了，每次都是这样', '第三条正常的评论内容']);
    });
});

describe('刷 B 站：挑视频、写说明（ADR 0084）', () => {
    test('合适：她会点开的分区、20 秒到 12 分钟、没有营销 / 争议词；社会、资讯、太长的不要', () => {
        assert.equal(suitable(video()), true);
        assert.equal(suitable(video({ category: '社会' })), false);
        assert.equal(suitable(video({ category: '预告·资讯' })), false);
        assert.equal(suitable(video({ duration: 5 })), false);
        assert.equal(suitable(video({ duration: 3600 })), false);
        assert.equal(suitable(video({ title: '商单 恰饭视频' })), false);
        assert.equal(suitable(video({ desc: '本期赞助来自某某' })), false);
    });

    test('挑：不合适的、发过的不挑；按日期哈希，同一天每次一样；没有返回 undefined', () => {
        const a = video({ bvid: 'BV1aaaaaaaaaa' });
        const b = video({ bvid: 'BV1bbbbbbbbbb' });
        const c = video({ bvid: 'BV1cccccccccc', category: '社会' });
        const picked = pickVideo([a, b, c], '2026-11-03', []);
        assert.ok(picked === a || picked === b);
        assert.equal(pickVideo([a, b, c], '2026-11-03', []), picked);
        assert.equal(pickVideo([a, b, c], '2026-11-03', [picked!.bvid]), picked === a ? b : a);
        assert.equal(pickVideo([a, b, c], '2026-11-03', ['BV1aaaaaaaaaa', 'BV1bbbbbbbbbb']), undefined);
    });

    test('说明：只给事实和方向——标题、UP 主、分区、时长、热评；不编没写的、不写链接、不说看了哪一段', () => {
        const note = videoNote(video(), ['笑死我了每次都这样', '这个梗我能玩一年'], '宝宝');
        for (const word of ['《每一位认真谋生的人都值得被仰望》', 'UP 主：李炮炮儿', '分区：搞笑', '约 6 分钟', '热评：「笑死我了每次都这样」「这个梗我能玩一年」', '发给他', '视频里没写的内容不编', '不说你看到了哪一段', '你不用写链接']) {
            assert.ok(note.includes(word), word);
        }
        assert.ok(!videoNote(video(), [], '宝宝').includes('热评'));
    });

    test('一天刷不刷：约 VIDEO_CHANCE 的日子；工作日晚上、周末下午到晚上', () => {
        const plans = Array.from({ length: 500 }, (_, i) => ({ weekend: i % 7 >= 5, plan: videoPlan(`d${i}`, i % 7 >= 5) }));
        const hits = plans.filter(p => p.plan);
        assert.ok(Math.abs(hits.length / plans.length - VIDEO_CHANCE) < 0.07, String(hits.length / plans.length));
        assert.ok(hits.filter(p => !p.weekend).every(p => p.plan!.minutes >= 19 * 60 && p.plan!.minutes <= 22 * 60 + 30));
        assert.ok(hits.filter(p => p.weekend).every(p => p.plan!.minutes >= 14 * 60 && p.plan!.minutes <= 22 * 60 + 30));
    });
});

describe('刷 B 站：每分钟看一眼（ADR 0084）', () => {
    const popularBody = { code: 0, data: { list: [
        { bvid: 'BV1Jonu6mEwN', aid: 11, title: '一条搞笑视频', desc: '-', owner: { name: '某 UP' }, tname: '搞笑', stat: { view: 1000, like: 50 }, duration: 100 },
        { bvid: 'BV1abcdefghi', aid: 12, title: '另一条日常', desc: '-', owner: { name: '另一个 UP' }, tname: '日常', stat: { view: 900, like: 40 }, duration: 200 },
    ] } };
    const fakeFetch = (calls: string[]): BiliFetch => async url => {
        calls.push(url);
        return url.includes('/reply/') ? reply({ code: 0, data: { replies: [{ content: { message: '这个也太真实了吧哈哈' } }] } }) : reply(popularBody);
    };
    const findEvening = () => {
        for (let day = 2; day < 29; day++) {
            const t = at(11, day, 22, 40);
            if (videoPlan(dayOf(t), isWeekend(t))) return t;
        }
        return assert.fail('找不到要刷的日子');
    };
    const make = (t: number, mode: 'dryRun' | 'on', outcome: (request: InitiateRequest) => InitiateOutcome | Promise<InitiateOutcome>) => {
        const clock = { t };
        const requests: InitiateRequest[] = [];
        const links: string[] = [];
        const calls: string[] = [];
        const logs: string[] = [];
        const dir = tmp();
        const browsing = createVideoBrowsing({
            mode, target: { qq: 10001, name: '宝宝' }, schedule, dir, now: () => clock.t, log: m => logs.push(m), fetch: fakeFetch(calls),
            initiate: async request => { requests.push(request); const result = await outcome(request); if (result.result === 'sent' || result.result === 'dryRun') request.commit(result.parts); return result; },
            sendLink: async video => { links.push(video.link); },
        });
        return { browsing, clock, requests, links, calls, logs, dir };
    };

    test('开着：挑一个、读热评、让她主动说一句，再发真链接；记下发过的，一天只一次；之后 36 小时不再发', async () => {
        const t = findEvening();
        const sent = make(t, 'on', request => ({ result: 'sent', parts: ['这个也太真实了'], messageIds: [1] }));
        await sent.browsing.tick();
        await sent.browsing.tick();
        assert.equal(sent.requests.length, 1, '一天一次');
        assert.match(sent.requests[0]!.note, /热评：「这个也太真实了吧哈哈」/);
        assert.equal(sent.requests[0]!.dryRun, false);
        assert.equal(sent.requests[0]!.maxBubbles, 2);
        assert.equal(sent.links.length, 1);
        assert.match(sent.links[0]!, /^https:\/\/www\.bilibili\.com\/video\/BV/);
        const saved = JSON.parse(readFileSync(join(sent.dir, 'bilibili.json'), 'utf8')) as { seen: string[]; shares: { mode: string }[] };
        assert.equal(saved.seen.length, 1);
        assert.equal(saved.shares[0]!.mode, 'on');
        sent.clock.t += 86_400_000; // 第二天（哪怕那天也该刷）不到 36 小时
        await sent.browsing.tick();
        assert.ok(sent.requests.length === 1 || sent.clock.t - t >= VIDEO_MIN_GAP_MS);
    });

    test('试运行：生成但不发链接，话存进 drafts.md，不用发给他', async () => {
        const t = findEvening();
        const dry = make(t, 'dryRun', () => ({ result: 'dryRun', parts: ['这个梗我能玩一年'] }));
        await dry.browsing.tick();
        assert.equal(dry.requests[0]!.dryRun, true);
        assert.deepEqual(dry.links, []);
        assert.match(readFileSync(join(dry.dir, 'drafts.md'), 'utf8'), /草稿，没发[\s\S]*这个梗我能玩一年[\s\S]*bilibili\.com\/video\/BV/);
    });

    test('正聊着（skipped）：今天的机会不算用掉，过 20 分钟再试；失败：今天不再试；睡着、上课时不刷', async () => {
        const t = findEvening();
        let busy = true;
        const talking = make(t, 'on', () => (busy ? { result: 'skipped', reason: '有没回的消息' } : { result: 'sent', parts: ['哈哈'], messageIds: [1] }));
        await talking.browsing.tick();
        assert.equal(talking.requests.length, 1);
        await talking.browsing.tick();
        assert.equal(talking.requests.length, 1, '20 分钟内不重试');
        busy = false;
        talking.clock.t += 21 * 60_000;
        await talking.browsing.tick();
        assert.equal(talking.requests.length, 2);
        assert.equal(talking.links.length, 1);

        const failing = make(t, 'on', () => ({ result: 'failed', reason: '模型出错' }));
        await failing.browsing.tick();
        failing.clock.t += 60 * 60_000;
        await failing.browsing.tick();
        assert.equal(failing.requests.length, 1, '失败了今天不再试');
        assert.ok(failing.logs.some(l => l.includes('这次没发成')));

        const asleep = make(at(11, 3, 3, 0), 'on', () => ({ result: 'sent', parts: ['x'], messageIds: [1] }));
        await asleep.browsing.tick();
        assert.deepEqual(asleep.calls, [], '睡着了连榜都不取');
    });

    test('取热门榜失败：只记一次日志，15 分钟后再试，再失败就隔 30 分钟（越隔越久，最多 2 小时）', async () => {
        const t = findEvening();
        const clock = { t };
        const logs: string[] = [];
        let calls = 0;
        const browsing = createVideoBrowsing({
            mode: 'on', target: { qq: 10001, name: '宝宝' }, schedule, dir: tmp(), now: () => clock.t, log: m => logs.push(m),
            fetch: async () => { calls++; return { ok: false, status: 412, text: async () => '' }; },
            initiate: async () => ({ result: 'skipped', reason: 'x' }), sendLink: async () => undefined,
        });
        await browsing.tick();
        await browsing.tick();
        assert.equal(calls, 1, '15 分钟内不重试');
        clock.t += 16 * 60_000;
        await browsing.tick();
        assert.equal(calls, 2);
        clock.t += 29 * 60_000;
        await browsing.tick();
        assert.equal(calls, 2, '又失败了，这回隔 30 分钟，不是 15');
        clock.t += 2 * 60_000;
        await browsing.tick();
        assert.equal(calls, 3);
        assert.equal(logs.filter(l => l.includes('取热门榜失败')).length, 1, logs.join('|'));
    });
});
