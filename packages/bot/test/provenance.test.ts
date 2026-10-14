import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { inheritedSources, readProvenance, recordProvenance, relatedProvenance, type ProvenanceEntry } from '../src/memory/provenance.ts';
import { auditContactPrivacy } from '../src/privacy-audit.ts';
import { forgetContact, type ForgetApi } from '../src/privacy-forget.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const fixture = () => {
    const base = mkdtempSync(join(tmpdir(), 'qqbot-provenance-')); dirs.push(base);
    const dir = join(base, 'bot'); mkdirSync(join(dir, 'memory'), { recursive: true });
    mkdirSync(join(dir, 'chats'));
    writeFileSync(join(dir, 'chats', '10001.jsonl'), 'fictional');
    writeFileSync(join(dir, 'memory', 'common.json'), JSON.stringify({ bankId: 'actual-common' }));
    return { base, dir, memory: join(dir, 'memory') };
};
const entry = (documentId: string, changes: Partial<ProvenanceEntry> = {}): ProvenanceEntry => ({
    bankId: 'actual-common', documentId, kind: 'diary', contacts: [10001], parents: [], complete: true,
    at: '2026-10-13T10:00:00Z', retention: 'shared', ...changes,
});

test('来源继承和闭包：联合日记到周记、阶段总结；旧父来源缺失则不完整', () => {
    const { memory } = fixture();
    recordProvenance(memory, entry('diary:2026-10-13', { contacts: [10001, 10002] }));
    const origin = inheritedSources(memory, 'actual-common', { contacts: [], parents: ['diary:2026-10-13'], complete: true });
    assert.deepEqual(origin.contacts, [10001, 10002]);
    recordProvenance(memory, entry('week:2026-10-12', { kind: 'week', contacts: [], parents: ['diary:2026-10-13'] }));
    recordProvenance(memory, entry('phase:test:2026-10-13', { kind: 'phase', contacts: [], parents: ['week:2026-10-12'] }));
    assert.equal(relatedProvenance(readProvenance(memory), 10001).length, 3);
    assert.equal(inheritedSources(memory, 'actual-common', { contacts: [], parents: ['diary:missing'], complete: true }).complete, false);
});

test('覆盖保留历史来源并集和远端可能存在的旧版本；来源账损坏失败关闭', () => {
    const { memory } = fixture();
    recordProvenance(memory, entry('d', { retention: 'pending' }));
    recordProvenance(memory, entry('d', { contacts: [10002], retention: 'local-only' }));
    assert.deepEqual(readProvenance(memory)[0]!.contacts, [10001, 10002]);
    assert.equal(readProvenance(memory)[0]!.retention, 'pending');
    writeFileSync(join(memory, 'provenance.json'), JSON.stringify({ version: 9, entries: [] }));
    assert.throws(() => readProvenance(memory), /来源账.*拒绝启动/);
});

test('审计和演练沿来源闭包找出完整目标，使用真实 bank；不含聊天/日记正文', async () => {
    const { base, dir, memory } = fixture();
    recordProvenance(memory, entry('diary:2026-10-13'));
    recordProvenance(memory, entry('week:2026-10-12', { kind: 'week', contacts: [], parents: ['diary:2026-10-13'] }));
    const audit = auditContactPrivacy(dir, 10001);
    assert.equal(audit.hindsight.commonBank, 'actual-common');
    assert.equal(audit.hindsight.derivedDocuments.length, 2);
    const result = await forgetContact(dir, 10001, { apply: false, trashDir: join(base, 'trash'), commonBank: 'wrong' });
    assert.equal(result.plan.derived.length, 2);
    assert.equal(result.plan.hindsight.commonBank, 'actual-common');
    assert.equal(result.applied, false);
});

test('派生遗忘必须明确选择，回收命中日记而保留无关日期；已遗忘标记持久化', async () => {
    const { base, dir, memory } = fixture();
    recordProvenance(memory, entry('diary:2026-10-13'));
    recordProvenance(memory, entry('week:2026-10-12', { kind: 'week', parents: ['diary:2026-10-13'] }));
    writeFileSync(join(memory, 'diary.json'), JSON.stringify({ texts: { '2026-10-13': '联合日记', '2026-10-12': '无关日记' }, written: { '2026-10-13': 4 }, weeks: {}, phases: {} }));
    const calls: string[] = [];
    const api: ForgetApi = { deleteBank: async () => {}, deleteMentalModel: async () => {}, deleteDocument: async (bank, id) => { calls.push(`${bank}/${id}`); } };
    const opts = { apply: true, trashDir: join(base, 'trash'), commonBank: 'wrong', api, isAlive: () => false };
    await assert.rejects(forgetContact(dir, 10001, opts), /include-derived/);
    assert.deepEqual(calls, []);
    const result = await forgetContact(dir, 10001, { ...opts, includeDerived: true });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(calls, ['actual-common/diary:2026-10-13', 'actual-common/week:2026-10-12']);
    const state = JSON.parse(readFileSync(join(memory, 'diary.json'), 'utf8'));
    assert.deepEqual(state.texts, { '2026-10-12': '无关日记' });
    assert.equal(state.forgotten['2026-10-13'], true);
    assert.deepEqual(JSON.parse(readFileSync(join(result.trash!, 'derived-diary.json'), 'utf8')).texts, { '2026-10-13': '联合日记' });
});

test('远端失败保留本地数据，修复后重复执行仍能找到目标', async () => {
    const { base, dir, memory } = fixture();
    recordProvenance(memory, entry('diary:2026-10-13', { retention: 'pending' }));
    let fail = true;
    const api: ForgetApi = { deleteBank: async () => {}, deleteMentalModel: async () => {}, deleteDocument: async () => { if (fail) throw new Error('503'); } };
    const opts = { apply: true, includeDerived: true, trashDir: join(base, 'trash'), commonBank: 'c', api, isAlive: () => false };
    const first = await forgetContact(dir, 10001, opts);
    assert.equal(first.failures.length, 1);
    assert.equal(first.moved.length, 0);
    assert.equal(readFileSync(join(dir, 'chats', '10001.jsonl'), 'utf8'), 'fictional');
    fail = false;
    const second = await forgetContact(dir, 10001, opts);
    assert.equal(second.plan.derived.length, 1);
    assert.deepEqual(second.failures, []);
    assert.notEqual(first.trash, second.trash, '回收目录不能撞名覆盖历史报告');
});

test('远端仍有排队写入时，执行前拒绝，不移动本地或发送删除', async () => {
    const { base, dir, memory } = fixture();
    recordProvenance(memory, entry('diary:2026-10-13', { retention: 'pending' }));
    const api: ForgetApi = {
        activeOperations: async () => ['retain'],
        deleteBank: async () => assert.fail('不能删除'),
        deleteDocument: async () => assert.fail('不能删除'),
        deleteMentalModel: async () => assert.fail('不能删除'),
    };
    await assert.rejects(forgetContact(dir, 10001, { apply: true, includeDerived: true, trashDir: join(base, 'trash'), commonBank: 'c', api }), /后台操作/);
    assert.equal(readFileSync(join(dir, 'chats', '10001.jsonl'), 'utf8'), 'fictional');
});
