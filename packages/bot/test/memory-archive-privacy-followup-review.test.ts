import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { archiveTestData } from '../src/memory/archive.ts';
import { loadArchiveJob, unfinishedArchiveJobs } from '../src/memory/archive-job.ts';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';
import { exportContact, forgetContact, planForget } from '../src/memory/privacy-forget.ts';

const secret = 'SYNTHETIC_ARCHIVE_PRIVATE_CONFIG';
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-archive-privacy-followup-')), data = join(root, 'data'), config = join(root, 'config.json');
    mkdirSync(join(data, 'chats'), { recursive: true }); writeFileSync(join(data, 'tiers.json'), JSON.stringify({ '10001': 'classmate' }));
    writeFileSync(join(data, 'chats', '10001.jsonl'), JSON.stringify({ role: 'user', content: 'SYNTHETIC_ARCHIVE_CHAT', time: '2026-11-04T12:00:00Z' }) + '\n');
    writeFileSync(config, JSON.stringify({ memory: { bankPrefix: 'synthetic-old' }, llm: { apiKey: secret } }));
    return { root, data, config };
}
function clean(root: string) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-archive-privacy-followup-')); rmSync(root, { recursive: true, force: true }); }
function interrupt(f: ReturnType<typeof fixture>) {
    const original = fs.renameSync;
    try {
        fs.renameSync = (from, to) => { if (String(to) === f.config) throw new Error(secret); return original(from, to); }; syncBuiltinESMExports();
        assert.throws(() => archiveTestData({ dataDir: f.data, configFiles: [f.config], prefix: 'synthetic-new', now: new Date('2026-11-05T12:00:00Z') }), error => !String(error).includes(secret));
    } finally { fs.renameSync = original; syncBuiltinESMExports(); }
    const ids = unfinishedArchiveJobs(f.data); assert.equal(ids.length, 1);
    const job = loadArchiveJob(f.data, ids[0]!);
    const index = job.steps.findIndex(step => step.target === f.config), temp = `${f.config}.archive-${job.id}-${index}.tmp`;
    assert.ok(existsSync(temp)); return { job, temp };
}

test('归档恢复配置正文与实际step临时文件列mixed，不向单联系人导出或移动共享密钥', () => {
    const f = fixture();
    try { const { job, temp } = interrupt(f), audit = auditContactPrivacy(f.data, 10001);
        const path = join('maintenance', 'archive-jobs', `${job.id}.json`), journal = audit.artifacts.find(item => item.path === path), residue = audit.artifacts.find(item => resolve(f.data, item.path) === temp);
        assert.equal(journal?.kind, 'mixed'); assert.equal(residue?.kind, 'mixed'); assert.ok(!JSON.stringify(audit).includes(secret));
        const plan = planForget(audit, 'synthetic-common'); assert.ok(!plan.move.includes(path)); assert.ok(plan.leave.some(item => item.path === path));
        const result = exportContact(f.data, 10001, join(f.root, 'exports'));
        assert.ok(!existsSync(join(result.dir, path))); assert.ok(!readFileSync(join(result.dir, 'audit.json'), 'utf8').includes(secret));
    } finally { clean(f.root); }
});

test('孤立坏归档journal临时正文也作为未知mixed报告，不猜联系人归属或泄漏内容', () => {
    const f = fixture(), dir = join(f.data, 'maintenance', 'archive-jobs');
    try { mkdirSync(dir, { recursive: true }); const name = '11111111-1111-4111-8111-111111111111.json.tmp-123-1'; writeFileSync(join(dir, name), secret);
        const audit = auditContactPrivacy(f.data, 10001); assert.equal(audit.artifacts.find(item => item.path.endsWith(name))?.kind, 'mixed');
        assert.ok(audit.limitations.some(line => /归档/.test(line))); assert.ok(!JSON.stringify(audit).includes(secret));
    } finally { clean(f.root); }
});

test('遗忘不能抢先移动未完成归档计划的已移动目标或开始远端删除', async () => {
    const f = fixture(); let requests = 0;
    try { const { job } = interrupt(f), archivedChat = job.steps.find(step => step.kind === 'move' && step.source.endsWith('10001.jsonl'))!.target;
        const bytes = readFileSync(archivedChat, 'utf8');
        await assert.rejects(forgetContact(f.data, 10001, { apply: true, trashDir: join(f.root, 'trash'), commonBank: 'synthetic-common', api: {
            deleteBank: async () => { requests++; }, deleteDocument: async () => { requests++; }, deleteMentalModel: async () => { requests++; },
        } }), /归档/);
        assert.equal(requests, 0); assert.equal(readFileSync(archivedChat, 'utf8'), bytes); assert.deepEqual(unfinishedArchiveJobs(f.data), [job.id]);
    } finally { clean(f.root); }
});
