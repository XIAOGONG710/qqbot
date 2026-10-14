import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { HindsightApi } from '../src/memory/hindsight.ts';
import { LongTermMemory } from '../src/memory/long-term.ts';
import { readCommonMemoryState, readContactMemoryState } from '../src/memory/state.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-state-')); dirs.push(dir); return dir; };
const contact = { qq: 10001, tier: 'boyfriend', name: '阿明' };
const names = { user: contact.name, char: '林梦瑶' };
const day = new Date('2026-10-01T12:00:00Z');
const history = [{ time: day.toISOString(), role: 'user' as const, content: '今天去了图书馆' }];

function setup() {
    const dir = fixture();
    const logs: string[] = [];
    const calls: string[] = [];
    const api: HindsightApi = {
        putBank: async () => { calls.push('put'); },
        retain: async () => { calls.push('retain'); },
        recall: async () => { calls.push('recall'); return []; },
        getMentalModel: async () => { calls.push('get-model'); return { id: 'relationship', name: '关系', content: '喜欢读书' }; },
        createMentalModel: async () => { calls.push('create-model'); },
        updateMentalModel: async () => { calls.push('update-model'); },
        refreshMentalModel: async () => { calls.push('refresh'); return 'operation'; },
        getDocument: async () => { calls.push('get-document'); return undefined; },
        listEntities: async () => { calls.push('entities'); return ['阿明']; },
    };
    const memory = new LongTermMemory({ api, dir, bankPrefix: 'test', recallTimeoutMs: 100, common: true,
        log: line => logs.push(line), now: () => day.getTime() + 86_400_000 });
    return { dir, memory, calls, logs, path: join(dir, '10001-boyfriend.json'), commonPath: join(dir, 'common.json') };
}

test('联系人和公共记忆旧格式只在内存迁到 v1，保留真实进度和旧模型标记；不存在才为空', () => {
    const dir = fixture(); const path = join(dir, 'state.json');
    assert.equal(readContactMemoryState(path), undefined);
    assert.equal(readCommonMemoryState(path), undefined);
    const legacy = { bankId: 'old-bank', retained: { 'ep-0': 3 }, common: { 'ep-0': 2 }, relationshipModel: true,
        bankConfigured: 'old-mission', personModel: 'old-person', commonSafetyVersion: 2 };
    const original = JSON.stringify(legacy); writeFileSync(path, original);
    assert.deepEqual(readContactMemoryState(path), { ...legacy, version: 1 });
    assert.equal(readFileSync(path, 'utf8'), original);
    const common = JSON.stringify({ bankId: 'old-common', bankConfigured: 'old-mission' }); writeFileSync(path, common);
    assert.deepEqual(readCommonMemoryState(path), { version: 1, bankId: 'old-common', bankConfigured: 'old-mission' });
    assert.equal(readFileSync(path, 'utf8'), common);
});

test('错误的联系人进度、未知版本/安全标记和缺失关键字段失败关闭，不隔离或重建', () => {
    const dir = fixture(); const path = join(dir, 'state.json');
    const base = { bankId: 'test-bank', retained: {} };
    for (const bad of [
        null, [], {}, { ...base, version: 9 }, { ...base, version: '1' }, { version: 1, bankId: 'test-bank' },
        { ...base, retained: [] }, { ...base, retained: { 'ep-0': -1 } }, { ...base, retained: { 'ep-0': 1.5 } },
        { ...base, retained: { 'ep-0': '2' } }, { ...base, retained: { bad: 2 } },
        { ...base, retained: { 'ep-9007199254740992': 1 } }, { ...base, common: null },
        { ...base, commonSafetyVersion: 99 }, { ...base, commonSafetyVersion: '2' }, { ...base, commonSafetyVersion: 2 },
        { ...base, bankConfigured: false }, { ...base, personModel: {} }, { ...base, relationshipModel: [] },
    ]) {
        const original = JSON.stringify(bad); writeFileSync(path, original);
        assert.throws(() => readContactMemoryState(path), /联系人记忆进度.*拒绝继续/);
        assert.equal(readFileSync(path, 'utf8'), original);
        assert.deepEqual(readdirSync(dir), ['state.json']);
    }
});

test('公共迁移标记只接受已知版本和字段类型；坏 JSON 的正文不进入错误消息', () => {
    const dir = fixture(); const path = join(dir, 'common.json');
    for (const bad of [null, [], {}, { version: 2, bankId: 'common' }, { bankId: '' },
        { bankId: 'common', bankConfigured: true }, { bankId: 'common', writtenSafetyVersion: '2' },
        { bankId: 'common', writtenSafetyVersion: 9 }]) {
        const original = JSON.stringify(bad); writeFileSync(path, original);
        assert.throws(() => readCommonMemoryState(path), /公共记忆迁移状态.*拒绝继续/);
        assert.equal(readFileSync(path, 'utf8'), original);
    }
    writeFileSync(path, 'PRIVATE_BODY not json');
    for (const read of [readContactMemoryState, readCommonMemoryState]) {
        assert.throws(() => read(path), error => !String(error).includes('PRIVATE_BODY') && /未重建/.test(String(error)));
    }
});

test('运行时联系人进度损坏，后台不调用远端，召回/关系/印象不使用旧缓存；修复后继续原进度', async () => {
    const { memory, calls, path, logs } = setup();
    await memory.sync(contact, names, history);
    memory.relationship(contact); memory.impression(contact);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(memory.relationship(contact));
    assert.ok(memory.impression(contact));
    const valid = readFileSync(path, 'utf8');
    assert.equal(JSON.parse(valid).version, 1);
    const bad = JSON.stringify({ bankId: memory.bankId(contact), retained: [] }); writeFileSync(path, bad);
    const before = calls.length;
    await memory.sync(contact, names, history);
    assert.equal(await memory.recall(contact, history, day), undefined);
    assert.equal(memory.relationship(contact), undefined);
    assert.equal(memory.impression(contact), undefined);
    assert.equal(calls.length, before);
    assert.equal(readFileSync(path, 'utf8'), bad);
    assert.ok(logs.some(line => line.includes('本轮不使用这份记忆')));
    writeFileSync(path, valid);
    await memory.sync(contact, names, history);
    assert.equal(calls.length, before, '可信恢复后已写片段不重新写');
});

test('公共状态损坏先于任何写入被拒绝；公共召回、实体、印象及旧文档读回均停用', async () => {
    const { memory, calls, path, commonPath, dir } = setup();
    await memory.sync(contact, names, history);
    assert.deepEqual(await memory.commonEntities(), ['阿明']);
    memory.impression(contact);
    await new Promise(resolve => setTimeout(resolve, 0));
    const original = readFileSync(path, 'utf8');
    const provenance = readFileSync(join(dir, 'provenance.json'), 'utf8');
    const bad = JSON.stringify({ bankId: memory.commonBankId(), writtenSafetyVersion: '2' }); writeFileSync(commonPath, bad);
    const before = calls.length;
    await memory.sync(contact, names, [...history, { ...history[0]!, content: '新的一条' }]);
    assert.equal(await memory.recallCommon(contact, history, day, [contact]), undefined);
    assert.equal(await memory.othersToday(contact, day, [{ ...contact, qq: 10002 }], day), undefined);
    assert.deepEqual(await memory.commonEntities(), []);
    assert.equal(memory.impression(contact), undefined);
    await assert.rejects(memory.readWritten('diary:2026-10-01'), /公共记忆迁移状态/);
    assert.throws(() => memory.writtenNeedsReshare(), /公共记忆迁移状态/);
    assert.throws(() => memory.markWrittenReshared(), /公共记忆迁移状态/);
    assert.equal(await memory.retainDiary('2026-10-01', day, '今天读书', names.char), false);
    assert.equal(await memory.retainDiary('2026-10-01', day, '这是秘密，验证码 123456', names.char), false);
    assert.equal(calls.length, before);
    assert.equal(readFileSync(commonPath, 'utf8'), bad);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(readFileSync(join(dir, 'provenance.json'), 'utf8'), provenance);
});

test('不能在公共库状态缺失或已换前缀时假标记旧文档迁移完成', () => {
    const { memory, commonPath } = setup();
    assert.throws(() => memory.markWrittenReshared(), /不能标记/);
    const original = JSON.stringify({ bankId: 'different-bank', bankConfigured: 'old' }); writeFileSync(commonPath, original);
    assert.throws(() => memory.markWrittenReshared(), /不能标记/);
    assert.equal(readFileSync(commonPath, 'utf8'), original);
});
