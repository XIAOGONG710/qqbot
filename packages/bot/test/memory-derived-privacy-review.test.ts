import assert from 'node:assert/strict';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { DerivedState } from '../src/memory/derived-state.ts';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';
import { exportContact, forgetContact } from '../src/memory/privacy-forget.ts';
import { archiveTestData } from '../src/memory/archive.ts';
import { fileOps, writeJsonAtomic } from '../src/memory/json-file.ts';

const roots: string[] = [], QQ = 10001, OTHER = 100010;
afterEach(() => { for (const dir of roots.splice(0)) { const target = resolve(dir); assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('qqbot-derived-privacy-')); rmSync(target, { recursive: true, force: true }); } });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-derived-privacy-')); roots.push(root);
    const data = join(root, 'data'), memory = join(data, 'memory'); mkdirSync(memory, { recursive: true });
    const store = new DerivedState(memory);
    store.mark('old-common', { qq: QQ, tier: 'boyfriend', documents: ['synthetic-episode-1'] });
    store.mark('old-common', { qq: OTHER, tier: 'classmate', documents: ['synthetic-episode-2'] });
    store.mark('old-private', { qq: QQ, tier: 'boyfriend' });
    return { root, data, memory, store, path: join(memory, 'derived.json'), coordination: join(memory, 'index.coordination.sqlite') };
}
const normalized = (path: string) => path.replaceAll('\\', '/');

test('共享derived清单只按owner.qq归属，不猜bank/doc/扩展内号码；JSON与见证均mixed且审计只读', () => {
    const f = fixture();
    const raw = JSON.parse(readFileSync(f.path, 'utf8'));
    raw.extension = { qq: 99999, private: 'SYNTHETIC_PRIVATE_EXTENSION' };
    raw.banks['old-common'].documents.push('looks-like-99999');
    writeFileSync(f.path, JSON.stringify(raw));
    const before = readFileSync(f.path), lockBefore = readFileSync(f.coordination);
    const own = auditContactPrivacy(f.data, QQ).artifacts.filter(item => normalized(item.path).startsWith('memory/'));
    assert.deepEqual(own.map(item => [normalized(item.path), item.kind]), [['memory/derived.json', 'mixed'], ['memory/index.coordination.sqlite', 'mixed']]);
    assert.equal(own[0]!.references, 2);
    assert.equal(auditContactPrivacy(f.data, OTHER).artifacts.find(item => normalized(item.path) === 'memory/derived.json')?.references, 1);
    assert.equal(auditContactPrivacy(f.data, 99999).artifacts.some(item => normalized(item.path) === 'memory/derived.json'), false);
    assert.doesNotMatch(JSON.stringify(auditContactPrivacy(f.data, QQ)), /SYNTHETIC_PRIVATE_EXTENSION/);
    assert.deepEqual(readFileSync(f.path), before); assert.deepEqual(readFileSync(f.coordination), lockBefore);
});

test('导出附可归属审计而不复制其他联系人共享store；forget留共享JSON/coord且旧守卫仍dirty', async () => {
    const f = fixture(); const before = readFileSync(f.path), lockBefore = readFileSync(f.coordination);
    const exported = exportContact(f.data, QQ, join(f.root, 'exports'));
    assert.equal(exported.files.includes('memory/derived.json'), false);
    assert.ok(exported.audit.artifacts.some(item => normalized(item.path) === 'memory/derived.json' && item.kind === 'mixed'));
    const result = await forgetContact(f.data, QQ, { apply: true, trashDir: join(f.root, 'trash'), commonBank: 'new-common', isAlive: () => false });
    assert.ok(result.plan.leave.some(item => normalized(item.path) === 'memory/derived.json'));
    assert.ok(result.plan.leave.some(item => normalized(item.path) === 'memory/index.coordination.sqlite'));
    assert.deepEqual(readFileSync(f.path), before); assert.deepEqual(readFileSync(f.coordination), lockBefore);
    assert.equal(new DerivedState(f.memory).snapshot('old-common').dirty, true);
});

test('坏JSON或无明确owner的坏形状不静默漏清单，安全失败且不改原件', () => {
    const f = fixture();
    for (const raw of ['{"SYNTHETIC_PRIVATE_BROKEN', JSON.stringify({ version: 1, banks: { x: { owners: ['SYNTHETIC_PRIVATE_OWNER'] } } })]) {
        writeFileSync(f.path, raw);
        assert.throws(() => auditContactPrivacy(f.data, QQ), error => !String(error).includes('SYNTHETIC_PRIVATE'));
        assert.equal(readFileSync(f.path, 'utf8'), raw);
    }
});

test('归档保留集中全bank守卫和见证：新prefix可用、切回旧bank仍block并明确报告未搬文件', () => {
    const f = fixture(), before = readFileSync(f.path);
    const config = join(f.root, 'config.json'); writeFileSync(config, JSON.stringify({ memory: { enabled: true, bankPrefix: 'old' } }));
    writeFileSync(join(f.memory, '10001-boyfriend.json'), '{}');
    const result = archiveTestData({ dataDir: f.data, configFiles: [config], prefix: 'new', now: new Date('2026-11-05T12:00:00Z'), isAlive: () => false });
    assert.equal(existsSync(f.path), true, '不能只移JSON留下coord见证而使新bank也失败关闭');
    assert.deepEqual(readFileSync(f.path), before); assert.equal(existsSync(f.coordination), true);
    assert.ok(result.skipped.some(item => item.file === f.path && /共享|屏障|守卫/.test(item.reason)));
    assert.ok(result.moves.some(item => item.from === join(f.memory, '10001-boyfriend.json')));
    assert.equal(JSON.parse(readFileSync(config, 'utf8')).memory.bankPrefix, 'new');
    const restarted = new DerivedState(f.memory);
    assert.equal(restarted.snapshot('new-common').dirty, false);
    assert.equal(restarted.snapshot('old-common').dirty, true);
    assert.equal(restarted.snapshot('old-private').dirty, true);
});

test('真实rename及清理失败留下的derived临时文件按owner列mixed，导出可审计且forget留原字节', async () => {
    const f = fixture(); const before = readFileSync(f.path);
    const rename = fileOps.renameSync, unlink = fileOps.unlinkSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0];
        fileOps.renameSync = ((from, to) => { if (String(to) === f.path) throw Object.assign(new Error('SYNTHETIC_PRIVATE_RENAME'), { code: 'EIO' }); return rename(from, to); }) as typeof rename;
        fileOps.unlinkSync = (path => { if (String(path).startsWith(f.path + '.tmp-')) throw Object.assign(new Error('SYNTHETIC_PRIVATE_UNLINK'), { code: 'EACCES' }); return unlink(path); }) as typeof unlink;
        assert.throws(() => writeJsonAtomic(f.path, JSON.parse(before.toString())));
    } finally { fileOps.renameSync = rename; fileOps.unlinkSync = unlink; fileOps.writeDelaysMs = delays; }
    const residue = readdirSync(f.memory).find(name => /^derived\.json\.tmp-\d+-\d+$/.test(name)); assert.ok(residue);
    const temporary = join(f.memory, residue), bytes = readFileSync(temporary);
    for (const name of ['derived.json.tmp-bad-1', 'derived.json.tmp-12-3.bak', 'derived.json.corrupt-123', 'derived-notes.json']) writeFileSync(join(f.memory, name), '{}');
    const audit = auditContactPrivacy(f.data, QQ), path = normalized(join('memory', residue));
    assert.ok(audit.artifacts.some(item => normalized(item.path) === path && item.kind === 'mixed' && item.references === 2));
    assert.equal(audit.artifacts.some(item => /tmp-bad|\.bak$|corrupt-123|derived-notes/.test(item.path)), false);
    const exported = exportContact(f.data, QQ, join(f.root, 'exports'));
    assert.ok(exported.audit.artifacts.some(item => normalized(item.path) === path)); assert.equal(exported.files.some(file => normalized(file) === path), false);
    const forgotten = await forgetContact(f.data, QQ, { apply: true, trashDir: join(f.root, 'trash'), commonBank: 'new-common', isAlive: () => false });
    assert.ok(forgotten.plan.leave.some(item => normalized(item.path) === path));
    assert.deepEqual(readFileSync(temporary), bytes); assert.deepEqual(readFileSync(f.path), before);
});

test('半行和坏schema的精确derived临时文件报告共享归属未知，不能按正文号码猜QQ或清理', () => {
    const f = fixture(); const path = join(f.memory, 'derived.json.tmp-123-456'), badShape = join(f.memory, 'derived.json.tmp-123-457');
    const raw = '{"private":"SYNTHETIC_PRIVATE_PARTIAL","qq":10001';
    writeFileSync(path, raw); writeFileSync(badShape, JSON.stringify({ version: 1, banks: { bad: { owners: [{ qq: QQ }] } } }));
    const audit = auditContactPrivacy(f.data, QQ);
    assert.ok(audit.limitations.some(text => /派生.*临时.*2.*归属.*未.*确认|派生.*临时.*2.*无法归属/.test(text)));
    assert.equal(audit.artifacts.some(item => /derived\.json\.tmp-123-45[67]$/.test(item.path)), false);
    assert.doesNotMatch(JSON.stringify(audit), /SYNTHETIC_PRIVATE_PARTIAL/);
    assert.equal(readFileSync(path, 'utf8'), raw); assert.equal(existsSync(badShape), true);
});
