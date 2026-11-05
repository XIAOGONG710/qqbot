import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';
import { exportContact, planForget } from '../src/memory/privacy-forget.ts';
import { createForgetJob } from '../src/memory/forget-job.ts';
import { acquireLock } from '../src/platform/lock.ts';
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-maintenance-privacy-')); rmSync(dir, { recursive: true, force: true }); } });
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'qqbot-maintenance-privacy-')); roots.push(dir); return dir; }
function job(dir: string, qq: number) { return createForgetJob(dir, { qq, move: [], leave: [], hindsight: { banks: [], commonBank: 'synthetic-common', documents: [], mentalModels: [] }, limitations: [] }, join(dir, 'trash'), false); }

test('维护日志及实际tmp按可信plan.qq入mixed清单，不混另一联系人或移走活任务', () => {
    const dir = fixture(), a = job(dir, 10001), b = job(dir, 10002), path = join(dir, 'maintenance', 'forget-jobs', `${a.id}.json`);
    const release = acquireLock(join(dir, 'bot.lock')); release();
    const bytes = readFileSync(path, 'utf8'), tmp = `${path}.tmp-123-1`; writeFileSync(tmp, bytes);
    const audit = auditContactPrivacy(dir, 10001), own = audit.artifacts.filter(item => item.path.includes(a.id));
    assert.equal(own.length, 2); assert.ok(own.every(item => item.kind === 'mixed'));
    assert.ok(!audit.artifacts.some(item => item.path.includes(b.id))); assert.ok(audit.artifacts.some(item => item.path === 'bot.coordination.sqlite'));
    assert.ok(planForget(audit, 'synthetic-common').move.every(path => !path.includes(a.id)));
    const exported = exportContact(dir, 10001, join(dir, 'exports')); assert.ok(!exported.files.some(path => path.includes(a.id)));
    assert.equal(existsSync(join(exported.dir, 'maintenance')), false); assert.equal(readFileSync(path, 'utf8'), bytes);
});

test('无效或半行维护tmp只报告归属未知，不因伪plan.qq猜归属或回显正文', () => {
    const dir = fixture(), a = job(dir, 10001), path = join(dir, 'maintenance', 'forget-jobs', `${a.id}.json`), raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.plan.qq = 10002; writeFileSync(`${path}.tmp-123-2`, JSON.stringify(raw)); writeFileSync(`${path}.tmp-123-3`, 'SYNTHETIC_PRIVATE_BAD_JOB');
    const audit = auditContactPrivacy(dir, 10002);
    assert.ok(!audit.artifacts.some(item => item.path.includes(a.id))); assert.ok(audit.limitations.some(line => /遗忘维护目录有 2/.test(line)));
    assert.ok(!JSON.stringify(audit).includes('SYNTHETIC_PRIVATE_BAD_JOB'));
});
