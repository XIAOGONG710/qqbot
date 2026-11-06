import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { readLifeEvents, validLifeEvent, writeLifeEvents, type LifeEvent } from '../src/world/life-events.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'world-ledger-review-')); dirs.push(dir); return join(dir, 'events.json'); };
const event: LifeEvent = { id: 'a', actor: 'linmengyao', kind: 'rest', day: '2026-11-05', startedAt: '2026-11-05T12:00:00+08:00', endedAt: '2026-11-05T12:30:00+08:00', source: 'simulation', result: 'succeeded' };

test('生活账拒绝不存在的日历日、空身份和不可安全记账的数值', () => {
    assert.ok(validLifeEvent(event));
    for (const change of [{ day: '2026-02-30' }, { startedAt: '2026-02-30T12:00:00Z' }, { id: '  ' }, { kind: '\n' }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { contact: Infinity }, { contact: -1 }, { contact: 1.5 }]) {
        assert.equal(validLifeEvent({ ...event, ...change }), false, JSON.stringify(change));
    }
    assert.ok(validLifeEvent({ ...event, amount: 10, contact: 1 }));
});

test('重复事件 ID 不能当成两条可独立消费的事实；坏文件原样保留', () => {
    const path = fixture(); const text = JSON.stringify({ version: 1, events: [event, { ...event, subject: '冲突正文' }] });
    writeFileSync(path, text);
    assert.throws(() => readLifeEvents(path, () => {}), /生活事件账/);
    assert.equal(readFileSync(path, 'utf8'), text);
});

test('损坏账本错误不泄漏事件正文，也不隔离重建历史', () => {
    const path = fixture(); const text = '{"events":[合成私密事件正文]}'; writeFileSync(path, text);
    const logs: string[] = [];
    assert.throws(() => readLifeEvents(path, line => logs.push(line)), error => error instanceof Error && !error.message.includes('合成私密事件正文'));
    assert.ok(logs.every(line => !line.includes('合成私密事件正文')));
    assert.equal(readFileSync(path, 'utf8'), text);
});

test('写入边界拒绝不安全数字及重复身份，不覆盖已有有效事件账', () => {
    const path = fixture(); writeLifeEvents(path, [event]); const before = readFileSync(path, 'utf8');
    for (const events of [[{ ...event, contact: Infinity }], [event, { ...event }], [{ ...event, day: '2026-02-30' }]]) {
        assert.throws(() => writeLifeEvents(path, events), /生活事件账/);
        assert.equal(readFileSync(path, 'utf8'), before);
        assert.deepEqual(readLifeEvents(path, () => {}), [event]);
    }
});
