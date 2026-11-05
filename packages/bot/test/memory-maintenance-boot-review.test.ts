import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { archiveTestData } from '../src/memory/archive.ts';
import { createForgetJob, saveForgetJob } from '../src/memory/forget-job.ts';
import { acquireLock } from '../src/platform/lock.ts';

const roots: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'qqbot-maintenance-boot-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-maintenance-boot-')); rmSync(dir, { recursive: true, force: true }); } });
function options(dir: string) {
    const config = parseAppConfig({ dataDir: dir, characterCard: join(dir, 'missing-{tier}.json'), llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, contacts: [{ qq: 10001, tier: 'classmate', name: '合成人' }], proactive: 'off' }, dir, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    return { config, transport: { friendHistory: async () => [], sendPrivateText: async () => 1 }, log() {}, sensitive: { on: () => false, describe: () => '' }, pipeline: { generate: async () => '合成回复' } };
}
function job(dir: string) { return createForgetJob(dir, { qq: 10001, move: [], leave: [], hindsight: { banks: [], commonBank: 'synthetic-common', documents: [], mentalModels: [] }, limitations: [] }, join(dir, 'trash'), false); }

test('未完成遗忘任务在任何prompt/世界写入和卡读取前阻止App，并释放启动租约', () => {
    const dir = fixture(); job(dir); writeFileSync(join(dir, 'last-prompt.json'), 'SYNTHETIC_PRIVATE_PROMPT');
    assert.throws(() => startApp(options(dir)), /未完成遗忘任务/);
    assert.equal(readFileSync(join(dir, 'last-prompt.json'), 'utf8'), 'SYNTHETIC_PRIVATE_PROMPT'); assert.equal(existsSync(join(dir, 'world')), false);
    assert.equal(existsSync(join(dir, 'bot.lock')), false); const release = acquireLock(join(dir, 'bot.lock')); release();
});

test('坏维护日志不能猜任务完成，固定安全错误且不显示原私密片段', () => {
    const dir = fixture(), pending = job(dir), path = join(dir, 'maintenance', 'forget-jobs', `${pending.id}.json`);
    writeFileSync(path, 'SYNTHETIC_SECRET_BAD_JOB'); writeFileSync(join(dir, 'last-prompt.json'), 'KEEP');
    assert.throws(() => startApp(options(dir)), error => /遗忘任务读取或校验失败/.test(String(error)) && !String(error).includes('SYNTHETIC_SECRET_BAD_JOB'));
    assert.equal(readFileSync(path, 'utf8'), 'SYNTHETIC_SECRET_BAD_JOB'); assert.equal(readFileSync(join(dir, 'last-prompt.json'), 'utf8'), 'KEEP');
});

test('已完成任务不永久关闭App；后续正常构造失败也收回租约', () => {
    const dir = fixture(), pending = job(dir); pending.complete = true; saveForgetJob(dir, pending);
    assert.throws(() => startApp(options(dir)), error => !/遗忘任务/.test(String(error)));
    assert.equal(existsSync(join(dir, 'bot.lock')), false); const release = acquireLock(join(dir, 'bot.lock')); release();
});

test('归档不绕未完成遗忘任务换档/换bank，拒绝后仍保文件和任务原件', () => {
    const dir = fixture(), pending = job(dir), path = join(dir, 'maintenance', 'forget-jobs', `${pending.id}.json`), before = readFileSync(path, 'utf8');
    writeFileSync(join(dir, 'tiers.json'), '{}');
    assert.throws(() => archiveTestData({ dataDir: dir, configFiles: [] }), /未完成遗忘任务/);
    assert.equal(readFileSync(path, 'utf8'), before); assert.equal(readFileSync(join(dir, 'tiers.json'), 'utf8'), '{}');
    assert.equal(existsSync(join(dir, 'bot.lock')), false);
});
