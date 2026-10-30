import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import type { HindsightApi, MemoryItem } from '../src/memory/hindsight.ts';
import { DEFAULTS } from '../src/platform/config.ts';
import { LongTermMemory, RECONCILE_EVERY_MS, RECONCILE_GRACE_MS, RECONCILE_MAX, RECONCILE_MAX_TRIES, RECONCILE_RETRY_MS } from '../src/memory/long-term.ts';

const names = { user: '阿明', char: '林梦瑶' };
const A = { qq: 1, tier: 'boyfriend' };
const HOUR = 3_600_000;
const T0 = new Date('2026-10-01T08:00:00').getTime();
/** 第 i 个片段：每隔 2 小时一段（远大于 45 分钟的间隔），一问一答 */
const episode = (i: number, said = '在吗'): StoredMessage[] => [
    { time: new Date(T0 + i * 2 * HOUR).toISOString(), role: 'user', content: said },
    { time: new Date(T0 + i * 2 * HOUR + 60_000).toISOString(), role: 'assistant', content: '在' },
];
const history = (count: number, crisisAt = -1): StoredMessage[] => Array.from({ length: count }, (_, i) => episode(i, i === crisisAt ? '我不想活了' : '在吗')).flat();
const idOf = (i: number) => `ep-${T0 + i * 2 * HOUR}`;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(options: { reconcile?: boolean; common?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-reconcile-'));
    dirs.push(dir);
    const docs = new Map<string, Set<string>>();
    const retains: { bank: string; id: string }[] = [];
    const control = { listError: undefined as Error | undefined, hideAll: false, lists: 0 };
    const api: HindsightApi = {
        putBank: async () => undefined,
        retain: async (bank: string, item: MemoryItem) => { retains.push({ bank, id: item.document_id }); (docs.get(bank) ?? docs.set(bank, new Set()).get(bank)!).add(item.document_id); },
        recall: async () => [],
        getMentalModel: async () => undefined,
        createMentalModel: async () => undefined,
        updateMentalModel: async () => undefined,
        refreshMentalModel: async () => 'op',
        listEntities: async () => [],
        listDocumentIds: async bank => { control.lists++; if (control.listError) throw control.listError; return control.hideAll ? [] : [...(docs.get(bank) ?? [])]; },
    };
    const logs: string[] = [];
    let clock = T0 + 1000 * HOUR;
    const memory = new LongTermMemory({ api, dir, bankPrefix: 'p', recallTimeoutMs: 1000, log: m => logs.push(m), now: () => clock, ...(options.reconcile !== undefined ? { reconcile: options.reconcile } : {}), ...(options.common ? { common: true } : {}) });
    const bank = memory.bankId(A);
    const state = () => JSON.parse(readFileSync(join(dir, '1-boyfriend.json'), 'utf8')) as { retained: Record<string, number>; requeued?: Record<string, number> };
    return { memory, docs, retains, control, logs, dir, bank, state, advance: (ms: number) => { clock += ms; }, lose: (id: string, bankId = bank) => docs.get(bankId)!.delete(id) };
}

describe('记忆对账（ADR 0201）：进度里记着写过、Hindsight 里却没有的，重新排队写', () => {
    test('线上默认是关', () => {
        assert.equal(DEFAULTS.memoryReconcile, false);
    });

    test('没开（默认）：丢了一篇也不管', async () => {
        const t = setup({ reconcile: false });
        await t.memory.sync(A, names, history(4));
        t.lose(idOf(1));
        t.advance(RECONCILE_EVERY_MS + HOUR);
        await t.memory.sync(A, names, history(4));
        assert.equal(t.control.lists, 0);
        assert.equal(t.retains.length, 4);
    });

    test('开着：丢了一篇（后台处理失败）→ 过了宽限期的下一次同步只重写那一篇；日志只写数量、不写内容', async () => {
        const t = setup({ reconcile: true });
        await t.memory.sync(A, names, history(4));
        assert.equal(t.retains.length, 4);
        t.lose(idOf(1));
        t.advance(RECONCILE_GRACE_MS + HOUR);
        await t.memory.sync(A, names, history(4));
        assert.deepEqual(t.retains.slice(4).map(r => r.id), [idOf(1)]);
        assert.ok(t.docs.get(t.bank)!.has(idOf(1)));
        assert.equal(t.state().requeued?.[`own:${idOf(1)}`], 1);
        const line = t.logs.find(l => l.includes('记忆对账'))!;
        assert.match(line, /他的 bank 1 个、公共库 0 个/);
        assert.ok(!line.includes('在吗'), '日志不记内容');
    });

    test('刚提交的先不算缺（Hindsight 在后台慢慢处理）：宽限期内不动', async () => {
        const t = setup({ reconcile: true });
        await t.memory.sync(A, names, history(3));
        t.lose(idOf(0));
        t.advance(RECONCILE_GRACE_MS - 60_000);
        await t.memory.sync(A, names, history(3));
        assert.equal(t.retains.length, 3);
    });

    test('进度文件是旧版本（没有提交时间）：当成早就提交了，缺了就重排', async () => {
        const t = setup({ reconcile: true });
        await t.memory.sync(A, names, history(3));
        const path = join(t.dir, '1-boyfriend.json');
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        delete raw.retainedAt;
        writeFileSync(path, JSON.stringify(raw));
        t.lose(idOf(2));
        t.advance(60_000);
        await t.memory.sync(A, names, history(3));
        assert.deepEqual(t.retains.slice(3).map(r => r.id), [idOf(2)]);
    });

    test('读不到文档列表：记一行、什么都不动；下一个周期再来', async () => {
        const t = setup({ reconcile: true });
        await t.memory.sync(A, names, history(3));
        t.lose(idOf(0));
        t.advance(RECONCILE_GRACE_MS + HOUR);
        t.control.listError = new Error('连不上');
        await t.memory.sync(A, names, history(3));
        assert.equal(t.retains.length, 3);
        assert.ok(t.logs.some(l => l.includes('读不到') && l.includes('这次不对')));
        t.control.listError = undefined;
        t.advance(RECONCILE_EVERY_MS + 1);
        await t.memory.sync(A, names, history(3));
        assert.deepEqual(t.retains.slice(3).map(r => r.id), [idOf(0)]);
    });

    test('Hindsight 里一篇都没有却记着一堆写过的（≥5 个）：多半是 bank 不对 / 接口变了，不动；少于 5 个不算可疑', async () => {
        const t = setup({ reconcile: true });
        await t.memory.sync(A, names, history(6));
        t.advance(RECONCILE_GRACE_MS + HOUR);
        t.control.hideAll = true;
        await t.memory.sync(A, names, history(6));
        assert.equal(t.retains.length, 6);
        assert.ok(t.logs.some(l => l.includes('一篇文档都没有')));
        const few = setup({ reconcile: true });
        await few.memory.sync(A, names, history(3));
        few.advance(RECONCILE_GRACE_MS + HOUR);
        few.control.hideAll = true;
        await few.memory.sync(A, names, history(3));
        assert.equal(few.retains.length, 6, '3 个都缺：全部重排');
    });

    test('对账的节奏：没发现缺的 6 小时一次；发现缺了之后 10 分钟再查一次', async () => {
        const t = setup({ reconcile: true });
        await t.memory.sync(A, names, history(3));
        const afterFirst = t.control.lists;
        t.advance(RECONCILE_GRACE_MS + HOUR);
        await t.memory.sync(A, names, history(3));
        const afterClean = t.control.lists;
        assert.ok(afterClean > afterFirst);
        t.advance(RECONCILE_EVERY_MS - 60_000);
        await t.memory.sync(A, names, history(3));
        assert.equal(t.control.lists, afterClean, '没满 6 小时不查');
        t.advance(2 * 60_000);
        t.lose(idOf(0));
        await t.memory.sync(A, names, history(3));
        assert.ok(t.control.lists > afterClean, '满了就查');
        const afterFound = t.control.lists;
        t.advance(RECONCILE_RETRY_MS - 60_000);
        await t.memory.sync(A, names, history(3));
        assert.equal(t.control.lists, afterFound, '发现缺了之后没满 10 分钟不查');
        t.advance(2 * 60_000);
        await t.memory.sync(A, names, history(3));
        assert.ok(t.control.lists > afterFound, '满 10 分钟再查');
    });

    test('同一个片段最多重排 RECONCILE_MAX_TRIES 次（Hindsight 老是处理失败的那种内容不要一直写）；一次最多重排 RECONCILE_MAX 个', async () => {
        const t = setup({ reconcile: true });
        await t.memory.sync(A, names, history(2));
        for (let round = 1; round <= RECONCILE_MAX_TRIES + 1; round++) {
            t.advance(RECONCILE_GRACE_MS + RECONCILE_EVERY_MS);
            t.lose(idOf(0));
            await t.memory.sync(A, names, history(2));
        }
        assert.equal(t.retains.filter(r => r.id === idOf(0)).length, 1 + RECONCILE_MAX_TRIES, '第一次写 + 重排 3 次');
        assert.equal(t.state().requeued?.[`own:${idOf(0)}`], RECONCILE_MAX_TRIES);

        const many = setup({ reconcile: true });
        const total = RECONCILE_MAX + 5;
        await many.memory.sync(A, names, history(total));
        for (let i = 0; i < total - 1; i++) many.lose(idOf(i)); // 留一篇在，不然会被当成「一篇都没有」
        many.advance(RECONCILE_GRACE_MS + HOUR);
        await many.memory.sync(A, names, history(total));
        assert.equal(many.retains.length - total, RECONCILE_MAX, '一次最多 30 个');
        many.advance(RECONCILE_RETRY_MS + 1);
        await many.memory.sync(A, names, history(total));
        assert.equal(many.retains.length - total, total - 1, '剩下的下一轮补上');
    });

    test('公共库也有宽限期：刚提交的不算缺', async () => {
        const t = setup({ reconcile: true, common: true });
        await t.memory.sync(A, names, history(3));
        const common = t.memory.commonBankId();
        const id = [...t.docs.get(common)!].find(doc => doc.includes(':ep-'))!;
        t.lose(id, common);
        t.advance(RECONCILE_GRACE_MS - 60_000);
        const before = t.retains.length;
        await t.memory.sync(A, names, history(3));
        assert.equal(t.retains.length, before);
    });

    test('公共库：缺的重排；危机相关的片段本来就不写，不算缺', async () => {
        const t = setup({ reconcile: true, common: true });
        await t.memory.sync(A, names, history(4, 2));
        const common = t.memory.commonBankId();
        const commonIds = [...t.docs.get(common)!].filter(id => id.includes(':ep-'));
        assert.equal(commonIds.length, 3, '4 个片段里危机那个（第 3 个）没写进公共库');
        assert.ok(!commonIds.some(id => id.endsWith(idOf(2))));
        t.lose(commonIds.find(id => id.endsWith(idOf(0)))!, common);
        t.advance(RECONCILE_GRACE_MS + HOUR);
        const before = t.retains.length;
        await t.memory.sync(A, names, history(4, 2));
        const fresh = t.retains.slice(before);
        assert.deepEqual(fresh.map(r => [r.bank, r.id.split(':').pop()]), [[common, idOf(0)]]);
        assert.match(t.logs.find(l => l.includes('记忆对账'))!, /他的 bank 0 个、公共库 1 个/);
    });
});
