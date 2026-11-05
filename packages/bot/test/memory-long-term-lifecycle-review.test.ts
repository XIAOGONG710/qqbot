import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LongTermMemory } from '../src/memory/long-term.ts';
import type { HindsightApi } from '../src/memory/hindsight.ts';
import { startApp, type App, type Transport } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';

const Memory: typeof LongTermMemory = process.env.SYNTHETIC_LONG_TERM_MODULE
    ? (await import(process.env.SYNTHETIC_LONG_TERM_MODULE)).LongTermMemory : LongTermMemory;

const NOW = Date.parse('2026-11-05T12:00:00Z');
const CONTACT = { qq: 10001, tier: 'boyfriend' }, NAMES = { char: '合成角色', user: '合成联系人' };
const history = (offset = 0) => [{ role: 'user' as const, content: '合成旧消息', time: new Date(NOW - 24 * 3600_000 + offset).toISOString(), messageId: 1 + offset }];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-memory-lifecycle-')); rmSync(root, { recursive: true, force: true }); } });
function temp() { const root = mkdtempSync(join(tmpdir(), 'qqbot-memory-lifecycle-')); roots.push(root); return root; }
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) assert.fail('合成等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function api(patch: Partial<HindsightApi> = {}): HindsightApi {
    return { putBank: async () => {}, retain: async () => {}, recall: async () => [], getMentalModel: async () => undefined, createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => 'synthetic-operation', ...patch };
}
function memory(fake: HindsightApi, common = false) { const dir = temp(); return { dir, memory: new Memory({ api: fake, dir, bankPrefix: 'synthetic', recallTimeoutMs: 100, now: () => NOW, log() {}, common }) }; }
type Lifecycle = { stop?: () => Promise<void> | undefined };
function stop(instance: LongTermMemory) {
    const lifecycle = instance as LongTermMemory & Lifecycle;
    assert.equal(typeof lifecycle.stop, 'function', '长期记忆须有同步关闭派发入口');
    return lifecycle.stop!();
}

test('stop关闭排队及后续派发，putBank已派发ACK可存进度但不继续retain', async () => {
    const held = gate<void>(); let putCalls = 0, retains = 0;
    const f = memory(api({ putBank: async () => { putCalls++; await held.promise; }, retain: async () => { retains++; } }));
    const first = f.memory.sync(CONTACT, NAMES, history()); const queued = f.memory.sync(CONTACT, NAMES, history(2 * 3600_000));
    let drain: Promise<void> | undefined;
    try {
        await until(() => putCalls === 1); drain = stop(f.memory);
        assert.ok(drain instanceof Promise); assert.equal(stop(f.memory), drain, '重复stop复用同一drain'); await tick(); assert.equal(retains, 0);
        const later = Promise.resolve().then(() => f.memory.sync(CONTACT, NAMES, history(4 * 3600_000)));
        held.release(); await Promise.allSettled([first, queued, later]); await drain;
        assert.equal(putCalls, 1); assert.equal(retains, 0);
        const state = JSON.parse(readFileSync(join(f.dir, '10001-boyfriend.json'), 'utf8')); assert.ok(state.bankConfigured);
    } finally { held.release(); await Promise.allSettled([first, queued]); await drain; }
});

test('stop等待当前retain ACK保存事实，后续片段及公共库不再派发', async () => {
    const held = gate<void>(); let retains = 0;
    const f = memory(api({ retain: async () => { retains++; await held.promise; } }), true);
    const input = [...history(), ...history(2 * 3600_000)];
    const task = f.memory.sync(CONTACT, NAMES, input); let drain: Promise<void> | undefined;
    try {
        await until(() => retains === 1); drain = stop(f.memory); assert.ok(drain instanceof Promise);
        let settled = false; void drain!.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
        held.release(); await task; await drain;
        assert.equal(retains, 1);
        const state = JSON.parse(readFileSync(join(f.dir, '10001-boyfriend.json'), 'utf8'));
        assert.equal(state.retained[`ep-${Date.parse(input[0]!.time)}`], 1);
        assert.equal(state.retained[`ep-${Date.parse(input[1]!.time)}`], undefined);
    } finally { held.release(); await task; await drain; }
});

test('idle stop同步收束，停止后实体读取不再调用提供方', async () => {
    let calls = 0, writes = 0; const f = memory(api({ listEntities: async () => { calls++; return ['合成实体']; }, putBank: async () => { writes++; }, retain: async () => { writes++; } }), true);
    assert.equal(stop(f.memory), undefined);
    await Promise.allSettled([Promise.resolve().then(() => f.memory.commonEntities()), Promise.resolve().then(() => f.memory.sync(CONTACT, NAMES, history()))]);
    assert.equal(calls, 0); assert.equal(writes, 0); assert.equal(existsSync(join(f.dir, '10001-boyfriend.json')), false);
});

test('模型create ACK可保存版本，update ACK但未派refresh不能冒认整个初始化完成', async () => {
    for (const phase of ['create', 'update'] as const) {
        const held = gate<void>(); let mutations = 0, refresh = 0, retains = 0;
        const f = memory(api({
            getMentalModel: async () => phase === 'create' ? undefined : { id: 'relationship', content: '合成旧模型' },
            createMentalModel: async () => { mutations++; await held.promise; },
            updateMentalModel: async () => { mutations++; await held.promise; },
            refreshMentalModel: async () => { refresh++; return 'synthetic-operation'; },
            retain: async () => { retains++; },
        }));
        const task = f.memory.sync(CONTACT, NAMES, history()); let drain: Promise<void> | undefined;
        try {
            await until(() => mutations === 1); drain = stop(f.memory); assert.ok(drain instanceof Promise);
            held.release(); await task; await drain;
            assert.equal(mutations, 1); assert.equal(refresh, 0); assert.equal(retains, 0);
            const state = JSON.parse(readFileSync(join(f.dir, '10001-boyfriend.json'), 'utf8'));
            if (phase === 'create') assert.ok(state.relationshipModel);
            else assert.equal(state.relationshipModel, undefined);
        } finally { held.release(); await task; await drain; }
    }
});

test('在途纯实体读取在stop时立即收束，不纳入写drain或重开下一次读取', async () => {
    const held = gate<string[]>(); let calls = 0;
    const f = memory(api({ listEntities: async () => { calls++; return held.promise; } }), true);
    const reading = f.memory.commonEntities(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await until(() => calls === 1); assert.equal(stop(f.memory), undefined);
        const settled = await Promise.race([reading.then(() => true, () => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 200); })]);
        assert.equal(settled, true);
        held.release(['合成迟到实体']); await tick();
        await Promise.allSettled([f.memory.commonEntities()]); assert.equal(calls, 1);
    } finally { clearTimeout(timer); held.release([]); await reading; }
});

test('并发实体请求不能让迟到旧响应覆盖较新成功，singleflight也符合契约', async () => {
    const first = gate<string[]>(), second = gate<string[]>(); let calls = 0;
    const f = memory(api({ listEntities: () => ++calls === 1 ? first.promise : second.promise }), true);
    const a = f.memory.commonEntities(), b = f.memory.commonEntities();
    try {
        await until(() => calls >= 1); await tick();
        if (calls === 1) { first.release(['合成新实体']); second.release(['合成新实体']); await Promise.all([a, b]); }
        else { second.release(['合成新实体']); await b; first.release(['合成旧实体']); await a; }
        assert.deepEqual(await f.memory.commonEntities(), ['合成新实体']);
    } finally { first.release([]); second.release([]); await Promise.allSettled([a, b]); }
});

test('公共写入使在途实体请求过时，晚返回不能把写入失效改成新鲜缓存', async () => {
    const held = gate<string[]>(); let calls = 0;
    const f = memory(api({ listEntities: () => ++calls === 1 ? held.promise : Promise.resolve(['合成写入后实体']) }), true);
    const old = f.memory.commonEntities();
    try {
        await tick(); await f.memory.sync(CONTACT, NAMES, history());
        held.release(['合成写入前实体']); await old;
        assert.deepEqual(await f.memory.commonEntities(), ['合成写入后实体']); assert.equal(calls, 2);
    } finally { held.release([]); await old; }
});

function appFixture() {
    const root = temp(), dataDir = join(root, 'bot'); mkdirSync(dataDir);
    for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const raw = { llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], schedule: false, herDays: false, moody: false, speechCheck: false, realWeather: false, proactive: 'off' };
    return { root, dataDir, raw };
}
function app(f: ReturnType<typeof appFixture>, withMemory: boolean): App {
    const config = parseAppConfig({ ...f.raw, ...(withMemory ? { memory: { baseUrl: 'http://synthetic.invalid', timeoutMs: 5000, recallTimeoutMs: 100, bankPrefix: 'synthetic' } } : {}) }, f.root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const transport: Transport = { friendHistory: async () => [], sendPrivateText: async () => 1 };
    return startApp({ config, transport, log() {}, sensitive: { on: () => false, describe: () => '' }, pipeline: { generate: async () => '合成回复', settle: { quietMs: 0, maxMs: 0 } } });
}
function probeAppLock(f: ReturnType<typeof appFixture>) {
    const appUrl = new URL('../src/platform/app.ts', import.meta.url).href, configUrl = new URL('../src/platform/config.ts', import.meta.url).href;
    const code = `import { startApp } from ${JSON.stringify(appUrl)}; import { parseAppConfig } from ${JSON.stringify(configUrl)};
        globalThis.fetch=async()=>{throw new Error('Network prohibited in synthetic lock probe');};
        let app; try { app=startApp({ config:parseAppConfig(${JSON.stringify(f.raw)},${JSON.stringify(f.root)},{QQBOT_LLM_API_KEY:'synthetic-key'}), transport:{friendHistory:async()=>[],sendPrivateText:async()=>1}, log(){}, pipeline:{generate:async()=> 'synthetic'} }); console.log('RELEASED'); } catch(error) { if(error instanceof Error && error.message.startsWith('已有一个 bot 在运行（PID ')) console.log('LOCKED'); else { console.log('UNEXPECTED'); process.exitCode=2; } } finally { app?.stop(); }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
}

test('真实App保留旧锁直到提交ACK；异步pending不冒记count，完成后重启核对进度且idle同步放锁', async () => {
    const f = appFixture(); const held = gate<Response>(); const originalFetch = globalThis.fetch; let retained = 0;
    const operations = new Map<string, { bank: string; status: 'pending' | 'completed' }>();
    let receipt: { success: true; async: true; bank_id: string; items_count: number; operation_id: string } | undefined;
    globalThis.fetch = async (_url, init) => {
        assert.ok(String(_url).startsWith('http://synthetic.invalid/'));
        const url = new URL(String(_url)), bank = decodeURIComponent(url.pathname.split('/banks/')[1]?.split('/')[0] ?? '');
        if (url.pathname.endsWith('/operations')) {
            const found = [...operations.entries()].filter(([, op]) => op.bank === bank && op.status === url.searchParams.get('status') && url.searchParams.get('type') === 'retain');
            return Response.json({ bank_id: bank, total: found.length, operations: found.slice(0, 1).map(([id, op]) => ({ operation_id: id, status: op.status })) });
        }
        if (url.pathname.includes('/operations/')) {
            const id = decodeURIComponent(url.pathname.split('/operations/')[1]!), operation = operations.get(id);
            return operation?.bank === bank ? Response.json({ operation_id: id, operation_type: 'batch_retain', status: operation.status, child_operations: [{ status: operation.status }] }) : new Response('', { status: 404 });
        }
        if (init?.method === 'POST' && url.pathname.endsWith('/memories')) {
            const body = JSON.parse(String(init.body));
            const accepted = { success: true as const, async: true as const, bank_id: bank, items_count: 1, operation_id: body.operation_id };
            if (!bank.endsWith('-common')) {
                retained++; receipt = accepted; operations.set(body.operation_id, { bank, status: 'pending' }); return held.promise;
            }
            operations.set(body.operation_id, { bank, status: 'completed' }); return Response.json(accepted);
        }
        if (init?.method === 'GET' && String(_url).includes('/mental-models/')) return new Response('', { status: 404 });
        return Response.json({});
    };
    const data = new ChatHistory(f.dataDir); data.append(10001, { role: 'user', time: new Date(Date.now() - 3600_000).toISOString(), content: '合成已结束片段', messageId: 7 });
    let running: App | undefined;
    try {
        running = app(f, true); await running.connected(20000); await until(() => retained === 1); running.stop();
        assert.equal(probeAppLock(f), 'LOCKED', '不能只检查锁文件存在，应证明另进程真实App拿不到锁');
        assert.ok(receipt); held.release(Response.json(receipt)); await until(() => !existsSync(join(f.dataDir, 'bot.lock')));
        const statePath = join(f.dataDir, 'memory', '10001-classmate.json');
        const state = JSON.parse(readFileSync(statePath, 'utf8')); assert.equal(Object.keys(state.retained).length, 0);
        assert.equal(Object.keys(state.pendingOwn).length, 1, '受理ACK不是文档已完成，停止后持久保留同UUID核对屏障');
        assert.equal(probeAppLock(f), 'RELEASED');
        operations.get(receipt.operation_id)!.status = 'completed';
        running = app(f, true); await running.connected(20000);
        await until(() => Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).retained).length === 1);
        await running.stop(); assert.equal(retained, 1, '完成核对不重发已经接受的正文');
        const idle = app(f, false); idle.stop(); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
    } finally {
        held.release(Response.json(receipt ?? {})); await running?.stop();
        // 旧实现反例没有drain API，也必须让受控ACK后续微任务在假fetch仍接管时收束。
        for (let i = 0; i < 12; i++) await tick();
        globalThis.fetch = originalFetch;
    }
});
