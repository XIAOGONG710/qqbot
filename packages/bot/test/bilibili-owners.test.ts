import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { bilibiliOwners, type BilibiliOwners, type BilibiliOwnersDeps } from '../src/bilibili/owners.ts';
import { DEFAULTS, type AppConfig, type Contact } from '../src/platform/config.ts';
import { loadTierCard, type TierCard } from '../src/platform/contact.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 她在 B 站那几样的外壳（bilibili/owners.ts）：配没配好、用哪张卡写公开的话、各自起停、坏状态不拖垮连接回调。
// 网络一律假的（注入的 request / fetch 只记调用，不出网）；只用合成角色卡。
const dirs: string[] = [];
const dataDir = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-bili-owners-')); dirs.push(d); return d; };
const started: BilibiliOwners[] = [];
afterEach(async () => {
    for (const owners of started.splice(0)) await Promise.all([owners.stopBrowsing(), owners.stopRisk(), owners.stopReplies()]);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HIM: Contact = { qq: 1001, name: '他', tier: 'boyfriend' };
const FRIEND: Contact = { qq: 1002, name: '同学', tier: 'classmate' };
const boyfriendCard = loadTierCard(syntheticCardPattern, 'boyfriend');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

interface Options {
    config?: Partial<AppConfig>;
    stopped?: () => boolean;
    worldCard?: TierCard['character'] | null;
    cardFor?: (tier: string) => TierCard;
    injectRequest?: boolean;
    decorateThrows?: boolean;
}
function harness(options: Options = {}) {
    const dir = dataDir();
    const logs: string[] = [];
    const cardsAsked: string[] = [];
    const requests: string[] = [];
    const fetches: string[] = [];
    let decorated = 0, guarded = 0;
    const config = { ...DEFAULTS, dataDir: dir, herDays: false, contacts: [HIM, FRIEND], ...options.config } as unknown as AppConfig;
    const deps: BilibiliOwnersDeps = {
        config,
        stopped: options.stopped ?? (() => false),
        log: line => { logs.push(line); },
        worldNow: () => Date.UTC(2026, 10, 24, 6, 0),
        cardFor: tier => { cardsAsked.push(tier); return (options.cardFor ?? (t => loadTierCard(syntheticCardPattern, t)))(tier); },
        worldCard: options.worldCard === null ? undefined : options.worldCard ?? boyfriendCard.character,
        bedtimes: () => [],
        exec: { llm: async () => '' },
        chatHistory: { append: () => {} },
        transport: { sendPrivateText: async () => 1 },
        responders: new Map(),
        decorateAccounts: source => { decorated++; if (options.decorateThrows) throw new Error('时间线状态坏了'); return source; },
        ownAccountGuard: request => { guarded++; return request; },
        bilibiliRequest: options.injectRequest === false ? undefined : async url => { requests.push(url); throw new Error('测试里不出网'); },
        bilibiliFetch: async url => { fetches.push(url); return { ok: false, status: 503, text: async () => '' }; },
    };
    const owners = bilibiliOwners(deps);
    started.push(owners);
    return { owners, dir, logs, cardsAsked, requests, fetches, counts: () => ({ decorated, guarded }) };
}
const full = { bilibiliAccount: true, bilibiliAtName: '他的B站名', bilibiliAtUid: 42 } as const;

describe('她的 B 站号（accountSource）', () => {
    test('没开 bilibiliAccount：没有账号来源', () => {
        const h = harness();
        assert.equal(h.owners.accountSource(), undefined);
        assert.deepEqual(h.counts(), { decorated: 0, guarded: 0 });
    });

    test('开了：建一次、之后复用同一个；注入了假请求就不包熔断守卫', () => {
        const h = harness({ config: { bilibiliAccount: true } });
        const source = h.owners.accountSource();
        assert.ok(source);
        assert.equal(h.owners.accountSource(), source);
        assert.deepEqual(h.counts(), { decorated: 1, guarded: 0 });
    });

    test('没注入请求（真的）：外面包一层她自己账号的守卫；建的时候不出网', () => {
        const h = harness({ config: { bilibiliAccount: true }, injectRequest: false });
        assert.ok(h.owners.accountSource());
        assert.deepEqual(h.counts(), { decorated: 1, guarded: 1 });
        assert.deepEqual(h.requests, []);
    });

    test('没有凭证文件：打开时记一次日志、不请求 B 站、不记凭证内容；停了之后不再记日志', async () => {
        const h = harness({ config: { bilibiliAccount: true } });
        assert.equal(await h.owners.accountSource()!(), undefined);
        assert.equal(h.logs.length, 1);
        assert.match(h.logs[0]!, /没有凭证文件/);
        assert.deepEqual(h.requests, []);
        let stopped = false;
        const quiet = harness({ config: { bilibiliAccount: true }, stopped: () => stopped });
        stopped = true;
        await quiet.owners.accountSource()!();
        assert.deepEqual(quiet.logs, []);
    });
});

describe('各自启动（startOwners）', () => {
    test('全关着：什么都不起，三个 stop 都是空的', () => {
        const h = harness();
        h.owners.startOwners();
        assert.deepEqual(h.logs, []);
        assert.equal(h.owners.stopBrowsing(), undefined);
        assert.equal(h.owners.stopRisk(), undefined);
        assert.equal(h.owners.stopReplies(), undefined);
    });

    test('已经停了：一样都不起', () => {
        const h = harness({ stopped: () => true, config: { bilibili: 'dryRun', bilibiliReplies: 'dryRun', ...full } });
        h.owners.startOwners();
        assert.deepEqual(h.logs, []);
        assert.equal(h.owners.stopBrowsing(), undefined);
    });

    test('刷 B 站：没有男朋友档的人或没有作息就不起', () => {
        const noTarget = harness({ config: { bilibili: 'on', contacts: [FRIEND] } });
        noTarget.owners.startOwners();
        assert.deepEqual(noTarget.logs, ['刷 B 站：没有男朋友档的联系人或没有作息，不启动']);
        assert.equal(noTarget.owners.stopBrowsing(), undefined);
        const noSchedule = harness({ config: { bilibili: 'on' }, worldCard: null });
        noSchedule.owners.startOwners();
        assert.deepEqual(noSchedule.logs, ['刷 B 站：没有男朋友档的联系人或没有作息，不启动']);
    });

    test('刷 B 站（试运行、没开账号）：只发给男朋友档的人、只读热门榜；再 start 不重起', async () => {
        const h = harness({ config: { bilibili: 'dryRun' } });
        h.owners.startOwners();
        h.owners.startOwners();
        const started = h.logs.filter(l => l.startsWith('刷 B 站：'));
        assert.deepEqual(started, ['刷 B 站：只写草稿（不发），发给 他；一周最多 3 个，读 B 站热门榜（公开接口，不登录）']);
        assert.ok(h.owners.stopBrowsing());
        assert.deepEqual(h.cardsAsked, [], '不评论就不读公开用的卡');
        await flush();
    });

    test('评论开着但没配好：分别说明缺什么，不评论（也不起风险监控）', () => {
        const noAccount = harness({ config: { bilibili: 'dryRun', bilibiliComment: 'dryRun' } });
        noAccount.owners.startOwners();
        assert.ok(noAccount.logs.includes('刷 B 站：bilibiliComment 开着，但要 bilibiliAccount 也开着才能评论，不评论'));
        const noTarget = harness({ config: { bilibili: 'dryRun', bilibiliComment: 'dryRun', bilibiliAccount: true } });
        noTarget.owners.startOwners();
        assert.ok(noTarget.logs.includes('刷 B 站：bilibiliComment 开着，但没填 bilibiliAtName / bilibiliAtUid（要 @ 的人），不评论'));
        assert.equal(noTarget.owners.stopRisk(), undefined);
    });

    test('隐私：评论用最低隐私档的卡（陌生人档，读不了用同学档），两张都读不了就不评论；绝不用男朋友档', () => {
        const fallback = harness({ config: { bilibili: 'dryRun', bilibiliComment: 'dryRun', ...full }, cardFor: tier => { if (tier === 'stranger') throw new Error('没有'); return loadTierCard(syntheticCardPattern, tier); } });
        fallback.owners.startOwners();
        assert.deepEqual(fallback.cardsAsked, ['stranger', 'classmate']);
        const none = harness({ config: { bilibili: 'dryRun', bilibiliComment: 'dryRun', ...full }, cardFor: () => { throw new Error('读不了'); } });
        none.owners.startOwners();
        assert.deepEqual(none.cardsAsked, ['stranger', 'classmate']);
        assert.ok(none.logs.includes('刷 B 站：陌生人档和同学档的卡都读不了，不评论'));
        assert.ok(!none.cardsAsked.includes('boyfriend'));
    });

    test('评论配好了：起风险监控（评论和回复共用），刷 B 站的开场白写明评论并 @ 谁', () => {
        const h = harness({ config: { bilibili: 'dryRun', bilibiliComment: 'dryRun', ...full } });
        h.owners.startOwners();
        assert.ok(h.logs.some(l => l.startsWith('B 站风险：公开评论 / 回复开着')));
        assert.match(h.logs.find(l => l.startsWith('刷 B 站：只写草稿'))!, /用她的 B 站号按口味搜.*分享后在视频下评论并 @ 他的B站名（只写草稿）/);
        assert.ok(h.owners.stopRisk());
        assert.deepEqual(h.cardsAsked, ['stranger']);
    });

    test('私信：没开账号、没填 uid 时说明不发；配好了开场白写明改在 B 站私信', () => {
        const noAccount = harness({ config: { bilibili: 'dryRun', bilibiliDm: 'on' } });
        noAccount.owners.startOwners();
        assert.ok(noAccount.logs.includes('刷 B 站：bilibiliDm 开着，但要 bilibiliAccount 也开着才能发私信，不发私信'));
        const noUid = harness({ config: { bilibili: 'dryRun', bilibiliDm: 'on', bilibiliAccount: true } });
        noUid.owners.startOwners();
        assert.ok(noUid.logs.includes('刷 B 站：bilibiliDm 开着，但没填 bilibiliAtUid（收私信的人的 B 站 uid），不发私信'));
        const ok = harness({ config: { bilibili: 'on', bilibiliDm: 'dryRun', ...full } });
        ok.owners.startOwners();
        assert.match(ok.logs.find(l => l.startsWith('刷 B 站：开'))!, /改在 B 站给他发私信（只写草稿），QQ 上只提醒一句/);
        assert.equal(ok.owners.stopRisk(), undefined, '只开私信不起风险监控');
    });

    test('回复评论：没开账号、没填 uid、卡读不了都说明不回', () => {
        const noAccount = harness({ config: { bilibiliReplies: 'dryRun' } });
        noAccount.owners.startOwners();
        assert.deepEqual(noAccount.logs, ['回复 B 站评论：bilibiliReplies 开着，但要 bilibiliAccount 也开着，不回复']);
        const noUid = harness({ config: { bilibiliReplies: 'dryRun', bilibiliAccount: true } });
        noUid.owners.startOwners();
        assert.deepEqual(noUid.logs, ['回复 B 站评论：bilibiliReplies 开着，但没填 bilibiliAtUid（先回谁），不回复']);
        const noCard = harness({ config: { bilibiliReplies: 'dryRun', ...full }, cardFor: () => { throw new Error('读不了'); } });
        noCard.owners.startOwners();
        assert.ok(noCard.logs.includes('回复 B 站评论：陌生人档和同学档的卡都读不了，不回复'));
        assert.equal(noCard.owners.stopReplies(), undefined);
    });

    test('回复评论配好了：单独起（不管刷视频开没开），也起风险监控；再 start 不重起', () => {
        const h = harness({ config: { bilibiliReplies: 'dryRun', ...full } });
        h.owners.startOwners();
        h.owners.startOwners();
        assert.equal(h.logs.filter(l => l.startsWith('回复 B 站评论：只写草稿（不发）')).length, 1);
        assert.equal(h.logs.filter(l => l.startsWith('B 站风险：')).length, 1);
        assert.ok(h.owners.stopReplies());
        assert.ok(h.owners.stopRisk());
        assert.equal(h.owners.stopBrowsing(), undefined);
    });

    test('关键状态坏了（风险状态文件损坏）：两项都暂停启动并记日志，不抛给连接回调，原文件不动', () => {
        const h = harness({ config: { bilibili: 'dryRun', bilibiliComment: 'dryRun', bilibiliReplies: 'dryRun', ...full } });
        mkdirSync(join(h.dir, 'presence'), { recursive: true });
        const riskFile = join(h.dir, 'presence', 'bilibili-risk.json');
        writeFileSync(riskFile, '{"version":1,"seen":');
        assert.doesNotThrow(() => h.owners.startOwners());
        assert.equal(h.logs.filter(l => l.startsWith('B 站后台状态不可用，保留原文件并暂停本项启动')).length, 2);
        assert.equal(h.owners.stopBrowsing(), undefined);
        assert.equal(h.owners.stopReplies(), undefined);
        assert.equal(readFileSync(riskFile, 'utf8'), '{"version":1,"seen":');
    });

    test('账号装饰出错：同样只记日志、不抛；日志只记错误类别，不记错误正文', () => {
        const h = harness({ config: { bilibili: 'dryRun', bilibiliReplies: 'dryRun', ...full }, decorateThrows: true });
        assert.doesNotThrow(() => h.owners.startOwners());
        assert.deepEqual(h.logs, Array(2).fill('B 站后台状态不可用，保留原文件并暂停本项启动（Error）'));
        assert.ok(h.logs.every(l => !l.includes('时间线状态坏了')));
    });
});
