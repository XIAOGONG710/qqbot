// Correctness probe: accepted is not completed. Synthetic data and fake HTTP only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { diaryWriter } from '../../../packages/bot/src/life/diary.ts';
import { LongTermMemory } from '../../../packages/bot/src/memory/long-term.ts';
import { HindsightClient } from '../../../packages/bot/src/memory/hindsight.ts';

const root = mkdtempSync(join(tmpdir(), 'qqbot-diary-acceptance-'));
const originalFetch = globalThis.fetch, operations = new Map();
let polls = 0, submissions = 0, generated = 0;
globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://synthetic.invalid');
    const bank = decodeURIComponent(url.pathname.split('/banks/')[1]?.split('/')[0] ?? '');
    if (init?.method === 'PUT') return Response.json({});
    if (init?.method === 'POST' && url.pathname.endsWith('/memories')) {
        const body = JSON.parse(String(init.body));
        assert.match(body.operation_id, /^[a-f0-9-]{36}$/);
        submissions++;
        operations.set(body.operation_id, 'pending');
        return Response.json({ success: true, async: true, bank_id: bank, items_count: 1, operation_id: body.operation_id });
    }
    const id = url.pathname.split('/operations/')[1];
    if (id) {
        polls++;
        const status = operations.get(id) ?? 'not_found';
        return Response.json({ operation_id: id, status, operation_type: status === 'not_found' ? null : 'batch_retain',
            ...(status === 'completed' ? { child_operations: [{ operation_id: '22222222-2222-4222-8222-222222222222', status: 'completed' }] } : {}) });
    }
    if (url.pathname.endsWith('/operations')) return Response.json({ bank_id: bank, operations: [], total: 0 });
    throw new Error('Unexpected synthetic route');
};
const schedule = { sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: '1' }, periods: { 1: { start: '08:00', end: '09:30' } },
    semester: { start: '2026-09-01', weeks: 20 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
    free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成' };
const memory = new LongTermMemory({ api: new HindsightClient('http://synthetic.invalid', 1000), dir: root, bankPrefix: 'synthetic', common: true, recallTimeoutMs: 100, log() {} });
const options = { sources: { charName: '合成角色', schedule, moods: [], books: [] }, contacts: [], history: { load: () => [] }, memory,
    generate: async () => { generated++; return '合成日记正文'; }, dir: root, log() {} };
let writer = diaryWriter(options);
const now = new Date('2026-11-05T12:00:00');
const state = () => JSON.parse(readFileSync(join(root, 'diary.json'), 'utf8'));
try {
    await writer.catchUp(now);
    assert.equal(submissions, 1);
    assert.equal(Object.keys(state().written).length, 0);
    const prepared = Object.values(state().prepared)[0];
    assert.equal(operations.get(prepared.operationId), 'pending');
    const pendingPolls = polls;
    await writer.stop();
    writer = diaryWriter(options);
    await writer.catchUp(now);
    assert.equal(submissions, 1);
    assert.equal(generated, 1);
    assert.equal(Object.keys(state().written).length, 0);
    assert.ok(polls > pendingPolls);
    assert.deepEqual(Object.values(state().prepared)[0], prepared);
    operations.set(prepared.operationId, 'completed');
    await writer.catchUp(now);
    const completed = state();
    assert.equal(completed.confirmed[prepared.documentId].operationId, prepared.operationId);
    assert.equal(completed.confirmed[prepared.documentId].sourceVerified, true);
    assert.equal(completed.texts[prepared.date], prepared.body);
    assert.ok(completed.written[prepared.date] > 0);
    console.log(JSON.stringify({ realClientFakeHTTP: true, pendingNeverWritten: true, restartPolledSameUUID: true, completedReceiptForFrozenBody: true }));
} finally {
    await writer.stop(); await memory.stop(); globalThis.fetch = originalFetch;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('qqbot-diary-acceptance-'));
    rmSync(root, { recursive: true, force: true });
}
