import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createVideoBrowsing, type BiliFetch } from '../src/bilibili.ts';
import { createPresence, type PresenceTransport } from '../src/presence.ts';
import { stateAt } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// 长跑（ADR 0083、0084）：把存在感的五项和刷 B 站全开，假时钟每分钟走一次、走 60 天，每隔几天「重启」一次（重新建，读同一份状态文件），
// 看频率和间隔是不是始终在界内——单日的单元测试看不出「一周最多 3 条」「隔 3–5 天」「36 小时」这类跨天的界。
const schedule = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json')).schedule!;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-soak-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const DAYS = 60;
const USER = 10001;
const reply = (body: unknown): Awaited<ReturnType<BiliFetch>> => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const popular = Array.from({ length: 60 }, (_, i) => ({
    bvid: `BV1${String(i).padStart(9, '0')}`, aid: 1000 + i, title: `视频${i}`, desc: '-', owner: { name: 'UP' }, tname: '搞笑', stat: { view: 100000, like: 5000 }, duration: 200,
}));
const biliFetch: BiliFetch = async url => url.includes('/popular') ? reply({ code: 0, data: { list: popular } }) : reply({ code: 0, data: { replies: [] } });

describe('长跑：60 天每分钟一次，隔几天重启一次', () => {
    test('点赞、签名、说说、在线状态、刷 B 站的频率和间隔始终在界内', async () => {
        const clock = { t: new Date(2026, 10, 2, 0, 0).getTime() };
        const end = clock.t + DAYS * DAY;
        const presenceDir = tmp();
        const biliDir = tmp();
        const events = {
            status: [] as { t: number; label: string; restart: boolean }[],
            like: [] as number[], sig: [] as number[], qzone: [] as number[], poke: [] as number[], bili: [] as { t: number; bvid: string }[],
        };
        let restartedNow = false;
        let posts = 0;
        const transport: PresenceTransport = {
            setOnlineStatus: async (status, ext) => { events.status.push({ t: clock.t, label: `${status}/${ext}`, restart: restartedNow }); restartedNow = false; },
            sendLike: async () => { events.like.push(clock.t); },
            setSignature: async () => { events.sig.push(clock.t); },
            postQzone: async () => { events.qzone.push(clock.t); return `tid${++posts}`; },
            pokeFriend: async () => { events.poke.push(clock.t); },
        };
        const buildPresence = () => createPresence({
            flags: { onlineStatus: true, profileLikes: true, signature: 'on', qzone: 'on', qzoneVisibility: 'friends', pokeOut: true },
            transport, schedule, likeTargets: [USER], pokeTargets: [USER], canPokeOut: () => true, dir: presenceDir, now: () => clock.t, log: () => {},
            composeQzone: async ({ now }) => ({ text: `说说${now}`, withPhoto: false }),
        });
        const buildBrowsing = () => createVideoBrowsing({
            mode: 'on', target: { qq: USER, name: '宝宝' }, schedule, dir: biliDir, now: () => clock.t, log: () => {}, fetch: biliFetch,
            initiate: async request => { request.commit(['好看']); return { result: 'sent', parts: ['好看'], messageIds: [1] }; },
            sendLink: async video => { events.bili.push({ t: clock.t, bvid: video.bvid }); },
        });

        let presence = buildPresence();
        let browsing = buildBrowsing();
        let nextRestart = clock.t + 2 * DAY + 14 * HOUR + 7 * MINUTE;
        for (; clock.t < end; clock.t += MINUTE) {
            if (clock.t >= nextRestart) {
                presence = buildPresence();
                browsing = buildBrowsing();
                restartedNow = true;
                nextRestart = clock.t + 3 * DAY + 5 * HOUR + 11 * MINUTE;
            }
            await presence.tick();
            await browsing.tick();
        }

        const kindAt = (t: number) => stateAt(schedule, new Date(t)).activity.kind;
        const hourOf = (t: number) => { const d = new Date(t); return d.getHours() + d.getMinutes() / 60; };
        const weekend = (t: number) => new Date(t).getDay() === 0 || new Date(t).getDay() === 6;
        const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!);
        const rolling = (times: number[], span: number) => Math.max(0, ...times.map(t => times.filter(u => u <= t && t - u < span).length));
        const summary = `点赞 ${events.like.length}，签名 ${events.sig.length}，说说 ${events.qzone.length}，状态 ${events.status.length}，B 站 ${events.bili.length}`;

        // 点赞：同一天最多一次（重启也不重复）；12:00–21:30；约八成的日子
        const likeDays = events.like.map(t => new Date(t).toDateString());
        assert.equal(new Set(likeDays).size, likeDays.length, `同一天点了两次：${summary}`);
        assert.ok(events.like.every(t => hourOf(t) >= 12 && hourOf(t) <= 21.6), '点赞的钟点');
        assert.ok(events.like.every(t => !['sleep', 'class'].includes(kindAt(t))), '睡着、上课时不点');
        assert.ok(events.like.length >= DAYS * 0.55 && events.like.length <= DAYS * 0.95, `点赞的日子占比：${summary}`);

        // 签名：第一次不是一开机就改；之后隔 3–5 天（等到她醒着，最多再晚一天）；睡着上课时不改
        assert.ok(events.sig.length >= 8 && events.sig.length <= 20, summary);
        assert.ok(events.sig[0]! - new Date(2026, 10, 2).getTime() >= HOUR, '第一次要隔一两个小时');
        assert.ok(gaps(events.sig).every(gap => gap >= 3 * DAY && gap <= 6 * DAY), `签名间隔（天）：${gaps(events.sig).map(g => (g / DAY).toFixed(1)).join(',')}`);
        assert.ok(events.sig.every(t => !['sleep', 'class'].includes(kindAt(t))), '睡着、上课时不改签名');

        // 说说：任何 7 天里最多 3 条；两条之间至少 20 小时；工作日 17:30 以后、周末 11:00 以后；每周平均有一两条
        assert.ok(rolling(events.qzone, 7 * DAY) <= 3, `7 天里发了 ${rolling(events.qzone, 7 * DAY)} 条`);
        assert.ok(gaps(events.qzone).every(gap => gap >= 20 * HOUR), '说说间隔');
        assert.ok(events.qzone.every(t => hourOf(t) >= (weekend(t) ? 11 : 17.5) && hourOf(t) <= 22.6), '说说的钟点');
        assert.ok(events.qzone.every(t => !['sleep', 'class'].includes(kindAt(t))), '睡着、上课时不发说说');
        assert.ok(events.qzone.length >= DAYS / 7 * 1 && events.qzone.length <= DAYS / 7 * 3, `说说总数：${summary}`);

        // 主动戳他：任何 7 天最多 3 下；隔至少 36 小时；工作日 19:00 以后、周末 14:00 以后、22:30 以前；她醒着；约三成的日子，被每周上限压一压
        assert.ok(rolling(events.poke, 7 * DAY) <= 3, `7 天里戳了 ${rolling(events.poke, 7 * DAY)} 下`);
        assert.ok(gaps(events.poke).every(gap => gap >= 36 * HOUR), '戳他的间隔');
        assert.ok(events.poke.every(t => hourOf(t) >= (weekend(t) ? 14 : 19) && hourOf(t) <= 22.6), '戳他的钟点');
        assert.ok(events.poke.every(t => !['sleep', 'class'].includes(kindAt(t))), '睡着、上课时不戳');
        assert.ok(events.poke.length >= 6 && events.poke.length <= 25, `戳他的次数：${events.poke.length}，${summary}`);

        // 在线状态：只在变的时候改；两次之间至少 10 分钟（重启后的第一次除外）；一天不超过 12 次
        assert.ok(events.status.length > DAYS, `状态改得太少：${summary}`);
        assert.ok(events.status.every((entry, i) => i === 0 || entry.restart || entry.t - events.status[i - 1]!.t >= 10 * MINUTE), '状态改得太勤');
        const perDay = new Map<string, number>();
        for (const entry of events.status) perDay.set(new Date(entry.t).toDateString(), (perDay.get(new Date(entry.t).toDateString()) ?? 0) + 1);
        const worst = [...perDay.entries()].sort((x, y) => y[1] - x[1])[0]!;
        assert.ok(worst[1] <= 8, `一天最多改了 ${worst[1]} 次：${events.status.filter(entry => new Date(entry.t).toDateString() === worst[0]).map(entry => `${new Date(entry.t).toTimeString().slice(0, 5)}→${entry.label}`).join(' ')}`);

        // 刷 B 站：任何 7 天里最多 3 个；两个之间至少 36 小时；不重复同一个视频；只在空闲或课间；工作日 19:00 以后、周末 14:00 以后；60 天里有一些
        const biliTimes = events.bili.map(entry => entry.t);
        assert.ok(rolling(biliTimes, 7 * DAY) <= 3, `7 天里刷了 ${rolling(biliTimes, 7 * DAY)} 个`);
        assert.ok(gaps(biliTimes).every(gap => gap >= 36 * HOUR), 'B 站间隔');
        assert.equal(new Set(events.bili.map(entry => entry.bvid)).size, events.bili.length, '同一个视频发了两次');
        assert.ok(biliTimes.every(t => ['free', 'between'].includes(kindAt(t))), '只在空闲或课间');
        assert.ok(biliTimes.every(t => hourOf(t) >= (weekend(t) ? 14 : 19) && hourOf(t) <= 23.5), 'B 站的钟点');
        assert.ok(events.bili.length >= 6 && events.bili.length <= 25, summary);
    });
});

describe('长跑：B 站接口一直取不到', () => {
    test('60 天里取榜的请求有上限（退避），只记一次日志，不发任何东西', async () => {
        const clock = { t: new Date(2026, 10, 2, 0, 0).getTime() };
        const logs: string[] = [];
        let requests = 0;
        let sent = 0;
        const browsing = createVideoBrowsing({
            mode: 'on', target: { qq: USER, name: '宝宝' }, schedule, dir: tmp(), now: () => clock.t, log: line => logs.push(line),
            fetch: async () => { requests++; return reply({ code: -352, message: '风控' }); },
            initiate: async request => { request.commit(['好看']); sent++; return { result: 'sent', parts: ['好看'], messageIds: [1] }; },
            sendLink: async () => { sent++; },
        });
        for (const end = clock.t + DAYS * DAY; clock.t < end; clock.t += MINUTE) await browsing.tick();
        assert.equal(sent, 0);
        assert.ok(logs.length <= 2, logs.join('|'));
        assert.ok(requests <= 150, `60 天里取了 ${requests} 次榜（被风控时不该一晚上每 15 分钟一次）`);
    });
});

describe('长跑：NapCat 的动作一直失败', () => {
    test('60 天里每一项的尝试次数都有上限，日志每一项只记一次', async () => {
        const clock = { t: new Date(2026, 10, 2, 0, 0).getTime() };
        const logs: string[] = [];
        const attempts = { status: 0, like: 0, sig: 0, qzone: 0, compose: 0, poke: 0 };
        const boom = (key: keyof typeof attempts) => async (): Promise<never> => { attempts[key]++; throw new Error('retcode 1200'); };
        const presence = createPresence({
            flags: { onlineStatus: true, profileLikes: true, signature: 'on', qzone: 'on', qzoneVisibility: 'friends', pokeOut: true },
            transport: { setOnlineStatus: boom('status'), sendLike: boom('like'), setSignature: boom('sig'), postQzone: boom('qzone'), pokeFriend: boom('poke') },
            schedule, likeTargets: [USER], pokeTargets: [USER], canPokeOut: () => true, dir: tmp(), now: () => clock.t, log: line => logs.push(line),
            composeQzone: async ({ now }) => { attempts.compose++; return { text: `说说${now}`, withPhoto: false }; },
        });
        for (const end = clock.t + DAYS * DAY; clock.t < end; clock.t += MINUTE) await presence.tick();
        assert.ok(attempts.like <= DAYS, `点赞试了 ${attempts.like} 次`);
        assert.ok(attempts.qzone <= DAYS, `发说说试了 ${attempts.qzone} 次`);
        assert.ok(attempts.poke <= DAYS, `戳他试了 ${attempts.poke} 次`);
        assert.ok(attempts.sig <= DAYS * 4 + 1, `改签名试了 ${attempts.sig} 次`);
        assert.ok(attempts.status <= DAYS * 14, `改状态试了 ${attempts.status} 次（一直失败不该每分钟一次）`);
        assert.ok(logs.length <= 6, logs.join('|'));
    });
});
