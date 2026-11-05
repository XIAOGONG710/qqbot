import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ChatHistory, RECALLED_TEXT, type StoredMessage } from '../src/memory/history.ts';
import { fileOps } from '../src/memory/json-file.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-pending-store-')); dirs.push(dir); return dir; };
const source = (id = 7, seq = '1') => ({ role: 'user' as const, time: '2026-11-05T12:00:00.000Z', messageId: id, messageSeq: seq });
const decoded = (content = '合成解码正文', id = 7, seq = '1'): StoredMessage => ({ ...source(id, seq), content });
const envelope = (text = '原始媒体') => ({ source: source(), message: [{ type: 'record', data: { file: text } }] });

test('stage先持久原始envelope，重启恢复且外部快照/输入修改不污染事实', () => {
    const dir = fixture(); const history = new ChatHistory(dir); const input = envelope();
    const id = history.stageIncoming(1, input); input.message[0]!.data.file = '伪造';
    const snap = history.pendingIncoming(1); assert.equal(snap.length, 1);
    assert.equal(snap[0]!.id, id); assert.equal(snap[0]!.withdrawn, false);
    (snap[0]!.message as typeof input.message)[0]!.data.file = '快照伪造';
    const restarted = new ChatHistory(dir);
    assert.equal((restarted.pendingIncoming(1)[0]!.message as typeof input.message)[0]!.data.file, '原始媒体');
    assert.equal(restarted.stageIncoming(1, envelope()), id, '重复stage不新建或重置');
});

test('撤回先于媒体解码，重启后prepare在append前持久精确遮盖且保留raw历史', () => {
    const dir = fixture(); const history = new ChatHistory(dir); const id = history.stageIncoming(1, envelope());
    assert.equal(history.recall(1, 7), true); assert.equal(history.pendingIncoming(1)[0]!.withdrawn, true);
    const restarted = new ChatHistory(dir); const message = restarted.prepareIncoming(1, id, decoded(), () => false);
    assert.equal(message.incomingId, id); assert.equal(message.content, '合成解码正文');
    assert.equal(new ChatHistory(dir).pendingIncoming(1)[0]!.prepared!.incomingId, id);
    restarted.append(1, message);
    assert.equal(restarted.load(1)[0]!.content, RECALLED_TEXT);
    assert.ok(readFileSync(join(dir, 'chats', '1.jsonl'), 'utf8').includes('合成解码正文'));
    assert.deepEqual(new ChatHistory(dir).pendingIncoming(1), []);
});

test('prepare固定首次解码与keep，晚撤回在未append阶段重算遮盖，不能借重试改正文', () => {
    const dir = fixture(); const history = new ChatHistory(dir); const id = history.stageIncoming(1, envelope());
    const first = history.prepareIncoming(1, id, decoded('首次正文'), () => false);
    assert.equal(history.recall(1, 7), true);
    const restarted = new ChatHistory(dir);
    const retry = restarted.prepareIncoming(1, id, decoded('后来伪造正文'), () => true);
    assert.equal(retry.content, first.content);
    restarted.append(1, retry); assert.equal(restarted.load(1)[0]!.content, RECALLED_TEXT);
});

test('危机keep优先于pending撤回及孤立legacy wildcard，重启后仍可见', () => {
    const dir = fixture(); const original = new ChatHistory(dir);
    writeFileSync(join(dir, 'chats', '1.recalled.json'), '[7]');
    const id = original.stageIncoming(1, envelope()); assert.equal(original.recall(1, 7), true);
    const message = original.prepareIncoming(1, id, decoded('危机原文必须保留'), () => true);
    original.append(1, message);
    assert.equal(new ChatHistory(dir).load(1)[0]!.content, '危机原文必须保留');
});

test('同弱身份不同载荷保留不同token，已撤回集合不波及后来stage的新条目', () => {
    const history = new ChatHistory(fixture());
    const a = history.stageIncoming(1, { source: { ...source(), messageSeq: undefined }, message: '载荷A' });
    const b = history.stageIncoming(1, { source: { ...source(), messageSeq: undefined }, message: '载荷B' });
    assert.notEqual(a, b); assert.equal(history.recall(1, 7), true);
    const c = history.stageIncoming(1, { source: { ...source(), messageSeq: undefined }, message: '载荷C' });
    const states = history.pendingIncoming(1);
    assert.deepEqual(states.map(row => [row.id, row.withdrawn]), [[a, true], [b, true], [c, false]]);
    assert.equal(history.discardIncoming(1, a), false); assert.equal(history.discardIncoming(1, c), true);
});

test('prepare发布前失败不放行正文且保留未prepared pending，恢复后可重试', () => {
    const dir = fixture(); const history = new ChatHistory(dir); const id = history.stageIncoming(1, envelope()); history.recall(1, 7);
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = () => { throw Object.assign(new Error('合成IO'), { code: 'EIO' }); };
        assert.throws(() => history.prepareIncoming(1, id, decoded(), () => false));
        const persisted = JSON.parse(readFileSync(join(dir, 'chats', '1.recalled.json'), 'utf8'));
        assert.equal(persisted.pending[0].prepared, undefined); assert.equal(persisted.pending[0].withdrawn, true);
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
    assert.equal(new ChatHistory(dir).prepareIncoming(1, id, decoded(), () => false).incomingId, id);
});

test('append发布前失败保留prepared pending，发布后异常读回确认不重放', () => {
    for (const phase of ['before', 'after'] as const) {
        const dir = fixture(); const history = new ChatHistory(dir); const id = history.stageIncoming(1, envelope());
        const message = history.prepareIncoming(1, id, decoded(), () => false);
        const descriptor = Object.getOwnPropertyDescriptor(fs, 'appendFileSync')!, append = fs.appendFileSync;
        try {
            Object.defineProperty(fs, 'appendFileSync', { ...descriptor, value: (...args: Parameters<typeof fs.appendFileSync>) => {
                if (phase === 'after') Reflect.apply(append, fs, args);
                throw Object.assign(new Error('合成追加IO'), { code: 'EIO' });
            } }); syncBuiltinESMExports();
            if (phase === 'before') assert.throws(() => history.append(1, message));
            else assert.doesNotThrow(() => history.append(1, message));
        } finally { Object.defineProperty(fs, 'appendFileSync', descriptor); syncBuiltinESMExports(); }
        const restarted = new ChatHistory(dir);
        if (phase === 'before') { assert.equal(restarted.pendingIncoming(1).length, 1); restarted.append(1, message); }
        else assert.deepEqual(restarted.pendingIncoming(1), []);
        restarted.append(1, message); assert.equal(restarted.load(1).length, 1);
    }
});

test('追加成功后pending清理失败不得重放；发布后清理EIO确认结果', () => {
    for (const phase of ['before', 'after'] as const) {
        const dir = fixture(); const history = new ChatHistory(dir); const id = history.stageIncoming(1, envelope());
        const message = history.prepareIncoming(1, id, decoded(), () => false);
        const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
        try {
            fileOps.writeDelaysMs = [0]; fileOps.renameSync = (from, to) => {
                if (phase === 'after') rename(from, to);
                throw Object.assign(new Error('合成清理IO'), { code: 'EIO' });
            };
            assert.doesNotThrow(() => history.append(1, message));
            assert.deepEqual(new ChatHistory(dir).pendingIncoming(1), [], '已落盘历史是完成事实，不因副状态未清理再次交给receive');
        } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
        assert.deepEqual(new ChatHistory(dir).pendingIncoming(1), []);
        assert.equal(new ChatHistory(dir).load(1).length, 1);
    }
});

test('pending坏schema失败关闭保留原字节，旧无pending v2仍兼容', () => {
    const dir = fixture(); new ChatHistory(dir); const path = join(dir, 'chats', '1.recalled.json');
    const base = { version: 2, legacyIds: [], messages: [] };
    writeFileSync(path, JSON.stringify(base)); assert.deepEqual(new ChatHistory(dir).pendingIncoming(1), []);
    for (const pending of [null, [{ id: 'bad', source: source(), message: 'x', withdrawn: false }], [{ id: 'inc-00000000-0000-0000-0000-000000000000', source: source(), message: null, withdrawn: false }]]) {
        const original = JSON.stringify({ ...base, pending }); writeFileSync(path, original);
        assert.throws(() => new ChatHistory(dir).pendingIncoming(1)); assert.equal(readFileSync(path, 'utf8'), original);
    }
});

test('撤回写失败仍保留RAM观察，prepare/append/read先重试dirty，不从旧intent暴露正文', () => {
    const dir = fixture(); const history = new ChatHistory(dir); const id = history.stageIncoming(1, envelope());
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = () => { throw Object.assign(new Error('合成撤回IO'), { code: 'EIO' }); };
        assert.throws(() => history.recall(1, 7));
        assert.throws(() => history.prepareIncoming(1, id, decoded(), () => false));
        assert.throws(() => history.pendingIncoming(1)); assert.throws(() => history.flushIncoming());
        assert.equal(JSON.parse(readFileSync(join(dir, 'chats', '1.recalled.json'), 'utf8')).pending[0].withdrawn, false, '未持久事实不能冒充已恢复');
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
    history.flushIncoming();
    const restarted = new ChatHistory(dir); assert.equal(restarted.pendingIncoming(1)[0]!.withdrawn, true);
    restarted.append(1, restarted.prepareIncoming(1, id, decoded(), () => false));
    assert.equal(restarted.load(1)[0]!.content, RECALLED_TEXT);
});

test('responder按另一属性顺序重建prepared消息仍可追加，错误内容/token不能放行', () => {
    const history = new ChatHistory(fixture()); const id = history.stageIncoming(1, envelope());
    const message = history.prepareIncoming(1, id, decoded(), () => false);
    assert.throws(() => history.append(1, { ...message, content: '伪造' }));
    const reordered: StoredMessage = { time: message.time, content: message.content, role: message.role, messageId: message.messageId, messageSeq: message.messageSeq, sourceTime: undefined, incomingId: message.incomingId };
    assert.doesNotThrow(() => history.append(1, reordered));
    assert.deepEqual(history.pendingIncoming(1), []);
});

test('明确seq的重复envelope不随媒体URL变化改token或重置撤回，真正不同seq仍独立', () => {
    const history = new ChatHistory(fixture()); const id = history.stageIncoming(1, envelope('旧媒体URL'));
    history.recall(1, 7);
    assert.equal(history.stageIncoming(1, envelope('新媒体URL')), id);
    assert.equal(history.pendingIncoming(1)[0]!.withdrawn, true);
    const message = history.pendingIncoming(1)[0]!.message; assert.ok(Array.isArray(message));
    assert.equal(message[0]!.data.file, '旧媒体URL');
    assert.notEqual(history.stageIncoming(1, { source: source(7, '2'), message: envelope('新媒体URL').message }), id);
});

test('真实追加后stat失效不误报未应用，重启只补完成清理', () => {
    const dir = fixture(); const history = new ChatHistory(dir);
    history.append(1, { role: 'assistant', time: source().time, content: '旧历史', messageId: 9 }); history.load(1);
    const id = history.stageIncoming(1, envelope()), message = history.prepareIncoming(1, id, decoded(), () => false);
    const path = join(dir, 'chats', '1.jsonl'); let appended = false;
    const stat = fs.statSync, append = fs.appendFileSync;
    const statDescriptor = Object.getOwnPropertyDescriptor(fs, 'statSync')!, appendDescriptor = Object.getOwnPropertyDescriptor(fs, 'appendFileSync')!;
    try {
        Object.defineProperty(fs, 'appendFileSync', { ...appendDescriptor, value: (...args: Parameters<typeof fs.appendFileSync>) => { const result = Reflect.apply(append, fs, args); appended = true; return result; } });
        Object.defineProperty(fs, 'statSync', { ...statDescriptor, value: (input: fs.PathLike, ...options: unknown[]) => {
            if (appended && String(input) === path) throw Object.assign(new Error('合成statIO'), { code: 'EIO' });
            return Reflect.apply(stat, fs, [input, ...options]);
        } }); syncBuiltinESMExports();
        assert.doesNotThrow(() => history.append(1, message));
    } finally { Object.defineProperty(fs, 'statSync', statDescriptor); Object.defineProperty(fs, 'appendFileSync', appendDescriptor); syncBuiltinESMExports(); }
    const restarted = new ChatHistory(dir); assert.deepEqual(restarted.pendingIncoming(1), []);
    assert.equal(restarted.load(1).length, 2);
});

test('旧调用方不能绕过已撤回预约直接追加，危机例外仍须明确准备', () => {
    const history = new ChatHistory(fixture()); const id = history.stageIncoming(1, envelope());
    history.recall(1, 7);
    assert.throws(() => history.append(1, decoded()), /预约/);
    assert.deepEqual(history.load(1), []);
    const accepted = history.prepareIncoming(1, id, decoded(), () => true);
    history.append(1, accepted);
    assert.equal(history.load(1)[0]!.content, decoded().content);
});

test('两弱token准备同一正文，一方追加后另一方只提交撤回意图/清理，不再追加', () => {
    const dir = fixture(); const history = new ChatHistory(dir); const weak = { ...source(), messageSeq: undefined };
    const a = history.stageIncoming(1, { source: weak, message: '载荷URL-A' });
    const b = history.stageIncoming(1, { source: weak, message: '载荷URL-B' });
    const message = { ...decoded('同一最终正文'), messageSeq: undefined };
    const first = history.prepareIncoming(1, a, message, () => false), second = history.prepareIncoming(1, b, message, () => false);
    history.append(1, first);
    assert.deepEqual(new ChatHistory(dir).pendingIncoming(1), []);
    assert.doesNotThrow(() => history.append(1, second)); assert.equal(history.load(1).length, 1);
    // raw未prepared条目不因相同元数据被擅自吞掉。
    const unprepared = history.stageIncoming(1, { source: weak, message: '尚未处理的载荷' });
    assert.equal(history.pendingIncoming(1)[0]!.id, unprepared);
});

test('长期pending的已撤回prepared不因200个后来撤回逐出精确mark而暴露', () => {
    const history = new ChatHistory(fixture()); const id = history.stageIncoming(1, envelope());
    history.recall(1, 7); const message = history.prepareIncoming(1, id, decoded('迟到的撤回正文'), () => false);
    for (let n = 0; n < 200; n++) { history.append(1, decoded(`别的正文${n}`, 1000 + n)); history.recall(1, 1000 + n); }
    history.append(1, message); assert.equal(history.load(1).at(-1)!.content, RECALLED_TEXT);
});

test('首次stage发布失败仍保留观察，期间撤回累积后flush可恢复withdrawn预约', () => {
    const dir = fixture(); const history = new ChatHistory(dir);
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = () => { throw Object.assign(new Error('合成stageIO'), { code: 'EIO' }); };
        assert.throws(() => history.stageIncoming(1, envelope()));
        assert.throws(() => history.recall(1, 7), '撤回也被观察但未能持久，不能悄悄返回false丢掉');
        assert.throws(() => history.pendingIncoming(1));
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
    history.flushIncoming();
    const restarted = new ChatHistory(dir), pending = restarted.pendingIncoming(1);
    assert.equal(pending.length, 1); assert.equal(pending[0]!.withdrawn, true);
    restarted.append(1, restarted.prepareIncoming(1, pending[0]!.id, decoded(), () => false));
    assert.equal(restarted.load(1)[0]!.content, RECALLED_TEXT);
});

test('IO故障期间连续不同ID撤回和新stage都可叠加观察，不因前次dirty阻止新事实', () => {
    const dir = fixture(); const history = new ChatHistory(dir);
    const a = history.stageIncoming(1, envelope());
    const b = history.stageIncoming(1, { source: source(8, '2'), message: '第二条' });
    const first = history.prepareIncoming(1, a, decoded('第一条正文'), () => false);
    const second = history.prepareIncoming(1, b, decoded('第二条正文', 8, '2'), () => false);
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = () => { throw Object.assign(new Error('合成连续IO'), { code: 'EIO' }); };
        assert.throws(() => history.recall(1, 7)); assert.throws(() => history.recall(1, 8));
        assert.throws(() => history.stageIncoming(1, { source: source(9, '3'), message: '故障期间第三条' }));
        assert.throws(() => history.recall(1, 9));
        assert.throws(() => history.append(1, first), '普通处理仍须先flush');
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
    history.flushIncoming();
    const restarted = new ChatHistory(dir), pending = restarted.pendingIncoming(1);
    assert.equal(pending.length, 3); assert.ok(pending.every(entry => entry.withdrawn));
    restarted.append(1, first); restarted.append(1, second);
    const third = pending.find(entry => entry.source.messageId === 9)!;
    restarted.append(1, restarted.prepareIncoming(1, third.id, decoded('第三条正文', 9, '3'), () => false));
    assert.deepEqual(restarted.load(1).map(message => message.content), [RECALLED_TEXT, RECALLED_TEXT, RECALLED_TEXT]);
});

test('已追加并已回复的pending残留不再成为撤回候选，清理IO失败也不绕过unanswered保护', () => {
    const dir = fixture(); const history = new ChatHistory(dir); const id = history.stageIncoming(1, envelope());
    const message = history.prepareIncoming(1, id, decoded('已经被回答的原文'), () => false);
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = () => { throw Object.assign(new Error('合成清理延迟'), { code: 'EIO' }); };
        history.append(1, message);
        assert.equal(JSON.parse(readFileSync(join(dir, 'chats', '1.recalled.json'), 'utf8')).pending.length, 1);
        history.append(1, { role: 'assistant', time: source().time, content: '已经回复', messageId: 8 });
        assert.equal(history.recall(1, 7), false, '副状态残留不能把已确认并已回答的消息重新归为未处理');
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
    history.flushIncoming();
    const restarted = new ChatHistory(dir); assert.deepEqual(restarted.pendingIncoming(1), []);
    assert.equal(restarted.load(1)[0]!.content, '已经被回答的原文');
});
