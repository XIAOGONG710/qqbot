import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DerivedState, isDerivedState } from '../src/memory/derived-state.ts';
import { createHash } from 'node:crypto';
import { fileOps } from '../src/memory/json-file.ts';
import { repairSourceManifestHash, type FinalEvidence, type RefreshSettlementEvidence, type RepairCheckpointEvidence, type RepairLease, type RepairPhase } from '../src/memory/derived-repair-protocol.ts';
const owner = { qq: 10001, tier: 'boyfriend' };
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'qqbot-derived-repair-state-')); return { dir, path: join(dir, 'derived.json'), store: new DerivedState(dir) }; }
function cleanup(dir: string) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-derived-repair-state-')); rmSync(dir, { recursive: true, force: true }); }
const h = (text: string) => createHash('sha256').update(text).digest('hex');
const bank = `synthetic-${h(`qqbot:${owner.qq}-${owner.tier}`).slice(0, 16)}`;
const sourceManifest = [{ documentId: 'ep-1', episodeDigest: h('episode'), contentHash: h('content'), count: 2 }];
const evidence: RepairCheckpointEvidence = { initialWatermark: '2026-11-05T12:00:00Z', finalWatermark: '2026-11-05T12:00:00Z', inventoryHash: h('inventory'), modelIdentityHash: h('identity'),
 safeConfigHash: h('paused-config'), restoredConfigHash: h('original-config'), originalAutomatic: true, originalCadence: 1800, clearContentHash: h(''),
 refreshOperationId: '12345678-1234-4123-8123-123456789012', refreshOutcome: 'content_written', modelIsStale: false, modelContentHash: h('fresh model'), modelSeenAt: '2026-11-05T11:59:00Z', modelRefreshedAt: '2026-11-05T12:01:00Z' };
const steps: [RepairPhase, RepairCheckpointEvidence][] = [
 ['pause-dispatched', { initialWatermark: evidence.initialWatermark, inventoryHash: evidence.inventoryHash, modelIdentityHash: evidence.modelIdentityHash, originalAutomatic: true, originalCadence: 1800 }],
 ['paused', { safeConfigHash: evidence.safeConfigHash }], ['clear-dispatched', {}], ['cleared', { clearContentHash: evidence.clearContentHash }], ['refresh-dispatched', {}],
 ['refresh-pending', { refreshOperationId: evidence.refreshOperationId }], ['restore-dispatched', { refreshOutcome: evidence.refreshOutcome, modelIsStale: false, modelContentHash: evidence.modelContentHash, modelSeenAt: evidence.modelSeenAt, modelRefreshedAt: evidence.modelRefreshedAt }],
 ['restored', { restoredConfigHash: evidence.restoredConfigHash }], ['verified', { finalWatermark: evidence.finalWatermark }],
];
function begin(store: DerivedState) { const state = store.snapshot(bank); return store.beginRepair(bank, { expectedGeneration: state.generation, eventSetHash: state.eventSetHash,
 sourceManifestHash: repairSourceManifestHash(sourceManifest), sourceManifest, owner, progressHash: h('progress') }); }
function finish(store: DerivedState, lease: RepairLease, after: RepairPhase = 'baseline'): FinalEvidence {
 for (const [phase, proof] of steps.slice(after === 'baseline' ? 0 : steps.findIndex(([phase]) => phase === after) + 1)) store.checkpoint(lease, phase, proof);
 return { ...evidence, sourceManifestHash: lease.sourceManifestHash, progressHash: lease.progressHash, eventSetHash: lease.eventSetHash } as FinalEvidence;
}
function pendingSettlement() {
 const f = fixture(); f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'first' }); const lease = begin(f.store);
 for (const [phase, proof] of steps) { f.store.checkpoint(lease, phase, proof); if (phase === 'refresh-pending') break; }
 f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'second' });
 const proof: RefreshSettlementEvidence = { observedGeneration: f.store.snapshot(bank).generation, operationId: evidence.refreshOperationId!, operationType: 'refresh_mental_model',
  modelId: 'relationship', status: 'completed', outcome: 'content_written', quiescentWatermark: evidence.initialWatermark!,
  operations: { pending: 0, processing: 0, failed: 0, cancelled: 0 }, pendingConsolidation: 0, failedConsolidation: 0,
  modelIdentityHash: evidence.modelIdentityHash!, configurationHash: evidence.safeConfigHash! };
 return { ...f, lease, proof };
}

test('相同稳定event重放不推进generation，新事件即使同doc仍推进', () => {
 const f = fixture();
 try { f.store.mark('private', { ...owner, documents: ['ep-1'], eventKey: 'recall-one' }); const first = f.store.snapshot('private');
  new DerivedState(f.dir).mark('private', { ...owner, documents: ['ep-1'], eventKey: 'recall-one' }); assert.equal(f.store.snapshot('private').generation, first.generation);
  f.store.mark('private', { ...owner, documents: ['ep-1'], eventKey: 'recall-two' }); assert.notEqual(f.store.snapshot('private').generation, first.generation);
 } finally { cleanup(f.dir); }
});

test('相同eventKey不能换owner或文档/未知scope，原文件不改', () => {
 for (const changed of [{ ...owner, documents: ['ep-2'] }, { qq: 10002, tier: 'boyfriend', documents: ['ep-1'] }, { ...owner }]) {
  const f = fixture(); try { f.store.mark('private', { ...owner, documents: ['ep-1'], eventKey: 'recall' }); const before = readFileSync(f.path, 'utf8');
   assert.throws(() => f.store.mark('private', { ...changed, eventKey: 'recall' })); assert.equal(readFileSync(f.path, 'utf8'), before);
  } finally { cleanup(f.dir); }
 }
});

test('v1精确与未知dirty迁移都保持未解决，重复读取不会伪clean或重置世代', () => {
 for (const allDocuments of [false, true]) {
  const f = fixture(); try { writeFileSync(f.path, JSON.stringify({ version: 1, banks: { private: { generation: '11111111-1111-4111-8111-111111111111', documents: ['ep-1'], owners: [{ ...owner, allDocuments }] } } }));
   const before = f.store.snapshot('private'); assert.equal(before.dirty, true); assert.equal(before.owners[0]!.allDocuments, allDocuments);
   assert.deepEqual(new DerivedState(f.dir).snapshot('private'), before); assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).version, 2);
  } finally { cleanup(f.dir); }
 }
});

test('严格journal和Final确认后换读取epoch，已修事件重放不再污染，新同doc事件会再脏化', () => {
 const f = fixture();
 try { f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'one' }); const lease = begin(f.store), proof = finish(f.store, lease);
  const result = f.store.commitVerifiedRepair(lease, proof); assert.notEqual(result.generation, lease.generation); assert.equal(f.store.snapshot(bank).dirty, false);
  assert.equal(f.store.snapshot(bank).allOwners[0]!.qq, owner.qq); assert.deepEqual(new DerivedState(f.dir).commitVerifiedRepair(lease, proof), result);
  new DerivedState(f.dir).mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'one' }); assert.equal(f.store.snapshot(bank).generation, result.generation); assert.equal(f.store.snapshot(bank).dirty, false);
  f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'two' }); assert.equal(f.store.snapshot(bank).dirty, true);
  f.store.commitVerifiedRepair(lease, proof); assert.equal(f.store.snapshot(bank).dirty, true, '旧receipt重试不能清新污染');
 } finally { cleanup(f.dir); }
});

test('新污染使旧lease不能commit，但旧已发生ACK可记旧journal且不改新repair指针', () => {
 const f = fixture();
 try { f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'one' }); const old = begin(f.store); f.store.checkpoint(old, ...steps[0]!);
  f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'two' });
  f.store.checkpoint(old, ...steps[1]!); const next = begin(f.store); assert.equal(f.store.snapshot(bank).repair!.lease.repairId, next.repairId);
  const proof = finish(f.store, old, 'paused'); assert.throws(() => f.store.commitVerifiedRepair(old, proof)); assert.equal(f.store.snapshot(bank).dirty, true);
 } finally { cleanup(f.dir); }
});

test('旧generation未确认mutation跨重启仍阻挡新repair，确认实际ACK后才可换lease', () => {
 for (const at of ['pause-dispatched', 'clear-dispatched', 'refresh-dispatched', 'refresh-pending', 'restore-dispatched', 'blocked'] as const) {
  const f = fixture();
  try { f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'first' }); const lease = begin(f.store);
   if (at === 'blocked') f.store.checkpoint(lease, 'blocked', { blockedReason: 'dispatch-uncertain' });
   else for (const [phase, proof] of steps) { f.store.checkpoint(lease, phase, proof); if (phase === at) break; }
   f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'second' }); const restarted = new DerivedState(f.dir);
   assert.throws(() => begin(restarted), at); assert.deepEqual(restarted.snapshot(bank).unresolvedRepairIds, [lease.repairId]);
   if (at === 'refresh-dispatched') {
    f.store.checkpoint(lease, 'refresh-pending', steps.find(([phase]) => phase === 'refresh-pending')![1]);
    assert.throws(() => begin(restarted));
    f.store.checkpoint(lease, 'restore-dispatched', steps.find(([phase]) => phase === 'restore-dispatched')![1]);
    assert.throws(() => begin(restarted));
    f.store.checkpoint(lease, 'restored', steps.find(([phase]) => phase === 'restored')![1]);
    const next = begin(restarted); assert.notEqual(next.repairId, lease.repairId); assert.equal(restarted.snapshot(bank).dirty, true);
   }
  } finally { cleanup(f.dir); }
 }
});

test('public/unknown或manifest未覆盖不能begin，顺序、hash改绑、布尔clear和不完整证据均拒绝', () => {
 const f = fixture();
 try { f.store.mark(bank, owner); assert.throws(() => begin(f.store));
  const other = fixture(); try { other.store.mark(bank, { ...owner, documents: ['ep-2'], eventKey: 'two' }); assert.throws(() => begin(other.store)); } finally { cleanup(other.dir); }
  const exact = fixture(); try { exact.store.mark(bank, { ...owner, documents: ['ep-1'] }); const lease = begin(exact.store);
   assert.throws(() => exact.store.checkpoint(lease, 'verified', evidence)); assert.throws(() => exact.store.commitVerifiedRepair(lease, true as unknown as FinalEvidence));
   exact.store.checkpoint(lease, ...steps[0]!); assert.throws(() => exact.store.checkpoint(lease, 'paused', { inventoryHash: h('different') }));
   const proof = finish(exact.store, lease, 'pause-dispatched'); assert.throws(() => exact.store.commitVerifiedRepair(lease, { ...proof, finalWatermark: '2026-11-05T12:02:00Z' })); assert.equal(exact.store.snapshot(bank).dirty, true);
  } finally { cleanup(exact.dir); }
 } finally { cleanup(f.dir); }
});

test('精确private v1可凭新证据修复，未知legacy不能因精确新event而缩小', () => {
 for (const unknown of [false, true]) { const f = fixture();
  try { writeFileSync(f.path, JSON.stringify({ version: 1, banks: { [bank]: { generation: '11111111-1111-4111-8111-111111111111', documents: ['ep-1'], owners: [{ ...owner, allDocuments: unknown }] } } }));
   f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'stable-observation' });
   if (unknown) assert.throws(() => begin(f.store)); else { const lease = begin(f.store); f.store.commitVerifiedRepair(lease, finish(f.store, lease)); assert.equal(f.store.snapshot(bank).dirty, false); }
  } finally { cleanup(f.dir); }
 }
});

test('repair发布前IO失败保旧文件，发布后异常精确读回只确认一次', () => {
 const f = fixture(), rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
 try { f.store.mark(bank, { ...owner, documents: ['ep-1'] }); const before = readFileSync(f.path, 'utf8'); fileOps.writeDelaysMs = [0];
  fileOps.renameSync = () => { throw new Error('synthetic unavailable'); }; assert.throws(() => begin(f.store)); assert.equal(readFileSync(f.path, 'utf8'), before);
  fileOps.renameSync = rename; const lease = begin(f.store), proof = finish(f.store, lease);
  fileOps.renameSync = (from, to) => { rename(from, to); throw new Error('after publish'); }; const receipt = f.store.commitVerifiedRepair(lease, proof);
  fileOps.renameSync = rename; assert.deepEqual(f.store.commitVerifiedRepair(lease, proof), receipt); assert.equal(f.store.snapshot(bank).dirty, false);
 } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; cleanup(f.dir); }
});

test('检查点必须先有对应证据，undefined不能擦除并改绑旧证据', () => {
 const f = fixture();
 try { f.store.mark(bank, { ...owner, documents: ['ep-1'] }); const lease = begin(f.store);
  assert.throws(() => f.store.checkpoint(lease, 'pause-dispatched', {}));
  f.store.checkpoint(lease, ...steps[0]!);
  f.store.checkpoint(lease, 'pause-dispatched', { inventoryHash: undefined });
  assert.equal(f.store.snapshot(bank).repair!.evidence.inventoryHash, evidence.inventoryHash);
  assert.throws(() => f.store.checkpoint(lease, 'pause-dispatched', { inventoryHash: h('changed') }));
  assert.throws(() => f.store.checkpoint(lease, 'paused', {}));
  assert.equal(f.store.snapshot(bank).repair!.phase, 'pause-dispatched');
 } finally { cleanup(f.dir); }
});

test('global水位差一微秒也不能commit；模型自身raw水位可早于global且必须明确不陈旧', () => {
 const f = fixture();
 try { f.store.mark(bank, { ...owner, documents: ['ep-1'] }); const lease = begin(f.store);
  const initialWatermark = '2026-11-05T12:00:00.000001Z', finalWatermark = '2026-11-05T12:00:00.000002Z';
  for (const [phase, proof] of steps) f.store.checkpoint(lease, phase, { ...proof,
   ...(phase === 'pause-dispatched' ? { initialWatermark } : {}), ...(phase === 'verified' ? { finalWatermark } : {}) });
  const final = { ...evidence, initialWatermark, finalWatermark, sourceManifestHash: lease.sourceManifestHash,
   progressHash: lease.progressHash, eventSetHash: lease.eventSetHash } as FinalEvidence;
  assert.throws(() => f.store.commitVerifiedRepair(lease, final)); assert.equal(f.store.snapshot(bank).dirty, true);
  assert.throws(() => f.store.commitVerifiedRepair(lease, { ...final, modelIsStale: true } as unknown as FinalEvidence));
 } finally { cleanup(f.dir); }
 const clean = fixture();
 try { clean.store.mark(bank, { ...owner, documents: ['ep-1'] }); const lease = begin(clean.store);
  clean.store.commitVerifiedRepair(lease, finish(clean.store, lease)); assert.equal(clean.store.snapshot(bank).dirty, false);
 } finally { cleanup(clean.dir); }
});

test('公共scope不能以私人candidate修复；篡改已修事件收据不能伪clean且保留原件', () => {
 const f = fixture();
 try { f.store.mark('synthetic-common', { ...owner, documents: ['ep-1'] }); const snapshot = f.store.snapshot('synthetic-common');
  assert.throws(() => f.store.beginRepair('synthetic-common', { expectedGeneration: snapshot.generation, eventSetHash: snapshot.eventSetHash,
   sourceManifestHash: repairSourceManifestHash(sourceManifest), sourceManifest, owner, progressHash: h('progress') }));
  f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'stable' }); const lease = begin(f.store);
  f.store.commitVerifiedRepair(lease, finish(f.store, lease));
  const data = JSON.parse(readFileSync(f.path, 'utf8')); data.banks[bank].events.stable.documents = ['ep-2'];
  const corrupt = JSON.stringify(data); writeFileSync(f.path, corrupt);
  assert.throws(() => new DerivedState(f.dir).snapshot(bank)); assert.equal(readFileSync(f.path, 'utf8'), corrupt);
 } finally { cleanup(f.dir); }
});

test('旧known UUID只凭绑定的completed与fresh静止证据收尾，保留新污染和原派发事实', () => {
 const f = fixture();
 try { f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'first' }); const old = begin(f.store);
  for (const [phase, proof] of steps) { f.store.checkpoint(old, phase, proof); if (phase === 'refresh-pending') break; }
  f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'second' }); const before = f.store.snapshot(bank);
  const settlement = { observedGeneration: before.generation, operationId: evidence.refreshOperationId!, operationType: 'refresh_mental_model' as const,
   modelId: 'relationship' as const, status: 'completed' as const, outcome: 'content_written' as const,
   quiescentWatermark: evidence.initialWatermark!, operations: { pending: 0 as const, processing: 0 as const, failed: 0 as const, cancelled: 0 as const },
   pendingConsolidation: 0 as const, failedConsolidation: 0 as const, modelIdentityHash: evidence.modelIdentityHash!, configurationHash: evidence.safeConfigHash! };
  const journal = f.store.repairJournals(bank)[0]!;
  assert.throws(() => f.store.settleRefresh(old, { ...settlement, operationId: '22345678-1234-4123-8123-123456789012' }));
  assert.throws(() => f.store.settleRefresh(old, { ...settlement, observedGeneration: old.generation }));
  assert.throws(() => f.store.settleRefresh(old, { ...settlement, operations: { ...settlement.operations, pending: 1 } } as never));
  f.store.settleRefresh(old, settlement); const settled = new DerivedState(f.dir);
  assert.equal(settled.snapshot(bank).generation, before.generation); assert.equal(settled.snapshot(bank).dirty, true);
  assert.deepEqual(settled.snapshot(bank).activeEventIds, before.activeEventIds); assert.deepEqual(settled.snapshot(bank).unresolvedRepairIds, []);
  const after = settled.repairJournals(bank)[0]!; assert.equal(after.phase, journal.phase); assert.deepEqual(after.evidence, journal.evidence); assert.deepEqual(after.settlement, settlement);
  const bytes = readFileSync(f.path, 'utf8'); settled.settleRefresh(old, settlement); assert.equal(readFileSync(f.path, 'utf8'), bytes);
  assert.throws(() => settled.settleRefresh(old, { ...settlement, quiescentWatermark: '2026-11-05T12:00:01Z' }));
  after.evidence.refreshOperationId = 'mutated'; assert.equal(settled.repairJournals(bank)[0]!.evidence.refreshOperationId, evidence.refreshOperationId);
  const next = begin(settled); assert.notEqual(next.repairId, old.repairId); assert.throws(() => settled.commitVerifiedRepair(old, finish(settled, old, 'refresh-pending')));
 } finally { cleanup(f.dir); }
});

test('非完成/不成功outcome、错误模型类型/配置、坏水位或不静止不能收尾且不改原件', () => {
 const f = pendingSettlement();
 try { const before = readFileSync(f.path, 'utf8');
  const bad = [{ status: 'failed' }, { status: 'cancelled' }, { status: 'not_found' }, { outcome: 'content_preserved_no_new_facts' },
   { operationType: 'retain' }, { modelId: 'person:other' }, { configurationHash: h('different') }, { modelIdentityHash: h('other') },
   { quiescentWatermark: '2026-02-30T00:00:00Z' }, { pendingConsolidation: 1 }, { failedConsolidation: 1 }, { operations: { pending: 0, processing: 0, failed: 0 } },
   { operations: { pending: 0, processing: 0, failed: 0, cancelled: 0, hidden: 0 } }];
  for (const delta of bad) { assert.throws(() => f.store.settleRefresh(f.lease, { ...f.proof, ...delta } as unknown as RefreshSettlementEvidence)); assert.equal(readFileSync(f.path, 'utf8'), before); }
  assert.throws(() => f.store.settleRefresh(f.lease, true as unknown as RefreshSettlementEvidence));
  assert.throws(() => f.store.settleRefresh({ ...f.lease, bankId: 'other' }, f.proof));
 } finally { cleanup(f.dir); }
});

test('收尾与新撤回CAS竞态失败关闭，未知UUID不能借补造证据解除，已收尾journal不能再派发', () => {
 const f = pendingSettlement();
 try { f.store.mark(bank, { ...owner, documents: ['ep-1'], eventKey: 'third' });
  assert.throws(() => f.store.settleRefresh(f.lease, f.proof)); assert.throws(() => begin(f.store));
  f.store.settleRefresh(f.lease, { ...f.proof, observedGeneration: f.store.snapshot(bank).generation });
  assert.throws(() => f.store.checkpoint(f.lease, 'restore-dispatched', steps.find(([phase]) => phase === 'restore-dispatched')![1]));
  assert.equal(f.store.snapshot(bank).dirty, true);
 } finally { cleanup(f.dir); }
 const unknown = fixture();
 try { unknown.store.mark(bank, { ...owner, documents: ['ep-1'] }); const lease = begin(unknown.store);
  for (const [phase, proof] of steps) { unknown.store.checkpoint(lease, phase, proof); if (phase === 'refresh-dispatched') break; }
  unknown.store.mark(bank, { ...owner, documents: ['ep-1'] });
  assert.throws(() => unknown.store.settleRefresh(lease, { ...f.proof, observedGeneration: unknown.store.snapshot(bank).generation }));
  assert.throws(() => begin(unknown.store));
 } finally { cleanup(unknown.dir); }
});

test('收尾发布前IO失败保屏障，rename后错误精确读回幂等，坏持久settlement拒读不覆盖', () => {
 const f = pendingSettlement(), rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
 try { const before = readFileSync(f.path, 'utf8'); fileOps.writeDelaysMs = [0]; fileOps.renameSync = () => { throw new Error('before publish'); };
  assert.throws(() => f.store.settleRefresh(f.lease, f.proof)); assert.equal(readFileSync(f.path, 'utf8'), before);
  fileOps.renameSync = (from, to) => { rename(from, to); throw new Error('after publish'); };
  f.store.settleRefresh(f.lease, f.proof); fileOps.renameSync = rename;
  const restarted = new DerivedState(f.dir); assert.deepEqual(restarted.snapshot(bank).unresolvedRepairIds, []); restarted.settleRefresh(f.lease, f.proof);
  const data = JSON.parse(readFileSync(f.path, 'utf8')); data.banks[bank].journals[f.lease.repairId].settlement.operationId = '22345678-1234-4123-8123-123456789012';
  const broken = JSON.stringify(data); writeFileSync(f.path, broken); assert.throws(() => restarted.snapshot(bank)); assert.equal(readFileSync(f.path, 'utf8'), broken);
 } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; cleanup(f.dir); }
});

test('同bank任务UUID只能归属一个lease，同lease重投ACK幂等，复用旧UUID保新unknown派发', () => {
 const f = pendingSettlement();
 try { f.store.checkpoint(f.lease, 'refresh-pending', { refreshOperationId: f.proof.operationId });
  f.store.settleRefresh(f.lease, f.proof); const next = begin(f.store);
  for (const [phase, proof] of steps) { f.store.checkpoint(next, phase, proof); if (phase === 'refresh-dispatched') break; }
  const before = readFileSync(f.path, 'utf8');
  assert.throws(() => f.store.checkpoint(next, 'refresh-pending', { refreshOperationId: f.proof.operationId }));
  assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(f.store.snapshot(bank).repair!.phase, 'refresh-dispatched');
  assert.equal(f.store.snapshot(bank).dirty, true);
  const tampered = JSON.parse(before), journal = tampered.banks[bank].journals[next.repairId];
  journal.phase = 'refresh-pending'; journal.evidence.refreshOperationId = f.proof.operationId;
  assert.equal(isDerivedState(tampered), false, '落盘重复任务owner必须拒绝，不能按对象顺序挑旧完成证据');
  const raw = JSON.stringify(tampered); writeFileSync(f.path, raw);
  assert.throws(() => new DerivedState(f.dir).snapshot(bank)); assert.equal(readFileSync(f.path, 'utf8'), raw);
 } finally { cleanup(f.dir); }
});
