import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { auditedApi, memoryLedger } from '../src/memory/memory-audit.ts';
import type { HindsightApi, MemoryItem } from '../src/memory/hindsight.ts';

const item: MemoryItem = { content: 'SYNTHETIC_PRIVATE_BODY', timestamp: '2026-11-05T00:00:00Z', context: 'synthetic', document_id: 'ep-1', tags: [], metadata: {} };
async function fixture(work: (dir: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-advanced-audit-'));
    try { await work(dir); }
    finally { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-advanced-audit-')); rmSync(dir, { recursive: true, force: true }); }
}

test('审计代理保留advanced能力缺省，不冒充旧API具备可恢复任务协议', async () => fixture(async dir => {
    const api = auditedApi({ retain: async () => {} } as unknown as HindsightApi, memoryLedger(dir));
    assert.equal(api.submitRetain, undefined); assert.equal(api.retentionStatus, undefined); assert.equal(api.deleteDocument, undefined);
}));

test('可恢复提交原UUID/请求透传，审计仅记受理和摘要，不把原文复制进账本', async () => fixture(async dir => {
    const calls: unknown[][] = [];
    class Fake {
        #value = 'bound';
        async submitRetain(bank: string, value: MemoryItem, operation: string) { calls.push([this.#value, bank, value, operation]); }
        async retentionStatus() { assert.equal(this.#value, 'bound'); return 'pending' as const; }
    }
    const ledger = memoryLedger(dir), api = auditedApi(new Fake() as unknown as HindsightApi, ledger);
    await api.submitRetain!('bank', item, 'synthetic-operation');
    assert.deepEqual(calls, [['bound', 'bank', item, 'synthetic-operation']]);
    assert.equal(await api.retentionStatus!('bank', 'synthetic-operation'), 'pending');
    const [entry] = ledger.read(); assert.equal(entry!.kind, 'retain-submit'); assert.equal(entry!.data.stage, 'accepted');
    assert.match(String(entry!.data.operation), /^[a-f0-9]{16}$/);
    assert.doesNotMatch(readFileSync(join(dir, 'identity', 'memory.jsonl'), 'utf8'), /SYNTHETIC_PRIVATE_BODY|synthetic-operation/);
    assert.equal(ledger.verify().ok, true);
}));

test('精确文档删除留痕，删除失败不记成功，派生审计失败不改已发生删除结果', async () => fixture(async dir => {
    const calls: string[] = [];
    const raw = { deleteDocument: async (bank: string, document: string) => { calls.push(`${bank}/${document}`); if (document === 'fail') throw new Error('synthetic'); } } as unknown as HindsightApi;
    const ledger = memoryLedger(dir), api = auditedApi(raw, ledger);
    await api.deleteDocument!('bank', 'doc'); await assert.rejects(api.deleteDocument!('bank', 'fail'));
    assert.deepEqual(calls, ['bank/doc', 'bank/fail']);
    assert.deepEqual(ledger.read().map(entry => [entry.kind, entry.data.document]), [['document-delete', 'doc']]);
    const broken = { append() { throw new Error('synthetic'); } } as never;
    await auditedApi(raw, broken).deleteDocument!('bank', 'still-deleted');
    assert.equal(calls.at(-1), 'bank/still-deleted');
}));
