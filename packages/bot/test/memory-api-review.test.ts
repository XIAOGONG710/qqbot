import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HindsightClient, HindsightError } from '../src/memory/hindsight.ts';
import { lastTouched } from '../src/memory/fading.ts';
import type { RecallRequest } from '../src/memory/hindsight.ts';
import { LongTermMemory } from '../src/memory/long-term.ts';
import type { HindsightApi, MemoryItem } from '../src/memory/hindsight.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('queued retention owns a snapshot of messages, contact and names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-api-review-'));
    const retained: MemoryItem[] = [];
    const banks: string[] = [];
    const api: HindsightApi = {
        putBank: async () => {}, retain: async (bank, item) => { banks.push(bank); retained.push(item); },
        recall: async () => [], getMentalModel: async () => undefined,
        createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '',
    };
    try {
        const memory = new LongTermMemory({ api, dir, bankPrefix: 'synthetic', recallTimeoutMs: 100, log() {}, now: () => Date.parse('2026-11-05T12:00:00Z') });
        const contact = { qq: 1, tier: 'boyfriend' };
        const names = { char: 'Synthetic character', user: 'Synthetic user' };
        const history = [{ role: 'user' as const, content: 'ORIGINAL', time: '2026-11-04T12:00:00Z', messageId: 1 }];
        const task = memory.sync(contact, names, history);
        const expectedBank = memory.bankId(contact);
        history[0]!.content = 'MUTATED';
        names.user = 'MUTATED';
        contact.qq = 2;
        await task;
        assert.equal(retained.length, 1);
        assert.deepEqual(banks, [expectedBank]);
        assert.match(retained[0]!.content, /ORIGINAL/);
        assert.doesNotMatch(retained[0]!.content, /MUTATED/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Hindsight rejects malformed recall values before they enter prompts', async () => {
    const original = globalThis.fetch;
    try {
        for (const body of [null, { results: [null] }, { results: [{ id: 'x', text: 'x', entities: [1] }] }, { results: [{ id: 'x', text: 42 }] }]) {
            globalThis.fetch = async () => Response.json(body);
            await assert.rejects(new HindsightClient('http://localhost', 100).recall('b', {} as RecallRequest), /响应格式无效/);
        }
    } finally { globalThis.fetch = original; }
});

test('Hindsight deadline also bounds a fetch implementation that ignores abort', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => new Promise(() => {});
    try { await assert.rejects(new HindsightClient('http://localhost', 20).health(20), /超时/); }
    finally { globalThis.fetch = original; }
});

test('Hindsight failure never includes private response, path or parser fragments', async () => {
    const original = globalThis.fetch;
    try {
        for (const response of [new Response('PRIVATE_BODY', { status: 503 }), new Response('{"PRIVATE_BODY":')]) {
            globalThis.fetch = async () => response;
            await assert.rejects(new HindsightClient('http://localhost', 100).getDocument('PRIVATE_BANK', 'PRIVATE_DOC'), error => {
                assert.ok(error instanceof HindsightError);
                assert.doesNotMatch(error.message, /PRIVATE/);
                return true;
            });
        }
    } finally { globalThis.fetch = original; }
});

test('Hindsight deadline includes a body that ignores abort and releases its reader', async () => {
    const original = globalThis.fetch;
    let canceled = false;
    const stream = new ReadableStream({ cancel() { canceled = true; } });
    globalThis.fetch = async () => new Response(stream);
    try {
        await assert.rejects(new HindsightClient('http://localhost', 20).health(20), /超时/);
        assert.equal(canceled, true);
        assert.equal(stream.locked, false);
    } finally { globalThis.fetch = original; }
});

test('Hindsight rejects oversized streamed data and cancels the body', async () => {
    const original = globalThis.fetch;
    let canceled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
        cancel() { canceled = true; },
    }));
    try {
        await assert.rejects(new HindsightClient('http://localhost', 100).health(100), /过大/);
        assert.equal(canceled, true);
    } finally { globalThis.fetch = original; }
});

test('dated memory preserves year 0099 instead of moving it to 1999', () => {
    const date = lastTouched({ id: 'synthetic', text: '', document_id: 'diary:0099-02-03' })!;
    assert.equal(date.getFullYear(), 99);
    assert.equal(date.getMonth(), 1);
    assert.equal(date.getDate(), 3);
});
