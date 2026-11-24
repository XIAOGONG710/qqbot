import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import { UNLISTED_TIER, type Contact } from '../src/platform/config.ts';
import type { MessageEvent } from '../src/platform/onebot.ts';
import { privateAdmission, type PrivateAdmissionDeps } from '../src/social/private-admission.ts';
import type { Responder } from '../src/social/responder.ts';
import { MINOR_NOTICE } from '../src/social/strangers.ts';

// 谁的私聊她回（social/private-admission.ts，ADR 0209）：名单、名单外好友、陌生人的规矩。QQ 通道、回复器、档位记录都用假的。
const dirs: string[] = [];
const dataDir = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-private-admission-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const HIM: Contact = { qq: 1001, name: '他', tier: 'boyfriend' };
const SELF = 9000;
const NOW = Date.UTC(2026, 10, 24, 4, 0, 0);
let nextId = 1;
const message = (userId: number, text: string, nickname = '路人甲'): MessageEvent => ({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: userId, message_id: nextId++,
    time: Math.floor(NOW / 1000), message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: userId, nickname },
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(options: { unlistedFriends?: boolean; dir?: string; transport?: Partial<PrivateAdmissionDeps['transport']>; tierWarning?: string } = {}) {
    const dir = options.dir ?? dataDir();
    const logs: string[] = [];
    const sent: { qq: number; text: string }[] = [];
    const rows = new Map<number, StoredMessage[]>();
    const created: Contact[] = [];
    const tierUpdates: { qq: number; tier: string; at: Date }[] = [];
    const responders = new Map<number, Responder>([[HIM.qq, { who: 'him' } as unknown as Responder]]);
    const unlisted = new Map<number, Contact>();
    const deps: PrivateAdmissionDeps = {
        config: { contacts: [HIM], unlistedFriends: options.unlistedFriends ?? true, dataDir: dir },
        transport: { sendPrivateText: async (qq, text) => { sent.push({ qq, text }); return 777; }, ...options.transport },
        responders, unlisted,
        createResponder: contact => { created.push(contact); return { who: contact.qq } as unknown as Responder; },
        tierRecord: { update: (qq, tier, at = new Date()) => { tierUpdates.push({ qq, tier, at }); return options.tierWarning; } },
        history: { load: qq => rows.get(qq) ?? [], append: (qq, row) => { rows.set(qq, [...rows.get(qq) ?? [], row]); } },
        unlistedName: nickname => nickname ? `昵称:${nickname}` : '对方',
        worldNow: () => NOW,
        log: line => { logs.push(line); },
    };
    const admission = privateAdmission(deps);
    return { admission, deps, dir, logs, sent, rows, created, tierUpdates, responders, unlisted };
}
/** 陌生人规矩要先有签名写明 AI */
async function signed(options: Parameters<typeof harness>[0] = {}) {
    const h = harness({ ...options, transport: { setSignature: async () => {}, callAction: async () => ({ long_nick: '日常（AI）' }), ...options.transport } });
    await h.admission.ensureAiSignature(SELF);
    assert.equal(h.admission.strangers!.signed(), true);
    return h;
}

describe('名单和名单外好友', () => {
    test('名单里的人：直接给他的回复器，不碰陌生人规矩、不限流', () => {
        const h = harness();
        for (let i = 0; i < 50; i++) assert.equal((h.admission.admit(message(HIM.qq, '在吗')) as unknown as { who: string }).who, 'him');
        assert.deepEqual(h.created, []);
        assert.deepEqual(h.logs, []);
    });

    test('没开名单外好友：名单外的私聊一律不回，不建陌生人规矩、不写 strangers.json', async () => {
        const h = harness({ unlistedFriends: false });
        assert.equal(h.admission.strangers, undefined);
        assert.equal(h.admission.admit(message(4242, '你好呀，今天天气怎么样')), undefined);
        assert.deepEqual(h.logs, ['忽略 QQ 4242 的私聊（不在名单）']);
        await h.admission.ensureAiSignature(SELF);
        assert.equal(existsSync(join(h.dir, 'strangers.json')), false);
        assert.deepEqual(h.created, []);
    });

    test('签名还没写明她是 AI：陌生人一律不回，也不建回复器', () => {
        const h = harness();
        assert.equal(h.admission.admit(message(4242, '想跟你聊聊最近看的书')), undefined);
        assert.match(h.logs[0]!, /个性签名还没写明她是 AI/);
        assert.deepEqual(h.created, []);
        assert.equal(h.unlisted.size, 0);
    });

    test('签名写明之后，名单外好友按 unlisted 档临时建回复器：昵称做称呼、换档时间取消息的 QQ 时间', async () => {
        const h = await signed({ tierWarning: '档位从 classmate 换成 unlisted' });
        const event = message(4242, '想跟你聊聊最近看的书', '小明');
        const responder = h.admission.admit(event);
        assert.ok(responder);
        assert.deepEqual(h.created, [{ qq: 4242, name: '昵称:小明', tier: UNLISTED_TIER }]);
        assert.equal(h.responders.get(4242), responder);
        assert.deepEqual(h.unlisted.get(4242), { qq: 4242, name: '昵称:小明', tier: UNLISTED_TIER });
        assert.deepEqual(h.tierUpdates, [{ qq: 4242, tier: UNLISTED_TIER, at: new Date(event.time * 1000) }]);
        assert.ok(h.logs.includes('档位从 classmate 换成 unlisted'), '换档提醒照记');
        assert.equal(h.admission.admit(message(4242, '你看过三体吗')), responder, '第二次用同一个回复器');
        assert.equal(h.created.length, 1);
    });
});

describe('陌生人的规矩（ADR 0209）', () => {
    test('说了自己是未成年人：照实说一句固定的话，之后再也不回；聊天记录里两条都有', async () => {
        const h = await signed();
        assert.equal(h.admission.admit(message(4242, '我今年15岁，上初三')), undefined);
        await flush();
        assert.deepEqual(h.sent, [{ qq: 4242, text: MINOR_NOTICE }]);
        assert.deepEqual(h.rows.get(4242)!.map(m => [m.role, m.content]), [['user', '我今年15岁，上初三'], ['assistant', MINOR_NOTICE]]);
        assert.equal(h.rows.get(4242)![1]!.messageId, 777);
        assert.equal(h.admission.admit(message(4242, '那我们聊聊游戏吧')), undefined);
        assert.match(h.logs.at(-1)!, /之前看出是未成年人，不再回/);
        assert.equal(h.sent.length, 1, '不再发第二次');
        assert.deepEqual(JSON.parse(readFileSync(join(h.dir, 'strangers.json'), 'utf8')).minors, [4242], '记进文件，重启后也认得');
    });

    test('未成年人那句没发出去：记日志，不记成她说过；之后照样不回', async () => {
        const h = await signed({ transport: { sendPrivateText: async () => { throw new Error('风控'); } } });
        assert.equal(h.admission.admit(message(4242, '我是初中生')), undefined);
        await flush();
        assert.deepEqual(h.rows.get(4242)!.map(m => m.role), ['user']);
        assert.match(h.logs.at(-1)!, /那句没发出去：风控/);
        assert.equal(h.admission.admit(message(4242, '在吗')), undefined);
    });

    test('「我弟上初中」不算未成年人', async () => {
        const h = await signed();
        assert.ok(h.admission.admit(message(4242, '我弟上初中了，想问问你怎么辅导作业')));
        assert.deepEqual(h.sent, []);
    });

    test('只打了个招呼：先不回、记下来；之后说了正事，连着招呼一起回', async () => {
        const h = await signed();
        assert.equal(h.admission.admit(message(4242, '在吗')), undefined);
        assert.equal(h.admission.admit(message(4242, '？？')), undefined, '招呼加问号还是只是招呼');
        assert.deepEqual(h.rows.get(4242)!.map(m => m.content), ['在吗', '？？']);
        assert.ok(h.admission.admit(message(4242, '想问下你喜欢什么电影')));
        assert.match(h.logs.find(l => l.includes('只打了个招呼'))!, /先不回/);
    });

    test('之前说了正事还没等到回，又催一句「在吗」：连着前面的看，不算只打招呼', async () => {
        const h = await signed();
        assert.ok(h.admission.admit(message(4242, '想问下你喜欢什么电影')));
        h.rows.set(4242, [{ time: new Date(NOW).toISOString(), role: 'user', content: '想问下你喜欢什么电影', messageId: 1 }]);
        assert.ok(h.admission.admit(message(4242, '在吗')));
    });

    test('她回过之后又来一句招呼：只看她最后一条之后的，照样先不回', async () => {
        const h = await signed();
        h.rows.set(4242, [{ time: new Date(NOW).toISOString(), role: 'user', content: '聊聊天', messageId: 1 }, { time: new Date(NOW).toISOString(), role: 'assistant', content: '好呀', messageId: 2 }]);
        h.unlisted.set(4242, { qq: 4242, name: 'x', tier: UNLISTED_TIER });
        h.responders.set(4242, {} as Responder);
        assert.equal(h.admission.admit(message(4242, 'hi')), undefined);
    });

    test('每天上限：同一个陌生人一天最多回 40 次；第 41 次不回并记原因', async () => {
        const h = await signed();
        // 名单外好友的限流是 10 分钟 30 次，先撞上它；换成直接写好当天的计数看陌生人的每日上限
        const day = new Date(NOW);
        const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
        writeFileSync(join(h.dir, 'strangers.json'), JSON.stringify({ day: key, counts: { 4242: 40 }, total: 40, minors: [], signedAt: NOW }));
        const fresh = harness({ dir: h.dir });
        assert.equal(fresh.admission.admit(message(4242, '想跟你聊聊最近看的书')), undefined);
        assert.match(fresh.logs.at(-1)!, /今天已经回了这个人 40 次/);
    });

    test('名单外好友限流：同一个人 10 分钟内第 31 条不回（个人限流），回复器留着', async () => {
        const h = await signed();
        for (let i = 0; i < 30; i++) assert.ok(h.admission.admit(message(4242, `第${i}个问题：你喜欢什么书`)), `第 ${i + 1} 条`);
        assert.equal(h.admission.admit(message(4242, '再问一个')), undefined);
        assert.match(h.logs.at(-1)!, /名单外好友个人限流；约 10 分钟后恢复/);
        assert.ok(h.responders.has(4242));
    });

    test('名单外好友限流：第一次来就超了全局上限，不建回复器', async () => {
        const h = await signed();
        // 全局 100：4 个人各 25 条
        for (const qq of [5001, 5002, 5003, 5004]) for (let i = 0; i < 25; i++) h.admission.admit(message(qq, `问题${i}：最近在看什么`));
        assert.equal(h.admission.admit(message(5005, '你好，想认识一下')), undefined);
        assert.match(h.logs.at(-1)!, /名单外好友全局限流/);
        assert.equal(h.responders.has(5005), false);
        assert.equal(h.unlisted.has(5005), false);
    });
});

describe('个性签名写明她是 AI', () => {
    test('签名里没有：补上「（AI）」再记已签', async () => {
        const set: string[] = [];
        const calls: unknown[] = [];
        const h = harness({ transport: { setSignature: async text => { set.push(text); }, callAction: async (action, params) => { calls.push([action, params]); return { longNick: '  今天   也要开心 ' }; } } });
        await h.admission.ensureAiSignature(SELF);
        assert.deepEqual(calls, [['get_stranger_info', { user_id: SELF, no_cache: true }]]);
        assert.deepEqual(set, ['今天 也要开心（AI）']);
        assert.equal(h.admission.strangers!.signed(), true);
        assert.match(h.logs.at(-1)!, /补上了「（AI）」/);
        assert.equal(JSON.parse(readFileSync(join(h.dir, 'strangers.json'), 'utf8')).signedAt, NOW);
    });

    test('本来就写着：不改签名，照样记已签', async () => {
        let set = 0;
        const h = harness({ transport: { setSignature: async () => { set++; }, callAction: async () => ({ long_nick: '我是 AI 助手' }) } });
        await h.admission.ensureAiSignature(SELF);
        assert.equal(set, 0);
        assert.equal(h.admission.strangers!.signed(), true);
        assert.match(h.logs.at(-1)!, /本来就写着/);
    });

    test('读不到现在的签名（或通道没有通用调用）：按空的补「（AI）」', async () => {
        const set: string[] = [];
        const h = harness({ transport: { setSignature: async text => { set.push(text); }, callAction: async () => { throw new Error('超时'); } } });
        await h.admission.ensureAiSignature(SELF);
        assert.deepEqual(set, ['（AI）']);
        assert.ok(h.logs.some(l => /读不到现在的个性签名（超时）/.test(l)));
        const noCall = harness({ transport: { setSignature: async text => { set.push(`2:${text}`); } } });
        await noCall.admission.ensureAiSignature(SELF);
        assert.equal(set.at(-1), '2:（AI）');
        assert.equal(noCall.admission.strangers!.signed(), true);
    });

    test('改不了签名（通道不支持或改失败）：不记已签，陌生人一直不回', async () => {
        const unsupported = harness({ transport: { callAction: async () => ({}) } });
        await unsupported.admission.ensureAiSignature(SELF);
        assert.equal(unsupported.admission.strangers!.signed(), false);
        assert.match(unsupported.logs[0]!, /改不了个性签名/);
        assert.equal(unsupported.admission.admit(message(4242, '想跟你聊聊最近看的书')), undefined);

        const failing = harness({ transport: { setSignature: async () => { throw new Error('频率过快'); }, callAction: async () => ({ long_nick: '' }) } });
        await failing.admission.ensureAiSignature(SELF);
        assert.equal(failing.admission.strangers!.signed(), false);
        assert.match(failing.logs.at(-1)!, /没改成（频率过快），先不回陌生人/);
    });

    test('没开名单外好友：什么都不查、不改', async () => {
        let touched = 0;
        const h = harness({ unlistedFriends: false, transport: { setSignature: async () => { touched++; }, callAction: async () => { touched++; return {}; } } });
        await h.admission.ensureAiSignature(SELF);
        assert.equal(touched, 0);
        assert.deepEqual(h.logs, []);
    });
});
