import assert from 'node:assert/strict';
import crypto, { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WrittenRetainStore, writtenRequestHash, WRITTEN_RETAIN_FILE, WRITTEN_RETAIN_MARKER, WRITTEN_RETAIN_COORDINATION_DIRECTORY } from '../src/memory/written-retain.ts';
import { fileOps } from '../src/memory/json-file.ts';
import type { MemoryItem } from '../src/memory/hindsight.ts';

const bank = 'synthetic-common', other = 'synthetic-other', secret = 'SYNTHETIC_WRITTEN_RESOURCE_BODY';
function item(index = 0): MemoryItem { return { content: `${secret}_${index}`, timestamp: '2026-11-04T22:00:00+08:00', context: 'Synthetic', document_id: `diary:2026-11-${String(index + 1).padStart(2, '0')}`, tags: ['diary'], metadata: {}, entities: [] }; }
function fixture(count = 3) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-source-resource-review-')), operations: Record<string, unknown> = {}, current: Record<string, string> = {};
    for (let index = 0; index < count; index++) {
        const payload = item(index), id = randomUUID(), documentId = payload.document_id!;
        operations[id] = { bankId: bank, documentId, operationId: id, requestHash: writtenRequestHash(payload), item: payload, phase: 'completed' };
        current[createHash('sha256').update(JSON.stringify([bank, documentId])).digest('hex')] = id;
    }
    const path = join(dir, WRITTEN_RETAIN_FILE); writeFileSync(path, JSON.stringify({ version: 1, operations, current, blockedBanks: {} })); writeFileSync(join(dir, WRITTEN_RETAIN_MARKER), '');
    return { dir, path, store: new WrittenRetainStore(dir), clean() { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-source-resource-review-')); rmSync(dir, { recursive: true, force: true }); } };
}

test('未变outbox的公共保护查询每次fresh读完整原字节，但不重复解析/重算所有正文SHA', () => {
    const f = fixture(20), originalHash = crypto.createHash, originalRead = fileOps.readFileSync, originalParse = JSON.parse;
    try {
        assert.deepEqual(f.store.blockedDocuments(bank), []);
        let hashes = 0, parses = 0, reads = 0, bytes = 0;
        crypto.createHash = ((...args: Parameters<typeof crypto.createHash>) => { hashes++; return originalHash(...args); }) as typeof crypto.createHash; syncBuiltinESMExports();
        JSON.parse = (...args: Parameters<typeof JSON.parse>) => { parses++; return originalParse(...args); };
        fileOps.readFileSync = ((...args: Parameters<typeof fileOps.readFileSync>) => { const result = originalRead(...args); if (String(args[0]) === f.path) { reads++; bytes += Buffer.byteLength(result); } return result; }) as typeof fileOps.readFileSync;
        for (let i = 0; i < 3; i++) assert.deepEqual(f.store.blockedDocuments(bank), []);
        assert.equal(reads, 3); assert.equal(bytes, 3 * statSync(f.path).size); assert.equal(parses, 0); assert.equal(hashes, 0, '相同已验证字节不能每次重算全部历史正文与current tuple SHA');
    } finally { crypto.createHash = originalHash; syncBuiltinESMExports(); fileOps.readFileSync = originalRead; JSON.parse = originalParse; f.clean(); }
});

test('guardState只返回当前文档固定元数据，blocked/intents共享验证缓存且副本不能污染缓存', () => {
    const f = fixture(), originalHash = crypto.createHash;
    try {
        const first = f.store.guardState(bank); assert.equal(first.intents.length, 3); assert.ok(!JSON.stringify(first).includes(secret));
        first.blockedDocuments.push('diary:synthetic-spurious'); first.intents[0]!.phase = 'prepared';
        let hashes = 0; crypto.createHash = ((...args: Parameters<typeof crypto.createHash>) => { hashes++; return originalHash(...args); }) as typeof crypto.createHash; syncBuiltinESMExports();
        assert.deepEqual(f.store.blockedDocuments(bank), []); assert.ok(f.store.sourceIntents(bank).every(row => row.phase === 'completed')); assert.deepEqual(f.store.guardState(other), { blockedDocuments: [], intents: [] });
        assert.equal(hashes, 0);
        assert.deepEqual(Object.keys(f.store.sourceIntents(bank)[0]!).sort(), ['documentId', 'operationId', 'phase', 'requestHash']);
    } finally { crypto.createHash = originalHash; syncBuiltinESMExports(); f.clean(); }
});

test('同mtime同长度的真实字节变化必须重新核验，并显示另一实例的新current意图', () => {
    const f = fixture(1);
    try {
        const before = f.store.sourceIntents(bank)[0]!, originalStat = statSync(f.path);
        const state = JSON.parse(readFileSync(f.path, 'utf8')); const op = state.operations[before.operationId]; op.item.content = op.item.content.replace('BODY', 'TEXT'); op.requestHash = writtenRequestHash(op.item);
        writeFileSync(f.path, JSON.stringify(state)); utimesSync(f.path, originalStat.atime, originalStat.mtime); assert.equal(statSync(f.path).size, originalStat.size);
        assert.notEqual(f.store.sourceIntents(bank)[0]!.requestHash, before.requestHash);
        const writer = new WrittenRetainStore(f.dir), next = writer.prepare(bank, { ...item(), content: `${secret}_new` });
        assert.equal(f.store.sourceIntents(bank)[0]!.operationId, next.operationId); assert.equal(f.store.sourceIntents(bank)[0]!.phase, 'prepared');
        assert.equal(Object.keys(f.store.snapshot().operations).length, 2, '不删已完成历史来缩短公共查询');
    } finally { f.clean(); }
});

test('另一进程持久来源屏障后，旧实例缓存不能继续返回clean', () => {
    const f = fixture(1);
    try {
        assert.deepEqual(f.store.blockedDocuments(bank), []);
        const module = new URL('../src/memory/written-retain.ts', import.meta.url).href;
        const script = `const{WrittenRetainStore}=await import(${JSON.stringify(module)});new WrittenRetainStore(${JSON.stringify(f.dir)}).markSourceChanged(${JSON.stringify(bank)},'diary:2026-11-01');`;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
        assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(f.store.guardState(bank).blockedDocuments, ['diary:2026-11-01']);
    } finally { f.clean(); }
});

test('缓存不能绕过坏正文hash、读IO、marker异常或见证丢JSON，恢复原件可重新读取', () => {
    const f = fixture(1), originalRead = fileOps.readFileSync;
    try {
        const before = readFileSync(f.path, 'utf8'); f.store.guardState(bank);
        const invalid = JSON.parse(before); Object.values(invalid.operations as Record<string, { item: MemoryItem }>)[0]!.item.content = 'SYNTHETIC_TAMPERED'; writeFileSync(f.path, JSON.stringify(invalid));
        assert.throws(() => f.store.guardState(bank), error => !String(error).includes('TAMPERED')); writeFileSync(f.path, before);
        fileOps.readFileSync = ((...args: Parameters<typeof fileOps.readFileSync>) => { if (String(args[0]) === f.path) throw Object.assign(new Error(secret), { code: 'EIO' }); return originalRead(...args); }) as typeof fileOps.readFileSync;
        assert.throws(() => f.store.guardState(bank), error => !String(error).includes(secret)); fileOps.readFileSync = originalRead;
        writeFileSync(join(f.dir, WRITTEN_RETAIN_MARKER), 'BAD'); assert.throws(() => f.store.guardState(bank)); writeFileSync(join(f.dir, WRITTEN_RETAIN_MARKER), '');
        unlinkSync(f.path); assert.throws(() => f.store.guardState(bank)); writeFileSync(f.path, before); assert.equal(f.store.sourceIntents(bank).length, 1);
    } finally { fileOps.readFileSync = originalRead; f.clean(); }
});

test('dirty来源观察必须先持久flush，失败不回退cache且恢复后两实例均看到屏障', () => {
    const f = fixture(1), originalRename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        f.store.guardState(bank); fileOps.writeDelaysMs = [0];
        fileOps.renameSync = ((from, to) => { if (String(to) === f.path) throw Object.assign(new Error(secret), { code: 'EIO' }); return originalRename(from, to); }) as typeof fileOps.renameSync;
        assert.throws(() => f.store.markSourceChanged(bank, 'diary:2026-11-01')); assert.throws(() => f.store.guardState(bank));
        fileOps.renameSync = originalRename; assert.deepEqual(f.store.guardState(bank).blockedDocuments, ['diary:2026-11-01']);
        assert.deepEqual(new WrittenRetainStore(f.dir).blockedDocuments(bank), ['diary:2026-11-01']);
    } finally { fileOps.renameSync = originalRename; fileOps.writeDelaysMs = delays; f.clean(); }
});

test('RMW发布失败不能把局部已变phase写入只读缓存，完成事实恢复后才变化', () => {
    const f = fixture(1), originalRename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        const next = f.store.prepare(bank, { ...item(), content: `${secret}_new` }); f.store.phase(next.operationId, 'dispatched'); assert.equal(f.store.sourceIntents(bank)[0]!.phase, 'dispatched');
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = ((from, to) => { if (String(to) === f.path) throw Object.assign(new Error(secret), { code: 'EIO' }); return originalRename(from, to); }) as typeof fileOps.renameSync;
        assert.throws(() => f.store.phase(next.operationId, 'completed')); fileOps.renameSync = originalRename;
        assert.equal(f.store.sourceIntents(bank)[0]!.phase, 'dispatched'); f.store.phase(next.operationId, 'completed'); assert.equal(f.store.sourceIntents(bank)[0]!.phase, 'completed');
    } finally { fileOps.renameSync = originalRename; fileOps.writeDelaysMs = delays; f.clean(); }
});

test('缓存命中仍获取协调锁，损坏协调库不能靠RAM声明clean', () => {
    const f = fixture(1);
    try { f.store.guardState(bank); writeFileSync(join(f.dir, WRITTEN_RETAIN_COORDINATION_DIRECTORY, 'index.coordination.sqlite'), 'SYNTHETIC_INVALID_SQLITE'); assert.throws(() => f.store.guardState(bank)); }
    finally { f.clean(); }
});

test('completed意图丢失current索引不能变成无来源clean，暖缓存和重启均保原拒读', () => {
    const f = fixture(1);
    try {
        const original = readFileSync(f.path, 'utf8');
        assert.equal(f.store.sourceIntents(bank).length, 1);
        const broken = JSON.parse(original); broken.current = {};
        const bytes = JSON.stringify(broken); writeFileSync(f.path, bytes);
        assert.throws(() => f.store.guardState(bank));
        assert.throws(() => new WrittenRetainStore(f.dir).snapshot());
        assert.equal(readFileSync(f.path, 'utf8'), bytes, '不能猜测重建最后一个版本');
        writeFileSync(f.path, original);
        assert.equal(f.store.sourceIntents(bank).length, 1);
    } finally { f.clean(); }
});

test('同文档多个完成版本保留历史，仅最新current参与来源；不同bank文档不能借索引覆盖', () => {
    const f = fixture(1);
    try {
        const next = f.store.prepare(bank, { ...item(), content: 'SYNTHETIC_REVISION' });
        f.store.phase(next.operationId, 'completed');
        assert.equal(Object.keys(f.store.snapshot().operations).length, 2);
        assert.deepEqual(f.store.sourceIntents(bank).map(op => op.operationId), [next.operationId]);
        const otherOp = f.store.prepare(other, item()); f.store.phase(otherOp.operationId, 'completed');
        const state = JSON.parse(readFileSync(f.path, 'utf8'));
        delete state.current[createHash('sha256').update(JSON.stringify([other, item().document_id])).digest('hex')];
        writeFileSync(f.path, JSON.stringify(state));
        assert.throws(() => f.store.guardState(bank));
    } finally { f.clean(); }
});
