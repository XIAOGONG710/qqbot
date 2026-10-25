import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { HindsightApi, MemoryItem } from '../src/memory/hindsight.ts';
import { auditedApi, memoryLedger, recordForget, recordNote, summarize } from '../src/memory-audit.ts';

// ADR 0158：长期记忆的写入、删除和纠错说明都留痕（只记哈希，不记原文）
describe('记忆账本', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const setup = () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memaudit-'));
        dirs.push(dir);
        const calls: string[] = [];
        class Fake {
            #private = 1;
            async retain(bank: string, item: MemoryItem) { calls.push(`retain ${bank} ${item.document_id}`); }
            async recall() { return []; }
            async health() { return this.#private; }
            async createMentalModel() { calls.push('create'); }
        }
        const raw = new Fake() as unknown as HindsightApi & { health(): Promise<number> };
        const ledger = memoryLedger(dir);
        return { dir, calls, ledger, api: auditedApi(raw, ledger, { now: () => new Date(2026, 9, 26, 1, 0) }) };
    };
    const item: MemoryItem = { content: '今天吃了泡面，加了个蛋', timestamp: '2026-10-25T15:45:00Z', context: 'chat', document_id: 'doc-1', tags: ['a'], metadata: {} };

    test('写入成功之后记一行：哪个库、哪篇文档、多长、哈希前 16 位，账本里没有原文', async () => {
        const { api, ledger, calls, dir } = setup();
        await api.retain('bank-1', item);
        assert.deepEqual(calls, ['retain bank-1 doc-1']);
        const [entry] = ledger.read();
        assert.equal(entry!.kind, 'retain');
        assert.deepEqual([entry!.data.bank, entry!.data.document, entry!.data.chars], ['bank-1', 'doc-1', 11]);
        assert.match(String(entry!.data.sha), /^[0-9a-f]{16}$/);
        assert.ok(!readFileSync(join(dir, 'identity', 'memory.jsonl'), 'utf8').includes('泡面'), '账本里不能有原文');
        assert.equal(ledger.verify().ok, true);
    });

    test('写入本身失败：不留痕（没写进去），错误照样抛给调用方', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memaudit-'));
        dirs.push(dir);
        const failing = { retain: async () => { throw new Error('连不上'); } } as unknown as HindsightApi;
        const ledger = memoryLedger(dir);
        await assert.rejects(() => auditedApi(failing, ledger).retain('b', item), /连不上/);
        assert.equal(ledger.read().length, 0);
    });

    test('别的方法原样转发（包括用到私有字段的）；建印象模型也留痕', async () => {
        const { api, ledger, calls } = setup();
        assert.deepEqual(await api.recall('b', {} as never), []);
        assert.equal(await (api as unknown as { health(): Promise<number> }).health(), 1);
        await (api.createMentalModel as unknown as (b: string, r: unknown) => Promise<void>)('b', { id: 'm1', name: '印象', source_query: '他是谁', tags: [], max_tokens: 100, trigger: {} });
        assert.ok(calls.includes('create'));
        assert.equal(ledger.read().at(-1)!.kind, 'model-create');
    });

    test('账本写不进去也不影响写入：照常写，记一行日志', async () => {
        const logs: string[] = [];
        const raw = { retain: async () => undefined } as unknown as HindsightApi;
        const broken = { append: () => { throw new Error('磁盘满了'); } } as never;
        await auditedApi(raw, broken, { log: m => logs.push(m) }).retain('b', item);
        assert.ok(logs.some(l => l.includes('没留痕')));
    });

    test('忘掉联系人记 forget（只记 id 数量、联系人只留哈希）；演练另记；手写说明记 note；摘要里按种类数', () => {
        const { ledger } = setup();
        recordForget(ledger, 2260168937, { applied: true, deleted: { banks: ['b1'], documents: ['d1', 'd2'], mentalModels: ['m1'] }, trash: 'runtime/privacy-trash/x', failures: [] });
        recordForget(ledger, 2260168937, { applied: false, plan: { hindsight: { banks: ['b1'], documents: ['d1'], mentalModels: [] } } });
        recordNote(ledger, '10-25 把“笔记本明天到”那条错的记忆标为作废', 'user');
        const kinds = ledger.read().map(e => e.kind);
        assert.deepEqual(kinds, ['forget', 'forget-dry-run', 'note']);
        assert.ok(!JSON.stringify(ledger.read()[0]).includes('2260168937'), '联系人 QQ 号不明文记');
        assert.deepEqual([ledger.read()[0]!.data.documents, ledger.read()[0]!.data.mentalModels], [2, 1]);
        const text = summarize(ledger);
        assert.match(text, /验过了/);
        assert.match(text, /忘掉联系人 1/);
        assert.match(text, /说明 1/);
    });
});
