import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';
import { exportContact, forgetContact } from '../src/memory/privacy-forget.ts';
import { archiveTestData } from '../src/memory/archive.ts';
import { createArchive, Dormancy, verifyArchive } from '../src/memory/dormancy.ts';
import { fileOps } from '../src/memory/json-file.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-privacy-review-')); rmSync(root, { recursive: true, force: true }); } });
const now = new Date('2026-11-05T12:00:00Z');
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-privacy-review-')); roots.push(root);
    const data = join(root, 'bot'); mkdirSync(join(data, 'chats'), { recursive: true });
    writeFileSync(join(data, 'chats', '10001.jsonl'), '合成第一版');
    return { root, data, state: join(data, 'dormancy.json'), dormancy: new Dormancy({ dataDir: data, repoRoot: root, now: () => now }) };
}

test('休眠状态损坏不能自动醒来、隔离或泄漏原文', () => {
    for (const raw of ['{"state":"dormant", "private":"SYNTHETIC_PRIVATE', JSON.stringify({ state: 'dormant', since: 'invalid', archive: 3 })]) {
        const f = fixture(); writeFileSync(f.state, raw);
        assert.throws(() => f.dormancy.state(), error => error instanceof Error && !error.message.includes('SYNTHETIC_PRIVATE'));
        assert.equal(readFileSync(f.state, 'utf8'), raw);
    }
});

test('旧提议异步留言不能在取消或确认之后重新开启休眠提议', () => {
    const f = fixture();
    const token = f.dormancy.propose('合成原因', undefined);
    f.dormancy.cancel();
    const update = f.dormancy as unknown as { updateProposal(token: unknown, note: string): boolean };
    assert.equal(typeof update.updateProposal, 'function');
    assert.equal(update.updateProposal(token, '合成晚回应'), false);
    assert.equal(f.dormancy.state().state, 'awake');
    const next = f.dormancy.propose('合成新原因', undefined);
    assert.notEqual(token, next);
    assert.equal(update.updateProposal(token, '被替换的晚回应'), false);
    assert.equal(update.updateProposal(next, '合成新留言'), true);
    assert.equal(f.dormancy.confirm().ok, true);
    assert.equal(update.updateProposal(next, '合成晚回应'), false);
    assert.equal(f.dormancy.state().state, 'dormant');
});

test('休眠写入失败保持原状态，已经原子发布却报EIO时承认实际发布结果', () => {
    const f = fixture(); const first = f.dormancy.propose('合成原因', undefined);
    const rename = fileOps.renameSync; const delays = fileOps.writeDelaysMs; fileOps.writeDelaysMs = [0];
    try {
        fileOps.renameSync = ((from, to) => { if (String(to) === f.state) throw Object.assign(new Error('SYNTHETIC_PRIVATE_IO'), { code: 'EIO' }); return rename(from, to); }) as typeof rename;
        assert.throws(() => f.dormancy.propose('合成第二次', undefined), error => error instanceof Error && !error.message.includes('SYNTHETIC_PRIVATE_IO'));
        assert.equal((f.dormancy.state() as { token?: string }).token, first);
        fileOps.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === f.state) throw Object.assign(new Error('SYNTHETIC_PRIVATE_IO'), { code: 'EIO' }); return result; }) as typeof rename;
        const published = f.dormancy.propose('合成已发布', undefined);
        assert.notEqual(published, first); assert.equal((f.dormancy.state() as { token?: string }).token, published);
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
});

test('坏清单安全返回核对问题，仍按约定能醒来', () => {
    for (const manifest of [null, { files: null }, { files: { '../outside.txt': { sha256: '0'.repeat(64) } } }]) {
        const f = fixture(); f.dormancy.propose(undefined, undefined); const archived = f.dormancy.confirm(); assert.equal(archived.ok, true);
        if (!archived.ok) continue;
        writeFileSync(join(archived.archive.dir, 'manifest.json'), JSON.stringify(manifest));
        assert.equal(verifyArchive(archived.archive.dir).ok, false);
        const woke = f.dormancy.wake(); assert.equal(woke.ok && woke.check.ok, false); assert.equal(f.dormancy.state().state, 'awake');
    }
});

test('嵌套manifest.json也是状态事实，必须纳入哈希清单', () => {
    const f = fixture(); mkdirSync(join(f.data, 'memory')); writeFileSync(join(f.data, 'memory', 'manifest.json'), '{}');
    const archived = createArchive({ repoRoot: f.root, dataDir: f.data, archiveRoot: join(f.root, 'archives'), now });
    assert.equal(verifyArchive(archived.dir).ok, true);
    writeFileSync(join(archived.dir, 'bot', 'memory', 'manifest.json'), '被合成修改');
    assert.equal(verifyArchive(archived.dir).ok, false);
});

test('真的复制确认后的封存bot内容恢复，新休眠实例可按说明唤醒', () => {
    const f = fixture(); f.dormancy.propose('合成原因', '合成留言');
    const done = f.dormancy.confirm(); assert.equal(done.ok, true); if (!done.ok) return;
    const restored = join(f.root, 'restored-bot'); cpSync(join(done.archive.dir, 'bot'), restored, { recursive: true });
    const dormancy = new Dormancy({ dataDir: restored, repoRoot: f.root, now: () => now });
    assert.equal(dormancy.state().state, 'dormant');
    const result = dormancy.wake(); assert.equal(result.ok && result.check.ok, true);
    assert.equal(dormancy.state().state, 'awake');
});

test('归档在任何移动前拒绝源链接与坏配置，不读出路径外资料', () => {
    const f = fixture(); const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, '10001.json'), '{}');
    symlinkSync(outside, join(f.data, 'memory'), 'junction');
    assert.throws(() => archiveTestData({ dataDir: f.data, configFiles: [], now, prefix: 'demo', isAlive: () => false }), /链接|范围/);
    assert.ok(existsSync(join(outside, '10001.json')));
    rmSync(join(f.data, 'memory'));
    const config = join(f.root, 'config.json'); writeFileSync(config, '{"memory":"SYNTHETIC_PRIVATE');
    assert.throws(() => archiveTestData({ dataDir: f.data, configFiles: [config], now, isAlive: () => false }), error => error instanceof Error && !error.message.includes('SYNTHETIC_PRIVATE'));
    assert.ok(existsSync(join(f.data, 'chats', '10001.jsonl')));
});

test('同秒导出和遗忘各自创建独立回收批次，不覆盖上一份恢复数据', async () => {
    const f = fixture(); const first = exportContact(f.data, 10001, join(f.root, 'export'), now);
    writeFileSync(join(f.data, 'chats', '10001.jsonl'), '合成第二版');
    const second = exportContact(f.data, 10001, join(f.root, 'export'), now);
    assert.notEqual(first.dir, second.dir); assert.equal(readFileSync(join(first.dir, 'chats', '10001.jsonl'), 'utf8'), '合成第一版');
    const options = { apply: true, trashDir: join(f.root, 'trash'), commonBank: 'demo-common', now, isAlive: () => false };
    const a = await forgetContact(f.data, 10001, options);
    writeFileSync(join(f.data, 'chats', '10001.jsonl'), '合成第三版');
    const b = await forgetContact(f.data, 10001, options);
    assert.notEqual(a.trash, b.trash); assert.equal(readFileSync(join(a.trash!, 'chats', '10001.jsonl'), 'utf8'), '合成第二版');
});

test('审计拒绝根内链接跳出数据根；坏记忆JSON不会移动后丢失远端删除目标', async () => {
    const f = fixture(); const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, '10001.json'), '{"bankId":"synthetic-outside"}');
    symlinkSync(outside, join(f.data, 'memory'), 'junction');
    assert.throws(() => auditContactPrivacy(f.data, 10001), /链接|范围/);
    // 所有链接目标均在本次合成temp根内；只移除此链接，不递归删除目标。
    rmSync(join(f.data, 'memory')); mkdirSync(join(f.data, 'memory'));
    writeFileSync(join(f.data, 'memory', '10001-boyfriend.json'), '{"bankId":"SYNTHETIC_PRIVATE');
    await assert.rejects(() => forgetContact(f.data, 10001, { apply: true, trashDir: join(f.root, 'trash'), commonBank: 'demo-common' }), error => error instanceof Error && !error.message.includes('SYNTHETIC_PRIVATE'));
    assert.ok(existsSync(join(f.data, 'memory', '10001-boyfriend.json')));
});

test('归档重复运行不覆盖tiers恢复快照，坏档位路径在任何移动前拒绝', () => {
    const f = fixture(); const tiers = join(f.data, 'tiers.json'); writeFileSync(tiers, JSON.stringify({ 10001: 'boyfriend' }));
    const options = { dataDir: f.data, configFiles: [], now, prefix: 'demo-new', isAlive: () => false };
    const a = archiveTestData(options); writeFileSync(join(f.data, 'chats', '10001.jsonl'), '合成第二版');
    const b = archiveTestData(options);
    assert.notEqual(a.tiersBackup, b.tiersBackup); assert.equal(JSON.parse(readFileSync(a.tiersBackup!, 'utf8'))['10001'], 'boyfriend');
    writeFileSync(tiers, JSON.stringify({ 10001: '../../../../outside' })); writeFileSync(join(f.data, 'chats', '10001.jsonl'), '合成不应移动');
    assert.throws(() => archiveTestData(options), /档位/); assert.ok(existsSync(join(f.data, 'chats', '10001.jsonl')));
});

test('历史归档前缀对应的公共文档和模型也按可证明的库归属删除，旧未知归属明确列未解决', async () => {
    const f = fixture(); const owner = createHash('sha256').update('qqbot:10001-boyfriend').digest('hex').slice(0, 16);
    for (const [dir, prefix] of [['memory', 'new'], ['memory/archive-old', 'old']]) {
        mkdirSync(join(f.data, dir!), { recursive: true });
        writeFileSync(join(f.data, dir!, '10001-boyfriend.json'), JSON.stringify({ bankId: `${prefix}-${owner}`, common: { 'ep-1': 1 }, personModel: 'v1' }));
    }
    const calls: string[] = [];
    await forgetContact(f.data, 10001, { apply: true, trashDir: join(f.root, 'trash'), commonBank: 'new-common', now, api: {
        deleteBank: async bank => { calls.push(`bank:${bank}`); },
        deleteDocument: async (bank, id) => { calls.push(`doc:${bank}:${id}`); },
        deleteMentalModel: async (bank, id) => { calls.push(`model:${bank}:${id}`); },
    } });
    assert.ok(calls.includes(`doc:old-common:${owner}:ep-1`));
    assert.ok(calls.includes(`model:old-common:person-${owner}`));
    assert.ok(calls.includes(`doc:new-common:${owner}:ep-1`));
    writeFileSync(join(f.data, 'memory', '10001-boyfriend.json'), JSON.stringify({ bankId: 'legacy-private', common: { 'ep-1': 1 } }));
    assert.ok(auditContactPrivacy(f.data, 10001).limitations.some(note => /未解决|无法核实/.test(note)));
});
