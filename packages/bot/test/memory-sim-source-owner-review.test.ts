import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LongTermMemory } from '../src/memory/long-term.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { runScenario, type SimHindsight } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import type { MemoryItem } from '../src/memory/hindsight.ts';

test('真实模拟宿主初始和restart均保护无writer的已知作者意图，只用合成卡与假API', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-sim-source-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const cardPath = join(root, 'synthetic-card.json'); writeFileSync(cardPath, JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const card = loadTierCard(cardPath, 'classmate'), marker = 'SYNTHETIC_SIM_UNVERIFIED_WRITTEN', runId = 'source-owner';
    const documents = new Map<string, MemoryItem>(), operations = new Set<string>(); let reads = 0;
    const api: SimHindsight = { putBank: async () => {}, retain: async () => assert.fail('advanced only'),
        submitRetain: async (_bank, item, id) => { operations.add(id); documents.set(item.document_id!, item); }, retentionStatus: async (_bank, id) => operations.has(id) ? 'completed' : 'not_found',
        recall: async () => [], getMentalModel: async () => undefined, createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '',
        activeOperations: async () => [], operationStatus: async () => 'completed', deleteBank: async () => assert.fail('keepBank'),
        getDocument: async (_bank, id) => { reads++; return documents.has(id) ? { original_text: documents.get(id)!.content } : undefined; } };
    const seed = new LongTermMemory({ api, dir: join(dataDir, 'memory'), bankPrefix: `sim-${runId}`, common: true, recallTimeoutMs: 100, log() {} });
    const original = LongTermMemory.prototype.commonBankId, instances = new Set<LongTermMemory>();
    try {
        assert.equal(await seed.retainDiary('2026-11-06', new Date('2026-11-06T12:00:00+08:00'), marker, '合成角色'), true); await seed.stop();
        LongTermMemory.prototype.commonBankId = function () { instances.add(this); return original.call(this); };
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir, contacts: [{ qq: 10001, tier: 'classmate', name: '合成甲' }] }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        const scenario = parseScenario({ name: 'SYNTHETIC_SOURCE_OWNER', tier: 'classmate', start: '2026-11-09T12:00:00+08:00', memory: true, schedule: false, steps: [{ restart: true }] });
        await runScenario(scenario, { runId, dataDir, card, llm: config.llm, prompt: config.prompt, hindsight: api, keepBank: true,
            generate: async () => assert.fail('no generation'), sleep: async () => {}, hindsightWaitMs: 100 });
        LongTermMemory.prototype.commonBankId = original;
        assert.ok(instances.size >= 1);
        for (const memory of instances) assert.equal(await memory.readDiary('2026-11-06'), undefined);
        assert.equal(reads, 0, '不能在宿主重启时遗漏未知来源的读口保护');
        assert.ok(instances.size >= 2, '覆盖初始和restart的两个真实memory实例');
    } finally {
        LongTermMemory.prototype.commonBankId = original;
        await seed.stop(); for (const memory of instances) await memory.stop();
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-sim-source-owner-')); rmSync(root, { recursive: true, force: true });
    }
});
