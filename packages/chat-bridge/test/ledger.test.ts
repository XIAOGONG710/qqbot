import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLedger, fileLedgerStorage, memoryLedgerStorage } from '../src/ledger.ts';
import { tempDir } from './helpers.ts';
import { join } from 'node:path';

const text = (value: string) => [{ kind: 'text' as const, text: value }];

test('消息和事件共用一条单调递增的 seq', () => {
    const ledger = createLedger(memoryLedgerStorage());
    assert.equal(ledger.seq, 0);
    const first = ledger.appendMessage({ id: 1, from: 'me', via: 'app', at: 1000, parts: text('a'), clientId: 'c1' });
    const event = ledger.appendEvent({ kind: 'read', upTo: 1 }, 1500);
    const second = ledger.appendMessage({ id: 2, from: 'her', via: 'qq', at: 2000, parts: text('b'), replyTo: 1 });
    assert.deepEqual([first.seq, event.seq, second.seq], [1, 2, 3]);
    assert.equal(ledger.seq, 3);
    assert.equal(ledger.byId(2)?.replyTo, 1);
    assert.equal(ledger.byClientId('c1')?.id, 1);
    assert.equal(ledger.lastFromMe()?.id, 1);
    assert.equal(ledger.lastReadUpTo(), 1);
});

test('只追加：撤回是一条新行，不改旧行；重读后 recalled 还在', () => {
    const storage = memoryLedgerStorage();
    const ledger = createLedger(storage);
    ledger.appendMessage({ id: 7, from: 'her', via: 'app', at: 1, parts: text('说错了') });
    const before = storage.text();
    ledger.appendEvent({ kind: 'recall', id: 7 }, 2);
    assert.ok(storage.text().startsWith(before));
    assert.equal(storage.text().split('\n').filter(Boolean).length, 2);
    assert.equal(before.includes('recalled'), false);
    assert.equal(ledger.byId(7)?.recalled, true);

    const reloaded = createLedger(memoryLedgerStorage(storage.text()));
    assert.equal(reloaded.seq, 2);
    assert.equal(reloaded.byId(7)?.recalled, true);
    assert.deepEqual(reloaded.after(0, 10).map(entry => 'message' in entry ? 'm' : 'e'), ['m', 'e']);
});

test('最后一行写了一半：前面的照常读回，下一条不会粘在半行后面', () => {
    const storage = memoryLedgerStorage();
    const ledger = createLedger(storage);
    ledger.appendMessage({ id: 1, from: 'me', via: 'app', at: 1, parts: text('a') });
    ledger.appendMessage({ id: 2, from: 'her', via: 'app', at: 2, parts: text('b') });
    const torn = memoryLedgerStorage(`${storage.text()}{"m":{"seq":3,"id":3,"from":"me","par`);

    const reloaded = createLedger(torn);
    assert.equal(reloaded.seq, 2);
    const next = reloaded.appendMessage({ id: 4, from: 'me', via: 'app', at: 3, parts: text('c') });
    assert.equal(next.seq, 3);

    const again = createLedger(memoryLedgerStorage(torn.text()));
    assert.deepEqual(again.after(0, 10).map(entry => 'message' in entry ? entry.message.id : -1), [1, 2, 4]);
});

test('坏行、形状不对的行、seq 倒退的行都跳过', () => {
    const lines = [
        '{"m":{"seq":1,"id":1,"from":"me","via":"app","at":1,"parts":[{"kind":"text","text":"a"}]}}',
        'not json',
        '{"m":{"seq":2,"id":2,"from":"someone","via":"app","at":1,"parts":[]}}',
        '{"m":{"seq":1,"id":9,"from":"me","via":"app","at":1,"parts":[]}}',
        '{"e":{"seq":5,"at":1,"event":{"kind":"unknown"}}}',
        '{"e":{"seq":5,"at":1,"event":{"kind":"reaction","id":1,"emojiId":76}}}',
        '',
    ];
    const ledger = createLedger(memoryLedgerStorage(lines.join('\n')));
    assert.equal(ledger.seq, 5);
    assert.equal(ledger.after(0, 10).length, 2);
    assert.equal(ledger.byId(9), undefined);
    assert.equal(ledger.appendMessage({ id: 3, from: 'me', via: 'app', at: 2, parts: [] }).seq, 6);
});

test('after：只给 since 之后的；太多时只给最新的', () => {
    const ledger = createLedger(memoryLedgerStorage());
    for (let id = 1; id <= 10; id++) ledger.appendMessage({ id, from: 'me', via: 'app', at: id, parts: text(String(id)) });
    const seqs = (entries: ReturnType<typeof ledger.after>) => entries.map(entry => 'message' in entry ? entry.message.seq : entry.event.seq);
    assert.deepEqual(seqs(ledger.after(7, 100)), [8, 9, 10]);
    assert.deepEqual(seqs(ledger.after(10, 100)), []);
    assert.deepEqual(seqs(ledger.after(0, 3)), [8, 9, 10]);
    assert.deepEqual(seqs(ledger.after(99, 3)), []);
});

test('before：往前翻一页消息，带上这段里的事件', () => {
    const ledger = createLedger(memoryLedgerStorage());
    ledger.appendMessage({ id: 1, from: 'me', via: 'app', at: 1, parts: text('1') });      // seq 1
    ledger.appendEvent({ kind: 'read', upTo: 1 }, 1);                                       // seq 2
    ledger.appendMessage({ id: 2, from: 'her', via: 'app', at: 2, parts: text('2') });     // seq 3
    ledger.appendEvent({ kind: 'reaction', id: 2, emojiId: 76 }, 2);                        // seq 4
    ledger.appendMessage({ id: 3, from: 'me', via: 'qq', at: 3, parts: text('3') });       // seq 5

    const page = ledger.before(5, 1);
    assert.deepEqual(page.messages.map(message => message.seq), [3]);
    assert.deepEqual(page.events.map(event => event.seq), [4]);

    const all = ledger.before(6, 100);
    assert.deepEqual(all.messages.map(message => message.seq), [1, 3, 5]);
    assert.deepEqual(all.events.map(event => event.seq), [2, 4]);
    assert.deepEqual(ledger.before(1, 100), { messages: [], events: [] });
});

test('recentMessages 和中继 id 的最大值', () => {
    const ledger = createLedger(memoryLedgerStorage());
    for (const id of [5, 10_000_000_001, 6, 10_000_000_002]) ledger.appendMessage({ id, from: 'her', via: 'app', at: id, parts: text('x') });
    assert.deepEqual(ledger.recentMessages(2).map(message => message.id), [6, 10_000_000_002]);
    assert.deepEqual(ledger.recentMessages(2, 6).map(message => message.id), [10_000_000_001, 6]);
    assert.equal(ledger.maxIdAtLeast(10_000_000_000), 10_000_000_002);
    assert.equal(createLedger(memoryLedgerStorage()).maxIdAtLeast(10_000_000_000), undefined);
});

test('文件存储：没有文件时是空账，写下去重开能读回', t => {
    const path = join(tempDir(t), 'nested', 'log.jsonl');
    const ledger = createLedger(fileLedgerStorage(path));
    assert.equal(ledger.seq, 0);
    ledger.appendMessage({ id: 1, from: 'me', via: 'app', at: 1, parts: text('在吗') });
    assert.equal(createLedger(fileLedgerStorage(path)).byId(1)?.parts[0]?.kind, 'text');
});
