import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { formatDate, herDay, stateAt } from '../src/life/schedule.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { DEFAULTS, type AppConfig, type Contact } from '../src/platform/config.ts';
import { loadTierCard, type TierCard } from '../src/platform/contact.ts';
import { POKE_OUT_TEXT } from '../src/social/pokes.ts';
import { pokeOutPlan, POKE_OUT_LATEST, type PresenceTransport } from '../src/social/presence.ts';
import { presenceOwner, type PresenceOwnerDeps } from '../src/social/presence-owner.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 存在感的外壳（social/presence-owner.ts）：起不起、用哪张卡写说说、给存在感的名单（点赞 / 看空间 / 戳谁）、戳他前看危机暂停。
// 只用合成角色卡；QQ 通道、模型、时钟都是假的。
const dirs: string[] = [];
const dataDir = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-presence-owner-')); dirs.push(d); return d; };
const owners: { stop(): Promise<void> | undefined }[] = [];
afterEach(async () => { for (const owner of owners.splice(0)) await owner.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const HIM: Contact = { qq: 1001, name: '他', tier: 'boyfriend' };
const FRIEND: Contact = { qq: 1002, name: '同学甲', tier: 'classmate' };
const OTHER: Contact = { qq: 1003, name: '同学乙', tier: 'classmate' };
const boyfriendCard = loadTierCard(syntheticCardPattern, 'boyfriend');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

/** 一个她醒着、没课的本地时刻 */
function freeMoment(hour: number): number {
    const schedule = boyfriendCard.character.schedule!;
    for (let day = 0; day < 60; day++) {
        const at = new Date(2026, 10, 2 + day, hour, 0);
        const kind = stateAt(schedule, at).activity.kind;
        if (kind === 'free' || kind === 'between') return at.getTime();
    }
    throw new Error('合成作息里找不到空闲时刻');
}

interface Options {
    config?: Partial<AppConfig>;
    now?: number;
    worldCard?: TierCard['character'] | undefined | null;
    cardFor?: (tier: string) => TierCard;
    dormant?: boolean;
    paused?: (qq: number, now: number) => boolean;
    rows?: StoredMessage[];
}
function harness(options: Options = {}) {
    const dir = dataDir();
    const logs: string[] = [];
    const calls: string[] = [];
    const cardsAsked: string[] = [];
    const rows = new Map<number, StoredMessage[]>([[HIM.qq, options.rows ?? []]]);
    const transport: PresenceTransport = {
        setOnlineStatus: async (status, ext) => { calls.push(`status:${status}:${ext}`); },
        sendLike: async (qq, times) => { calls.push(`like:${qq}:${times}`); },
        readUserQzone: async uin => { calls.push(`peek:${uin}`); return []; },
        pokeFriend: async qq => { calls.push(`poke:${qq}`); },
    };
    const config = { ...DEFAULTS, dataDir: dir, herDays: false, contacts: [HIM, FRIEND, OTHER], ...options.config } as unknown as AppConfig;
    const deps: PresenceOwnerDeps = {
        config, log: line => { logs.push(line); },
        worldNow: () => options.now ?? freeMoment(14),
        cardFor: tier => { cardsAsked.push(tier); return (options.cardFor ?? (t => loadTierCard(syntheticCardPattern, t)))(tier); },
        worldCard: options.worldCard === null ? undefined : options.worldCard ?? boyfriendCard.character,
        bedtimes: () => [],
        exec: { llm: async () => '' },
        chatHistory: { load: qq => rows.get(qq) ?? [], append: (qq, row) => { rows.set(qq, [...rows.get(qq) ?? [], row]); } },
        transport,
        vision: undefined,
        rainyAt: () => false,
        dormancy: options.dormant === undefined ? undefined : { isDormant: () => options.dormant! },
        crisisState: { pausedAt: options.paused ?? (() => false) },
    };
    const owner = presenceOwner(deps);
    owners.push(owner);
    return { owner, dir, logs, calls, cardsAsked, rows };
}

describe('存在感起不起', () => {
    test('一个开关都没开：不起、不建目录、不读卡；selfNote / reapply / stop 都是空操作', () => {
        const h = harness();
        h.owner.start();
        assert.equal(existsSync(join(h.dir, 'presence')), false);
        assert.deepEqual(h.logs, []);
        assert.deepEqual(h.cardsAsked, []);
        assert.equal(h.owner.selfNote(Date.now()), undefined);
        assert.doesNotThrow(() => h.owner.reapply());
        assert.equal(h.owner.stop(), undefined);
    });

    test('开了但没有作息（herDays 关、卡上没作息）：记一行原因，不起', () => {
        const h = harness({ config: { qqPresence: true }, worldCard: null });
        h.owner.start();
        assert.match(h.logs[0]!, /存在感：没有作息/);
        assert.equal(existsSync(join(h.dir, 'presence')), false);
        assert.deepEqual(h.calls, []);
    });

    test('开了在线状态：起来就按作息挂一次在线状态；再 start 不重起；selfNote 可用', async () => {
        const h = harness({ config: { qqPresence: true } });
        h.owner.start();
        h.owner.start();
        await flush();
        assert.equal(h.calls.filter(c => c.startsWith('status:')).length, 1);
        assert.equal(h.logs.filter(l => l.startsWith('存在感：')).length, 1);
        assert.match(h.logs.find(l => l.startsWith('存在感：'))!, /^存在感：在线状态、资料卡点赞、主动戳他$/, '三项都跟着 qqPresence（开关合并）');
        assert.equal(existsSync(join(h.dir, 'presence', 'presence.json')), true);
        assert.equal(h.owner.selfNote(Date.now()), undefined, '还没真改签名、没发说说，没有可说的');
        await h.owner.stop();
    });

    test('休眠中：起了也什么都不动', async () => {
        const h = harness({ config: { qqPresence: true }, dormant: true });
        h.owner.start();
        await flush();
        assert.deepEqual(h.calls, []);
    });

    test('reapply：醒来、重连后重新挂一次在线状态', async () => {
        const h = harness({ config: { qqPresence: true } });
        h.owner.start();
        await flush();
        h.owner.reapply();
        await flush();
        assert.equal(h.calls.filter(c => c.startsWith('status:')).length, 2);
    });
});

describe('说说用哪张卡（隐私：公开的地方用最低隐私档）', () => {
    test('先用陌生人档；开日志写明试运行、仅好友可见', () => {
        const h = harness({ config: { qzone: 'dryRun' } });
        h.owner.start();
        assert.deepEqual(h.cardsAsked, ['stranger']);
        assert.match(h.logs.at(-1)!, /说说（只写草稿，仅好友可见）/);
    });

    test('陌生人档读不了用同学档；绝不退到男朋友档', () => {
        const h = harness({ config: { qzone: 'on', qzoneVisibility: 'public' }, cardFor: tier => { if (tier === 'stranger') throw new Error('没有'); return loadTierCard(syntheticCardPattern, tier); } });
        h.owner.start();
        assert.deepEqual(h.cardsAsked, ['stranger', 'classmate']);
        assert.match(h.logs.at(-1)!, /说说（真发，所有人可见）/);
    });

    test('两张都读不了：不写说说（其余照起），日志说明', () => {
        const h = harness({ config: { qzone: 'on', qqPresence: true }, cardFor: () => { throw new Error('读不了'); } });
        h.owner.start();
        assert.deepEqual(h.cardsAsked, ['stranger', 'classmate']);
        assert.ok(h.logs.includes('存在感：陌生人档和同学档的卡都读不了，不写说说'));
        // qzone 开着时签名、翻空间等跟着起（开关合并），只是没有说说
        assert.equal(h.logs.at(-1), '存在感：在线状态、资料卡点赞、主动戳他、个性签名（真改）、翻空间（记进提示词）、看好友空间（记进提示词）、刷陌生人（记进提示词 + 留样本）', '起来的清单里没有说说');
    });
});

describe('名单：点赞、看空间、戳他', () => {
    test('看好友空间只看用户点名的人（qqAllowFriends），名单里别的人不看', async () => {
        const h = harness({ config: { qzone: 'dryRun', qqAllowFriends: [OTHER.qq] } });
        h.owner.start();
        await flush();
        assert.deepEqual(h.calls.filter(c => c.startsWith('peek:')), [`peek:${OTHER.qq}`]);
        assert.match(h.logs.find(l => l.startsWith('存在感：'))!, /看好友空间（只写草稿）/);
    });

    test('没点名任何人：一个空间都不看', async () => {
        const h = harness({ config: { qzone: 'on' } });
        h.owner.start();
        await flush();
        assert.deepEqual(h.calls.filter(c => c.startsWith('peek:')), []);
    });

    // 戳他：找一个这天要戳、她醒着、已过了点的时刻
    function pokeMoment(): number {
        const schedule = boyfriendCard.character.schedule!;
        for (let day = 0; day < 120; day++) {
            const base = new Date(2026, 10, 2 + day, 12, 0);
            const plan = pokeOutPlan(formatDate(herDay(schedule, base)), base.getDay() === 0 || base.getDay() === 6);
            if (!plan) continue;
            const minutes = Math.min(plan.minutes + 5, POKE_OUT_LATEST);
            const at = new Date(2026, 10, 2 + day, Math.floor(minutes / 60), minutes % 60);
            const kind = stateAt(schedule, at).activity.kind;
            if (kind === 'free' || kind === 'between') return at.getTime();
        }
        throw new Error('合成作息里找不到能戳的时刻');
    }
    const quietRows = (now: number): StoredMessage[] => [{ time: new Date(now - 5 * 3_600_000).toISOString(), role: 'assistant', content: '我去看书啦', messageId: 1 }];

    test('只戳男朋友档的人；戳完记进聊天记录', async () => {
        const now = pokeMoment();
        const h = harness({ config: { qqPresence: true }, now, rows: quietRows(now) });
        h.owner.start();
        await flush();
        assert.deepEqual(h.calls.filter(c => c.startsWith('poke:')), [`poke:${HIM.qq}`]);
        assert.equal(h.rows.get(HIM.qq)!.at(-1)!.content, POKE_OUT_TEXT);
        assert.equal(h.rows.get(HIM.qq)!.at(-1)!.role, 'assistant');
    });

    test('在危机暂停里不戳他', async () => {
        const now = pokeMoment();
        const asked: number[] = [];
        const h = harness({ config: { qqPresence: true }, now, rows: quietRows(now), paused: qq => { asked.push(qq); return true; } });
        h.owner.start();
        await flush();
        assert.deepEqual(asked, [HIM.qq]);
        assert.deepEqual(h.calls.filter(c => c.startsWith('poke:')), []);
        assert.equal(h.rows.get(HIM.qq)!.length, 1, '没记戳过');
    });

    test('聊天没安静下来（最后一条是他说的）不戳', async () => {
        const now = pokeMoment();
        const h = harness({ config: { qqPresence: true }, now, rows: [{ time: new Date(now - 5 * 3_600_000).toISOString(), role: 'user', content: '在忙吗', messageId: 1 }] });
        h.owner.start();
        await flush();
        assert.deepEqual(h.calls.filter(c => c.startsWith('poke:')), []);
    });
});
