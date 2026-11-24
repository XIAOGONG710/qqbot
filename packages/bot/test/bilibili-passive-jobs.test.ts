import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { BiliAccount } from '../src/bilibili/bilibili-account.ts';
import type { BiliFetch } from '../src/bilibili/bilibili.ts';
import { passiveJobs, type PassiveJobsDeps } from '../src/bilibili/passive-jobs.ts';
import { memesPath, saveMemes } from '../src/language/memes.ts';
import type { Watched } from '../src/language/watching.ts';
import { DEFAULTS, type AppConfig } from '../src/platform/config.ts';
import { loadTierCard, type TierCard } from '../src/platform/contact.ts';
import { passiveReads } from '../src/platform/passive-reads.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 她在 B 站只读的三件事（bilibili/passive-jobs.ts）：看一个视频、刷推荐、学热梗。只测外壳的门槛、并发、出错和停；
// 网络一律假的：B 站请求走注入的 fetch，热梗榜单走全局 fetch（测试里换掉），模型返回空。
const dirs: string[] = [];
const dataDir = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-passive-jobs-')); dirs.push(d); return d; };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const boyfriendCard = loadTierCard(syntheticCardPattern, 'boyfriend');
const at = (hour: number) => new Date(2026, 10, 24, hour, 0).getTime();
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

interface Options {
    config?: Partial<AppConfig>;
    now?: number;
    stopped?: () => boolean;
    account?: () => Promise<BiliAccount | undefined>;
    noAccountSource?: boolean;
    worldCard?: TierCard['character'] | null;
    fetch?: BiliFetch;
}
function harness(options: Options = {}) {
    const dir = dataDir();
    const logs: string[] = [];
    const fetches: { url: string; signal: AbortSignal }[] = [];
    const watched: (readonly Watched[])[] = [];
    let sourceAsked = 0;
    const timers: (() => void)[] = [];
    const exec = {
        now: () => options.now ?? at(15),
        llm: async () => '',
        files: { read: () => '', write: () => {}, append: () => {}, remove: () => {}, exists: () => false, list: () => [], mkdir: () => {} },
        after: (fn: () => void) => { timers.push(fn); return {} as ReturnType<typeof setTimeout>; },
        cancel: () => {},
    };
    const stopped = options.stopped ?? (() => false);
    const passive = passiveReads({ stopped, exec });
    const config = { ...DEFAULTS, dataDir: dir, herDays: false, ...options.config } as unknown as AppConfig;
    const deps: PassiveJobsDeps = {
        config, stopped, log: line => { logs.push(line); }, exec, passive,
        bilibiliAccountSource: () => { sourceAsked++; return options.noAccountSource ? undefined : options.account ?? (async () => undefined); },
        bilibiliFetch: options.fetch ?? (async (url, init) => { fetches.push({ url, signal: init.signal }); return { ok: false, status: 503, text: async () => '' }; }),
        vision: undefined,
        worldCard: options.worldCard === null ? undefined : options.worldCard ?? boyfriendCard.character,
        bedtimes: () => [],
        watchedFile: join(dir, 'watching', 'watched.json'),
        setWatched: entries => { watched.push(entries); },
        memesFile: memesPath(dir),
    };
    return { jobs: passiveJobs(deps), passive, dir, logs, fetches, watched, sourceAsked: () => sourceAsked, timers };
}
const account = (over: Partial<BiliAccount> = {}): BiliAccount => ({
    name: '合成号', mid: 1,
    search: async () => { throw new Error('搜索被限流'); },
    subtitle: async () => ({ status: 'none' }),
    ...over,
} as unknown as BiliAccount);

describe('她自己看一个视频（watchJob）', () => {
    test('门槛：没开 watching、停了、没有 B 站号、不到 14 点都不看，连账号都不打开', async () => {
        let opened = 0;
        const open = async () => { opened++; return account(); };
        for (const h of [harness({ account: open }), harness({ config: { watching: true }, stopped: () => true, account: open }), harness({ config: { watching: true }, noAccountSource: true }), harness({ config: { watching: true }, now: at(13), account: open })]) {
            await h.jobs.watchJob();
            assert.deepEqual(h.watched, []);
            assert.deepEqual(h.logs, []);
        }
        assert.equal(opened, 0);
    });

    test('账号这会儿打不开：这一轮什么都不做；做完放开，下一轮还能再来', async () => {
        let opened = 0;
        const h = harness({ config: { watching: true }, account: async () => { opened++; return undefined; } });
        await h.jobs.watchJob();
        await h.jobs.watchJob();
        assert.equal(opened, 2);
        assert.deepEqual(h.watched, []);
    });

    test('同一时间只跑一轮：前一轮没完，再叫直接返回', async () => {
        let release!: (value: BiliAccount | undefined) => void;
        let opened = 0;
        const h = harness({ config: { watching: true }, account: () => { opened++; return new Promise(resolve => { release = resolve; }); } });
        const first = h.jobs.watchJob();
        await tick();
        await h.jobs.watchJob();
        assert.equal(opened, 1);
        release(undefined);
        await first;
    });

    test('看完一轮（这里搜索失败）：日志带原因，把看过的列表交回 App；搜的时候带着停的 signal', async () => {
        const signals: (AbortSignal | undefined)[] = [];
        const h = harness({ config: { watching: true }, account: async () => account({ search: async (_k, _o, signal) => { signals.push(signal); throw new Error('搜索被限流'); } }) });
        await h.jobs.watchJob();
        assert.ok(h.logs.some(l => /她看视频：搜「.+」失败（搜索被限流）/.test(l)));
        assert.deepEqual(h.watched, [[]]);
        assert.equal(signals[0], h.passive.lifetime.signal);
    });

    test('打开账号抛错：记「这一轮出错」；停了之后出错不记', async () => {
        const h = harness({ config: { watching: true }, account: async () => { throw new Error('凭证读不了'); } });
        await h.jobs.watchJob();
        assert.deepEqual(h.logs, ['她看视频：这一轮出错（凭证读不了）']);
        let stopped = false;
        const quiet = harness({ config: { watching: true }, stopped: () => stopped, account: async () => { stopped = true; throw new Error('凭证读不了'); } });
        await quiet.jobs.watchJob();
        assert.deepEqual(quiet.logs, []);
    });

    test('被动读取停了：派好的这一轮不再做', async () => {
        let opened = 0;
        const h = harness({ config: { watching: true }, account: async () => { opened++; return account(); } });
        h.passive.stop();
        await h.jobs.watchJob();
        assert.equal(opened, 0);
        assert.deepEqual(h.watched, []);
    });
});

describe('刷推荐（feedJob）', () => {
    test('没开（watching 或 bilibili 关着）/ 停了：不刷', async () => {
        for (const h of [harness(), harness({ config: { bilibili: 'on' } }), harness({ config: { watching: true, bilibili: 'off' } }), harness({ config: { watching: true, bilibili: 'dryRun' }, stopped: () => true })]) {
            await h.jobs.feedJob();
            assert.deepEqual(h.fetches, []);
        }
    });

    test('醒着、过了 14 点：经被动读取去拉推荐（带停的 signal）；读不到就记一行跳过', async () => {
        const h = harness({ config: { watching: true, bilibili: 'dryRun' }, now: at(15) });
        await h.jobs.feedJob();
        assert.ok(h.fetches.length >= 1);
        assert.equal(h.fetches[0]!.signal.aborted, false);
        h.passive.stop();
        assert.equal(h.fetches[0]!.signal.aborted, true, '停的时候请求的 signal 一起取消');
        assert.ok(h.logs.some(l => l.startsWith('刷 B 站：推荐读不到')));
    });

    test('按作息她在上课：不刷；同一刻没有作息卡就不看作息、照刷', async () => {
        // 合成作息：2026-11-23（周一）15:30 在上课
        const inClass = new Date(2026, 10, 23, 15, 30).getTime();
        const busy = harness({ config: { watching: true, bilibili: 'on' }, now: inClass });
        await busy.jobs.feedJob();
        assert.deepEqual(busy.fetches, []);
        const noSchedule = harness({ config: { watching: true, bilibili: 'on' }, now: inClass, worldCard: null });
        await noSchedule.jobs.feedJob();
        assert.ok(noSchedule.fetches.length >= 1);
    });

    test('不到 14 点：不刷', async () => {
        const h = harness({ config: { watching: true, bilibili: 'on' }, now: at(10) });
        await h.jobs.feedJob();
        assert.deepEqual(h.fetches, []);
    });

    test('同一时间只刷一轮', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let calls = 0;
        const h = harness({ config: { watching: true, bilibili: 'dryRun' }, fetch: async () => { calls++; await gate; return { ok: false, status: 503, text: async () => '' }; } });
        const first = h.jobs.feedJob();
        await tick();
        await h.jobs.feedJob();
        assert.equal(calls, 1);
        release();
        await first;
    });
});

describe('学网络热梗（refreshMemeJob）', () => {
    test('门槛：没开 memes、停了、没有 B 站号：不学', async () => {
        for (const h of [harness(), harness({ config: { memes: true }, stopped: () => true }), harness({ config: { memes: true }, noAccountSource: true })]) {
            await h.jobs.refreshMemeJob();
            assert.deepEqual(h.logs, []);
        }
    });

    test('刚刷过（还没到 6 小时）：不学', async () => {
        let opened = 0;
        const h = harness({ config: { memes: true }, account: async () => { opened++; return undefined; } });
        saveMemes(memesPath(h.dir), { version: 1, refreshedAt: new Date(at(14)).toISOString(), entries: [] });
        await h.jobs.refreshMemeJob();
        assert.deepEqual(h.logs, []);
        assert.equal(opened, 0);
    });

    test('热梗库坏了：保留原库、跳过这一轮，记一行（不重建）', async () => {
        const h = harness({ config: { memes: true } });
        mkdirSync(join(h.dir, 'memes'), { recursive: true });
        writeFileSync(memesPath(h.dir), '{"version":1,"entries":[');
        await h.jobs.refreshMemeJob();
        assert.equal(h.logs.length, 1);
        assert.match(h.logs[0]!, /^网络热梗：本轮保留原库并跳过刷新/);
        assert.equal(readFileSync(memesPath(h.dir), 'utf8'), '{"version":1,"entries":[');
    });

    test('B 站号这会儿打不开：下次再学，不拉榜单', async () => {
        let listed = 0;
        globalThis.fetch = (async () => { listed++; throw new Error('不该出网'); }) as typeof fetch;
        const h = harness({ config: { memes: true } });
        await h.jobs.refreshMemeJob();
        assert.deepEqual(h.logs, ['网络热梗：她的 B 站号这会儿打不开，下次再学']);
        assert.equal(listed, 0);
    });

    test('有账号：去拉四个榜（这里全读不到），这一轮不动库；榜单请求带着停的 signal', async () => {
        const urls: string[] = [];
        const signals: AbortSignal[] = [];
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { urls.push(String(url)); if (init?.signal) signals.push(init.signal); return new Response('', { status: 503 }); }) as typeof fetch;
        const h = harness({ config: { memes: true }, account: async () => account() });
        await h.jobs.refreshMemeJob();
        assert.ok(urls.some(u => u.includes('bilibili.com')));
        assert.ok(h.logs.includes('网络热梗：四个榜都没读到，这一轮不动'));
        assert.deepEqual(h.fetches, [], '榜单不走注入的 B 站 fetch（见报告：测试接缝）');
        h.passive.stop();
        assert.ok(signals.length > 0 && signals.every(s => s.aborted), '停的时候榜单请求也被取消');
    });

    test('同一时间只学一轮', async () => {
        let release!: (value: BiliAccount | undefined) => void;
        let opened = 0;
        const h = harness({ config: { memes: true }, account: () => { opened++; return new Promise(resolve => { release = resolve; }); } });
        const first = h.jobs.refreshMemeJob();
        await tick();
        await h.jobs.refreshMemeJob();
        assert.equal(opened, 1);
        release(undefined);
        await first;
    });
});
