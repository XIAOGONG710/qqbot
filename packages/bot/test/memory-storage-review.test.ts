import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ChatHistory, type StoredMessage } from '../src/memory/history.ts';
import { readJsonOr, writeJsonAtomic } from '../src/memory/json-file.ts';
import { stateTimestamp } from '../src/memory/state-schema.ts';
import { findMissed, shouldCatchUp, toStored, type HistoryMessage } from '../src/memory/backfill.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-storage-review-')); dirs.push(dir); return dir; };
const message = (id: number): StoredMessage => ({ role: 'user', time: '2026-11-05T12:00:00.000Z', content: `合成消息${id}`, messageId: id });

test('非JSON根值不能发布坏文件，序列化失败保留原文件且不留临时文件', () => {
    const dir = fixture(); const path = join(dir, 'state.json');
    writeJsonAtomic(path, { fact: 1 }); const before = readFileSync(path, 'utf8');
    for (const value of [undefined, () => undefined, Symbol('synthetic'), { toJSON: () => undefined }]) {
        assert.throws(() => writeJsonAtomic(path, value));
        assert.equal(readFileSync(path, 'utf8'), before);
        assert.deepEqual(readdirSync(dir), ['state.json']);
    }
});

test('JSON损坏/迁移异常日志和抛错不带私密正文，throw保留原文件', () => {
    const dir = fixture(); const path = join(dir, 'state.json'); const secret = 'PRIVATE42';
    const broken = `{"text":${secret}}`;
    writeFileSync(path, broken);
    assert.throws(() => readJsonOr(path, {}, undefined, { invalid: 'throw' }), error => !String(error).includes(secret));
    assert.equal(readFileSync(path, 'utf8'), broken);
    const logs: string[] = [];
    readJsonOr(path, {}, text => logs.push(text));
    assert.ok(logs.every(text => !text.includes(secret)));
    writeFileSync(path, '{}');
    assert.throws(() => readJsonOr(path, {}, undefined, { invalid: 'throw', migrate: () => { throw new Error(secret); } }), error => !String(error).includes(secret));
});

test('持久时间戳的UTC瞬时也须四位年，合法低年与正常偏移保留', () => {
    assert.equal(stateTimestamp('0000-01-01T00:00:00+14:00'), false);
    assert.equal(stateTimestamp('9999-12-31T23:59:00-14:00'), false);
    for (const time of ['0000-01-01T14:00:00+14:00', '0099-12-31T23:00:00Z', '2026-11-05T12:00:00+08:00']) assert.equal(stateTimestamp(time), true);
});

test('崩溃尾半行之后追加新消息，活实例和重启后都能读到，原尾字节仍保留', () => {
    const dir = fixture(); const history = new ChatHistory(dir); const path = join(dir, 'chats', '1.jsonl');
    const prefix = JSON.stringify(message(1)) + '\n' + '{"time":"unfinished';
    writeFileSync(path, prefix);
    assert.equal(history.load(1).length, 1);
    history.append(1, message(2));
    assert.deepEqual(history.load(1).map(m => m.messageId), [1, 2]);
    assert.deepEqual(new ChatHistory(dir).load(1).map(m => m.messageId), [1, 2]);
    assert.ok(readFileSync(path, 'utf8').startsWith(prefix));
});

test('load快照不能修改缓存事实和ID索引', () => {
    const history = new ChatHistory(fixture()); history.append(1, message(1));
    const snapshot = history.load(1); snapshot[0]!.content = '伪造正文'; snapshot[0]!.messageId = 999;
    assert.equal(history.load(1)[0]!.content, '合成消息1');
    assert.equal(history.load(1)[0]!.messageId, 1);
    assert.equal(history.hasMessage(1, 1), true);
    assert.equal(history.hasMessage(1, 999), false);
});

test('append之后调用方修改原对象不改变活缓存，与重启读盘一致', () => {
    const dir = fixture(); const history = new ChatHistory(dir); history.append(1, message(1)); history.load(1);
    const next = message(2); history.append(1, next); next.content = '伪造正文'; next.messageId = 999;
    assert.deepEqual(history.load(1), new ChatHistory(dir).load(1));
});

test('补回坏时间/ID/消息容器不拖垮其它合法事实，同批重复事实只补一次', () => {
    const valid: HistoryMessage = { message_id: 7, time: 100, sender: { user_id: 2 }, message: '合法' };
    const malformed = [ { ...valid, time: 1e15 }, { ...valid, message_id: -1 }, { ...valid, message: null }, { ...valid, message: [null] } ] as unknown as HistoryMessage[];
    assert.deepEqual(toStored([...malformed, valid], 1).map(m => m.content), ['合法']);
    assert.equal(findMissed([], [valid, valid], 1).length, 1);
});

test('未来的待回复消息不触发当前补回回复，正常三小时窗口保持', () => {
    const now = new Date('2026-11-05T12:00:00Z');
    assert.equal(shouldCatchUp([{ ...message(1), time: '2026-11-05T12:01:00Z' }], now), false);
    assert.equal(shouldCatchUp([{ ...message(1), time: '2026-11-05T11:59:00Z' }], now), true);
});

test('损坏的撤回标记失败关闭，保留原文件且不将原文重新交给调用方', () => {
    const dir = fixture(); const history = new ChatHistory(dir); history.append(1, message(1));
    const path = join(dir, 'chats', '1.recalled.json');
    for (const original of ['[1,', '{"private":"SYNTHETIC_PRIVATE_RECALL"}', '[1,-2]']) {
        writeFileSync(path, original);
        assert.throws(() => new ChatHistory(dir).load(1), error => !String(error).includes('SYNTHETIC_PRIVATE_RECALL'));
        assert.equal(readFileSync(path, 'utf8'), original);
    }
});

test('同大小同mtime原子替换后，活缓存和ID索引使用新文件事实', () => {
    const dir = fixture(); const history = new ChatHistory(dir); const path = join(dir, 'chats', '1.jsonl');
    const time = new Date('2026-01-01T00:00:00Z');
    writeFileSync(path, JSON.stringify(message(1)) + '\n'); utimesSync(path, time, time);
    assert.equal(history.hasMessage(1, 1), true);
    const before = statSync(path, { bigint: true });
    writeFileSync(path + '.next', JSON.stringify(message(2)) + '\n'); utimesSync(path + '.next', time, time);
    renameSync(path + '.next', path);
    const after = statSync(path, { bigint: true });
    assert.equal(before.size, after.size); assert.equal(before.mtimeNs, after.mtimeNs);
    assert.notEqual(`${before.dev}:${before.ino}:${before.ctimeNs}`, `${after.dev}:${after.ino}:${after.ctimeNs}`, '实际文件系统提供替换身份变化');
    assert.deepEqual(history.load(1).map(m => m.messageId), [2]);
    assert.equal(history.hasMessage(1, 1), false); assert.equal(history.hasMessage(1, 2), true);
});

test('同大小同mtime替换后直接append不把旧缓存拼接到新文件', () => {
    const dir = fixture(); const history = new ChatHistory(dir); const path = join(dir, 'chats', '1.jsonl');
    const time = new Date('2026-01-01T00:00:00Z');
    writeFileSync(path, JSON.stringify(message(1)) + '\n'); utimesSync(path, time, time); history.load(1);
    writeFileSync(path + '.next', JSON.stringify(message(2)) + '\n'); utimesSync(path + '.next', time, time); renameSync(path + '.next', path);
    history.append(1, message(3));
    assert.deepEqual(history.load(1).map(m => m.messageId), [2, 3]);
    assert.deepEqual(history.load(1), new ChatHistory(dir).load(1));
});

test('存在性探测掩盖IO错误时，读/ID检查/追加仍传播非ENOENT，保留真实文件和缓存', () => {
    const dir = fixture(); const history = new ChatHistory(dir); history.append(1, message(1)); history.load(1);
    const path = join(dir, 'chats', '1.jsonl'); const before = readFileSync(path, 'utf8');
    const exists = fs.existsSync; const stat = fs.statSync; const descriptor = Object.getOwnPropertyDescriptor(fs, 'statSync')!;
    const failure = Object.assign(new Error('合成IO错误'), { code: 'EIO' });
    try {
        // existsSync对底层权限/IO失败只说false；stat保留可分类错误。
        fs.existsSync = input => String(input) === path ? false : exists(input);
        Object.defineProperty(fs, 'statSync', { ...descriptor, value: ((input: fs.PathLike, ...options: unknown[]) => {
            if (String(input) === path) throw failure;
            return Reflect.apply(stat, fs, [input, ...options]);
        }) as typeof fs.statSync });
        syncBuiltinESMExports();
        assert.throws(() => history.load(1), error => error === failure);
        assert.throws(() => history.hasMessage(1, 1), error => error === failure);
        assert.throws(() => history.append(1, message(2)), error => error === failure);
    } finally { fs.existsSync = exists; Object.defineProperty(fs, 'statSync', descriptor); syncBuiltinESMExports(); }
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(history.hasMessage(1, 1), true);
});
