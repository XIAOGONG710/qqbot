import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ChatHistory, RECALLED_TEXT, sourceMessageSeq, type StoredMessage } from '../src/memory/history.ts';
import { findMissed, newerThanStored, toStored, type HistoryMessage } from '../src/memory/backfill.ts';
import { fileOps } from '../src/memory/json-file.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-source-identity-')); dirs.push(dir); return dir; };
const SELF = 10001, PEER = 20002;
const BASE = Date.parse('2026-11-05T12:00:00Z') / 1000;
const iso = (offset: number) => new Date((BASE + offset) * 1000).toISOString();
const user = (id: number, offset: number, messageSeq?: string, content = '合成用户消息'): StoredMessage => ({ role: 'user', time: iso(offset), content, messageId: id, ...(messageSeq !== undefined ? { messageSeq } : {}) });
const fetched = (id: number, offset: number, role: 'user' | 'assistant' = 'user', seq?: string): HistoryMessage => ({
    message_id: id, time: BASE + offset, sender: { user_id: role === 'assistant' ? SELF : PEER }, message: role === 'assistant' ? '合成助手消息' : '合成用户消息', ...(seq !== undefined ? { real_seq: seq } : {}),
});

test('live身份按角色和源秒区分合法短ID重用，旧has(id)保留存在查询', () => {
    const history = new ChatHistory(fixture()); history.append(PEER, user(7, 0, '10'));
    assert.equal(history.hasMessage(PEER, 7), true);
    assert.equal(history.hasMessage(PEER, 7, { role: 'user', time: iso(0), messageSeq: '10' }), true);
    assert.equal(history.hasMessage(PEER, 7, { role: 'user', time: iso(1), messageSeq: '11' }), false);
    assert.equal(history.hasMessage(PEER, 7, { role: 'assistant', time: iso(0), sourceTime: BASE, messageSeq: '10' }), false);
});

test('同源秒不同real_seq不合并，超安全整数序号以原字符串保持精确且重启一致', () => {
    const dir = fixture(); const history = new ChatHistory(dir);
    const first = '9007199254740992', second = '9007199254740993';
    history.append(PEER, user(7, 0, first));
    assert.equal(history.hasMessage(PEER, 7, { role: 'user', time: iso(0), messageSeq: second }), false);
    history.append(PEER, user(7, 0, second));
    const restarted = new ChatHistory(dir);
    for (const seq of [first, second]) assert.equal(restarted.hasMessage(PEER, 7, { role: 'user', time: iso(0), messageSeq: seq }), true);
    assert.deepEqual(restarted.load(PEER).map(m => m.messageSeq), [first, second]);
});

test('real_seq只规范十进制字符串，不Number化大序号，零也保留', () => {
    assert.equal(sourceMessageSeq('0000'), '0');
    assert.equal(sourceMessageSeq(0), '0');
    assert.equal(sourceMessageSeq('0009007199254740993'), '9007199254740993');
    for (const value of ['-1', '1.5', '', NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(sourceMessageSeq(value), undefined);
});

test('补回旧user源秒相同才去重，新源秒和角色碰撞正常保留', () => {
    const stored = [user(7, 0)];
    const got = findMissed(stored, [fetched(7, 0), fetched(7, 1), fetched(7, 1, 'assistant')], SELF);
    assert.deepEqual(got.map(m => [m.role, m.time]), [['user', iso(1)], ['assistant', iso(1)]]);
    assert.equal(newerThanStored(stored, [fetched(7, 1)], undefined, SELF).length, 1);
});

test('同批fetched的相同身份去重，同短ID同秒但不同序号均保留', () => {
    const a = fetched(7, 0, 'user', '9007199254740992'), b = fetched(7, 0, 'user', '9007199254740993');
    const got = findMissed([], [b, a, a], SELF);
    assert.equal(got.length, 2);
    assert.deepEqual(new Set(got.map(m => m.messageSeq)), new Set([a.real_seq, b.real_seq]));
    assert.equal(findMissed([user(7, 0, a.real_seq)], [a, b], SELF)[0]!.messageSeq, b.real_seq);
});

test('补回assistant明确保存源秒/序号，后续重用可区分；源字段不把ACK改成QQ时间', () => {
    const [known] = toStored([fetched(7, 0, 'assistant', '20')], SELF);
    assert.equal(known!.sourceTime, BASE); assert.equal(known!.messageSeq, '20');
    const stored = [{ ...known!, time: iso(2.6) }, user(8, 0)];
    const got = findMissed(stored, [fetched(7, 0, 'assistant', '20'), fetched(7, 1, 'assistant', '21')], SELF);
    assert.equal(got.length, 1); assert.equal(got[0]!.sourceTime, BASE + 1);
    assert.equal(stored[0]!.time, iso(2.6));
});

test('旧ACK-only助手跨秒仍采用明确弱身份兼容，不伪造源时间或误补旧消息', () => {
    const dir = fixture(); const history = new ChatHistory(dir);
    const legacy: StoredMessage = { role: 'assistant', time: iso(2.6), content: '合成助手消息', messageId: 7 };
    history.append(PEER, legacy);
    assert.equal(history.hasMessage(PEER, 7, { role: 'assistant', time: iso(0), sourceTime: BASE }), true);
    assert.deepEqual(findMissed([legacy, user(8, 0)], [fetched(7, 1, 'assistant')], SELF), []);
    assert.equal(new ChatHistory(dir).load(PEER)[0]!.sourceTime, undefined);
    // 这是本批保守兼容的显式残余：旧助手的未来重用仍无法可靠区别。
    assert.equal(history.hasMessage(PEER, 7, { role: 'assistant', time: iso(10), sourceTime: BASE + 10 }), true);
});

test('新撤回只绑定当前未回复发生条目，旧同ID和后来新同ID不被遮盖', () => {
    const dir = fixture(); const history = new ChatHistory(dir);
    history.append(PEER, user(7, 0, '1', '已回答旧消息'));
    history.append(PEER, { role: 'assistant', time: iso(1), content: '旧回复', messageId: 8 });
    history.append(PEER, user(7, 2, '2', '本次撤回'));
    assert.equal(history.recall(PEER, 7), true);
    history.append(PEER, user(7, 3, '3', '后来合法新消息'));
    assert.deepEqual(new ChatHistory(dir).load(PEER).map(m => m.content), ['已回答旧消息', '旧回复', RECALLED_TEXT, '后来合法新消息']);
});

test('旧number[]撤回标记冻结当前已隐藏历史，迁移后相同ID新发生条目可见', () => {
    const dir = fixture(); const history = new ChatHistory(dir);
    history.append(PEER, user(7, 0, '1', '旧消息A')); history.append(PEER, user(7, 1, '2', '旧消息B'));
    writeFileSync(join(dir, 'chats', `${PEER}.recalled.json`), '[7]');
    const restarted = new ChatHistory(dir);
    assert.deepEqual(restarted.load(PEER).map(m => m.content), [RECALLED_TEXT, RECALLED_TEXT]);
    restarted.append(PEER, user(7, 2, '3', '新发生条目'));
    assert.deepEqual(new ChatHistory(dir).load(PEER).map(m => m.content), [RECALLED_TEXT, RECALLED_TEXT, '新发生条目']);
    const state = JSON.parse(readFileSync(join(dir, 'chats', `${PEER}.recalled.json`), 'utf8'));
    assert.equal(state.version, 2); assert.deepEqual(state.legacyIds, []); assert.equal(state.messages.length, 2);
});

test('孤立旧撤回ID保留保守wildcard，不猜出已丢失的来源', () => {
    const dir = fixture(); const history = new ChatHistory(dir); history.append(PEER, user(1, 0));
    writeFileSync(join(dir, 'chats', `${PEER}.recalled.json`), '[77]'); const restarted = new ChatHistory(dir); restarted.load(PEER);
    restarted.append(PEER, user(77, 1));
    assert.equal(new ChatHistory(dir).load(PEER).at(-1)!.content, RECALLED_TEXT);
});

test('歧义撤回只遮当时非危机候选集合，逐条keep且固定诊断不泄漏正文', () => {
    const dir = fixture(); const logs: string[] = []; const history = new ChatHistory(dir, text => logs.push(text));
    history.append(PEER, user(7, 0, '1', 'PRIVATE_NORMAL_A'));
    history.append(PEER, user(7, 1, '2', 'PRIVATE_NORMAL_B'));
    history.append(PEER, user(7, 2, '3', 'PRIVATE_CRISIS_KEEP'));
    assert.equal(history.recall(PEER, 7, content => content.includes('CRISIS')), true);
    history.append(PEER, user(7, 3, '4', '后来消息'));
    assert.deepEqual(history.load(PEER).map(m => m.content), [RECALLED_TEXT, RECALLED_TEXT, 'PRIVATE_CRISIS_KEEP', '后来消息']);
    assert.ok(logs.length > 0); assert.ok(logs.every(text => !text.includes('PRIVATE_')));
});

test('同ID同源秒且无seq的不同正文，撤回mark不能穿透keep遮住危机内容', () => {
    const dir = fixture(); const history = new ChatHistory(dir);
    history.append(PEER, user(7, 0, undefined, 'SYNTHETIC_RETRACTED_NORMAL'));
    history.append(PEER, user(7, 0, undefined, 'SYNTHETIC_CRISIS_KEEP'));
    assert.equal(history.recall(PEER, 7, content => content.includes('CRISIS')), true);
    assert.deepEqual(history.load(PEER).map(m => m.content), [RECALLED_TEXT, 'SYNTHETIC_CRISIS_KEEP']);
    assert.deepEqual(new ChatHistory(dir).load(PEER).map(m => m.content), [RECALLED_TEXT, 'SYNTHETIC_CRISIS_KEEP']);
    const state = JSON.parse(readFileSync(join(dir, 'chats', `${PEER}.recalled.json`), 'utf8'));
    assert.equal(state.messages.length, 1);
    assert.match(state.messages[0].contentHash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(state).includes('SYNTHETIC_'), '正文只用于本地精确遮盖摘要，不复制进副状态');
});

test('legacy迁移发布前失败保留旧事实，发布后EIO确认成功；两种恢复均不吞后来新条目', () => {
    for (const phase of ['before', 'after'] as const) {
        const dir = fixture(); const original = new ChatHistory(dir);
        original.append(PEER, user(7, 0, '1', 'ONLY_OLD_SECRET'));
        const path = join(dir, 'chats', `${PEER}.recalled.json`);
        writeFileSync(path, '[7]');
        const historyPath = join(dir, 'chats', `${PEER}.jsonl`);
        const oldHistory = readFileSync(historyPath, 'utf8');
        const restarted = new ChatHistory(dir);
        const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
        let attempts = 0;
        try {
            fileOps.writeDelaysMs = [0];
            fileOps.renameSync = (from, to) => {
                if (String(to) !== path) return rename(from, to);
                attempts++;
                if (phase === 'after') rename(from, to);
                throw Object.assign(new Error('合成迁移发布边界错误'), { code: 'EIO' });
            };
            if (phase === 'before') {
                assert.throws(() => restarted.append(PEER, user(7, 1, '2', '后来新消息')));
                assert.equal(readFileSync(path, 'utf8'), '[7]');
                assert.equal(readFileSync(historyPath, 'utf8'), oldHistory, '迁移没落盘，不接受可能被旧wildcard吞掉的新消息');
            } else {
                assert.doesNotThrow(() => restarted.append(PEER, user(7, 1, '2', '后来新消息')), '已发布迁移不能误报未应用');
            }
            assert.equal(attempts, 1);
        } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
        if (phase === 'before') restarted.append(PEER, user(7, 1, '2', '后来新消息'));
        assert.deepEqual(new ChatHistory(dir).load(PEER).map(m => m.content), [RECALLED_TEXT, '后来新消息']);
        const state = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(state.version, 2); assert.deepEqual(state.legacyIds, []);
        assert.equal(state.messages.length, 1); assert.match(state.messages[0].contentHash, /^[a-f0-9]{64}$/);
        assert.ok(!JSON.stringify(state).includes('ONLY_OLD_SECRET'));
    }
});
