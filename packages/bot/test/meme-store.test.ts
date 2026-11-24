import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { commitMemeRefresh, MemeStoreLockError, readMemeFile, replaceMemes, updateMemes, withMemeStoreLock, type MemeRefreshDelta } from '../src/language/meme-store.ts';
import type { MemeEntry, MemeFile } from '../src/language/memes.ts';

// 热梗库的读写（language/meme-store.ts）：只直接测这个模块的规则；跨进程并发和 CLI 见 memory-memes-concurrency-review.test.ts。
const dirs: string[] = [];
const memesFile = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-meme-store-')); dirs.push(d); return join(d, 'memes', 'memes.json'); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const entry = (term: string, over: Partial<MemeEntry> = {}): MemeEntry => ({
    term, meaning: `${term}的合成意思`, example: `${term}例句`, confidence: 'high', firstSeen: '2026-11-01', lastSeen: '2026-11-10', seen: 1, ...over,
});
const write = (path: string, file: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(file)); };
const onDisk = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as MemeFile;
const delta = (over: Partial<MemeRefreshDelta> = {}): MemeRefreshDelta => ({ terms: [], learned: [], today: '2026-11-20', refreshedAt: '2026-11-20T08:00:00.000Z', keepDays: 45, max: 40, ...over });

describe('协调锁', () => {
    test('同步操作：返回结果，建好目录和协调文件；锁不嵌套也能连续用', () => {
        const path = memesFile();
        assert.equal(withMemeStoreLock(path, () => 7), 7);
        assert.equal(existsSync(`${path}.coordination.sqlite`), true);
        assert.equal(withMemeStoreLock(path, () => 'again'), 'again');
    });

    test('不收异步操作（返回 promise 的）：抛 TypeError，锁照样放掉', () => {
        const path = memesFile();
        assert.throws(() => withMemeStoreLock(path, (() => Promise.resolve(1)) as unknown as () => number), TypeError);
        assert.equal(withMemeStoreLock(path, () => 'ok'), 'ok', '后来的还能拿到锁');
    });

    test('操作自己抛错：原样抛出，锁放掉', () => {
        const path = memesFile();
        assert.throws(() => withMemeStoreLock(path, () => { throw new Error('作者操作失败'); }), /作者操作失败/);
        assert.equal(withMemeStoreLock(path, () => 1), 1);
    });

    test('锁持有时再进同一把锁：报繁忙、可重试，里面的操作不执行', () => {
        const path = memesFile();
        let inner = false;
        withMemeStoreLock(path, () => {
            assert.throws(() => withMemeStoreLock(path, () => { inner = true; }), (error: unknown) => error instanceof MemeStoreLockError && error.retryable === true && /繁忙/.test(error.message));
        });
        assert.equal(inner, false);
    });

    test('协调文件打不开（路径是个目录）：报不可重试的锁错误，不跑操作', () => {
        const path = memesFile();
        mkdirSync(`${path}.coordination.sqlite`, { recursive: true });
        let ran = false;
        assert.throws(() => withMemeStoreLock(path, () => { ran = true; }), (error: unknown) => error instanceof MemeStoreLockError && error.retryable === false && error.name === 'MemeStoreLockError');
        assert.equal(ran, false);
    });
});

describe('读热梗库', () => {
    test('文件不存在：空库，不建 JSON', () => {
        const path = memesFile();
        assert.deepEqual(readMemeFile(path), { version: 1, entries: [] });
        assert.equal(existsSync(path), false);
    });

    test('合法文件原样读回', () => {
        const path = memesFile();
        const file: MemeFile = { version: 1, refreshedAt: '2026-11-10T00:00:00.000Z', entries: [entry('a', { authorRevision: 2 })], revision: 3, authorRevision: 2 };
        write(path, file);
        assert.deepEqual(readMemeFile(path), file);
    });

    test('坏文件一律拒绝（不当成空库重建），错误里不带原文；原文件不动', () => {
        const bad: Record<string, unknown> = {
            半截: '{"version":1,"entries":[{"term":"SYNTHETIC_PRIVATE',
            版本不对: { version: 2, entries: [] },
            重复词: { version: 1, entries: [entry('a'), entry('a')] },
            空词: { version: 1, entries: [entry('  ')] },
            空解释: { version: 1, entries: [entry('a', { meaning: ' ' })] },
            日期反了: { version: 1, entries: [entry('a', { firstSeen: '2026-11-11', lastSeen: '2026-11-10' })] },
            日期不存在: { version: 1, entries: [entry('a', { lastSeen: '2026-02-30' })] },
            seen为零: { version: 1, entries: [entry('a', { seen: 0 })] },
            置信度不认识: { version: 1, entries: [entry('a', { confidence: 'low' as never })] },
            作者版本超过总版本: { version: 1, revision: 1, authorRevision: 2, entries: [] },
            条目作者版本超过全局: { version: 1, revision: 3, authorRevision: 1, entries: [entry('a', { authorRevision: 2 })] },
            刷新时间不合法: { version: 1, refreshedAt: 'yesterday', entries: [] },
        };
        for (const [name, value] of Object.entries(bad)) {
            const path = memesFile();
            mkdirSync(join(path, '..'), { recursive: true });
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            writeFileSync(path, text);
            assert.throws(() => readMemeFile(path), (error: unknown) => error instanceof Error && /拒绝把作者资料当空白重建/.test(error.message) && !error.message.includes('SYNTHETIC_PRIVATE'), name);
            assert.equal(readFileSync(path, 'utf8'), text, `${name}：原文件不动`);
        }
    });
});

describe('作者更新（updateMemes / replaceMemes）', () => {
    test('改了的、新加的、点名 touch 的条目拿到新的作者版本；没动的保留旧版本', () => {
        const path = memesFile();
        write(path, { version: 1, revision: 4, authorRevision: 3, entries: [entry('留着', { authorRevision: 1 }), entry('要改', { authorRevision: 2 }), entry('点名', { authorRevision: 3 })] });
        const result = updateMemes(path, fresh => ({
            ...fresh,
            entries: [...fresh.entries.map(e => (e.term === '要改' ? { ...e, meaning: '新的解释' } : e)), entry('新的')],
        }), { touch: ['点名'] });
        assert.equal(result.revision, 5);
        assert.equal(result.authorRevision, 5);
        assert.deepEqual(Object.fromEntries(result.entries.map(e => [e.term, e.authorRevision])), { 留着: 1, 要改: 5, 点名: 5, 新的: 5 });
        assert.deepEqual(onDisk(path), result);
    });

    test('回调拿到的是副本：在里面乱改再返回 undefined，库和文件都不变', () => {
        const path = memesFile();
        write(path, { version: 1, entries: [entry('a')] });
        const before = readFileSync(path, 'utf8');
        const result = updateMemes(path, fresh => { fresh.entries[0]!.meaning = '偷偷改'; return undefined; });
        assert.equal(result.entries[0]!.meaning, 'a的合成意思');
        assert.equal(readFileSync(path, 'utf8'), before);
    });

    test('提议的结构无效（重复词）或回调是异步的：拒绝，原文件不变', () => {
        const path = memesFile();
        write(path, { version: 1, entries: [entry('a')] });
        const before = readFileSync(path, 'utf8');
        assert.throws(() => updateMemes(path, fresh => ({ ...fresh, entries: [entry('b'), entry('b')] })), /作者更新结构无效/);
        assert.throws(() => updateMemes(path, (async (fresh: MemeFile) => fresh) as unknown as (fresh: MemeFile) => MemeFile), /只接受同步操作/);
        assert.equal(readFileSync(path, 'utf8'), before);
    });

    test('修订计数到安全上限：拒绝，不调回调', () => {
        const path = memesFile();
        write(path, { version: 1, revision: Number.MAX_SAFE_INTEGER, entries: [] });
        let called = false;
        assert.throws(() => updateMemes(path, fresh => { called = true; return fresh; }), /安全上限/);
        assert.equal(called, false);
    });

    test('replaceMemes：整份替换，所有条目都算作者碰过；结构无效的不进锁直接拒', () => {
        const path = memesFile();
        write(path, { version: 1, revision: 2, authorRevision: 1, entries: [entry('a', { authorRevision: 1 })] });
        const replaced = replaceMemes(path, { version: 1, entries: [entry('a'), entry('b')] });
        assert.deepEqual(replaced.entries.map(e => [e.term, e.authorRevision]), [['a', 3], ['b', 3]]);
        assert.throws(() => replaceMemes(path, { version: 1, entries: [entry('x', { seen: -1 })] }), /替换结构无效/);
        assert.deepEqual(onDisk(path).entries.map(e => e.term), ['a', 'b']);
    });
});

describe('后台刷新提交（commitMemeRefresh）', () => {
    test('日期不合法：直接拒，不碰文件', () => {
        const path = memesFile();
        assert.throws(() => commitMemeRefresh(path, { version: 1, entries: [] }, delta({ today: '2026-13-01' })), /日期无效/);
        assert.throws(() => commitMemeRefresh(path, { version: 1, entries: [] }, delta({ refreshedAt: '2026-11-20' })), /日期无效/);
        assert.equal(existsSync(path), false);
    });

    test('榜上又出现的词：作者没改过就 +1 并更新最后见到；新学的词加进来（作者版本 0）', () => {
        const path = memesFile();
        const base: MemeFile = { version: 1, entries: [entry('老梗')] };
        write(path, base);
        const { file, added, bumped } = commitMemeRefresh(path, base, delta({ terms: ['老梗', '不在库里'], learned: [entry('新梗', { firstSeen: '2026-11-20', lastSeen: '2026-11-20' })] }));
        assert.equal(added, 1);
        assert.equal(bumped, 1);
        const old = file.entries.find(e => e.term === '老梗')!;
        assert.equal(old.seen, 2);
        assert.equal(old.lastSeen, '2026-11-20');
        assert.equal(file.entries.find(e => e.term === '新梗')!.authorRevision, 0);
        assert.equal(file.revision, 1);
        assert.equal(file.refreshedAt, '2026-11-20T08:00:00.000Z');
        assert.deepEqual(onDisk(path), file);
    });

    test('作者在刷新期间改了这个词的解释：不给它 +1（不把旧观察记到新解释上）', () => {
        const path = memesFile();
        const base: MemeFile = { version: 1, entries: [entry('梗')] };
        write(path, { version: 1, revision: 1, authorRevision: 1, entries: [entry('梗', { meaning: '作者新解释', authorRevision: 1 })] });
        const { file, bumped } = commitMemeRefresh(path, base, delta({ terms: ['梗'] }));
        assert.equal(bumped, 0);
        assert.equal(file.entries[0]!.seen, 1);
        assert.equal(file.entries[0]!.meaning, '作者新解释');
    });

    test('刷新期间作者有过任何操作（全局作者版本变了）：新学的词先不加，下次再学', () => {
        const path = memesFile();
        const base: MemeFile = { version: 1, entries: [] };
        write(path, { version: 1, revision: 1, authorRevision: 1, entries: [] });
        const { file, added } = commitMemeRefresh(path, base, delta({ learned: [entry('被删过的梗')] }));
        assert.equal(added, 0);
        assert.deepEqual(file.entries, []);
    });

    test('新学的词其实别处已经加进库（比如另一轮刷新）：当成又见了一次，不重复加', () => {
        const path = memesFile();
        const base: MemeFile = { version: 1, entries: [] };
        write(path, { version: 1, revision: 1, entries: [entry('同一个梗')] });
        const { file, added, bumped } = commitMemeRefresh(path, base, delta({ learned: [entry('同一个梗', { meaning: '另一种说法' })] }));
        assert.equal(added, 0);
        assert.equal(bumped, 1);
        assert.equal(file.entries.length, 1);
        assert.equal(file.entries[0]!.meaning, '同一个梗的合成意思');
    });

    test('修剪：超过保留天数的丢掉，按最后见到、再按次数排，只留前 max 个', () => {
        const path = memesFile();
        const base: MemeFile = { version: 1, entries: [] };
        write(path, { version: 1, entries: [
            entry('过期', { firstSeen: '2026-01-01', lastSeen: '2026-10-01' }),
            entry('次数少', { lastSeen: '2026-11-19', seen: 1 }),
            entry('次数多', { lastSeen: '2026-11-19', seen: 5 }),
            entry('最近', { lastSeen: '2026-11-20' }),
        ] });
        const { file } = commitMemeRefresh(path, base, delta({ keepDays: 30, max: 2 }));
        assert.deepEqual(file.entries.map(e => e.term), ['最近', '次数多']);
    });

    test('刷新时间不倒退：较旧的一轮晚提交，保留较新的 refreshedAt', () => {
        const path = memesFile();
        write(path, { version: 1, refreshedAt: '2026-11-21T00:00:00.000Z', entries: [] });
        const { file } = commitMemeRefresh(path, { version: 1, entries: [] }, delta());
        assert.equal(file.refreshedAt, '2026-11-21T00:00:00.000Z');
    });

    test('停了（signal 已取消）：不写盘，原文件不变', () => {
        const path = memesFile();
        write(path, { version: 1, entries: [entry('a')] });
        const before = readFileSync(path, 'utf8');
        const controller = new AbortController();
        controller.abort(new Error('停了'));
        assert.throws(() => commitMemeRefresh(path, { version: 1, entries: [entry('a')] }, delta({ terms: ['a'], signal: controller.signal })), /停了/);
        assert.equal(readFileSync(path, 'utf8'), before);
    });

    test('学到的条目本身不合法：整份拒绝，不写半份', () => {
        const path = memesFile();
        write(path, { version: 1, entries: [entry('a')] });
        const before = readFileSync(path, 'utf8');
        assert.throws(() => commitMemeRefresh(path, { version: 1, entries: [entry('a')] }, delta({ learned: [entry('坏的', { meaning: '' })] })), /结构无效/);
        assert.equal(readFileSync(path, 'utf8'), before);
    });
});
