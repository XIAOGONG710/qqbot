// Correctness probe: owned readers cannot modify finished logs/reports or a
// restarted scope. Only synthetic cards, fake APIs and temporary files are used.
// --restart releases the old read only in the actual restarted user prompt.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { runScenario } from '../../../packages/bot/src/sim/runner.ts';
import { parseScenario } from '../../../packages/bot/src/sim/scenario.ts';
import { loadTierCard } from '../../../packages/bot/src/platform/contact.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';

const restart = process.argv.includes('--restart');
const root = mkdtempSync(join(tmpdir(), 'qqbot-sim-late-log-')), dataDir = join(root, 'data');
const originalFetch = globalThis.fetch;
let release = () => {};
try {
    mkdirSync(dataDir);
    globalThis.fetch = async () => { throw new Error('Network prohibited in synthetic lifecycle probe'); };
    const cardPath = join(root, 'synthetic-card.json');
    writeFileSync(cardPath, JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' },
        characterCard: join(root, 'synthetic-{tier}.json'), dataDir, contacts: [{ qq: 10001, name: '合成甲', tier: 'classmate' }] },
    root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const card = loadTierCard(cardPath, 'classmate');
    const model = new Promise((_, reject) => { release = () => reject(new Error('SYNTHETIC_LATE_MODEL_FAILURE')); });
    let modelReads = 0, deletes = 0, releasedAfterRestart = false, oldReadLoggedDuringRestartedGeneration = false;
    const modelCalls = new Map();
    const api = { putBank: async () => {}, retain: async () => {}, recall: async () => [],
        getMentalModel: async (bank, id) => {
            const key = `${bank}:${id}`, seen = modelCalls.get(key) ?? 0;
            modelCalls.set(key, seen + 1);
            // Initial model-existence queries must finish. Hold only the real
            // background refresh triggered by the first conversational prompt.
            if (seen !== 1) return undefined;
            modelReads++; return model;
        }, createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '',
        activeOperations: async () => [], operationStatus: async () => 'completed', deleteBank: async () => { deletes++; } };
    const scenario = parseScenario({ name: 'SYNTHETIC_LATE_MEMORY_READ', tier: 'classmate', start: '2026-11-09T12:00:00+08:00', memory: true, schedule: false,
        history: [{ role: 'user', content: '合成过去的话', time: '2026-11-08T12:00:00+08:00' },
            { role: 'assistant', content: '合成过去的回复', time: '2026-11-08T12:01:00+08:00' }],
        steps: [{ say: '合成新问候' }, ...(restart ? [{ restart: true }, { say: '合成重启后问候' }] : [])] });
    const result = await runScenario(scenario, { runId: 'synthetic-late-log', dataDir, card, llm: config.llm, prompt: config.prompt, hindsight: api,
        generate: async messages => {
            if (restart && messages.some(message => message.role === 'user' && message.content.includes('合成重启后问候'))) {
                releasedAfterRestart = true;
                release(); await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
                oldReadLoggedDuringRestartedGeneration = readFileSync(join(dataDir, 'sim.log'), 'utf8').includes('SYNTHETIC_LATE_MODEL_FAILURE');
            }
            return '合成回应';
        }, sleep: async () => {}, hindsightWaitMs: 100, settle: { quietMs: 0, maxMs: 0 }, realNow: () => Date.parse(scenario.start) });
    const before = readFileSync(join(dataDir, 'sim.log'), 'utf8');
    const returned = JSON.stringify(result);
    assert.ok(modelReads > 0, 'The real runner must start the held background read');
    assert.ok(deletes > 0, 'The real runner must finish deleting its fake banks');
    release(); await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
    const after = readFileSync(join(dataDir, 'sim.log'), 'utf8');
    assert.equal(releasedAfterRestart, restart);
    assert.equal(oldReadLoggedDuringRestartedGeneration, false);
    assert.equal(after, before); assert.equal(JSON.stringify(result), returned); assert.ok(!after.includes('SYNTHETIC_LATE_MODEL_FAILURE'));
    console.log(JSON.stringify({ correctnessProbe: true, runnerReturned: true, restart, oldReadLoggedDuringRestartedGeneration,
        modelReads, deletedBanks: deletes, lateLogAfterReturn: after.length - before.length,
        returnedReportMutated: result.steps.some(step => step.logs.some(line => line.includes('SYNTHETIC_LATE_MODEL_FAILURE'))) }));
} finally {
    release(); await new Promise(done => setImmediate(done)); globalThis.fetch = originalFetch;
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-sim-late-log-'));
    rmSync(root, { recursive: true, force: true });
}
