import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { ownerBankPath, readOwnerBank, writeOwnerBank } from '../src/memory/owner-bank.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-ownerbank-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const info = { ownerBank: 'linmengyao-a5db1eb499a38621', commonBank: 'linmengyao-common', legacyBank: 'linmengyao' };

describe('他的 bank 写给 DSH 桌面上的她（ADR 0176）', () => {
    test('写出去、读得回来；内容没变就不重写', () => {
        const dir = tmp();
        assert.equal(readOwnerBank(dir), undefined, '还没写过');
        assert.equal(writeOwnerBank(dir, info, () => new Date('2026-10-29T14:00:00Z')), true);
        assert.deepEqual(readOwnerBank(dir), { ...info, writtenAt: '2026-10-29T14:00:00.000Z' });
        // 把文件改老，再写一遍同样的内容：不应该动它
        const path = ownerBankPath(dir);
        const old = new Date('2026-01-01T00:00:00Z');
        utimesSync(path, old, old);
        assert.equal(writeOwnerBank(dir, info, () => new Date('2026-10-30T00:00:00Z')), false);
        assert.equal(statSync(path).mtime.getTime(), old.getTime());
        assert.equal(JSON.parse(readFileSync(path, 'utf8')).writtenAt, '2026-10-29T14:00:00.000Z');
    });

    test('他被降档、换了 bank：重写', () => {
        const dir = tmp();
        writeOwnerBank(dir, info);
        assert.equal(writeOwnerBank(dir, { ...info, ownerBank: 'linmengyao-0000000000000000' }), true);
        assert.equal(readOwnerBank(dir)!.ownerBank, 'linmengyao-0000000000000000');
    });

    test('文件读坏了 / 缺字段：当没有，不抛错', () => {
        const dir = tmp();
        writeFileSync(ownerBankPath(dir), '{ 坏了');
        assert.equal(readOwnerBank(dir), undefined);
        writeFileSync(ownerBankPath(dir), JSON.stringify({ ownerBank: 'x' }));
        assert.equal(readOwnerBank(dir), undefined);
    });
});
