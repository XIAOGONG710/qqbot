import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { readMotivationLedger } from '../src/life/motivation-ledger.ts';
import type { Drive, ShadowActivityCandidate } from '../src/life/motivation.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { TransientStateError } from '../src/memory/transient-io.ts';

const dirs: string[] = [];
const ledgerPath = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-motivation-ledger-')); dirs.push(d); return join(d, 'motivation.json'); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const at = '2026-11-16T12:00:00.000Z';
const drive = (id: string, over: Partial<Drive> = {}): Drive => ({
    id, source: 'external', goal: '记住天气变化', eventIds: ['weather:rain'], strength: 0.4, urgency: 0.1, persistence: 0.5, createdAt: at, status: 'active', ...over,
});
const candidate = (id: string, driveId: string, over: Partial<ShadowActivityCandidate> = {}): ShadowActivityCandidate => ({
    id, driveId, kind: 'remember', createdAt: at, reason: '影子模式只保留动机', ...over,
});
const onDisk = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { version: number; drives: Drive[]; candidates: ShadowActivityCandidate[] };

describe('影子动机账', () => {
    test('文件不存在：空账，不建文件；什么都没加时也不写', () => {
        const path = ledgerPath();
        const ledger = readMotivationLedger(path);
        assert.deepEqual(ledger.drives(), []);
        assert.deepEqual(ledger.candidates(), []);
        assert.equal(ledger.appendDrives([]), 0);
        assert.equal(existsSync(path), false);
    });

    test('追加动机和候选：按 id 去重（先来的留着），返回新增几条，写盘后换个实例读回一样', () => {
        const path = ledgerPath();
        const ledger = readMotivationLedger(path);
        assert.equal(ledger.appendDrives([drive('a'), drive('b')]), 2);
        assert.equal(ledger.appendDrives([drive('a', { goal: '改过的目标' }), drive('c')]), 1);
        assert.deepEqual(ledger.drives().map(d => [d.id, d.goal]), [['a', '记住天气变化'], ['b', '记住天气变化'], ['c', '记住天气变化']]);
        assert.equal(ledger.appendCandidates([candidate('a:remember', 'a'), candidate('a:remember', 'a', { kind: 'wait' })]), 1, '同一批里重复的也只算一次');
        const file = onDisk(path);
        assert.equal(file.version, 1);
        assert.deepEqual(file.drives.map(d => d.id), ['a', 'b', 'c']);
        assert.deepEqual(file.candidates.map(c => [c.id, c.kind]), [['a:remember', 'remember']]);
        const reopened = readMotivationLedger(path);
        assert.deepEqual(reopened.drives(), ledger.drives());
        assert.deepEqual(reopened.candidates(), ledger.candidates());
    });

    test('全是重复的：返回 0，不重写文件', () => {
        const path = ledgerPath();
        const ledger = readMotivationLedger(path);
        ledger.appendDrives([drive('a')]);
        writeFileSync(path, `${JSON.stringify({ version: 1, drives: [drive('a')], candidates: [] })}`);
        const before = readFileSync(path, 'utf8');
        assert.equal(ledger.appendDrives([drive('a')]), 0);
        assert.equal(readFileSync(path, 'utf8'), before);
    });

    test('格式无效的动机 / 候选：抛错带上 id，账和文件都不变', () => {
        const path = ledgerPath();
        const ledger = readMotivationLedger(path);
        ledger.appendDrives([drive('a')]);
        const before = readFileSync(path, 'utf8');
        assert.throws(() => ledger.appendDrives([drive('ok'), drive('bad', { strength: 2 })]), /影子动机格式无效：bad/);
        assert.throws(() => ledger.appendDrives([drive('noorigin', { eventIds: undefined })]), /影子动机格式无效：noorigin/, '外驱必须能追溯到事件');
        assert.throws(() => ledger.appendDrives([null as unknown as Drive]), /影子动机格式无效：unknown/);
        assert.throws(() => ledger.appendCandidates([candidate('x', 'a', { kind: 'send_qq' as never })]), /影子活动候选格式无效：x/, '不认识的活动种类（比如外发）不收');
        assert.deepEqual(ledger.drives().map(d => d.id), ['a']);
        assert.deepEqual(ledger.candidates(), []);
        assert.equal(readFileSync(path, 'utf8'), before);
    });

    test('候选引用了不存在的动机：拒收，不写盘', () => {
        const path = ledgerPath();
        const ledger = readMotivationLedger(path);
        ledger.appendDrives([drive('a')]);
        const before = readFileSync(path, 'utf8');
        assert.throws(() => ledger.appendCandidates([candidate('ghost:remember', 'ghost')]), /引用了不存在的动机/);
        assert.deepEqual(ledger.candidates(), []);
        assert.equal(readFileSync(path, 'utf8'), before);
    });

    test('坏文件（半截 JSON、版本不对、重复 id、候选指向不存在的动机）：拒绝启动，原文件不动、不挪走', () => {
        const bad = [
            '{"version":1,"drives":[',
            JSON.stringify({ version: 2, drives: [], candidates: [] }),
            JSON.stringify({ version: 1, drives: [drive('a'), drive('a')], candidates: [] }),
            JSON.stringify({ version: 1, drives: [drive('a')], candidates: [candidate('c', 'missing')] }),
            JSON.stringify({ version: 1, drives: {}, candidates: [] }),
            JSON.stringify([]),
        ];
        for (const text of bad) {
            const path = ledgerPath();
            writeFileSync(path, text);
            assert.throws(() => readMotivationLedger(path), (error: unknown) => error instanceof Error && /拒绝启动；原文件未重建/.test(error.message) && error.message.includes(path), text);
            assert.equal(readFileSync(path, 'utf8'), text, '原文件原样保留');
        }
    });

    test('合法的旧文件照常读回', () => {
        const path = ledgerPath();
        writeFileSync(path, JSON.stringify({ version: 1, drives: [drive('a')], candidates: [candidate('a:wait', 'a', { kind: 'wait' })] }));
        const ledger = readMotivationLedger(path);
        assert.deepEqual(ledger.drives().map(d => d.id), ['a']);
        assert.deepEqual(ledger.candidates().map(c => c.id), ['a:wait']);
    });

    test('暂时读不到（句柄不够）：原样抛 TransientStateError，不说成坏文件', () => {
        const path = ledgerPath();
        writeFileSync(path, JSON.stringify({ version: 1, drives: [], candidates: [] }));
        const read = fileOps.readFileSync, delays = fileOps.readDelaysMs;
        fileOps.readDelaysMs = [0];
        fileOps.readFileSync = (() => { throw Object.assign(new Error('synthetic IO'), { code: 'EMFILE' }); }) as typeof read;
        try {
            assert.throws(() => readMotivationLedger(path), (error: unknown) => error instanceof TransientStateError);
        } finally { fileOps.readFileSync = read; fileOps.readDelaysMs = delays; }
    });
});
