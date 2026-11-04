import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-privacy-inventory-')); rmSync(root, { recursive: true, force: true }); } });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'qqbot-privacy-inventory-')); roots.push(root); return root; }
function jsonl(root: string, file: string, rows: unknown[]) { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); return path; }
const feedback = (contact?: number) => ({ at: '2026-11-05T12:00:00Z', label: 'fake', messageId: 1, herMessageId: 2, tier: 'boyfriend', her: ['SYNTHETIC_PRIVATE_HER'], context: [{ role: 'user', text: 'SYNTHETIC_PRIVATE_CONTEXT' }], ...(contact === undefined ? {} : { contact }) });
const find = (root: string, path: string) => auditContactPrivacy(root, 10001).artifacts.find(item => item.path.replaceAll('\\', '/') === path);

test('反馈月文件按明确contact计数并列为混合，不输出原文或归为单人专属', () => {
    const root = fixture(); const path = jsonl(root, 'feedback/2026-11.jsonl', [feedback(10001), feedback(10002), feedback(10001), feedback()]);
    const before = readFileSync(path, 'utf8'); const artifact = find(root, 'feedback/2026-11.jsonl');
    assert.equal(artifact?.kind, 'mixed'); assert.equal(artifact.references, 2);
    assert.doesNotMatch(JSON.stringify(auditContactPrivacy(root, 10001)), /SYNTHETIC_PRIVATE/);
    assert.equal(readFileSync(path, 'utf8'), before);
});

test('无来源旧反馈不猜联系人，坏行不伪造归属且明确审计局限', () => {
    const root = fixture(); const path = jsonl(root, 'feedback/2026-11.jsonl', [feedback(), feedback(10002)]);
    writeFileSync(path, readFileSync(path, 'utf8') + '{"contact":10001,"private":"SYNTHETIC_PRIVATE');
    const report = auditContactPrivacy(root, 10001);
    assert.equal(report.artifacts.length, 0);
    assert.ok(report.limitations.some(note => /反馈/.test(note) && /无来源|坏行|无法归属/.test(note)));
    assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_PRIVATE/);
});

test('合法JSON但不符合反馈schema的行同样计入未能归属限制', () => {
    const root = fixture(); jsonl(root, 'feedback/2026-11.jsonl', [{ ...feedback(10001), her: 42 }]);
    const report = auditContactPrivacy(root, 10001);
    assert.equal(report.artifacts.length, 0);
    assert.ok(report.limitations.some(note => /1 条坏行或无效记录/.test(note)));
});

test('按QQ键的亲热状态和明确uin的空间缓存列为混合，别人的状态不冒认', () => {
    const root = fixture(); writeFileSync(join(root, 'intimacy.json'), JSON.stringify({ 10001: { remaining: 3, armedAt: '2026-11-05T12:00:00Z' }, 10002: { remaining: 1 } }));
    mkdirSync(join(root, 'presence')); writeFileSync(join(root, 'presence', 'presence.json'), JSON.stringify({ version: 1, peek: { uin: 10001, note: 'SYNTHETIC_PRIVATE' } }));
    assert.equal(find(root, 'intimacy.json')?.kind, 'mixed'); assert.equal(find(root, 'presence/presence.json')?.references, 1);
    writeFileSync(join(root, 'presence', 'presence.json'), JSON.stringify({ version: 1, peek: { uin: 10002, note: '10001' } }));
    assert.equal(find(root, 'presence/presence.json'), undefined);
});

test('账号审计区分好友QQ与同号群，仅好友动作归属联系人', () => {
    const root = fixture(); jsonl(root, 'account-audit.jsonl', [
        { action: 'send_like', target: 10001, allowed: true },
        { action: 'set_group_leave', target: 10001, allowed: true },
        { action: 'send_like', target: 10002, allowed: true },
    ]);
    assert.equal(find(root, 'account-audit.jsonl')?.references, 1);
    assert.equal(find(root, 'account-audit.jsonl')?.kind, 'mixed');
});

test('记忆账本按标准bank文档模型和forget哈希关联，保留共享链不逐行删', () => {
    const root = fixture();
    const owner = createHash('sha256').update('qqbot:10001-boyfriend').digest('hex').slice(0, 16);
    const contact = createHash('sha256').update('10001').digest('hex').slice(0, 12);
    jsonl(root, 'identity/memory.jsonl', [
        { kind: 'retain', data: { bank: `demo-${owner}`, document: 'ep-1' } },
        { kind: 'retain', data: { bank: 'demo-common', document: `${owner}:ep-1` } },
        { kind: 'model-create', data: { bank: 'demo-common', model: `person-${owner}` } },
        { kind: 'forget', data: { contact } },
        { kind: 'note', data: { by: '10001', text: 'SYNTHETIC_PRIVATE' } },
        { kind: 'retain', data: { bank: `explanation ${owner}` } },
    ]);
    writeFileSync(join(root, 'identity', 'memory.jsonl.head'), 'synthetic-checkpoint');
    assert.equal(find(root, 'identity/memory.jsonl')?.references, 4);
    assert.equal(find(root, 'identity/memory.jsonl')?.kind, 'mixed');
    assert.equal(find(root, 'identity/memory.jsonl.head')?.kind, 'mixed');
    assert.doesNotMatch(JSON.stringify(auditContactPrivacy(root, 10001)), /SYNTHETIC_PRIVATE/);
});
