import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/memory/ledger.ts';
import { Identity, type GitProbe } from '../src/memory/identity.ts';
import { auditedApi } from '../src/memory/memory-audit.ts';
import type { HindsightApi, MemoryItem } from '../src/memory/hindsight.ts';
import { Timeline, timelineFromDevice } from '../src/memory/timeline.ts';
import { TierRecord } from '../src/memory/tier-record.ts';
const at = new Date('2026-11-05T12:00:00Z');
function fixture(work: (dir: string) => void) { const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-ledger-')); try { work(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }

test('哈希链截尾后追加不能悄悄抹除原有断链证据', () => fixture(dir => {
 const ledger = new Ledger(join(dir, 'log.jsonl')); ledger.append('first', {}, at); ledger.append('second', {}, at);
 const first = readFileSync(ledger.path, 'utf8').split('\n')[0]! + '\n'; writeFileSync(ledger.path, first);
 const head = readFileSync(`${ledger.path}.head`, 'utf8'); assert.equal(ledger.verify().ok, false);
 assert.throws(() => ledger.append('third', {}, at)); assert.equal(readFileSync(ledger.path, 'utf8'), first); assert.equal(readFileSync(`${ledger.path}.head`, 'utf8'), head);
}));

test('合法JSON坏形状与坏行可诊断，不抛TypeError也不把坏原文塞进read占位', () => fixture(dir => {
 for (const raw of ['null\n', '[]\n', '{"seq":0}\n', 'PRIVATE_LEDGER_BODY\n']) {
  const ledger = new Ledger(join(dir, 'bad.jsonl')); writeFileSync(ledger.path, raw);
  assert.equal(ledger.verify().ok, false); assert.ok(!JSON.stringify(ledger.read()).includes('PRIVATE_LEDGER_BODY'));
 }
}));

test('账本哈希使用实际JSON表示，Date/toJSON/稀疏数组不会自写自验失败', () => fixture(dir => {
 const ledger = new Ledger(join(dir, 'log.jsonl')); const sparse = Array(2); sparse[1] = undefined;
 const original = { when: at, nested: { toJSON: () => ({ answer: 42 }) }, sparse };
 const saved = ledger.append('synthetic', original, at); assert.equal(ledger.verify().ok, true);
 assert.deepEqual(saved.data, JSON.parse(JSON.stringify(original)));
}));

test('档位更新写失败不先发布内存，恢复后的相同目标仍会提交换档时间', () => fixture(dir => {
 const path = join(dir, 'tiers.json'); const tiers = new TierRecord(path); tiers.update(1, 'boyfriend', at);
 const backup = join(dir, 'backup'); renameSync(path, backup); mkdirSync(path);
 assert.throws(() => tiers.update(1, 'classmate', at)); assert.equal(tiers.since(1), undefined);
 rmSync(path, { recursive: true }); renameSync(backup, path); tiers.update(1, 'classmate', at);
 assert.equal(new TierRecord(path).since(1)!.getTime(), at.getTime());
 writeFileSync(path, '{"PRIVATE_TIER_BODY":'); assert.throws(() => new TierRecord(path), error => error instanceof Error && !error.message.includes('PRIVATE_TIER_BODY'));
}));

test('时间线不读取未来事实、按发生时刻取最近、零limit不变全量，坏成功标记不被洗成成功', () => fixture(dir => {
 const path = join(dir, 'timeline.jsonl'); const timeline = new Timeline(path, () => at);
// 「未来」要超出 recent() 给的 60 秒时钟偏差容忍（DSH 线保留的，跨进程时间戳可能略快）才算未来
 for (const [offset, summary] of [[-1000, '最新'], [-3000, '最旧'], [-2000, '中间'], [120_000, '未来']] as const) timeline.record({ at: new Date(at.getTime() + offset), channel: 'web', kind: 'search', summary });
 assert.deepEqual(timeline.recent(at, 24, 2).map(item => item.summary), ['中间', '最新']); assert.deepEqual(timeline.recent(at, 24, 0), []);
 writeFileSync(path, JSON.stringify({ at: at.toISOString(), channel: 'web', kind: 'search', summary: '坏标记', ok: 'false' }) + '\n');
 assert.deepEqual(timeline.read(), []);
 const onAudit = timelineFromDevice({ record: () => { throw new Error('synthetic IO'); } } as unknown as Timeline);
 assert.doesNotThrow(() => onAudit({ at: at.getTime(), source: 'model', action: 'notify', target: 'computer', decision: 'executed' }));
}));

test('设定坏链不被check继续写入覆盖，删除文件同样需要自己的提交依据', () => fixture(dir => {
 const root = join(dir, 'repo'); const source = join(root, 'characters/linmengyao/source'); mkdirSync(source, { recursive: true });
 const a = join(source, 'a.json'); const b = join(source, 'b.json'); writeFileSync(a, '{}'); writeFileSync(b, '{}');
 const git: GitProbe = { head: () => 'synthetic', commits: () => [{ hash: 'synthetic', author: 'synthetic', date: at.toISOString(), subject: '合成修改', files: ['characters/linmengyao/source/b.json'] }], dirty: () => [] };
 const identity = new Identity({ repoRoot: root, dataDir: join(dir, 'data'), git, now: () => at }); identity.check();
 rmSync(a); writeFileSync(b, '{"v":2}'); assert.equal(identity.check().changes[0]!.explained, false);
 writeFileSync(identity.ledger.path, ''); const head = readFileSync(`${identity.ledger.path}.head`, 'utf8');
 assert.equal(identity.check().chain.ok, false); assert.equal(readFileSync(identity.ledger.path, 'utf8'), ''); assert.equal(readFileSync(`${identity.ledger.path}.head`, 'utf8'), head);
}));

test('记忆审计使用调用时内容快照，审计失败日志不泄露异常正文且不使已成功retain失败', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-audit-review-'));
 try {
  const ledger = new Ledger(join(dir, 'memory.jsonl')); let release!: () => void;
  const raw = { retain: async () => new Promise<void>(resolve => { release = resolve; }) } as unknown as HindsightApi;
  const item: MemoryItem = { content: '原始合成内容', timestamp: at.toISOString(), context: 'synthetic', document_id: 'synthetic', tags: [], metadata: {} };
  const task = auditedApi(raw, ledger).retain('synthetic', item); item.content = '后来修改的内容'; release(); await task;
  assert.equal(ledger.read()[0]!.data.chars, 6);
  const logs: string[] = []; const broken = { append: () => { throw new Error('PRIVATE_AUDIT_FAILURE'); } } as unknown as Ledger;
  await auditedApi({ retain: async () => {} } as unknown as HindsightApi, broken, { log: text => logs.push(text) }).retain('synthetic', item);
  assert.ok(logs.every(text => !text.includes('PRIVATE_AUDIT_FAILURE')));
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
