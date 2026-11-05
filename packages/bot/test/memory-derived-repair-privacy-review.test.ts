import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { auditedApi, memoryLedger } from '../src/memory/memory-audit.ts';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';
import { exportContact, forgetContact } from '../src/memory/privacy-forget.ts';
import type { HindsightApi } from '../src/memory/hindsight.ts';

const roots: string[] = [], qq = 10001, other = 100010, secret = 'SYNTHETIC_PRIVATE_REPAIR_CONTENT';
afterEach(() => { for (const dir of roots.splice(0)) { const target = resolve(dir); assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('qqbot-repair-privacy-')); rmSync(target, { recursive: true, force: true }); } });
const owner = (qq: number) => createHash('sha256').update(`qqbot:${qq}-boyfriend`).digest('hex').slice(0, 16);
function fixture() {
    const data = mkdtempSync(join(tmpdir(), 'qqbot-repair-privacy-')); roots.push(data); const ledger = memoryLedger(data);
    const raw = { repairConfigureModel: async () => ({ content: secret }), repairClearModel: async () => ({ content: '' }),
        repairRefreshModel: async () => '11111111-1111-4111-8111-111111111111', repairRestoreAutomatic: async () => ({ content: secret }) } as unknown as HindsightApi;
    return { data, ledger, api: auditedApi(raw, ledger) };
}
async function writes(api: HindsightApi, bank: string, model: string) {
    await api.repairConfigureModel!(bank, model); await api.repairClearModel!(bank, model);
    await api.repairRefreshModel!(bank, model); await api.repairRestoreAutomatic!(bank, model, 1800, false);
}
const normalized = (path: string) => path.replaceAll('\\', '/');

test('四repair kind按标准private bank或公共person模型归属，不猜正文/文档/同号前缀', async () => {
    const f = fixture();
    await writes(f.api, `old-${owner(qq)}`, 'relationship'); await writes(f.api, 'old-common', `person-${owner(qq)}`);
    await writes(f.api, `old-${owner(other)}`, 'relationship'); await writes(f.api, 'old-common', `person-${owner(other)}`);
    await writes(f.api, `not a standard bank ${owner(qq)}`, 'relationship'); await writes(f.api, 'external-bank', `person-${owner(qq)}`);
    f.ledger.append('model-repair-clear', { bank: 'external-bank', model: 'unrelated', document: `${owner(qq)}:ep-1`, note: secret });
    f.ledger.append('model-repair-unknown', { bank: `old-${owner(qq)}`, model: 'relationship' });
    const report = auditContactPrivacy(f.data, qq), entry = report.artifacts.find(row => normalized(row.path) === 'identity/memory.jsonl');
    assert.equal(entry?.kind, 'mixed'); assert.equal(entry.references, 8);
    assert.equal(report.artifacts.find(row => normalized(row.path) === 'identity/memory.jsonl.head')?.kind, 'mixed');
    assert.equal(auditContactPrivacy(f.data, other).artifacts.find(row => normalized(row.path) === 'identity/memory.jsonl')?.references, 8);
    assert.equal(auditContactPrivacy(f.data, 99999).artifacts.some(row => normalized(row.path) === 'identity/memory.jsonl'), false);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret)); assert.equal(f.ledger.verify().ok, true);
});

test('export审计列出repair共享账本而不拷整链，forget留链及head原字节不破坏其他联系人', async () => {
    const f = fixture(); await writes(f.api, `old-${owner(qq)}`, 'relationship'); await writes(f.api, `old-${owner(other)}`, 'relationship');
    const path = join(f.data, 'identity', 'memory.jsonl'), head = path + '.head', before = readFileSync(path), headBefore = readFileSync(head);
    const exported = exportContact(f.data, qq, join(f.data, 'exports'));
    assert.ok(exported.audit.artifacts.some(row => normalized(row.path) === 'identity/memory.jsonl' && row.references === 4));
    assert.equal(exported.files.some(path => normalized(path).startsWith('identity/memory.jsonl')), false);
    const result = await forgetContact(f.data, qq, { apply: true, trashDir: join(f.data, 'trash'), commonBank: 'current-common', isAlive: () => false });
    assert.ok(result.plan.leave.some(row => normalized(row.path) === 'identity/memory.jsonl' && row.references === 4));
    assert.ok(result.plan.leave.some(row => normalized(row.path) === 'identity/memory.jsonl.head'));
    assert.deepEqual(readFileSync(path), before); assert.deepEqual(readFileSync(head), headBefore); assert.equal(f.ledger.verify().ok, true);
});
