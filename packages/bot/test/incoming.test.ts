import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { ChatHistory } from '../src/memory/history.ts';
import type { Contact } from '../src/platform/config.ts';
import { incomingReceipts, type IncomingDeps } from '../src/platform/incoming.ts';
import { segmentsToText, type MessageEvent, type Segment } from '../src/platform/onebot.ts';

// 入站收据（platform/incoming.ts）：聊天记录用真的（临时目录），计时器、读图读语音、回复器用假的。
const dirs: string[] = [];
const dataDir = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-incoming-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const HIM: Contact = { qq: 1001, name: '他', tier: 'boyfriend' };
const FRIEND: Contact = { qq: 1002, name: '同学', tier: 'classmate' };
const nowSeconds = () => Math.floor(Date.now() / 1000);
let nextMessageId = 100;
const event = (userId: number, message: Segment[] | string, over: Partial<MessageEvent> = {}): MessageEvent => ({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 9000, user_id: userId, message_id: nextMessageId++,
    time: nowSeconds() - 10, message, raw_message: typeof message === 'string' ? message : '', sender: { user_id: userId }, ...over,
});
const text = (value: string): Segment[] => [{ type: 'text', data: { text: value } }];

type FakeTimer = { fn: () => void; ms: number | undefined; cancelled: boolean; unref: () => void };
function harness(over: { recalls?: boolean; stopped?: () => boolean; syncing?: () => boolean; dormant?: boolean; since?: Date; deviceOwner?: Contact; reader?: { needs: (m: Segment[] | string) => boolean; read: (m: Segment[] | string) => Promise<Segment[] | string> } } = {}) {
    const dir = dataDir();
    const chatHistory = new ChatHistory(dir);
    const timers: FakeTimer[] = [];
    const logs: string[] = [];
    const crises: { qq: number; at: number; level: string }[] = [];
    const synced: number[] = [];
    const caughtUp: number[] = [];
    const inbox = new Map<number, Promise<void>>();
    const deps: IncomingDeps = {
        config: { contacts: [HIM, FRIEND], recalls: over.recalls ?? true },
        stopped: over.stopped ?? (() => false),
        syncing: over.syncing ?? (() => false),
        exec: {
            after: (fn, ms) => { const timer: FakeTimer = { fn, ms, cancelled: false, unref: () => {} }; timers.push(timer); return timer as unknown as ReturnType<typeof setTimeout>; },
            cancel: timer => { if (timer) (timer as unknown as FakeTimer).cancelled = true; },
        },
        chatHistory,
        history: chatHistory,
        tierRecord: { since: () => over.since },
        dormancy: over.dormant === undefined ? undefined : { isDormant: () => over.dormant! },
        responders: new Map([[HIM.qq, { catchUp: () => { caughtUp.push(HIM.qq); } }], [FRIEND.qq, { catchUp: () => { caughtUp.push(FRIEND.qq); } }]]),
        readerFor: () => over.reader as ReturnType<IncomingDeps['readerFor']>,
        quoteLookup: () => id => (id === 42 ? { role: 'assistant', content: '我周三有早八' } : undefined),
        forwardLookup: () => () => undefined,
        markCrisis: (qq, at, level) => { crises.push({ qq, at, level }); },
        syncRecalledMemory: qq => { synced.push(qq); },
        deviceOwner: over.deviceOwner,
        plainTextOf: message => segmentsToText(message),
        inbox,
        log: line => { logs.push(line); },
    };
    const receipts = incomingReceipts(deps);
    return { receipts, chatHistory, timers, logs, crises, synced, caughtUp, inbox, deps };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

describe('来源校验和身份', () => {
    test('validIncomingEvent：QQ 号、消息 id、秒数都得是安全整数且时间合法', () => {
        const { receipts } = harness();
        assert.equal(receipts.validIncomingEvent(event(HIM.qq, '在')), true);
        assert.equal(receipts.validIncomingEvent(event(HIM.qq, '在', { message_id: 0 })), true, '消息 id 0 合法');
        for (const bad of [{ user_id: 0 }, { user_id: -5 }, { user_id: 1.5 }, { message_id: -1 }, { message_id: Number.MAX_SAFE_INTEGER + 1 }, { time: 1.5 }, { time: 9e15 }, { time: Number.NaN }] as Partial<MessageEvent>[]) {
            assert.equal(receipts.validIncomingEvent(event(HIM.qq, '在', bad)), false, JSON.stringify(bad));
        }
    });

    test('eventIdentity：他说的、QQ 秒转 ISO、原始序号去掉前导零', () => {
        const { receipts } = harness();
        assert.deepEqual(receipts.eventIdentity(event(HIM.qq, '在', { time: 1_790_000_000, real_seq: '0042' })), { role: 'user', time: new Date(1_790_000_000_000).toISOString(), messageSeq: '42' });
        assert.equal(receipts.eventIdentity(event(HIM.qq, '在', { real_seq: 'abc' })).messageSeq, undefined);
    });

    test('tracksIncoming / stageEvent：只给开了撤回的名单里的人记收据', () => {
        const on = harness();
        assert.equal(on.receipts.tracksIncoming(HIM.qq), true);
        assert.equal(on.receipts.tracksIncoming(4242), false, '名单外的人不记收据');
        const id = on.receipts.stageEvent(event(HIM.qq, text('早')));
        assert.match(id!, /^inc-/);
        assert.deepEqual(on.chatHistory.pendingIncoming(HIM.qq).map(p => p.id), [id]);
        assert.equal(on.receipts.stageEvent(event(4242, text('早'))), undefined);
        const off = harness({ recalls: false });
        assert.equal(off.receipts.tracksIncoming(HIM.qq), false);
        assert.equal(off.receipts.stageEvent(event(HIM.qq, text('早'))), undefined);
    });

    test('claim / release 按次数计：两次 claim 要两次 release 才放掉', () => {
        const { receipts } = harness();
        receipts.claimIncoming('a'); receipts.claimIncoming('a');
        receipts.releaseIncoming('a');
        assert.equal(receipts.activeIncoming.get('a'), 1);
        receipts.releaseIncoming('a');
        assert.equal(receipts.activeIncoming.has('a'), false);
        receipts.releaseIncoming('never');
        assert.equal(receipts.activeIncoming.has('never'), false);
    });

    test('prepareReceived：没有收据就原样组装；有收据经聊天记录落盘并带上收据 id', () => {
        const { receipts } = harness();
        const e = event(HIM.qq, text('今天好累'));
        assert.deepEqual(receipts.prepareReceived(e, '今天好累'), { ...receipts.eventIdentity(e), messageId: e.message_id, content: '今天好累' });
        const id = receipts.stageEvent(e)!;
        const prepared = receipts.prepareReceived(e, '今天好累', id);
        assert.equal(prepared.incomingId, id);
        assert.equal(prepared.content, '今天好累');
    });
});

describe('从收据补回（recoverIncoming）', () => {
    test('收据补进聊天记录、清掉收据、让记忆跟上；返回补了几条', async () => {
        const h = harness();
        h.receipts.stageEvent(event(HIM.qq, text('晚上吃什么')));
        h.receipts.stageEvent(event(HIM.qq, [{ type: 'reply', data: { id: 42 } }, { type: 'text', data: { text: '这句什么意思' } }]));
        assert.equal(await h.receipts.recoverIncoming(HIM.qq), 2);
        assert.deepEqual(h.chatHistory.load(HIM.qq).map(m => m.content), ['晚上吃什么', '[引用你说的：「我周三有早八」]这句什么意思']);
        assert.deepEqual(h.chatHistory.pendingIncoming(HIM.qq), []);
        assert.deepEqual(h.synced, [HIM.qq]);
        assert.equal(await h.receipts.recoverIncoming(HIM.qq), 0, '再补一次什么都没有');
        assert.deepEqual(h.synced, [HIM.qq], '没补到就不同步');
    });

    test('补回的话里有想伤害自己的意思：照样记一笔危机，时间按他说话的时候', async () => {
        const h = harness();
        const e = event(HIM.qq, text('我不想活了'));
        h.receipts.stageEvent(e);
        await h.receipts.recoverIncoming(HIM.qq);
        assert.equal(h.crises.length, 1);
        assert.equal(h.crises[0]!.qq, HIM.qq);
        assert.equal(h.crises[0]!.at, e.time * 1000);
    });

    test('解出来是空的：丢掉收据，不进记录', async () => {
        const h = harness();
        h.receipts.stageEvent(event(HIM.qq, text('   ')));
        assert.equal(await h.receipts.recoverIncoming(HIM.qq), 0);
        assert.deepEqual(h.chatHistory.load(HIM.qq), []);
        assert.deepEqual(h.chatHistory.pendingIncoming(HIM.qq), []);
    });

    test('正在处理、还在缓冲区里的收据不抢', async () => {
        const h = harness();
        const active = h.receipts.stageEvent(event(HIM.qq, text('一')))!;
        const buffered = h.receipts.stageEvent(event(HIM.qq, text('二')))!;
        h.receipts.stageEvent(event(HIM.qq, text('三')));
        h.receipts.claimIncoming(active);
        h.receipts.bufferedIncomingIds.add(buffered);
        assert.equal(await h.receipts.recoverIncoming(HIM.qq), 1);
        assert.deepEqual(h.chatHistory.load(HIM.qq).map(m => m.content), ['三']);
        assert.equal(h.receipts.activeIncoming.get(active), 1, '别人占着的不动');
    });

    test('隐私：换档之前收到的收据不补进当前档的记录（也不丢）', async () => {
        const since = new Date();
        const h = harness({ since });
        h.receipts.stageEvent(event(HIM.qq, text('换档前说的'), { time: Math.floor(since.getTime() / 1000) - 3600 }));
        h.receipts.stageEvent(event(HIM.qq, text('换档后说的'), { time: Math.floor(since.getTime() / 1000) + 1 }));
        assert.equal(await h.receipts.recoverIncoming(HIM.qq), 1);
        assert.deepEqual(h.chatHistory.load(HIM.qq).map(m => m.content), ['换档后说的']);
        assert.equal(h.chatHistory.pendingIncoming(HIM.qq).length, 1, '旧档的收据留着');
    });

    test('中断的设备主人指令不重跑（收据留着）；别人发的同样文字照常当聊天补回', async () => {
        const h = harness({ deviceOwner: HIM });
        h.receipts.stageEvent(event(HIM.qq, text('/屏幕')));
        h.receipts.stageEvent(event(HIM.qq, text('批准')));
        h.receipts.stageEvent(event(HIM.qq, text('/屏幕好看吗')));
        h.receipts.stageEvent(event(FRIEND.qq, text('/屏幕')));
        assert.equal(await h.receipts.recoverIncoming(HIM.qq), 1);
        assert.deepEqual(h.chatHistory.load(HIM.qq).map(m => m.content), ['/屏幕好看吗'], '只认整条指令');
        assert.equal(h.chatHistory.pendingIncoming(HIM.qq).length, 2);
        assert.equal(await h.receipts.recoverIncoming(FRIEND.qq), 1);
        assert.deepEqual(h.chatHistory.load(FRIEND.qq).map(m => m.content), ['/屏幕']);
    });

    test('要读的图 / 语音先读；读失败就按原消息转文字', async () => {
        let reads = 0;
        const h = harness({ reader: { needs: m => typeof m !== 'string' && m.some(s => s.type === 'image'), read: async () => { reads++; if (reads === 2) throw new Error('看不清'); return text('[图片：一只猫]'); } } });
        h.receipts.stageEvent(event(HIM.qq, [{ type: 'image', data: { summary: '' } }]));
        h.receipts.stageEvent(event(HIM.qq, [{ type: 'image', data: { summary: '' } }]));
        assert.equal(await h.receipts.recoverIncoming(HIM.qq), 2);
        assert.deepEqual(h.chatHistory.load(HIM.qq).map(m => m.content), ['[图片：一只猫]', '[图片]']);
    });

    test('不补：没开撤回 / 不在名单、已经停了、在休眠', async () => {
        const stopped = harness({ stopped: () => true });
        stopped.receipts.stageEvent(event(HIM.qq, text('x')));
        assert.equal(await stopped.receipts.recoverIncoming(HIM.qq), 0);
        const dormant = harness({ dormant: true });
        dormant.receipts.stageEvent(event(HIM.qq, text('x')));
        assert.equal(await dormant.receipts.recoverIncoming(HIM.qq), 0);
        assert.deepEqual(dormant.chatHistory.load(HIM.qq), []);
        assert.equal(await harness().receipts.recoverIncoming(4242), 0);
        assert.equal(await harness({ recalls: false }).receipts.recoverIncoming(HIM.qq), 0);
    });

    test('queueIncomingRecovery：排在这个人的收件队后面；做完把队清掉', async () => {
        const h = harness();
        h.receipts.stageEvent(event(HIM.qq, text('排队的')));
        let release!: () => void;
        h.inbox.set(HIM.qq, new Promise<void>(resolve => { release = resolve; }));
        const queued = h.receipts.queueIncomingRecovery(HIM.qq);
        await flush();
        assert.deepEqual(h.chatHistory.load(HIM.qq), [], '前面的还没完');
        release();
        assert.equal(await queued, 1);
        await flush();
        assert.equal(h.inbox.has(HIM.qq), false);
    });
});

describe('失败重试和停止', () => {
    test('incomingFailure：只记一次日志、只开一个 1 秒的重试；重试时逐人补回，最近没回的叫回复器', async () => {
        const h = harness();
        h.receipts.stageEvent(event(HIM.qq, text('刚才那条')));
        h.receipts.incomingFailure(new Error('磁盘满'));
        h.receipts.incomingFailure(new Error('又失败'));
        assert.equal(h.logs.length, 1);
        assert.match(h.logs[0]!, /入站处理未完成/);
        assert.equal(h.timers.length, 1);
        assert.equal(h.timers[0]!.ms, 1000);
        h.timers[0]!.fn();
        await flush();
        assert.deepEqual(h.chatHistory.load(HIM.qq).map(m => m.content), ['刚才那条']);
        assert.deepEqual(h.caughtUp, [HIM.qq], '只有补到消息且该回的那个人');
        assert.deepEqual(h.synced.sort(), [HIM.qq, HIM.qq, FRIEND.qq].sort(), '每个人都让记忆跟上');
        h.receipts.incomingFailure(new Error('第二轮'));
        assert.equal(h.logs.length, 2, '一轮成功之后再失败会重新记日志');
    });

    test('正在补回漏掉的消息时：重试往后推一秒，不同时跑', () => {
        const h = harness({ syncing: () => true });
        h.receipts.stageEvent(event(HIM.qq, text('等补回完再说')));
        h.receipts.incomingFailure(new Error('x'));
        h.timers[0]!.fn();
        assert.equal(h.timers.length, 2, '又排了一次');
        assert.deepEqual(h.chatHistory.load(HIM.qq), [], '这一轮没动收据');
    });

    test('停了：不开重试', () => {
        const h = harness({ stopped: () => true });
        h.receipts.incomingFailure(new Error('x'));
        assert.equal(h.timers.length, 0);
        assert.equal(h.logs.length, 1);
    });

    test('休眠时重试补不进，也不叫回复器', async () => {
        const h = harness({ dormant: true });
        h.receipts.stageEvent(event(HIM.qq, text('睡着时来的')));
        h.receipts.incomingFailure(new Error('x'));
        h.timers[0]!.fn();
        await flush();
        assert.deepEqual(h.caughtUp, []);
        assert.deepEqual(h.chatHistory.load(HIM.qq), []);
    });

    test('stop：取消待跑的重试，把入站状态落盘；落盘失败只记日志', () => {
        const h = harness();
        h.receipts.incomingFailure(new Error('x'));
        h.receipts.stop();
        assert.equal(h.timers[0]!.cancelled, true);
        h.chatHistory.flushIncoming = () => { throw new Error('只读磁盘'); };
        assert.doesNotThrow(() => h.receipts.stop());
        assert.match(h.logs.at(-1)!, /停止时入站状态仍未确认持久/);
    });
});
