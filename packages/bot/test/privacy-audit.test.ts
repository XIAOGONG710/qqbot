import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { auditContactPrivacy } from '../src/privacy-audit.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

test('联系人隐私审计只报位置和数量，并给出私人 bank、公共文档和个人模型的精确目标', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-privacy-'));
    dirs.push(dir);
    for (const sub of ['chats', 'memory', 'logs', 'world']) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, 'chats', '10001.jsonl'), '{"content":"秘密"}\n');
    writeFileSync(join(dir, 'memory', '10001-boyfriend.json'), JSON.stringify({
        bankId: 'linmengyao-private', retained: { ep1: 2 }, common: { ep1: 2 }, personModel: 'v1',
    }));
    writeFileSync(join(dir, 'tiers.json'), JSON.stringify({ 10001: { tier: 'boyfriend' }, 10002: { tier: 'classmate' } }));
    writeFileSync(join(dir, 'tiers.before-test.json'), JSON.stringify({ 10001: { tier: 'known' } }));
    writeFileSync(join(dir, 'logs', '2026-10-13.log'), '[10001] 收到消息\n[10002] 另一人\n');
    writeFileSync(join(dir, 'world', 'actions.json'), JSON.stringify({ actions: [{ contact: 10001 }, { contact: 10002 }] }));
    writeFileSync(join(dir, 'world', 'action-queue.json'), JSON.stringify({ items: [{ target: 'contact:10001' }] }));
    writeFileSync(join(dir, 'world', 'events.json'), JSON.stringify({ version: 1, events: [
        { contact: 10001, target: 'contact:10001' }, { contact: 10002 },
    ] }));
    writeFileSync(join(dir, 'world', 'state.json'), JSON.stringify({ cameraFund: { camera: { gifts: [{ contact: 10001 }] } } }));
    mkdirSync(join(dir, 'stickers'), { recursive: true });
    writeFileSync(join(dir, 'stickers', 'index.json'), JSON.stringify({ entries: [{ source: { kind: 'received', from: 10001 } }] }));
    writeFileSync(join(dir, 'last-prompt.json'), JSON.stringify({ qq: 10001, messages: [{ content: '不要出现在报告' }] }));

    const report = auditContactPrivacy(dir, 10001);
    assert.deepEqual(report.hindsight.banks, ['linmengyao-private']);
    assert.equal(report.hindsight.commonDocuments.length, 1);
    assert.match(report.hindsight.commonDocuments[0]!, /:ep1$/);
    assert.equal(report.hindsight.commonMentalModels[0], `person-${report.hindsight.commonDocuments[0]!.split(':')[0]}`);
    assert.deepEqual(report.artifacts.map(item => [item.path.replaceAll('\\', '/'), item.kind, item.references]), [
        ['chats/10001.jsonl', 'direct', undefined],
        ['last-prompt.json', 'direct', undefined],
        ['logs/2026-10-13.log', 'mixed', 1],
        ['memory/10001-boyfriend.json', 'direct', undefined],
        ['stickers/index.json', 'mixed', 1],
        ['tiers.before-test.json', 'mixed', 1],
        ['tiers.json', 'mixed', 1],
        ['world/action-queue.json', 'mixed', 1],
        ['world/actions.json', 'mixed', 1],
        ['world/events.json', 'mixed', 1],
        ['world/state.json', 'mixed', 1],
    ]);
    assert.doesNotMatch(JSON.stringify(report), /秘密|不要出现在报告/);
});
