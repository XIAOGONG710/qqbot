import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as runner from '../src/sim/runner.ts';
import type { SimHindsight } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { LongTermMemory } from '../src/memory/long-term.ts';
import { HindsightClient, type MemoryItem } from '../src/memory/hindsight.ts';
import type { Schedule } from '../src/life/schedule.ts';

const schedule: Schedule = { sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:30' } },
    semester: { start: '2026-09-01', weeks: 20 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
    free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成学校' };
const UUID = '11111111-1111-4111-8111-111111111111';
function wrapped(api: SimHindsight, down: () => boolean): SimHindsight {
    const factory = (runner as unknown as { switchable?: (api: SimHindsight, down: () => boolean) => SimHindsight }).switchable;
    assert.equal(typeof factory, 'function'); return factory!(api, down);
}
function minimal(): SimHindsight { return { putBank: async () => {}, retain: async () => {}, recall: async () => [], getMentalModel: async () => undefined, createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '', activeOperations: async () => [], operationStatus: async () => 'completed', deleteBank: async () => {} }; }

test('真实模拟宿主＋真实SDK保留advanced：accepted/pending不写written，重开只核旧UUID/body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-sim-capabilities-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const path = join(root, 'synthetic-card.json'); writeFileSync(path, JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const card = loadTierCard(path, 'classmate'); card.character.schedule = structuredClone(schedule);
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'classmate', name: '合成甲' }] }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const scenario = parseScenario({ name: 'SYNTHETIC_ADVANCED_CAPABILITIES', tier: 'classmate', start: '2026-11-09T12:00:00+08:00', memory: true, schedule: true, steps: [{ memory: 'sync' }] });
    const originalFetch = globalThis.fetch, originalBank = LongTermMemory.prototype.commonBankId, instances = new Set<LongTermMemory>();
    const operations = new Map<string, string>(), posts: { id?: string; content: string }[] = []; let generated = 0;
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input)); assert.equal(url.origin, 'http://synthetic.invalid'); const bank = url.pathname.split('/banks/')[1]?.split('/')[0];
        if (init?.method === 'PUT') return Response.json({});
        if (init?.method === 'POST' && url.pathname.endsWith('/memories')) {
            const body = JSON.parse(String(init.body)), id = body.operation_id ?? randomUUID(); posts.push({ id: body.operation_id, content: body.items[0].content }); operations.set(id, 'pending');
            return Response.json({ success: true, async: true, bank_id: bank, items_count: 1, operation_id: id });
        }
        if (url.pathname.endsWith('/operations')) return Response.json({ bank_id: bank, operations: [], total: 0 });
        const id = url.pathname.split('/operations/')[1];
        if (id) { const status = operations.get(id) ?? 'not_found'; return Response.json({ operation_id: id, operation_type: status === 'not_found' ? null : 'batch_retain', status,
            ...(status === 'completed' ? { child_operations: [{ operation_id: UUID, status: 'completed' }] } : {}) }); }
        if (url.pathname.includes('/mental-models/') || url.pathname.includes('/documents/')) return new Response('', { status: 404 });
        if (init?.method === 'POST' && url.pathname.endsWith('/mental-models')) return Response.json({});
        throw Error('Unexpected synthetic capability route');
    };
    LongTermMemory.prototype.commonBankId = function () { instances.add(this); return originalBank.call(this); };
    const options = { runId: 'capabilities', dataDir, card, llm: config.llm, prompt: config.prompt, hindsight: new HindsightClient('http://synthetic.invalid', 1000), keepBank: true,
        generate: async () => `SYNTHETIC_DIARY_BODY_${++generated}`, sleep: async () => {}, hindsightWaitMs: 100 };
    try {
        await runner.runScenario(scenario, options); const first = JSON.parse(readFileSync(join(dataDir, 'memory', 'diary.json'), 'utf8'));
        assert.equal(Object.keys(first.written).length, 0, '真实SDK的async受理不能因模拟包装丢能力而被当完成'); assert.equal(posts.length, 1); assert.ok(posts[0]!.id); assert.equal(generated, 1);
        const pending = first.prepared['diary:2026-11-06']; assert.equal(pending.operationId, posts[0]!.id); operations.set(pending.operationId, 'completed');
        await runner.runScenario(scenario, options); const second = JSON.parse(readFileSync(join(dataDir, 'memory', 'diary.json'), 'utf8'));
        assert.equal(second.texts['2026-11-06'], pending.body); assert.equal(second.confirmed['diary:2026-11-06'].operationId, pending.operationId);
        assert.equal(posts.filter(post => post.id === pending.operationId).length, 1); assert.equal(posts.length, 2); assert.equal(generated, 2);
    } finally {
        LongTermMemory.prototype.commonBankId = originalBank; for (const memory of instances) await memory.stop(); globalThis.fetch = originalFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-sim-capabilities-')); rmSync(root, { recursive: true, force: true });
    }
});

test('包装保持可选能力真实存在性、原API this和全部参数身份，不制造旧接口缺省能力', async () => {
    const api = minimal(), absent = wrapped(api, () => false); assert.equal(absent.submitRetain, undefined); assert.equal(absent.retentionStatus, undefined); assert.equal(absent.repairStats, undefined); assert.equal('submitRetain' in absent, false);
    const names = ['submitRetain', 'retentionStatus', 'deleteDocument', 'repairStats', 'repairModels', 'repairDocuments', 'repairObservationInventory', 'repairSourceConsolidationInventory', 'repairConfigureModel', 'repairRefreshOperation', 'futureSyntheticMethod'];
    const calls: { name: string; args: unknown[] }[] = [];
    Object.assign(api, Object.fromEntries(names.map(name => [name, function (this: SimHindsight, ...args: unknown[]) { assert.equal(this, api); calls.push({ name, args }); return Promise.resolve(name); }])));
    Object.freeze(api);
    const proxy = wrapped(api, () => false), item = { synthetic: true }, controller = new AbortController(), options = { signal: controller.signal };
    for (const name of names) { const method = Reflect.get(proxy, name); assert.equal(name in proxy, true); assert.equal(typeof method, 'function'); assert.equal(await Reflect.apply(method, proxy, ['bank', item, UUID, options]), name); }
    for (const call of calls) { assert.equal(call.args[1], item); assert.equal(call.args[3], options); assert.equal((call.args[3] as typeof options).signal, controller.signal); }
    assert.deepEqual(calls.map(call => call.name), names);
});

test('模拟down守卫覆盖新增能力，保留deleteBank清理例外并可恢复', async () => {
    const api = minimal(); let down = true, calls = 0, deletes = 0;
    api.submitRetain = async () => { calls++; }; api.retentionStatus = async () => { calls++; return 'pending'; }; api.repairObservationInventory = async () => { calls++; return []; }; api.deleteBank = async () => { deletes++; };
    const proxy = wrapped(api, () => down), item: MemoryItem = { content: 'Synthetic', timestamp: '2026-11-04T12:00:00Z' };
    await assert.rejects(proxy.submitRetain!('bank', item, UUID), /模拟 Hindsight 停了/); await assert.rejects(proxy.retentionStatus!('bank', UUID), /模拟 Hindsight 停了/); await assert.rejects(proxy.repairObservationInventory!('bank'), /模拟 Hindsight 停了/); assert.equal(calls, 0);
    await proxy.deleteBank('bank'); assert.equal(deletes, 1); down = false; await proxy.submitRetain!('bank', item, UUID); assert.equal(await proxy.retentionStatus!('bank', UUID), 'pending'); assert.deepEqual(await proxy.repairObservationInventory!('bank'), []); assert.equal(calls, 3);
});

test('真实SDK final guard的超时/AbortSignal经包装仍生效，不能丢options后直接POST', async () => {
    const originalFetch = globalThis.fetch; let posts = 0, aborted = false;
    globalThis.fetch = async (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, 'http://synthetic.invalid');
        if (url.pathname.endsWith(`/operations/${UUID}`)) return Response.json({ operation_id: UUID, operation_type: null, status: 'not_found' });
        if (url.pathname.endsWith('/operations')) return Response.json({ bank_id: 'synthetic', operations: [], total: 0 });
        if (init?.method === 'POST') posts++; return Response.json({}); };
    try { const api = wrapped(new HindsightClient('http://synthetic.invalid', 50), () => false);
        await assert.rejects(api.submitRetain!('synthetic', { content: 'Synthetic', timestamp: '2026-11-04T12:00:00Z' }, UUID, { canSubmit: signal => {
            signal.addEventListener('abort', () => aborted = true); return new Promise<boolean>(() => {});
        } }), /超时/); assert.equal(aborted, true); assert.equal(posts, 0);
    } finally { globalThis.fetch = originalFetch; }
});
