import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';
import { exportContact, planForget } from '../src/memory/privacy-forget.ts';
import { archiveTestData } from '../src/memory/archive.ts';
import { writtenRequestHash } from '../src/memory/written-retain.ts';
import { createHash, randomUUID } from 'node:crypto';
function fixture(work: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-written-privacy-')); mkdirSync(join(root, 'memory'));
    try { work(root); } finally { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-written-privacy-')); rmSync(root, { recursive: true, force: true }); }
}
test('共享日记prepared/body及提交意图仅列mixed，导出/遗忘不复制或移动另一来源正文', () => fixture(root => {
    for (const file of ['diary.json', 'written-retain.json', 'written-retain.initialized']) writeFileSync(join(root, 'memory', file), 'SYNTHETIC_SHARED_PRIVATE_BODY');
    mkdirSync(join(root, 'memory', 'written-retain-coordination'));
    writeFileSync(join(root, 'memory', 'written-retain-coordination', 'index.coordination.sqlite'), 'SYNTHETIC_COORDINATION');
    const audit = auditContactPrivacy(root, 10001), shared = audit.artifacts.filter(item => /diary|written-retain/.test(item.path));
    assert.equal(shared.length, 4); assert.ok(shared.every(item => item.kind === 'mixed'));
    const plan = planForget(audit, 'synthetic-common'); assert.equal(plan.move.length, 0); assert.equal(plan.leave.length, 4);
    const result = exportContact(root, 10001, join(root, 'exports'));
    assert.ok(!existsSync(join(result.dir, 'memory'))); assert.ok(!readFileSync(join(result.dir, 'audit.json'), 'utf8').includes('SYNTHETIC_SHARED_PRIVATE_BODY'));
}));

test('归档遇坏提交状态或见证丢JSON，在改tiers或配置前拒绝且保留原件', () => fixture(root => {
    const path = join(root, 'memory', 'written-retain.json'), tiers = join(root, 'tiers.json'), config = join(root, 'config.json');
    const originalTiers = JSON.stringify({ '10001': { tier: 'classmate' } }), originalConfig = JSON.stringify({ memory: { bankPrefix: 'synthetic-original' } });
    writeFileSync(tiers, originalTiers); writeFileSync(config, originalConfig);
    writeFileSync(join(root, 'memory', 'written-retain.initialized'), '');
    assert.throws(() => archiveTestData({ dataDir: root, configFiles: [config], prefix: 'synthetic-new' }), /见证/);
    writeFileSync(path, '{SYNTHETIC_INVALID');
    assert.throws(() => archiveTestData({ dataDir: root, configFiles: [config], prefix: 'synthetic-new' }), /无法核验/);
    assert.equal(readFileSync(path, 'utf8'), '{SYNTHETIC_INVALID');
    assert.equal(readFileSync(tiers, 'utf8'), originalTiers); assert.equal(readFileSync(config, 'utf8'), originalConfig);
}));
test('实际body临时残留也保留共享隐私属性，不泛收任意相近文件', () => fixture(root => {
    for (const file of ['diary.json.tmp-123-1', 'written-retain.json.tmp-123-2', 'written-retain-secrets.json']) writeFileSync(join(root, 'memory', file), 'SYNTHETIC_PARTIAL_PRIVATE');
    const audit = auditContactPrivacy(root, 10001), found = audit.artifacts.filter(item => item.path.includes('.tmp-'));
    assert.equal(found.length, 2); assert.ok(found.every(item => item.kind === 'mixed')); assert.ok(!audit.artifacts.some(item => item.path.includes('secrets')));
    assert.ok(!JSON.stringify(audit).includes('SYNTHETIC_PARTIAL_PRIVATE'));
}));
test('归档拒未确认日记提交，完成后保留原意图及marker不随prefix移动', () => fixture(root => {
    const bank = 'synthetic-common', documentId = 'diary:2026-11-05', id = randomUUID();
    const item = { content: 'SYNTHETIC_WRITTEN', timestamp: '2026-11-05T22:00:00+08:00', document_id: documentId, context: 'synthetic', tags: ['qq-private', 'diary'], metadata: { source: 'diary' }, entities: [{ text: '合成角色', type: 'PERSON' }] };
    const operation = { bankId: bank, documentId, operationId: id, item, requestHash: writtenRequestHash(item), phase: 'dispatched' };
    const key = createHash('sha256').update(JSON.stringify([bank, documentId])).digest('hex');
    const state = { version: 1, operations: { [id]: operation }, current: { [key]: id }, blockedBanks: {} };
    const path = join(root, 'memory', 'written-retain.json'); writeFileSync(path, JSON.stringify(state)); writeFileSync(join(root, 'memory', 'written-retain.initialized'), '');
    assert.throws(() => archiveTestData({ dataDir: root, configFiles: [], prefix: 'synthetic-new' }), /未完成日记/);
    operation.phase = 'completed'; writeFileSync(path, JSON.stringify(state)); const bytes = readFileSync(path, 'utf8');
    const result = archiveTestData({ dataDir: root, configFiles: [], prefix: 'synthetic-new' });
    assert.equal(readFileSync(path, 'utf8'), bytes); assert.ok(!result.moves.some(move => move.from === path)); assert.ok(existsSync(join(root, 'memory', 'written-retain.initialized')));
}));
