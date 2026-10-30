import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { MemoryItem } from '../src/memory/hindsight.ts';
import {
    applyImport, archiveDirName, describePlan, exportBundle, expectedEpisodeIds, fetchWrittenDocs, listDocumentIds, memoryGap, memoryItemOf, mergeChatRows, mergeDiaryState,
    parseChatJsonl, planImport, readBundle, serializeChatRows, type BundleDoc, type ChatRow, type FetchLike, type MigrationApi,
} from '../src/ops/history-migrate.ts';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-migrate-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const row = (time: string, role: 'user' | 'assistant', content: string, extra: Record<string, unknown> = {}): ChatRow => ({ time, role, content, ...extra });
const T = (clock: string, day = '2026-10-10') => `${day}T${clock}.000Z`;

describe('聊天记录并入', () => {
    test('读 jsonl：坏行、没有时间 / 角色 / 内容的跳过并计数，能读的行原样（多余的字段也在）', () => {
        const text = [JSON.stringify(row(T('08:00:00'), 'user', '早', { messageId: 7 })), '{坏的', JSON.stringify({ role: 'user', content: '没时间' }), JSON.stringify({ time: T('08:01:00'), role: 'system', content: 'x' }), '', JSON.stringify(row(T('08:02:00'), 'assistant', '早呀'))].join('\n');
        const { rows, bad } = parseChatJsonl(text);
        assert.equal(rows.length, 2);
        assert.equal(bad, 3);
        assert.equal(rows[0]!.messageId, 7);
    });

    test('两边都有的一条（同一个人、同一句话、时间差 3 秒以内）只算一条；差得远的是新的', () => {
        const existing = [row(T('08:00:00'), 'user', '在吗'), row(T('08:00:05'), 'assistant', '在')];
        const incoming = [row(T('08:00:02'), 'user', '在吗'), row(T('08:00:05'), 'assistant', '在'), row(T('08:30:00'), 'user', '在吗')];
        const merged = mergeChatRows(existing, incoming);
        assert.equal(merged.added, 1);
        assert.equal(merged.skipped, 2);
        assert.deepEqual(merged.rows.map(r => r.time), [T('08:00:00'), T('08:00:05'), T('08:30:00')]);
    });

    test('同一句话但隔了半小时（只有一边有这一条）不是同一条', () => {
        const merged = mergeChatRows([row(T('08:00:00'), 'user', '在吗')], [row(T('08:30:00'), 'user', '在吗')]);
        assert.equal(merged.added, 1);
        assert.equal(merged.skipped, 0);
        assert.equal(mergeChatRows([row(T('08:00:00'), 'user', '在吗')], [row(T('08:00:03'), 'user', '在吗')]).skipped, 1, '正好 3 秒还算同一条');
        assert.equal(mergeChatRows([row(T('08:00:00'), 'user', '在吗')], [row(T('08:00:04'), 'user', '在吗')]).skipped, 0, '4 秒就不是了');
    });

    test('一模一样的两条「嗯」是两条：已有一条不会把素材里的两条都吞掉；素材里自己的两条也都保留', () => {
        const existing = [row(T('09:00:00'), 'user', '嗯')];
        const incoming = [row(T('09:00:01'), 'user', '嗯'), row(T('09:00:02'), 'user', '嗯')];
        assert.equal(mergeChatRows(existing, incoming).added, 1);
        assert.equal(mergeChatRows([], incoming).added, 2);
    });

    test('按时间排好；新机器上已有的行内容一个字不改（连多余字段）；同一时刻已有的在前', () => {
        const existing = [row(T('10:00:00'), 'user', 'b', { messageId: 2, extra: 'keep' })];
        const merged = mergeChatRows(existing, [row(T('09:00:00'), 'user', 'a'), row(T('10:00:00'), 'assistant', 'c'), row(T('11:00:00'), 'user', 'd')]);
        assert.deepEqual(merged.rows.map(r => r.content), ['a', 'b', 'c', 'd']);
        assert.equal(merged.rows[1], existing[0], '同一个对象，没复制没改');
    });

    test('序列化：一行一条，末尾有换行；空的是空串', () => {
        assert.equal(serializeChatRows([]), '');
        assert.equal(serializeChatRows([row(T('08:00:00'), 'user', 'x')]).split('\n').length, 2);
    });
});

describe('diary.json 并入', () => {
    test('新机器已有的键不动，只补没有的；多出来的字段也保留', () => {
        const existing = { written: { '2026-10-27': 100 }, texts: { '2026-10-27': '新的' }, weeks: {}, phases: {}, extra: 1 };
        const incoming = { written: { '2026-10-26': 80, '2026-10-27': 999 }, texts: { '2026-10-26': '旧的', '2026-10-27': '不该盖' }, weeks: { '2026-10-19': 200 }, phases: { '国庆节:2026-10-07': 300 } };
        const { state, added } = mergeDiaryState(existing, incoming);
        assert.deepEqual(state.written, { '2026-10-27': 100, '2026-10-26': 80 });
        assert.equal(state.texts['2026-10-27'], '新的');
        assert.deepEqual(added, { written: 1, texts: 1, weeks: 1, phases: 1 });
        assert.equal((state as unknown as { extra: number }).extra, 1);
    });

    test('新机器上没有 diary.json（空对象）也行', () => {
        assert.deepEqual(mergeDiaryState({}, { written: { a: 1 } }).state, { written: { a: 1 }, texts: {}, weeks: {}, phases: {} });
    });
});

const diaryDoc: BundleDoc = {
    id: 'diary:2026-10-25', text: '林梦瑶的日记（2026-10-25）\n今天……', tags: ['qq-private', 'diary'], metadata: { date: '2026-10-25', source: 'diary' },
    context: '林梦瑶自己写的日记', eventDate: '2026-10-25T22:00:00+08:00', entities: [{ text: '林梦瑶', type: 'PERSON' }],
};
const weekDoc: BundleDoc = { ...diaryDoc, id: 'week:2026-10-19', text: '林梦瑶的周记（10月19日–10月25日）\n这周……', tags: ['qq-private', 'week'], metadata: { id: 'week:2026-10-19', source: 'week' }, context: '林梦瑶自己写的周记' };

describe('她自己写的文档', () => {
    test('原样再写一次：content / timestamp / context / document_id / tags / metadata / entities 都照旧；没有实体就不带 entities', () => {
        assert.deepEqual(memoryItemOf(diaryDoc), {
            content: diaryDoc.text, timestamp: '2026-10-25T22:00:00+08:00', context: '林梦瑶自己写的日记', document_id: 'diary:2026-10-25',
            tags: ['qq-private', 'diary'], metadata: { date: '2026-10-25', source: 'diary' }, entities: [{ text: '林梦瑶', type: 'PERSON' }],
        });
        assert.equal('entities' in memoryItemOf({ ...diaryDoc, entities: [] }), false);
    });

    const server = (ids: string[], docs: Record<string, unknown>, fail?: string): FetchLike => async url => {
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        if (fail && path.includes(fail)) return { ok: false, status: 500, json: async () => ({}) };
        const list = /\/documents\?limit=(\d+)&offset=(\d+)$/.exec(path);
        if (list) {
            const offset = Number(list[2]);
            return { ok: true, status: 200, json: async () => ({ items: ids.slice(offset, offset + Number(list[1])).map(id => ({ id })), total: ids.length }) };
        }
        const id = decodeURIComponent(path.split('/documents/')[1]!);
        return docs[id] ? { ok: true, status: 200, json: async () => docs[id] } : { ok: false, status: 404, json: async () => ({}) };
    };
    const apiDoc = (doc: BundleDoc) => ({
        id: doc.id, original_text: doc.text, tags: doc.tags, document_metadata: doc.metadata, created_at: '2026-10-26T00:00:00Z',
        retain_params: { context: doc.context, entities: doc.entities, event_date: doc.eventDate, metadata: doc.metadata },
    });

    test('只取她自己写的（diary: / week: / phase: / diary-self: / self:）；聊天片段（ep-…、哈希:ep-…）不取；翻页读全', async () => {
        const many = Array.from({ length: 130 }, (_, i) => `a5db1eb499a38621:ep-${i}`);
        const ids = [...many, 'diary:2026-10-25', 'week:2026-10-19', 'ep-1', 'self:abc:1'];
        const docs = { 'diary:2026-10-25': apiDoc(diaryDoc), 'week:2026-10-19': apiDoc(weekDoc), 'self:abc:1': apiDoc({ ...diaryDoc, id: 'self:abc:1' }) };
        assert.equal((await listDocumentIds('http://x:8888', 'bank', server(ids, docs))).length, 134);
        const got = await fetchWrittenDocs('http://x:8888/', 'bank', server(ids, docs));
        assert.deepEqual(got.map(d => d.id), ['diary:2026-10-25', 'self:abc:1', 'week:2026-10-19']);
        assert.deepEqual(got.find(d => d.id === 'diary:2026-10-25'), diaryDoc);
    });

    test('接口出错、文档没有原文都直接报错，不悄悄少搬', async () => {
        await assert.rejects(fetchWrittenDocs('http://x', 'bank', server(['diary:1'], {}, '/documents?')), /500/);
        await assert.rejects(fetchWrittenDocs('http://x', 'bank', server(['diary:1'], { 'diary:1': { id: 'diary:1', original_text: '' } })), /没有原文/);
    });
});

/** 造一个假的旧数据目录 + 假的 Hindsight，导出成素材包 */
async function makeBundle(): Promise<{ bundleDir: string; liveDir: string }> {
    const liveDir = temp();
    mkdirSync(join(liveDir, 'chats'), { recursive: true });
    writeFileSync(join(liveDir, 'chats', '111.jsonl'), serializeChatRows([row(T('08:00:00', '2026-10-06'), 'user', '早'), row(T('08:00:30', '2026-10-06'), 'assistant', '早呀'), row(T('09:00:00', '2026-10-26'), 'user', '睡了')]));
    writeFileSync(join(liveDir, 'chats', '222.jsonl'), serializeChatRows([row(T('08:00:00', '2026-10-07'), 'user', '另一个人')]));
    mkdirSync(join(liveDir, 'memory'), { recursive: true });
    writeFileSync(join(liveDir, 'memory', 'diary.json'), JSON.stringify({ written: { '2026-10-25': 268 }, texts: { '2026-10-25': '今天……' }, weeks: { '2026-10-19': 282 }, phases: {} }));
    writeFileSync(join(liveDir, 'memory', '111-boyfriend.json'), JSON.stringify({ bankId: 'old-prefix-abc', retained: { 'ep-1': 3 } }));
    mkdirSync(join(liveDir, 'promises'), { recursive: true });
    writeFileSync(join(liveDir, 'promises', '111-boyfriend.json'), JSON.stringify({ promises: [{ id: 'p1', what: '带她去吃火锅' }] }));
    writeFileSync(join(liveDir, 'promises', '222-classmate.json'), JSON.stringify({ promises: [] }));
    mkdirSync(join(liveDir, 'secrets'), { recursive: true });
    writeFileSync(join(liveDir, 'secrets', 'k.json'), '{"key":"不该出现"}');
    writeFileSync(join(liveDir, 'config.json'), '{"llm":{"apiKey":"不该出现"}}');
    mkdirSync(join(liveDir, 'presence'), { recursive: true });
    writeFileSync(join(liveDir, 'presence', 'qzone-cookie.json'), '{"cookie":"不该出现"}');
    writeFileSync(join(liveDir, 'presence', 'presence.json'), '{"ok":1}');
    mkdirSync(join(liveDir, 'photos'), { recursive: true });
    writeFileSync(join(liveDir, 'photos', 'a.jpg'), 'x');
    const ids = ['ep-1', 'a5db1eb499a38621:ep-1', 'diary:2026-10-25', 'week:2026-10-19'];
    const docs: Record<string, unknown> = {
        'diary:2026-10-25': { id: 'diary:2026-10-25', original_text: diaryDoc.text, tags: diaryDoc.tags, retain_params: { context: diaryDoc.context, entities: diaryDoc.entities, event_date: diaryDoc.eventDate, metadata: diaryDoc.metadata } },
        'week:2026-10-19': { id: 'week:2026-10-19', original_text: weekDoc.text, tags: weekDoc.tags, retain_params: { context: weekDoc.context, entities: weekDoc.entities, event_date: weekDoc.eventDate, metadata: weekDoc.metadata } },
    };
    const fetchImpl: FetchLike = async url => {
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        const list = /\/documents\?limit=(\d+)&offset=(\d+)$/.exec(path);
        if (list) return { ok: true, status: 200, json: async () => ({ items: ids.map(id => ({ id })), total: ids.length }) };
        const id = decodeURIComponent(path.split('/documents/')[1]!);
        return { ok: !!docs[id], status: docs[id] ? 200 : 404, json: async () => docs[id] };
    };
    const bundleDir = join(temp(), 'bundle');
    await exportBundle({ liveDir, outDir: bundleDir, hindsightUrl: 'http://127.0.0.1:8888', commonBank: 'old-prefix-common', fetchImpl, now: () => new Date('2026-10-30T12:00:00Z') });
    return { bundleDir, liveDir };
}

describe('素材包导出 / 读取', () => {
    test('带上聊天、她自己写的文档、diary.json、存档；密钥 / 配置 / 名字像 cookie 的 / 照片不带；manifest 记哈希', async () => {
        const { bundleDir } = await makeBundle();
        const bundle = readBundle(bundleDir);
        assert.deepEqual([...bundle.chats.keys()].sort(), ['111.jsonl', '222.jsonl']);
        assert.equal(bundle.chats.get('111.jsonl')!.length, 3);
        assert.deepEqual(bundle.docs.map(d => d.id), ['diary:2026-10-25', 'week:2026-10-19']);
        assert.equal(bundle.diary!.written!['2026-10-25'], 268);
        assert.deepEqual(bundle.manifest.counts.docs, { diary: 1, week: 1 });
        const all = Object.keys(bundle.manifest.files);
        assert.ok(all.includes('archive/promises/111-boyfriend.json') && all.includes('archive/memory/111-boyfriend.json') && all.includes('archive/presence/presence.json'));
        for (const banned of ['secrets', 'config.json', 'cookie', 'photos']) assert.ok(!all.some(f => f.includes(banned)), banned);
        assert.equal(bundle.manifest.source.dir, bundle.manifest.source.dir.replace(/[\\/]/g, ''), '只记目录名，不带路径');
        assert.ok(!readFileSync(join(bundleDir, 'manifest.json'), 'utf8').includes(tmpdir()), 'manifest 里没有本机的目录路径（只有目录名）');
    });

    test('--chats：只带点名的联系人的聊天，别人的不进素材包', async () => {
        const { liveDir } = await makeBundle();
        const out = join(temp(), 'only-one');
        const manifest = await exportBundle({ liveDir, outDir: out, hindsightUrl: 'http://x', commonBank: 'b', chats: ['111'], fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ items: [], total: 0 }) }) });
        assert.deepEqual(Object.keys(manifest.counts.chats), ['111.jsonl']);
        assert.deepEqual(readdirSync(join(out, 'chats')), ['111.jsonl']);
        const archived = Object.keys(manifest.files).filter(f => f.startsWith('archive/'));
        assert.ok(archived.includes('archive/promises/111-boyfriend.json') && !archived.some(f => f.includes('222')), '别的联系人的存档文件也不带');
    });

    test('输出目录不是空的就拒绝；包被改过 / 缺文件，读的时候直接报错', async () => {
        const { bundleDir, liveDir } = await makeBundle();
        await assert.rejects(exportBundle({ liveDir, outDir: bundleDir, hindsightUrl: 'http://x', commonBank: 'b', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ items: [], total: 0 }) }) }), /不是空目录/);
        writeFileSync(join(bundleDir, 'chats', '111.jsonl'), '改过了\n');
        assert.throws(() => readBundle(bundleDir), /哈希对不上 chats\/111.jsonl/);
        rmSync(join(bundleDir, 'docs.jsonl'));
        assert.throws(() => readBundle(bundleDir), /缺文件 docs.jsonl/);
        assert.throws(() => readBundle(temp()), /不是素材包/);
    });
});

/** 新机器的数据目录：有 111 的聊天（含和素材重叠的一条）和自己的 diary.json，没有 222 */
function makeTarget(): string {
    const dataDir = temp();
    mkdirSync(join(dataDir, 'chats'), { recursive: true });
    mkdirSync(join(dataDir, 'memory'), { recursive: true });
    writeFileSync(join(dataDir, 'chats', '111.jsonl'), serializeChatRows([row(T('09:00:02', '2026-10-26'), 'user', '睡了', { messageId: 5 }), row(T('10:00:00', '2026-10-28'), 'user', '新机器上的')]));
    writeFileSync(join(dataDir, 'memory', 'diary.json'), JSON.stringify({ written: { '2026-10-28': 50 }, texts: { '2026-10-28': '新机器的日记' }, weeks: {}, phases: {} }));
    return dataDir;
}

const fakeApi = (initial: Record<string, string> = {}) => {
    const stored = new Map(Object.entries(initial));
    const retained: { bank: string; item: MemoryItem }[] = [];
    const api: MigrationApi = {
        async retain(bank, item) { retained.push({ bank, item }); stored.set(item.document_id, item.content); },
        async getDocument(_bank, id) { return stored.has(id) ? { original_text: stored.get(id)! } : undefined; },
        async activeOperations() { return []; },
    };
    return { api, retained, stored };
};

describe('新机器上 plan / apply', () => {
    test('plan 只看不写：并多少、跳过哪些（新机器上没有的联系人默认跳过）、diary 多几个、几篇文档；写了什么都没有', async () => {
        const { bundleDir } = await makeBundle();
        const dataDir = makeTarget();
        const before = readFileSync(join(dataDir, 'chats', '111.jsonl'), 'utf8');
        const plan = planImport({ dataDir, bundle: readBundle(bundleDir) });
        const chat = plan.chats.find(c => c.file === '111.jsonl')!;
        assert.deepEqual([chat.status, chat.existing, chat.incoming, chat.added, chat.duplicates], ['merge', 2, 3, 2, 1]);
        assert.equal(plan.chats.find(c => c.file === '222.jsonl')!.status, 'skip-not-present');
        assert.deepEqual(plan.diary.added, { written: 1, texts: 1, weeks: 1, phases: 0 });
        assert.deepEqual(plan.docs, { total: 2, byKind: { diary: 1, week: 1 } });
        assert.deepEqual(plan.problems, []);
        assert.equal(readFileSync(join(dataDir, 'chats', '111.jsonl'), 'utf8'), before);
        assert.deepEqual(readdirSync(dataDir).sort(), ['chats', 'memory']);
        assert.match(describePlan(plan), /并进 2 条.*1 条重复不动/);
    });

    test('--only 和 --create-missing', async () => {
        const { bundleDir } = await makeBundle();
        const dataDir = makeTarget();
        const bundle = readBundle(bundleDir);
        assert.equal(planImport({ dataDir, bundle, only: ['222'] }).chats.find(c => c.file === '111.jsonl')!.status, 'skip-excluded');
        assert.equal(planImport({ dataDir, bundle, createMissing: true }).chats.find(c => c.file === '222.jsonl')!.status, 'merge');
    });

    test('Koishi 还在跑（bot.lock 里的 PID 活着）就拒绝，什么都不写', async () => {
        const { bundleDir } = await makeBundle();
        const dataDir = makeTarget();
        writeFileSync(join(dataDir, 'bot.lock'), String(process.pid));
        const before = readFileSync(join(dataDir, 'chats', '111.jsonl'), 'utf8');
        assert.ok(planImport({ dataDir, bundle: readBundle(bundleDir) }).problems[0]!.includes('先把 Koishi 停掉'));
        await assert.rejects(applyImport({ dataDir, bundle: readBundle(bundleDir), api: fakeApi().api, commonBank: 'c' }), /Koishi/);
        assert.equal(readFileSync(join(dataDir, 'chats', '111.jsonl'), 'utf8'), before);
        assert.ok(!readdirSync(dataDir).some(n => n.startsWith('migration-')));
    });

    test('apply：先备份；并聊天（已有的一行不改）；并 diary.json；把她自己写的文档原样写进公共库；存档不启用；留 migration-done.json；锁用完就还', async () => {
        const { bundleDir } = await makeBundle();
        const dataDir = makeTarget();
        writeFileSync(join(dataDir, 'bot.lock'), '999999'); // 已经死了的旧锁
        const original = readFileSync(join(dataDir, 'chats', '111.jsonl'), 'utf8');
        const { api, retained } = fakeApi();
        const result = await applyImport({ dataDir, bundle: readBundle(bundleDir), api, commonBank: 'linmengyao-common', now: () => new Date(2026, 9, 30, 18, 30, 5), waitMs: 1000 });

        assert.equal(result.backupDir, join(dataDir, 'migration-backup-20261030-183005'));
        assert.equal(readFileSync(join(result.backupDir, 'chats', '111.jsonl'), 'utf8'), original);
        assert.ok(existsSync(join(result.backupDir, 'memory', 'diary.json')));

        const merged = parseChatJsonl(readFileSync(join(dataDir, 'chats', '111.jsonl'), 'utf8')).rows;
        assert.deepEqual(merged.map(r => r.content), ['早', '早呀', '睡了', '新机器上的']);
        assert.equal(merged[2]!.messageId, 5, '重叠那条保留新机器上原来的行（带它的 messageId）');
        assert.equal(existsSync(join(dataDir, 'chats', '222.jsonl')), false);

        const diary = JSON.parse(readFileSync(join(dataDir, 'memory', 'diary.json'), 'utf8'));
        assert.deepEqual(Object.keys(diary.written).sort(), ['2026-10-25', '2026-10-28']);
        assert.equal(diary.texts['2026-10-28'], '新机器的日记');
        assert.deepEqual(Object.keys(diary.weeks), ['2026-10-19']);

        assert.deepEqual(retained.map(r => [r.bank, r.item.document_id]), [['linmengyao-common', 'diary:2026-10-25'], ['linmengyao-common', 'week:2026-10-19']]);
        assert.deepEqual(retained[0]!.item, memoryItemOf(diaryDoc));
        assert.equal(result.waited, 'done');

        const archive = join(dataDir, archiveDirName(readBundle(bundleDir)));
        assert.equal(archiveDirName(readBundle(bundleDir)), 'vm-archive-20261030');
        assert.ok(existsSync(join(archive, 'promises', '111-boyfriend.json')) && existsSync(join(archive, 'memory', '111-boyfriend.json')));
        assert.ok(!existsSync(join(dataDir, 'promises')), '存档不启用：承诺没有被放进新机器的运行目录');
        assert.ok(!existsSync(join(dataDir, 'memory', '111-boyfriend.json')), '新机器自己的写入进度没被旧的覆盖 / 新建');
        assert.equal(JSON.parse(readFileSync(join(dataDir, 'migration-done.json'), 'utf8')).docs.retained, 2);
        assert.equal(existsSync(join(dataDir, 'bot.lock')), false, '锁用完就还');
    });

    test('再跑一遍结果一样：聊天不再多、文档不重写（已经有同样的）、新机器上同 id 内容不一样的不覆盖并列出来', async () => {
        const { bundleDir } = await makeBundle();
        const dataDir = makeTarget();
        const bundle = readBundle(bundleDir);
        const { api, retained } = fakeApi({ 'week:2026-10-19': '新机器上她自己写的另一篇周记' });
        const first = await applyImport({ dataDir, bundle, api, commonBank: 'c', now: () => new Date(2026, 9, 30, 18, 0, 0) });
        assert.deepEqual([first.docs.retained, first.docs.same, first.docs.conflicts], [['diary:2026-10-25'], [], ['week:2026-10-19']]);
        const after = readFileSync(join(dataDir, 'chats', '111.jsonl'), 'utf8');
        const second = await applyImport({ dataDir, bundle, api, commonBank: 'c', now: () => new Date(2026, 9, 30, 18, 5, 0) });
        assert.deepEqual([second.docs.retained, second.docs.same], [[], ['diary:2026-10-25']]);
        assert.equal(readFileSync(join(dataDir, 'chats', '111.jsonl'), 'utf8'), after);
        assert.equal(retained.length, 1);
        assert.equal(second.plan.chats.find(c => c.file === '111.jsonl')!.added, 0);
    });
});

describe('迁完之后：记忆补齐了没有', () => {
    const at = (ms: number) => new Date(ms).toISOString();
    const H = 3_600_000;
    const base = Date.parse('2026-10-10T00:00:00Z');

    test('相邻两条隔 45 分钟以上是新片段，id 是 ep-<首条毫秒>；最后一段还没结束（离现在不到 45 分钟）的不算', () => {
        const rows = [row(at(base), 'user', 'a'), row(at(base + 10 * 60_000), 'assistant', 'b'), row(at(base + 3 * H), 'user', 'c'), row(at(base + 3 * H + 5 * 60_000), 'assistant', 'd'), row(at(base + 9 * H), 'user', 'e')];
        assert.deepEqual(expectedEpisodeIds(rows, base + 9 * H + 10 * 60_000), [`ep-${base}`, `ep-${base + 3 * H}`]);
        assert.deepEqual(expectedEpisodeIds(rows, base + 9 * H + 50 * 60_000), [`ep-${base}`, `ep-${base + 3 * H}`, `ep-${base + 9 * H}`]);
        assert.deepEqual(expectedEpisodeIds([], base), []);
    });

    test('和 Hindsight 里实际有的比：缺的列出来；公共库的 id 带「哈希:」前缀', () => {
        assert.deepEqual(memoryGap(['ep-1', 'ep-2', 'ep-3'], ['ep-1', 'ep-3', 'diary:2026-10-25']), { expected: 3, present: 2, missing: ['ep-2'] });
        assert.deepEqual(memoryGap(['ep-1', 'ep-2'], ['a5db:ep-1', 'a5db:ep-2'], 'a5db:'), { expected: 2, present: 2, missing: [] });
    });
});
