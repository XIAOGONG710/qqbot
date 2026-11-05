// M32b UNFIXED diagnostic, not a correct-behaviour regression test.
// Run from repository root: node docs/reviews/repro/memory-model-revision.mjs
// Only temporary synthetic data/fake API, no network or runtime reads.
// Stable document replacement does not itself regenerate provider mental models.
// Official v0.10.2 source (retain commit is not enough):
// https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L18088
// Automatic refresh after retractions is best effort; retain is not a caller:
// https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L20674
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LongTermMemory, OPEN_EPISODE_STEP } from '../../../packages/bot/src/memory/long-term.ts';
import { ChatHistory, RECALLED_TEXT } from '../../../packages/bot/src/memory/history.ts';
const marker = 'SYNTHETIC_WITHDRAWN_MODEL_SECRET';
const contact = { qq: 10001, tier: 'boyfriend', name: 'Synthetic User' }, names = { char: 'Synthetic Character', user: contact.name };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function run() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-model-residue-'));
    let now = Date.parse('2026-11-05T12:30:00Z'), modelReads = 0, refreshes = 0, retains = 0;
    const documents = new Map(), models = new Map();
    const api = {
        putBank: async () => {},
        retain: async (bank, item) => { retains++; documents.set(`${bank}/${item.document_id}`, structuredClone(item)); },
        getMentalModel: async (bank, id) => { modelReads++; return structuredClone(models.get(`${bank}/${id}`)); },
        createMentalModel: async (bank, item) => { models.set(`${bank}/${item.id}`, { id: item.id }); },
        updateMentalModel: async () => {}, refreshMentalModel: async () => { refreshes++; return 'synthetic-refresh'; }, recall: async () => [],
    };
    const options = { api, dir, bankPrefix: 'synthetic', recallTimeoutMs: 100, now: () => now, log() {}, common: true };
    const memory = new LongTermMemory(options), history = new ChatHistory(dir);
    let restarted;
    try {
        for (let i = 0; i < OPEN_EPISODE_STEP; i++) history.append(contact.qq, { role: 'user', messageId: i + 1,
            content: i === 15 ? marker : `synthetic message ${i}`, time: new Date(now - 15 * 60_000 + i * 1000).toISOString() });
        await memory.sync(contact, names, history.load(contact.qq));
        assert.equal(documents.size, 2); assert.equal(retains, 2);
        assert.ok([...documents.values()].every(item => item.content.includes(marker)));
        assert.ok(models.size >= 2);
        // Model provider previously generated prose from the then-current retained document.
        for (const model of models.values()) model.content = `Previously generated model: ${marker}`;
        memory.relationship(contact); memory.impression(contact); await tick(); await tick();
        assert.ok(memory.relationship(contact).includes(marker)); assert.ok(memory.impression(contact).includes(marker));
        const refreshBefore = refreshes;
        assert.equal(history.recall(contact.qq, 16), true);
        assert.equal(history.load(contact.qq)[15].content, RECALLED_TEXT);
        await memory.sync(contact, names, history.load(contact.qq));
        assert.equal(retains, 4, 'source document overwrite must actually complete');
        assert.equal(documents.size, 2, 'document identities must stay stable');
        assert.ok([...documents.values()].every(item => !item.content.includes(marker)));
        // Fresh instance has no old RAM cache, yet reads unchanged provider model prose.
        restarted = new LongTermMemory(options);
        restarted.relationship(contact); restarted.impression(contact); await tick(); await tick();
        assert.ok(restarted.relationship(contact).includes(marker), 'M32b diagnostic changed: provider old model no longer visible');
        assert.ok(restarted.impression(contact).includes(marker), 'M32b diagnostic changed: provider old impression no longer visible');
        console.log(JSON.stringify({ diagnostic: 'M32b-unfixed', case: 'provider-derived-model-still-old-after-restart',
            messages: OPEN_EPISODE_STEP, assistantMessages: 0, historyRedacted: true, stableDocuments: documents.size, retainCalls: retains,
            documentsStillOriginal: false, relationshipStillOriginalAfterOverwrite: true, impressionStillOriginalAfterOverwrite: true,
            extraRefreshRequestsOnOverwrite: refreshes - refreshBefore, providerModelReads: modelReads }));
    } finally {
        await memory.stop(); await restarted?.stop();
        const target = resolve(dir); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('qqbot-model-residue-'));
        rmSync(target, { recursive: true, force: true });
    }
}
await run();
