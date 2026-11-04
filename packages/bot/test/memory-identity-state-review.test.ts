import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Identity, type IdentityOptions } from '../src/memory/identity.ts';
import { fileOps } from '../src/memory/json-file.ts';

function fixture() {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-identity-state-'));
 const options: IdentityOptions = { repoRoot: dir, dataDir: join(dir, 'data'), git: { head: () => 'synthetic', commits: () => [], dirty: () => [] } };
 const identity = new Identity(options);
 identity.ledger.append('genesis', { snapshot: {} });
 identity.ledger.append('change', { files: [], commits: [], dirty: [], explained: false });
 return { dir, options, identity, path: join(dir, 'data/identity/state.json') };
}

test('坏告知状态不重置、不隐藏改动、不被markTold或启动检查覆盖，错误不带原文', () => {
 const f = fixture();
 try {
  for (const text of ['{"private-synthetic":', 'null', '[]', '{}', '{"toldSeq":"1"}', '{"toldSeq":-2}', '{"toldSeq":0.5}', '{"toldSeq":1e100}', '{"toldSeq":1e999}', '{"toldSeq":2}', '{"toldSeq":1,"toldHash":"bad"}', JSON.stringify({ toldSeq: 1, toldHash: '0'.repeat(64) })]) {
   writeFileSync(f.path, text);
   const before = readFileSync(f.identity.ledger.path, 'utf8');
   for (const action of [() => f.identity.unseen(), () => f.identity.markTold(), () => f.identity.check()]) {
    assert.throws(action, error => error instanceof Error && /告知状态/.test(error.message) && !error.message.includes('private-synthetic'));
    assert.equal(readFileSync(f.path, 'utf8'), text);
    assert.equal(readFileSync(f.identity.ledger.path, 'utf8'), before);
   }
  }
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('缺省与合法旧告知状态兼容，原子新状态重启后绑定账本且保留扩展字段', () => {
 const f = fixture();
 try {
  assert.equal(f.identity.unseen().length, 1);
  writeFileSync(f.path, '{"toldSeq":-1}');
  assert.equal(new Identity(f.options).unseen().length, 1);
  writeFileSync(f.path, JSON.stringify({ toldSeq: 0, extension: { version: 2 } }));
  assert.equal(new Identity(f.options).unseen().length, 1);
  f.identity.markTold();
  const saved = JSON.parse(readFileSync(f.path, 'utf8'));
  assert.equal(saved.toldSeq, 1); assert.equal(saved.toldHash, f.identity.ledger.last()!.hash);
  assert.deepEqual(saved.extension, { version: 2 });
  assert.deepEqual(new Identity(f.options).unseen(), []);
  f.identity.ledger.append('change', { files: [], commits: [], dirty: [] });
  assert.equal(new Identity(f.options).unseen().length, 1);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('写入前失败保留旧告知进度，发布后异常可确认成功且重启不重复告知', () => {
 const f = fixture(); const original = fileOps.renameSync;
 try {
  writeFileSync(f.path, '{"toldSeq":0}');
  fileOps.renameSync = () => { throw new Error('private-synthetic-disk-error'); };
  assert.throws(() => f.identity.markTold(), error => error instanceof Error && /告知状态/.test(error.message) && !error.message.includes('private-synthetic'));
  assert.equal(readFileSync(f.path, 'utf8'), '{"toldSeq":0}');
  assert.equal(new Identity(f.options).unseen().length, 1);
  fileOps.renameSync = (...args) => { original(...args); throw new Error('after publish'); };
  f.identity.markTold();
  assert.deepEqual(new Identity(f.options).unseen(), []);
 } finally { fileOps.renameSync = original; rmSync(f.dir, { recursive: true, force: true }); }
});

test('现有状态读失败不视为初次运行，恢复IO后保留原告知进度', () => {
 const f = fixture();
 try {
  writeFileSync(f.path, '{"toldSeq":1}'); renameSync(f.path, `${f.path}.saved`); mkdirSync(f.path);
  assert.throws(() => f.identity.unseen(), /告知状态/);
  assert.throws(() => f.identity.markTold(), /告知状态/);
  rmSync(f.path, { recursive: true }); renameSync(`${f.path}.saved`, f.path);
  assert.deepEqual(new Identity(f.options).unseen(), []);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('坏链或同序号换链不会把告知标记迁往另一段历史，保留原状态', () => {
 const f = fixture();
 try {
  f.identity.markTold(); const saved = readFileSync(f.path, 'utf8');
  rmSync(f.identity.ledger.path); rmSync(`${f.identity.ledger.path}.head`);
  f.identity.ledger.append('genesis', { snapshot: {}, replacement: true });
  f.identity.ledger.append('change', { files: [], commits: [], dirty: [], replacement: true });
  assert.throws(() => new Identity(f.options).unseen(), /告知状态/);
  assert.throws(() => f.identity.markTold(), /告知状态/);
  assert.equal(readFileSync(f.path, 'utf8'), saved);
  writeFileSync(f.identity.ledger.path, '{broken-private-synthetic');
  assert.throws(() => f.identity.markTold(), /告知状态/);
  assert.equal(readFileSync(f.path, 'utf8'), saved);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
