import assert from 'node:assert/strict';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { LongTermMemory, OPEN_EPISODE_STEP } from '../src/memory/long-term.ts';
import { ChatHistory, RECALLED_TEXT } from '../src/memory/history.ts';
import type { HindsightApi, MentalModel, MemoryItem } from '../src/memory/hindsight.ts';

const NOW = Date.parse('2026-11-05T12:30:00Z'), OLD = 'SYNTHETIC_WITHDRAWN_MODEL_SECRET', FRESH = 'SYNTHETIC_PROVIDER_REPAIRED';
const a = { qq: 10001, tier: 'boyfriend', name: 'Synthetic A' }, b = { qq: 10002, tier: 'classmate', name: 'Synthetic B' };
const names = (name: string) => ({ char: 'Synthetic Character', user: name });
const roots: string[] = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => { for (const dir of roots.splice(0)) { const target = resolve(dir); assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('qqbot-model-revision-')); rmSync(target, { recursive: true, force: true }); } });
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-model-revision-')); roots.push(dir);
    const documents = new Map<string, MemoryItem>(), models = new Map<string, MentalModel>(), reads: string[] = [];
    let hold = false; const releases: (() => void)[] = [];
    const api: HindsightApi = {
        putBank: async () => {}, retain: async (bank, item) => { documents.set(`${bank}/${item.document_id}`, structuredClone(item)); },
        getMentalModel: async (bank, id) => {
            const key = `${bank}/${id}`; reads.push(key); const captured = structuredClone(models.get(key));
            if (hold) await new Promise<void>(resolve => { releases.push(resolve); });
            return captured;
        },
        createMentalModel: async (bank, item) => { models.set(`${bank}/${item.id}`, { id: item.id }); },
        updateMentalModel: async () => {}, refreshMentalModel: async () => 'synthetic-refresh', recall: async () => [],
    };
    const memory = new LongTermMemory({ api, dir, bankPrefix: 'synthetic', recallTimeoutMs: 100, now: () => NOW, log() {}, common: true });
    const history = new ChatHistory(dir);
    function append(qq: number, from = 0) { for (let i = from; i < from + OPEN_EPISODE_STEP; i++) history.append(qq, {
        role: 'user', messageId: i + 1, content: i === 15 ? OLD : `synthetic message ${i}`,
        time: new Date(NOW - 15 * 60_000 + i * 1000).toISOString(),
    }); }
    function setModels(content: string) { for (const model of models.values()) model.content = content; }
    function release() { hold = false; for (const done of releases.splice(0)) done(); }
    return { memory, history, documents, reads, append, setModels, release, held: () => releases.length,
        hold: () => { hold = true; }, unhold: () => { hold = false; } };
}
async function warm(f: ReturnType<typeof fixture>, person: typeof a) {
    f.memory.relationship(person); f.memory.impression(person); await tick(); await tick();
    assert.ok(f.memory.relationship(person)?.includes(OLD)); assert.ok(f.memory.impression(person)?.includes(OLD));
}
function revised(f: ReturnType<typeof fixture>) {
    assert.equal(f.history.recall(a.qq, 16), true); assert.equal(f.history.load(a.qq)[15]!.content, RECALLED_TEXT);
    return f.memory.sync(a, names(a.name), f.history.load(a.qq));
}

test('正文revision后首次getter不返回旧缓存，后台可读供应商fresh；其他联系人缓存保留', async () => {
    const f = fixture();
    try {
        for (const person of [a, b]) { f.append(person.qq); await f.memory.sync(person, names(person.name), f.history.load(person.qq)); }
        f.setModels(OLD); await warm(f, a); await warm(f, b);
        const otherRelationship = f.memory.relationship(b), otherImpression = f.memory.impression(b), reads = f.reads.length;
        f.setModels(FRESH); await revised(f);
        assert.ok([...f.documents].filter(([key]) => key.startsWith(f.memory.bankId(a) + '/')).every(([, item]) => !item.content.includes(OLD)));
        assert.equal(f.memory.relationship(b), otherRelationship); assert.equal(f.memory.impression(b), otherImpression);
        assert.equal(f.reads.length, reads, 'revision不使其他联系人缓存重取');
        assert.ok(!f.memory.relationship(a)?.includes(OLD)); assert.ok(!f.memory.impression(a)?.includes(OLD));
        await tick(); await tick();
        assert.ok(f.memory.relationship(a)?.includes(FRESH)); assert.ok(f.memory.impression(a)?.includes(FRESH));
    } finally { f.release(); await f.memory.stop(); }
});

test('revision前已派发旧model读取晚返回不能重新填入旧正文', async () => {
    const f = fixture();
    try {
        f.append(a.qq); await f.memory.sync(a, names(a.name), f.history.load(a.qq)); f.setModels(OLD); f.hold();
        f.memory.relationship(a); f.memory.impression(a); await tick(); assert.equal(f.held(), 2);
        f.setModels(FRESH); await revised(f);
        // 清理hold设置不释放旧响应；新读取可以完成，而旧响应在最后才到达。
        const pending = f.held();
        f.unhold();
        assert.ok(!f.memory.relationship(a)?.includes(OLD)); assert.ok(!f.memory.impression(a)?.includes(OLD));
        await tick(); await tick();
        assert.ok(f.memory.relationship(a)?.includes(FRESH)); assert.ok(f.memory.impression(a)?.includes(FRESH));
        f.release(); await tick(); await tick();
        assert.equal(pending, 2);
        assert.ok(!f.memory.relationship(a)?.includes(OLD)); assert.ok(!f.memory.impression(a)?.includes(OLD));
        await tick(); await tick();
        assert.ok(f.memory.relationship(a)?.includes(FRESH)); assert.ok(f.memory.impression(a)?.includes(FRESH));
    } finally { f.release(); await f.memory.stop(); }
});

test('正常追加未修订旧正文不强制废弃既有model缓存或改变十分钟读取策略', async () => {
    const f = fixture();
    try {
        f.append(a.qq); await f.memory.sync(a, names(a.name), f.history.load(a.qq)); f.setModels(OLD); await warm(f, a);
        const oldRelationship = f.memory.relationship(a), oldImpression = f.memory.impression(a), reads = f.reads.length;
        f.setModels(FRESH); f.append(a.qq, OPEN_EPISODE_STEP); await f.memory.sync(a, names(a.name), f.history.load(a.qq));
        assert.equal(f.memory.relationship(a), oldRelationship); assert.equal(f.memory.impression(a), oldImpression);
        assert.equal(f.reads.length, reads);
    } finally { f.release(); await f.memory.stop(); }
});
