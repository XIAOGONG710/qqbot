import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { photoAllowance, photoShelf, PHOTO_HISTORY_PREFIX, PHOTO_MAX_BYTES, PHOTO_TARGET, type PhotoCandidate, type PhotoSource } from '../src/vision/photos.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = () => new Date('2026-11-05T12:00:00Z');
function fixture(source?: PhotoSource) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-review-')); dirs.push(dir);
    const logs: string[] = [];
    const make = () => photoShelf({ dir: join(dir, 'shelf'), now, log: line => logs.push(line), source, pauseMs: 0 });
    const file = (n: number) => { const file = join(dir, `${n}.jpg`); writeFileSync(file, `synthetic-${n}`); return file; };
    return { dir, root: join(dir, 'shelf'), path: join(dir, 'shelf', 'index.json'), logs, make, file };
}
const candidate = (n: number): PhotoCandidate => ({ kind: 'cat', title: `Synthetic-${n}`, pageUrl: 'https://example.org', imageUrl: `https://example.org/${n}`, width: 3000, height: 2000, license: 'CC0', artist: '', series: 'synthetic' });
const source = (): PhotoSource => ({ search: async kind => kind === 'cat' ? [candidate(1), candidate(2)] : [],
    download: async url => ({ bytes: new Uint8Array(130 * 1024).fill(url.endsWith('1') ? 1 : 2), type: 'image/jpeg' }),
    judge: async () => ({ keep: true, caption: '合成三花猫趴在地面上' }) });

test('坏索引明确失败、保留原文件且错误和日志不回显正文', () => {
    const f = fixture(); mkdirSync(f.root); const content = '{"PRIVATE_PHOTO_BODY":'; writeFileSync(f.path, content);
    assert.throws(f.make, error => error instanceof Error && !error.message.includes('PRIVATE_PHOTO_BODY'));
    assert.equal(readFileSync(f.path, 'utf8'), content); assert.ok(f.logs.every(line => !line.includes('PRIVATE_PHOTO_BODY')));
});

test('索引拒绝越界路径、重复身份与损坏计数，不能静默丢记录', () => {
    const f = fixture(); const shelf = f.make(); const entry = shelf.add(f.file(1), 'cat', '合成猫');
    const valid = JSON.parse(readFileSync(f.path, 'utf8'));
    for (const edits of [
        (value: typeof valid) => { value.entries[0].file = '../../1.jpg'; },
        (value: typeof valid) => { value.entries[0].used = -1; },
        (value: typeof valid) => { value.entries[0].addedAt = 'PRIVATE_BAD_DATE'; },
        (value: typeof valid) => { value.entries.push({ ...entry }); },
    ]) {
        const bad = structuredClone(valid); edits(bad); const text = JSON.stringify(bad); writeFileSync(f.path, text);
        assert.throws(f.make); assert.equal(readFileSync(f.path, 'utf8'), text);
    }
});

test('公开列表和添加返回值不能直接改写货架内部条目', () => {
    const f = fixture(); const shelf = f.make(); const entry = shelf.add(f.file(1), 'cat', '合成猫');
    entry.caption = '被外部改写'; shelf.list()[0]!.used = 999;
    assert.equal(shelf.list()[0]!.caption, '合成猫'); assert.equal(shelf.list()[0]!.used, 0);
});

test('used写盘失败保持内存原计数，恢复后只计一次', () => {
    const f = fixture(); const shelf = f.make(); const entry = shelf.add(f.file(1), 'cat', '合成猫');
    const backup = join(f.root, 'backup.json'); const before = readFileSync(f.path, 'utf8');
    renameSync(f.path, backup); mkdirSync(f.path);
    assert.throws(() => shelf.used(entry.id)); assert.equal(shelf.list()[0]!.used, 0);
    assert.equal(readFileSync(backup, 'utf8'), before);
    rmSync(f.path, { recursive: true }); renameSync(backup, f.path); shelf.used(entry.id);
    assert.equal(shelf.list()[0]!.used, 1); assert.equal(f.make().list()[0]!.used, 1);
});

test('发现照片提交失败不标记seen，恢复或重启后仍可重新收取', async () => {
    const f = fixture(source()); const shelf = f.make(); mkdirSync(f.root); mkdirSync(f.path);
    await assert.rejects(shelf.discover()); assert.equal(shelf.list().length, 0);
    rmSync(f.path, { recursive: true }); await shelf.discover(); assert.equal(shelf.list('cat').length, 2);
    assert.equal(f.make().list('cat').length, 2);
});

test('发现最后一个空位只收一张，不能超出目标', async () => {
    const f = fixture(source()); const shelf = f.make();
    for (let i = 0; i < PHOTO_TARGET.cat! - 1; i++) shelf.add(f.file(i + 10), 'cat', '合成旧猫照');
    await shelf.discover(); assert.equal(shelf.list('cat').length, PHOTO_TARGET.cat);
});

test('照片清理遵守本轮种类和菜名范围，兼容旧boolean调用', () => {
    const f = fixture(); const shelf = f.make(); const cat = shelf.add(f.file(1), 'cat', '合成猫'); const food = shelf.add(f.file(2), 'food', '合成饭', '合成菜甲');
    const clean = shelf.clean as (text: string, allow?: boolean, scope?: { kind?: 'cat' | 'food'; dish?: string }) => string;
    assert.equal(clean(`<photo:${food.id}>`, true, { kind: 'cat' }), '');
    assert.equal(clean(`<photo:${food.id}>`, true, { kind: 'food', dish: '合成菜乙' }), '');
    assert.equal(clean(`<photo:${food.id}>`, true, { kind: 'food', dish: '合成菜甲' }), `<photo:${food.id}>`);
    assert.equal(clean(`<photo:${cat.id}>`, true), `<photo:${cat.id}>`);
});

test('发送配额采用过去事实中的最新时间，不依赖数组顺序或未来记录', () => {
    const sent = (time: string) => ({ role: 'assistant' as const, content: `${PHOTO_HISTORY_PREFIX}合成猫`, time });
    assert.equal(photoAllowance([sent('2026-11-05T11:00:00Z'), sent('2026-11-05T02:00:00Z')], now().getTime()).allowed, false);
    assert.equal(photoAllowance([sent('2026-11-06T12:00:00Z')], now().getTime()).allowed, true);
});

test('图片文件写入失败不能永久标记看过，恢复后正常收图', async () => {
    const f = fixture(source()); const shelf = f.make(); mkdirSync(f.root); writeFileSync(join(f.root, 'files'), 'synthetic obstacle');
    await assert.rejects(shelf.discover());
    rmSync(join(f.root, 'files')); await shelf.discover(); assert.equal(shelf.list('cat').length, 2);
});

test('缺失图片可以重新添加修复，发现也能补回已登记但丢失的照片', async () => {
    const f = fixture(source()); const shelf = f.make(); const input = f.file(1); const entry = shelf.add(input, 'cat', '合成猫');
    rmSync(join(f.root, 'files', entry.file)); shelf.add(input, 'cat', '别的说明'); assert.equal(shelf.has('cat'), true);
    await shelf.discover(); const collected = shelf.list('cat').find(item => item.origin)!; assert.ok(collected);
    rmSync(join(f.root, 'files', collected.file)); await shelf.discover();
    assert.ok(shelf.resolve(`<photo:${collected.id}>`));
});

test('过大或被替换成目录的货架文件不提供发送路径', () => {
    const f = fixture(); const shelf = f.make(); const entry = shelf.add(f.file(1), 'cat', '合成猫'); const file = join(f.root, 'files', entry.file);
    truncateSync(file, PHOTO_MAX_BYTES + 1); assert.equal(shelf.resolve(`<photo:${entry.id}>`), undefined);
    rmSync(file); mkdirSync(file); assert.equal(shelf.has('cat'), false);
});

test('旧有效索引可省略seen，未知顶层与条目字段在正常写回后保留', () => {
    const f = fixture(); const shelf = f.make(); const entry = shelf.add(f.file(1), 'cat', '合成猫');
    const index = JSON.parse(readFileSync(f.path, 'utf8')); delete index.seen; index.extension = { keep: true }; index.entries[0].extension = 'keep';
    writeFileSync(f.path, JSON.stringify(index)); const again = f.make(); again.used(entry.id);
    const saved = JSON.parse(readFileSync(f.path, 'utf8')); assert.deepEqual(saved.extension, { keep: true }); assert.equal(saved.entries[0].extension, 'keep');
});

test('两个货架实例顺序修改时陈旧写明确冲突，不覆盖另一实例已提交的索引', () => {
    const f = fixture(); const first = f.make(); const stale = f.make(); first.add(f.file(1), 'cat', '合成猫甲');
    const before = readFileSync(f.path, 'utf8');
    assert.throws(() => stale.add(f.file(2), 'cat', '合成猫乙'), /更新|冲突/);
    assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(stale.list().length, 0);
    const fresh = f.make(); fresh.add(f.file(2), 'cat', '合成猫乙'); assert.equal(f.make().list().length, 2);
});

test('下载和看图的HTTP 5xx不永久耗掉候选，恢复后可以重试', async () => {
    for (const stage of ['download', 'judge'] as const) {
        const provider = source(); const download = provider.download; const judge = provider.judge; let broken = true;
        if (stage === 'download') provider.download = async url => { if (broken) throw new Error('HTTP 502'); return download(url); };
        else provider.judge = async (image, kind) => { if (broken) throw new Error('HTTP 504'); return judge(image, kind); };
        const f = fixture(provider); const shelf = f.make(); assert.equal(await shelf.discover(), 'retry');
        broken = false; await shelf.discover(); assert.equal(shelf.list('cat').length, 2);
    }
});

test('发现等待供应商期间手动填满目标，恢复后不能再超收', async () => {
    const provider = source(); const original = provider.download;
    let ready!: () => void; let resume!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; }); const gate = new Promise<void>(resolve => { resume = resolve; });
    provider.download = async url => { ready(); await gate; return original(url); };
    const f = fixture(provider); const shelf = f.make();
    for (let i = 0; i < PHOTO_TARGET.cat! - 1; i++) shelf.add(f.file(i + 10), 'cat', '合成旧猫照');
    const discovering = shelf.discover(); await waiting;
    try { shelf.add(f.file(99), 'cat', '合成最后空位'); } finally { resume(); }
    await discovering; assert.equal(shelf.list('cat').length, PHOTO_TARGET.cat);
});

test('猫照缓存全丢及重启后仍保留已登记系列，只修回原猫不换另一只', async () => {
    const provider = source(); const search = provider.search; const download = provider.download;
    const f = fixture(provider); const shelf = f.make(); await shelf.discover();
    for (const entry of shelf.list('cat')) rmSync(join(f.root, 'files', entry.file));
    let downloaded = 0;
    provider.search = async kind => kind === 'cat' ? [{ ...candidate(3), series: 'another-cat' }] : [];
    provider.download = async () => { downloaded++; return { bytes: new Uint8Array(130 * 1024).fill(9), type: 'image/jpeg' }; };
    const reopened = f.make(); await reopened.discover();
    assert.equal(downloaded, 0); assert.equal(reopened.has('cat'), false);
    provider.search = search; provider.download = download; await reopened.discover();
    assert.equal(reopened.list('cat').length, 2); assert.ok(reopened.list('cat').every(entry => entry.origin?.series === 'synthetic'));
});

test('照片发送后的历史依据登记元数据，缓存丢失不变原始令牌绕过配额', () => {
    const f = fixture(); const shelf = f.make(); const entry = shelf.add(f.file(1), 'cat', '合成猫'); const token = `<photo:${entry.id}>`;
    rmSync(join(f.root, 'files', entry.file));
    const reopened = f.make(); const history = reopened.history(token);
    assert.equal(history, `${PHOTO_HISTORY_PREFIX}合成猫`);
    assert.equal(reopened.resolve(token), undefined); assert.equal(reopened.prompt('cat'), undefined); assert.equal(reopened.clean(token), '');
    assert.equal(photoAllowance([{ role: 'assistant', content: history, time: '2026-11-05T11:00:00Z' }], now().getTime()).allowed, false);
});
