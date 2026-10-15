import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { TierRecord } from '../src/tier-record.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-state-schema-')); dirs.push(dir); return dir; };

test('档位文件验证 QQ、已知档位与换档时间，坏状态保留原样；旧字符串格式兼容', () => {
    const dir = fixture(); const path = join(dir, 'tiers.json');
    writeFileSync(path, JSON.stringify({ '10001': 'boyfriend' }));
    assert.equal(new TierRecord(path).update(10001, 'boyfriend'), undefined);
    for (const value of [
        [], null, { '10001': null }, { '10001': 'admin' }, { other: 'classmate' },
        { '10001': { tier: 'classmate', since: 'not-a-date' } },
        { '10001': { tier: 'classmate', since: '2026-02-30T10:00:00Z' } },
    ]) {
        const original = JSON.stringify(value); writeFileSync(path, original);
        assert.throws(() => new TierRecord(path), /schema.*不启动/);
        assert.equal(readFileSync(path, 'utf8'), original);
    }
});

test('运行时拒绝坏档位写入，不能污染文件', () => {
    const dir = fixture(); const path = join(dir, 'tiers.json');
    const record = new TierRecord(path); record.update(10001, 'classmate');
    const before = readFileSync(path, 'utf8');
    assert.throws(() => record.update(10001, 'admin' as never), /schema/);
    assert.throws(() => record.update(-1, 'classmate'), /schema/);
    assert.throws(() => record.update(10001, 'classmate', new Date('bad')), /schema/);
    assert.equal(readFileSync(path, 'utf8'), before);
});
