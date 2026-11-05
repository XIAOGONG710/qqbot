import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatHistory } from '../src/memory/history.ts';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';
import { exportContact, forgetContact } from '../src/memory/privacy-forget.ts';
import { archiveTestData } from '../src/memory/archive.ts';

const QQ = 10001, OTHER = 100010;
const source = { role: 'user' as const, time: '2026-11-05T12:00:00Z', sourceTime: Date.parse('2026-11-05T12:00:00Z') / 1000, messageId: 9, messageSeq: '10' };
function stage(dir: string, qq: number, prepared = false) {
 const history = new ChatHistory(dir);
 const id = history.stageIncoming(qq, { source, message: [{ type: 'image', data: { file: 'SYNTHETIC_PRIVATE_RAW' } }] });
 if (prepared) history.prepareIncoming(qq, id, { ...source, content: 'SYNTHETIC_PRIVATE_PREPARED' }, () => false);
 return join(dir, 'chats', `${qq}.recalled.json`);
}
function residues(dir: string, qq: number) {
 const base = join(dir, 'chats', `${qq}.recalled.json`);
 return ['.tmp-123-4', '.corrupt-1793880000000'].map(suffix => { const path = base + suffix; writeFileSync(path, `SYNTHETIC_PRIVATE_RESIDUE${suffix}`); return path; });
}

test('pending原始及prepared专属文件和确定崩溃残留纳入审计并按原字节导出，不泛匹配相邻QQ', () => {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-pending-privacy-'));
 try {
  const data = join(root, 'data'); mkdirSync(data); const path = stage(data, QQ, true); stage(data, OTHER);
  const owned = [path, ...residues(data, QQ)];
  writeFileSync(path + '.unrelated', 'UNRELATED');
  const audit = auditContactPrivacy(data, QQ);
  const files = audit.artifacts.filter(a => a.kind === 'direct').map(a => a.path.replaceAll('\\', '/'));
  assert.deepEqual(files.sort(), owned.map(p => p.slice(data.length + 1).replaceAll('\\', '/')).sort());
  assert.doesNotMatch(JSON.stringify(audit), /SYNTHETIC_PRIVATE/);
  const exported = exportContact(data, QQ, join(root, 'export'));
  for (const file of exported.files) assert.deepEqual(readFileSync(join(exported.dir, file)), readFileSync(join(data, file)));
  assert.equal(exported.files.length, 3); assert.equal(new ChatHistory(data).pendingIncoming(QQ).length, 1);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('遗忘仅移动本QQ pending及确定残留，其他QQ和只读资料原样保留', async () => {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-pending-forget-'));
 try {
  const data = join(root, 'data'); mkdirSync(data); const path = stage(data, QQ); const other = stage(data, OTHER, true);
  const owned = [path, ...residues(data, QQ)]; const before = owned.map(p => readFileSync(p)); const otherBefore = readFileSync(other);
  writeFileSync(join(data, 'README.txt'), 'READONLY_SYNTHETIC');
  const result = await forgetContact(data, QQ, { apply: true, trashDir: join(root, 'trash'), commonBank: 'synthetic-common' });
  assert.deepEqual(result.failures, []); assert.equal(result.moved.length, 3);
  for (const [index, file] of owned.entries()) { assert.equal(existsSync(file), false); assert.deepEqual(readFileSync(join(result.trash!, file.slice(data.length + 1))), before[index]); }
  assert.deepEqual(new ChatHistory(data).pendingIncoming(QQ), []); assert.deepEqual(readFileSync(other), otherBefore);
  assert.equal(readFileSync(join(data, 'README.txt'), 'utf8'), 'READONLY_SYNTHETIC');
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('归档连同孤立pending和残留完整搬走，不再重启恢复旧pending，归档名仍可按QQ审计', () => {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-pending-archive-'));
 try {
  const data = join(root, 'data'); mkdirSync(data); const path = stage(data, QQ, true); const orphan = stage(data, OTHER);
  const owned = [path, ...residues(data, QQ), orphan]; const before = owned.map(p => readFileSync(p));
  writeFileSync(join(data, 'chats', `${QQ}.jsonl`), 'SYNTHETIC_ARCHIVED_CHAT\n');
  writeFileSync(join(data, 'tiers.json'), JSON.stringify({ [QQ]: 'classmate' }));
  const untouched = join(data, 'chats', `${QQ}.recalled.json.unrelated`); writeFileSync(untouched, 'READONLY_SYNTHETIC');
  const result = archiveTestData({ dataDir: data, configFiles: [], now: new Date('2026-11-05T12:00:00Z') });
  for (const [index, file] of owned.entries()) {
   const move = result.moves.find(m => m.from === file); assert.ok(move, `missing ${file}`);
   assert.equal(existsSync(file), false); assert.deepEqual(readFileSync(move.to), before[index]);
  }
  assert.deepEqual(new ChatHistory(data).pendingIncoming(QQ), []); assert.deepEqual(new ChatHistory(data).pendingIncoming(OTHER), []);
  const audit = auditContactPrivacy(data, QQ);
  assert.equal(audit.artifacts.filter(a => a.kind === 'direct' && a.path.replaceAll('\\', '/').startsWith('chats/archive/')).length, 4);
  assert.ok(audit.artifacts.some(a => a.kind === 'mixed' && a.path.replaceAll('\\', '/').startsWith('maintenance/archive-jobs/')));
  assert.equal(readFileSync(untouched, 'utf8'), 'READONLY_SYNTHETIC');
 } finally { rmSync(root, { recursive: true, force: true }); }
});
