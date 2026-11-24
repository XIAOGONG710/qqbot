import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import { quotedContext } from '../src/platform/quoted-context.ts';
import type { Segment } from '../src/platform/onebot.ts';

// 引用和合并转发的补齐（platform/quoted-context.ts）：NapCat 用假的 callAction，聊天记录用内存数组。
const HIM = 1001, SELF = 2002, OTHER = 3003;
const reply = (id: number | string): Segment => ({ type: 'reply', data: { id } });
const text = (value: string): Segment => ({ type: 'text', data: { text: value } });

function harness(options: { noCallAction?: boolean; selfId?: number; respond?: (action: string, params: Record<string, unknown>) => unknown } = {}) {
    const rows = new Map<number, StoredMessage[]>();
    const calls: { action: string; params: Record<string, unknown> }[] = [];
    const logs: string[] = [];
    const callAction = async (action: string, params: Record<string, unknown> = {}) => { calls.push({ action, params }); return options.respond?.(action, params); };
    const quoted = quotedContext({
        transport: options.noCallAction ? {} : { callAction },
        history: { load: qq => rows.get(qq) ?? [] },
        selfId: () => options.selfId ?? SELF,
        log: message => { logs.push(message); },
    });
    return { quoted, rows, calls, logs };
}
const stored = (messageId: number, role: StoredMessage['role'], content: string): StoredMessage => ({ time: '2026-11-24T01:00:00.000Z', role, content, messageId });

describe('引用的那一条', () => {
    test('quoteLookup：先查聊天记录（同 id 取最后一条），记录里没有也没问过就是 undefined', () => {
        const { quoted, rows } = harness();
        rows.set(HIM, [stored(5, 'user', '旧的'), stored(6, 'assistant', '她说的'), stored(5, 'user', '新的')]);
        const lookup = quoted.quoteLookup(HIM);
        assert.deepEqual(lookup(6), { role: 'assistant', content: '她说的' });
        assert.deepEqual(lookup(5), { role: 'user', content: '新的' });
        assert.equal(lookup(7), undefined);
        assert.equal(quoted.quoteLookup(OTHER)(6), undefined, '别人的聊天记录查不到这个人的');
    });

    test('missingQuotes：只列记录里没有、也没补过的 id；纯文字、没有引用段、没有通用调用时都是空', () => {
        const { quoted, rows } = harness();
        rows.set(HIM, [stored(5, 'user', '在')]);
        assert.deepEqual(quoted.missingQuotes(HIM, [reply(5), reply('6'), reply('不是数字'), text('嗯')]), [6]);
        assert.deepEqual(quoted.missingQuotes(HIM, '[CQ:reply,id=6]'), []);
        assert.deepEqual(quoted.missingQuotes(HIM, [text('没引用')]), []);
        assert.deepEqual(harness({ noCallAction: true }).quoted.missingQuotes(HIM, [reply(6)]), []);
    });

    test('fetchQuotes：对方发的记成他说的、她自己发的记成她说的，补过的不再列为缺；日志不记正文', async () => {
        const { quoted, calls, logs } = harness({
            respond: (_action, params) => params.message_id === 8
                ? { sender: { user_id: HIM }, message: [text('周三\n 有  早八')] }
                : { user_id: SELF, message: '我是她' },
        });
        await quoted.fetchQuotes(HIM, [8, 9]);
        assert.deepEqual(calls, [{ action: 'get_msg', params: { message_id: 8 } }, { action: 'get_msg', params: { message_id: 9 } }]);
        const lookup = quoted.quoteLookup(HIM);
        assert.deepEqual(lookup(8), { role: 'user', content: '周三 有 早八' }, '空白压成一个空格');
        assert.deepEqual(lookup(9), { role: 'assistant', content: '我是她' });
        assert.deepEqual(quoted.missingQuotes(HIM, [reply(8), reply(9)]), []);
        assert.ok(logs.every(line => !line.includes('早八') && !line.includes('我是她')), '日志里没有被引用的正文');
        assert.match(logs[0]!, /他说的/);
        assert.match(logs[1]!, /她说的/);
    });

    test('隐私：引用的是第三个人的话（群里、别的私聊）就不认、不猜，也不进缓存', async () => {
        const { quoted, logs } = harness({ respond: () => ({ sender: { user_id: OTHER }, message: '别人的秘密' }) });
        await quoted.fetchQuotes(HIM, [10]);
        assert.equal(quoted.quoteLookup(HIM)(10), undefined);
        assert.deepEqual(quoted.missingQuotes(HIM, [reply(10)]), [10], '下次还算缺');
        assert.deepEqual(logs, [`[${HIM}] 引用的那一条记录里没有，问 NapCat 也没认出来`]);
    });

    test('还不知道她自己的号（selfId 是 0）：发的人是 0 也不当成她', async () => {
        const { quoted } = harness({ selfId: 0, respond: () => ({ user_id: 0, message: '谁说的' }) });
        await quoted.fetchQuotes(HIM, [11]);
        assert.equal(quoted.quoteLookup(HIM)(11), undefined);
        await quoted.fetchQuotes(HIM, [11], SELF);
        assert.equal(quoted.quoteLookup(HIM)(11), undefined, '显式给的 self 也不等于 0');
    });

    test('NapCat 返回空内容、空结果或抛错：记一行日志接着补下一条，不抛', async () => {
        const { quoted, logs } = harness({
            respond: (_action, params) => {
                if (params.message_id === 1) return { sender: { user_id: HIM }, message: [text('   ')] };
                if (params.message_id === 2) return undefined;
                if (params.message_id === 3) throw new Error('消息不存在');
                return { sender: { user_id: HIM }, message: '好的' };
            },
        });
        await quoted.fetchQuotes(HIM, [1, 2, 3, 4]);
        assert.equal(logs.length, 4);
        assert.match(logs[2]!, /没拿到：消息不存在/);
        assert.deepEqual(quoted.quoteLookup(HIM)(4), { role: 'user', content: '好的' });
        assert.equal(quoted.quoteLookup(HIM)(1), undefined);
    });

    test('补过的引用最多留 200 条，多了先丢最早的', async () => {
        const { quoted } = harness({ respond: (_action, params) => ({ sender: { user_id: HIM }, message: `第${String(params.message_id)}条` }) });
        await quoted.fetchQuotes(HIM, Array.from({ length: 201 }, (_, i) => i + 1));
        assert.equal(quoted.quoteLookup(HIM)(1), undefined, '最早的那条被挤掉了');
        assert.deepEqual(quoted.quoteLookup(HIM)(2), { role: 'user', content: '第2条' });
        assert.deepEqual(quoted.quoteLookup(HIM)(201), { role: 'user', content: '第201条' });
    });
});

describe('合并转发', () => {
    const forwardNode = (userId: number, nickname: string, message: string) => ({ type: 'node', data: { user_id: userId, nickname, content: message } });

    test('missingForwards：只列只有 id、没带 content 的转发段，补过的、空 id、纯文字、没有通用调用的都不列', async () => {
        const { quoted } = harness({ respond: () => ({ messages: [forwardNode(HIM, '他', '嗨')] }) });
        const message: Segment[] = [
            { type: 'forward', data: { id: 'abc' } },
            { type: 'forward', data: { id: 'inline', content: [forwardNode(HIM, '他', '自带')] } },
            { type: 'forward', data: {} },
            text('看这个'),
        ];
        assert.deepEqual(quoted.missingForwards(message), ['abc']);
        assert.deepEqual(quoted.missingForwards('[转发]'), []);
        assert.deepEqual(harness({ noCallAction: true }).quoted.missingForwards(message), []);
        await quoted.fetchForwards(HIM, ['abc']);
        assert.deepEqual(quoted.missingForwards(message), []);
    });

    test('forwardLookup：他写「他」、她写「你」、别人写昵称（不把别人的话写成他的）；日志只记条数', async () => {
        const { quoted, calls, logs } = harness({
            respond: () => ({ messages: [forwardNode(HIM, '阿明', '今晚吃啥'), forwardNode(SELF, '梦', '随便'), forwardNode(OTHER, '小王', '火锅'), forwardNode(4004, '', '我也去')] }),
        });
        await quoted.fetchForwards(HIM, ['f1']);
        assert.deepEqual(calls, [{ action: 'get_forward_msg', params: { message_id: 'f1' } }]);
        assert.equal(quoted.forwardLookup(HIM)({ id: 'f1' }), '[转发的聊天记录（共 4 条）：他：今晚吃啥／你：随便／小王：火锅／别人：我也去]');
        assert.deepEqual(logs, [`[${HIM}] 转发的聊天记录问 NapCat 拿到了 4 条（日志不记内容）`]);
        assert.equal(quoted.forwardLookup(HIM)({ id: 'unknown' }), undefined, '没补过的 id 查不到');
    });

    test('forwardLookup：段里自带 content 的直接用；还不知道自己的号时她的话按昵称写', () => {
        const { quoted } = harness({ selfId: 0 });
        assert.equal(quoted.forwardLookup(HIM)({ content: [forwardNode(SELF, '梦', '在呢')] }), '[转发的聊天记录（共 1 条）：梦：在呢]');
        assert.equal(quoted.forwardLookup(HIM, SELF)({ content: [forwardNode(SELF, '梦', '在呢')] }), '[转发的聊天记录（共 1 条）：你：在呢]');
    });

    test('fetchForwards：没内容、不是数组、抛错都只记日志，不进缓存', async () => {
        const { quoted, logs } = harness({
            respond: (_action, params) => {
                if (params.message_id === 'empty') return { messages: [] };
                if (params.message_id === 'weird') return { messages: 'x' };
                throw new Error('超时');
            },
        });
        await quoted.fetchForwards(HIM, ['empty', 'weird', 'boom']);
        assert.equal(logs.length, 3);
        assert.match(logs[2]!, /没拿到：超时/);
        assert.deepEqual(quoted.missingForwards([{ type: 'forward', data: { id: 'empty' } }]), ['empty']);
    });

    test('补过的转发最多留 50 份，多了先丢最早的', async () => {
        const { quoted } = harness({ respond: () => ({ messages: [forwardNode(HIM, '他', '嗨')] }) });
        await quoted.fetchForwards(HIM, Array.from({ length: 51 }, (_, i) => `f${i}`));
        assert.equal(quoted.forwardLookup(HIM)({ id: 'f0' }), undefined);
        assert.ok(quoted.forwardLookup(HIM)({ id: 'f1' }));
        assert.ok(quoted.forwardLookup(HIM)({ id: 'f50' }));
    });
});
