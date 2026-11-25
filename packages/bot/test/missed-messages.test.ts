import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import type { HistoryMessage } from '../src/memory/backfill.ts';
import { ChatHistory, type StoredMessage } from '../src/memory/history.ts';
import type { Contact } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { missedMessages, type MissedMessagesDeps } from '../src/platform/missed-messages.ts';
import type { Segment } from '../src/platform/onebot.ts';
import { quotedContext } from '../src/platform/quoted-context.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 连上之后补回漏掉的消息、补回复（platform/missed-messages.ts）：聊天记录用真的（临时目录），NapCat、回复器、收据那一套用假的。
const dirs: string[] = [];
const dataDir = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-missed-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); mock.timers.reset(); });

const SELF = 9000;
const HIM: Contact = { qq: 1001, name: '他', tier: 'boyfriend' };
const FRIEND: Contact = { qq: 1002, name: '同学', tier: 'classmate' };
const nowSeconds = () => Math.floor(Date.now() / 1000);
const text = (value: string): Segment[] => [{ type: 'text', data: { text: value } }];
let nextId = 500;
const qqMessage = (from: number, message: Segment[] | string, secondsAgo = 60, id = nextId++): HistoryMessage => ({ message_id: id, time: nowSeconds() - secondsAgo, sender: { user_id: from }, message });

interface Options {
    contacts?: Contact[];
    fetched?: Record<number, HistoryMessage[] | Error>;
    stopped?: () => boolean;
    since?: Date;
    tracks?: boolean;
    sensitive?: boolean;
    feedback?: (qq: number, message: Segment[] | string) => boolean;
    stickers?: boolean;
    reader?: { needs: (m: Segment[] | string) => boolean; read: (m: Segment[] | string) => Promise<Segment[] | string> };
    callAction?: (action: string, params: Record<string, unknown>) => Promise<unknown>;
    schedule?: boolean;
    onFetch?: () => void;
    now?: () => number;
}
function harness(options: Options = {}) {
    const dir = dataDir();
    const chatHistory = new ChatHistory(dir);
    const logs: string[] = [];
    const failures: unknown[] = [];
    const crises: { qq: number; at: number; level: string }[] = [];
    const claims: string[] = [], releases: string[] = [];
    const stickers: { from: number; messageId: number }[] = [];
    const caughtUp: number[] = [];
    const cardsAsked: string[] = [];
    const friendHistoryCalls: [number, number][] = [];
    const activeIncoming = new Map<string, number>();
    const bufferedIncomingIds = new Set<string>();
    const contacts = options.contacts ?? [HIM];
    const quoted = quotedContext({ transport: options.callAction ? { callAction: options.callAction } : {}, history: chatHistory, selfId: () => SELF, log: line => { logs.push(line); } });
    const deps: MissedMessagesDeps = {
        config: { contacts, schedule: options.schedule ?? false },
        stopped: options.stopped ?? (() => false),
        ...(options.now ? { now: options.now } : {}),
        transport: {
            friendHistory: async (qq, count) => {
                friendHistoryCalls.push([qq, count]);
                options.onFetch?.();
                const got = options.fetched?.[qq] ?? [];
                if (got instanceof Error) throw got;
                return got;
            },
        },
        history: chatHistory,
        chatHistory,
        tierRecord: { since: () => options.since },
        feedback: options.feedback ? ({ consume: (qq: number, _tier: string, message: Segment[] | string) => options.feedback!(qq, message) } as unknown as MissedMessagesDeps['feedback']) : undefined,
        collectingStickers: options.stickers ? ({ consider: async (_m: unknown, source: { from: number; messageId: number }) => { stickers.push(source); } } as unknown as MissedMessagesDeps['collectingStickers']) : undefined,
        ownStickerWork: async work => { await work(new AbortController().signal); },
        readerFor: () => options.reader as ReturnType<MissedMessagesDeps['readerFor']>,
        incoming: {
            recoverIncoming: async () => 0,
            incomingFailure: error => { failures.push(error); },
            tracksIncoming: () => options.tracks ?? false,
            activeIncoming, bufferedIncomingIds,
            claimIncoming: id => { claims.push(id); return activeIncoming; },
            releaseIncoming: id => { releases.push(id); },
        },
        quoted,
        markCrisis: (qq, at, level) => { crises.push({ qq, at, level }); },
        sensitive: { on: () => options.sensitive ?? false },
        cardFor: tier => { cardsAsked.push(tier); return loadTierCard(syntheticCardPattern, tier); },
        responders: new Map(contacts.map(c => [c.qq, { catchUp: () => { caughtUp.push(c.qq); } }])),
        log: line => { logs.push(line); },
    };
    const missed = missedMessages(deps);
    return { missed, chatHistory, logs, failures, crises, claims, releases, stickers, caughtUp, cardsAsked, friendHistoryCalls, activeIncoming, bufferedIncomingIds };
}
const contents = (rows: StoredMessage[]) => rows.map(m => `${m.role}:${m.content}`);

describe('补回漏掉的消息（syncMissed）', () => {
    test('手动代发不入聊天账，也不盖住仍待回复的本人消息', async () => {
        const h = harness({ fetched: { [HIM.qq]: [
            qqMessage(HIM.qq, '还等她回', 30),
            qqMessage(SELF, text('【本人手动代发】代发正文'), 20),
        ] } });
        await h.missed.syncMissed(SELF);
        await h.missed.catchUpAll();
        assert.deepEqual(contents(h.chatHistory.load(HIM.qq)), ['user:还等她回']);
        assert.deepEqual(h.caughtUp, [HIM.qq]);
        assert.ok(h.logs.every(line => !line.includes('代发正文')));
    });
    test('他发的、她在别处发的都按时间补进记录；问 NapCat 要 20 条；日志默认只记条数和字数，不记正文', async () => {
        const h = harness({ fetched: { [HIM.qq]: [qqMessage(HIM.qq, text('第二条'), 30), qqMessage(HIM.qq, text('第一条'), 90), qqMessage(SELF, text('她回的'), 20)] } });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(h.friendHistoryCalls, [[HIM.qq, 20]]);
        assert.deepEqual(contents(h.chatHistory.load(HIM.qq)), ['user:第一条', 'user:第二条', 'assistant:她回的']);
        assert.equal(h.chatHistory.load(HIM.qq)[2]!.sourceTime !== undefined, true, '她的那条带 QQ 源时间');
        assert.deepEqual(h.logs, [`[${HIM.qq}] 补回 3 条漏掉的消息：2 条是对方的，1 条是她的（共 9 字）`]);
        assert.ok(h.logs.every(l => !l.includes('第一条')));
    });

    test('敏感日志开着时才把补回的正文写进日志', async () => {
        const h = harness({ sensitive: true, fetched: { [HIM.qq]: [qqMessage(HIM.qq, text('想你了'), 30), qqMessage(SELF, text('我也是'), 20)] } });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(h.logs, [`[${HIM.qq}] 补回 2 条漏掉的消息：对方：想你了 / 她：我也是`]);
    });

    test('已经在记录里的不重复补；再跑一遍什么都不加、不记日志', async () => {
        const first = qqMessage(HIM.qq, text('只有一条'), 30);
        const h = harness({ fetched: { [HIM.qq]: [first] } });
        await h.missed.syncMissed(SELF);
        await h.missed.syncMissed(SELF);
        assert.deepEqual(contents(h.chatHistory.load(HIM.qq)), ['user:只有一条']);
        assert.equal(h.logs.length, 1);
    });

    test('拉历史失败（没有聊天记录时 NapCat 也报错）：记一行日志，接着补下一个人', async () => {
        const h = harness({ contacts: [HIM, FRIEND], fetched: { [HIM.qq]: new Error('消息不存在'), [FRIEND.qq]: [qqMessage(FRIEND.qq, text('明天交作业'), 30)] } });
        await h.missed.syncMissed(SELF);
        assert.match(h.logs[0]!, /\[1001\] 拉取历史消息失败，跳过补回：消息不存在/);
        assert.deepEqual(contents(h.chatHistory.load(FRIEND.qq)), ['user:明天交作业']);
        assert.deepEqual(h.failures, []);
    });

    test('停了：一个人都不拉', async () => {
        const h = harness({ stopped: () => true, fetched: { [HIM.qq]: [qqMessage(HIM.qq, text('x'))] } });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(h.friendHistoryCalls, []);
    });

    test('拉历史时停了：不补、不记日志', async () => {
        let stopped = false;
        const h = harness({ stopped: () => stopped, onFetch: () => { stopped = true; }, fetched: { [HIM.qq]: [qqMessage(HIM.qq, text('x'))] } });
        await h.missed.syncMissed(SELF);
        assert.equal(h.friendHistoryCalls.length, 1);
        assert.deepEqual(h.chatHistory.load(HIM.qq), []);
        assert.deepEqual(h.logs, []);
    });

    test('隐私：换档之前的消息不补回（降档后旧记录归档了，不能从 QQ 里再拿回来）', async () => {
        const since = new Date(Date.now() - 60_000);
        const h = harness({ since, fetched: { [HIM.qq]: [qqMessage(HIM.qq, text('换档前'), 3600), qqMessage(HIM.qq, text('换档后'), 10)] } });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(contents(h.chatHistory.load(HIM.qq)), ['user:换档后']);
    });

    test('补回的话里有想伤害自己的意思：记一笔危机，时间按他说话的时候', async () => {
        const message = qqMessage(HIM.qq, text('我不想活了'), 120);
        const h = harness({ fetched: { [HIM.qq]: [message] } });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(h.crises.map(c => [c.qq, c.at]), [[HIM.qq, message.time * 1000]]);
    });

    test('记录里已经有的近期危机话（上次中断前存下的）：补回前也重新记一笔；她说的、太久以前的不算', async () => {
        const h = harness();
        const recent = new Date(Date.now() - 60_000).toISOString();
        h.chatHistory.append(HIM.qq, { time: new Date(Date.now() - 400 * 86_400_000).toISOString(), role: 'user', content: '我不想活了', messageId: 1 });
        h.chatHistory.append(HIM.qq, { time: recent, role: 'assistant', content: '我不想活了', messageId: 2 });
        h.chatHistory.append(HIM.qq, { time: recent, role: 'user', content: '我不想活了', messageId: 3 });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(h.crises.map(c => c.at), [Date.parse(recent)]);
    });

    test('停机期间他回的「假」/「像」：交给反馈通道，不当聊天补回；她自己的话不送反馈', async () => {
        const seen: string[] = [];
        const h = harness({
            feedback: (_qq, message) => { const plain = typeof message === 'string' ? message : String(message[0]?.data?.text); seen.push(plain); return plain === '假'; },
            fetched: { [HIM.qq]: [qqMessage(HIM.qq, text('假'), 40), qqMessage(SELF, text('嗯'), 30), qqMessage(HIM.qq, text('晚安'), 20)] },
        });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(contents(h.chatHistory.load(HIM.qq)), ['assistant:嗯', 'user:晚安']);
        assert.deepEqual(seen, ['假', '晚安']);
    });

    test('不能给反馈的人（同学档、没开 feedback）：反馈通道不碰', async () => {
        let asked = 0;
        const h = harness({ contacts: [FRIEND], feedback: () => { asked++; return true; }, fetched: { [FRIEND.qq]: [qqMessage(FRIEND.qq, text('假'), 40)] } });
        await h.missed.syncMissed(SELF);
        assert.equal(asked, 0);
        assert.deepEqual(contents(h.chatHistory.load(FRIEND.qq)), ['user:假']);
    });

    test('记收据时：他发的每条先记收据、占住，补完放掉；正在处理的同一条不抢', async () => {
        const busy = qqMessage(HIM.qq, text('正在处理的'), 40);
        const h = harness({ tracks: true, fetched: { [HIM.qq]: [busy, qqMessage(HIM.qq, text('新的'), 30), qqMessage(SELF, text('她的'), 20)] } });
        const busyId = h.chatHistory.stageIncoming(HIM.qq, { source: { messageId: busy.message_id, role: 'user', time: new Date(busy.time * 1000).toISOString() }, message: busy.message });
        h.activeIncoming.set(busyId, 1);
        await h.missed.syncMissed(SELF);
        assert.deepEqual(contents(h.chatHistory.load(HIM.qq)), ['user:新的', 'assistant:她的']);
        assert.equal(h.claims.length, 1, '她的话不记收据，正在处理的不占');
        assert.deepEqual(h.releases, h.claims);
        assert.equal(h.chatHistory.load(HIM.qq)[0]!.incomingId, h.claims[0]);
        assert.deepEqual(h.chatHistory.pendingIncoming(HIM.qq).map(p => p.id), [busyId], '别人的收据原样留着');
    });

    test('记收据时解出来是空的：把收据丢掉，不进记录', async () => {
        const h = harness({ tracks: true, fetched: { [HIM.qq]: [qqMessage(HIM.qq, text('   '), 30)] } });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(h.chatHistory.load(HIM.qq), []);
        assert.deepEqual(h.chatHistory.pendingIncoming(HIM.qq), []);
        assert.equal(h.claims.length, 1);
        assert.deepEqual(h.releases, h.claims);
    });

    test('他发的图先看一看再补；读失败就按原消息；男朋友档的顺手收表情包（她自己的不收）', async () => {
        let reads = 0;
        const needs = (m: Segment[] | string) => typeof m !== 'string' && m.some(s => s.type === 'image');
        const h = harness({
            stickers: true,
            // 和真的读法一样：不用读的原样返回
            reader: { needs, read: async m => { if (!needs(m)) return m; reads++; if (reads === 2) throw new Error('看不清'); return text('[图片：晚霞]'); } },
            fetched: { [HIM.qq]: [qqMessage(HIM.qq, [{ type: 'image', data: {} }], 40, 71), qqMessage(HIM.qq, [{ type: 'image', data: {} }], 30, 72), qqMessage(SELF, text('好看'), 20, 73)] },
        });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(contents(h.chatHistory.load(HIM.qq)), ['user:[图片：晚霞]', 'user:[图片]', 'assistant:好看']);
        assert.deepEqual(h.stickers, [{ from: HIM.qq, messageId: 71 }, { from: HIM.qq, messageId: 72 }]);
    });

    test('同学档的人不收表情包', async () => {
        const h = harness({ contacts: [FRIEND], stickers: true, fetched: { [FRIEND.qq]: [qqMessage(FRIEND.qq, [{ type: 'image', data: {} }], 30)] } });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(h.stickers, []);
    });

    test('补回消息里引用的那一条不在记录里：先问 NapCat 补上，再转文字', async () => {
        const calls: unknown[] = [];
        const h = harness({
            callAction: async (action, params) => { calls.push([action, params]); return { sender: { user_id: SELF }, message: '我周三有早八' }; },
            fetched: { [HIM.qq]: [qqMessage(HIM.qq, [{ type: 'reply', data: { id: 9 } }, { type: 'text', data: { text: '那周四呢' } }], 30)] },
        });
        await h.missed.syncMissed(SELF);
        assert.deepEqual(calls, [['get_msg', { message_id: 9 }]]);
        assert.deepEqual(contents(h.chatHistory.load(HIM.qq)), ['user:[引用你说的：「我周三有早八」]那周四呢']);
    });

    test('处理中出错（比如收据写不进）：交给 incomingFailure，接着下一个人', async () => {
        const h = harness({ contacts: [HIM, FRIEND], tracks: true, fetched: { [HIM.qq]: [qqMessage(HIM.qq, text('一'), 30)], [FRIEND.qq]: [qqMessage(FRIEND.qq, text('二'), 30)] } });
        const stage = h.chatHistory.stageIncoming.bind(h.chatHistory);
        h.chatHistory.stageIncoming = (qq, envelope) => { if (qq === HIM.qq) throw new Error('写不进'); return stage(qq, envelope); };
        await h.missed.syncMissed(SELF);
        assert.equal(h.failures.length, 1);
        assert.match(String(h.failures[0]), /写不进/);
        assert.deepEqual(h.chatHistory.load(HIM.qq), [], '收据都没记上的不补，等下次');
        assert.deepEqual(contents(h.chatHistory.load(FRIEND.qq)), ['user:二']);
    });
});

describe('补回复（catchUpAll）', () => {
    const at = (iso: string) => Date.parse(iso);

    test('最后几条是他发的、在 3 小时内：叫回复器回', () => {
        const h = harness();
        h.chatHistory.append(HIM.qq, { time: new Date(Date.now() - 10 * 60_000).toISOString(), role: 'user', content: '在吗', messageId: 1 });
        h.missed.catchUpAll();
        assert.deepEqual(h.caughtUp, [HIM.qq]);
        assert.deepEqual(h.logs, [`[${HIM.qq}] 有没回的消息，回复`]);
    });

    test('「现在」按注入的时钟算（模拟器的虚拟时钟），不看真实时钟', () => {
        const sent = at('2026-01-01T09:00:00+08:00');
        const h = harness({ now: () => sent + 10 * 60_000 });
        h.chatHistory.append(HIM.qq, { time: new Date(sent).toISOString(), role: 'user', content: '在吗', messageId: 1 });
        h.missed.catchUpAll();
        assert.deepEqual(h.caughtUp, [HIM.qq], '虚拟时钟上才过 10 分钟：回；按真实时钟早就超过 3 小时了');
        const late = harness({ now: () => sent + 5 * 3_600_000 });
        late.chatHistory.append(HIM.qq, { time: new Date(sent).toISOString(), role: 'user', content: '在吗', messageId: 1 });
        late.missed.catchUpAll();
        assert.deepEqual(late.caughtUp, []);
    });

    test('没回的超过 3 小时：只补记录，等他下一条一起回；最后是她说的就什么都不做', () => {
        const h = harness({ contacts: [HIM, FRIEND] });
        h.chatHistory.append(HIM.qq, { time: new Date(Date.now() - 5 * 3_600_000).toISOString(), role: 'user', content: '在吗', messageId: 1 });
        h.chatHistory.append(FRIEND.qq, { time: new Date(Date.now() - 60_000).toISOString(), role: 'assistant', content: '好的', messageId: 2 });
        h.missed.catchUpAll();
        assert.deepEqual(h.caughtUp, []);
        assert.deepEqual(h.logs, [`[${HIM.qq}] 没回的消息已超过 3 小时，只补记录，等对方下一条消息时一起回`]);
        assert.deepEqual(h.cardsAsked, [], '没开作息就不读卡');
    });

    test('按作息时：她睡着时来的（超过 3 小时、12 小时内），起床后照样回', () => {
        mock.timers.enable({ apis: ['Date'], now: at('2026-11-24T10:00:00+08:00') });
        const h = harness({ schedule: true });
        h.chatHistory.append(HIM.qq, { time: new Date(at('2026-11-24T04:00:00+08:00')).toISOString(), role: 'user', content: '睡了吗', messageId: 1 });
        h.missed.catchUpAll();
        assert.deepEqual(h.cardsAsked, ['boyfriend']);
        assert.deepEqual(h.caughtUp, [HIM.qq]);
    });

    test('按作息时：她醒着时来的、已超过 3 小时的照旧不回', () => {
        mock.timers.enable({ apis: ['Date'], now: at('2026-11-24T20:00:00+08:00') });
        const h = harness({ schedule: true });
        h.chatHistory.append(HIM.qq, { time: new Date(at('2026-11-24T14:00:00+08:00')).toISOString(), role: 'user', content: '下午好', messageId: 1 });
        h.missed.catchUpAll();
        assert.deepEqual(h.caughtUp, []);
    });

    test('读记录或卡出错：交给 incomingFailure，接着下一个人', () => {
        const h = harness({ contacts: [HIM, FRIEND] });
        h.chatHistory.append(FRIEND.qq, { time: new Date(Date.now() - 60_000).toISOString(), role: 'user', content: '在吗', messageId: 1 });
        const load = h.chatHistory.load.bind(h.chatHistory);
        h.chatHistory.load = qq => { if (qq === HIM.qq) throw new Error('坏了'); return load(qq); };
        h.missed.catchUpAll();
        assert.equal(h.failures.length, 1);
        assert.deepEqual(h.caughtUp, [FRIEND.qq]);
    });
});
