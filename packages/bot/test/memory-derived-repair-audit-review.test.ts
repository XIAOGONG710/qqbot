import assert from 'node:assert/strict';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { auditedApi, memoryLedger } from '../src/memory/memory-audit.ts';
import type { HindsightApi, RepairModelEvidence } from '../src/memory/hindsight.ts';

const roots: string[] = [], secret = 'SYNTHETIC_PRIVATE_REPAIR_BODY', uuid = '11111111-1111-4111-8111-111111111111';
afterEach(() => { for (const dir of roots.splice(0)) { const target = resolve(dir); assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('qqbot-repair-audit-')); rmSync(target, { recursive: true, force: true }); } });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-repair-audit-')); roots.push(dir); return dir; };
const mutations = ['repairConfigureModel', 'repairClearModel', 'repairRefreshModel', 'repairRestoreAutomatic'] as const;

test('四个repair mutation原ACK与this绑定保持，账本只记元数据；refresh仅accepted不记completed', async () => {
    const dir = temp(), ledger = memoryLedger(dir), calls: unknown[][] = [];
    const receipt = Object.defineProperty({}, 'content', { enumerable: true, get() { throw new Error(secret); } }) as RepairModelEvidence;
    class Fake {
        #owner = 'bound';
        async repairConfigureModel(bank: string, model: string) { calls.push([this.#owner, 'pause', bank, model]); return receipt; }
        async repairClearModel(bank: string, model: string) { calls.push([this.#owner, 'clear', bank, model]); return receipt; }
        async repairRefreshModel(bank: string, model: string) { calls.push([this.#owner, 'refresh', bank, model]); return uuid; }
        async repairRestoreAutomatic(bank: string, model: string, cadence: number, enabled?: boolean) { calls.push([this.#owner, 'restore', bank, model, cadence, enabled]); return receipt; }
    }
    const api = auditedApi(new Fake() as unknown as HindsightApi, ledger);
    assert.equal(await api.repairConfigureModel!('bank', 'relationship'), receipt);
    assert.equal(await api.repairClearModel!('bank', 'relationship'), receipt);
    assert.equal(await api.repairRefreshModel!('bank', 'relationship'), uuid);
    assert.equal(await api.repairRestoreAutomatic!('bank', 'relationship', 1800, false), receipt);
    assert.equal(calls.length, 4); assert.ok(calls.every(call => call[0] === 'bound')); assert.deepEqual(calls.at(-1), ['bound', 'restore', 'bank', 'relationship', 1800, false]);
    const entries = ledger.read(); assert.equal(entries.length, 4);
    assert.deepEqual(entries.map(row => row.kind), ['model-repair-configure', 'model-repair-clear', 'model-repair-refresh-submit', 'model-repair-restore']);
    for (const row of entries) { assert.equal(row.data.bank, 'bank'); assert.equal(row.data.model, 'relationship'); assert.notEqual(row.data.stage, 'completed'); }
    assert.equal(entries[2]!.data.stage, 'accepted'); assert.match(String(entries[2]!.data.operation), /^[a-f0-9]{16}$/);
    assert.equal(entries[3]!.data.cadence, 1800); assert.equal(entries[3]!.data.automatic, false);
    assert.doesNotMatch(readFileSync(join(dir, 'identity', 'memory.jsonl'), 'utf8'), new RegExp(`${secret}|${uuid}`));
    assert.equal(ledger.verify().ok, true);
});

test('旧API缺省repair能力保持undefined；只读repair证据绑定转发且不生成写入审计', async () => {
    const dir = temp(), ledger = memoryLedger(dir);
    class ReadOnly { #value = 7; async repairStats() { return this.#value; } }
    const api = auditedApi(new ReadOnly() as unknown as HindsightApi, ledger);
    for (const method of mutations) assert.equal(api[method], undefined);
    assert.equal(await api.repairStats!('bank'), 7); assert.deepEqual(ledger.read(), []);
});

test('repair主调用失败原异常透传，不写成功审计或触发重复调用', async () => {
    const dir = temp(), ledger = memoryLedger(dir), failure = new Error(secret); let calls = 0;
    const raw = Object.fromEntries(mutations.map(method => [method, async () => { calls++; throw failure; }])) as unknown as HindsightApi;
    const api = auditedApi(raw, ledger);
    for (const method of mutations) await assert.rejects((api[method] as (...args: unknown[]) => Promise<unknown>)('bank', 'relationship', 1800), error => error === failure);
    assert.equal(calls, 4); assert.deepEqual(ledger.read(), []);
});

test('审计准备/写入/日志失败不改已确认repair ACK，也不读取正文补审计', async () => {
    const receipt = { content: secret }, logs: string[] = []; let calls = 0;
    const raw = { repairClearModel: async () => { calls++; return receipt; } } as unknown as HindsightApi;
    const broken = { append() { throw new Error(secret); } } as never;
    const wrapped = auditedApi(raw, broken, { log: text => { logs.push(text); throw new Error(secret); } });
    assert.equal(await wrapped.repairClearModel!('bank', 'relationship'), receipt); assert.equal(calls, 1);
    assert.equal(logs.length, 1); assert.ok(logs.every(text => !text.includes(secret)));
});

test('在途repair受理前不写成功行，ACK后才追加一行且返回同一receipt', async () => {
    const dir = temp(), ledger = memoryLedger(dir); let release!: (value: RepairModelEvidence) => void;
    const held = new Promise<RepairModelEvidence>(resolve => { release = resolve; });
    const api = auditedApi({ repairConfigureModel: () => held } as unknown as HindsightApi, ledger);
    const running = api.repairConfigureModel!('bank', 'relationship'); assert.deepEqual(ledger.read(), []);
    const receipt = {} as RepairModelEvidence; release(receipt); assert.equal(await running, receipt); assert.equal(ledger.read().length, 1);
});
