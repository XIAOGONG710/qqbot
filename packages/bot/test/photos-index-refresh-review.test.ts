import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileOps } from '../src/memory/json-file.ts';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { PHOTO_INDEX_LOCK_FILE } from '../src/vision/photo-index-lock.ts';
import { photoShelf, PHOTO_HISTORY_PREFIX, PHOTO_TARGET, type FoodSource, type PhotoCandidate, type PhotoSource } from '../src/vision/photos.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-refresh-')); dirs.push(dir);
    const root = join(dir, 'shelf');
    const make = (source?: PhotoSource, foodSource?: FoodSource) => photoShelf({ dir: root, log: () => {}, now: () => new Date('2026-11-05T12:00:00Z'), source, foodSource, pauseMs: 0 });
    const file = (n: number) => { const path = join(dir, `${n}.jpg`); writeFileSync(path, `synthetic-${n}`); return path; };
    return { root, make, file };
};
const source = (series: string, n: number): PhotoSource => ({ search: async kind => kind === 'cat' ? [{ kind, title: `synthetic-${n}`, series,
    pageUrl: 'https://example.org', imageUrl: 'https://example.org/image', width: 3000, height: 2000, license: 'CC0', artist: '' } satisfies PhotoCandidate] : [],
    download: async () => ({ bytes: new Uint8Array(130 * 1024).fill(n), type: 'image/jpeg' }), judge: async () => ({ keep: true, caption: '合成猫照' }) });
function gate(provider: PhotoSource) {
    const original = provider.download; let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>(done => { entered = done; }); const wait = new Promise<void>(done => { release = done; });
    provider.download = async url => { entered(); await wait; return original(url); }; return { ready, release };
}

test('旧实例公开读取看见CLI式新增与删除，顺序delta不会覆盖其它变更', () => {
    const f = fixture(); const a = f.make(); const b = f.make(); const first = a.add(f.file(1), 'cat', '合成猫甲');
    const token = `<photo:${first.id}>`;
    assert.equal(b.list().length, 1); assert.ok(b.has('cat')); assert.ok(b.prompt('cat')?.includes(first.id)); assert.equal(b.clean(token), token);
    assert.equal(b.status().count, 1); assert.equal(b.history(token), `${PHOTO_HISTORY_PREFIX}合成猫甲`);
    b.add(f.file(2), 'view', '合成天空'); a.used(first.id); b.used(first.id); assert.equal(a.list('cat')[0]!.used, 2);
    assert.equal(b.remove(first.id), true); assert.equal(a.resolve(token), undefined); assert.equal(a.status().count, 1);
});

test('resolve发送时说明保持幂等，CLI删除重加不同caption后直到新resolve才更新', () => {
    const f = fixture(); const a = f.make(); const entry = a.add(f.file(1), 'cat', '发送时说明'); const b = f.make(); const token = `<photo:${entry.id}>`;
    assert.ok(a.resolve(token)); b.remove(entry.id);
    assert.equal(a.history(token), `${PHOTO_HISTORY_PREFIX}发送时说明`); assert.equal(a.history(token), `${PHOTO_HISTORY_PREFIX}发送时说明`);
    assert.equal(a.resolve(token), undefined);
    b.add(f.file(1), 'cat', '重新添加的新说明'); assert.equal(a.history(token), `${PHOTO_HISTORY_PREFIX}发送时说明`);
    assert.ok(a.resolve(token)); assert.equal(a.history(token), `${PHOTO_HISTORY_PREFIX}重新添加的新说明`);
});

test('实际resolve的receipt在索引损坏后仍保留已发送事实，其它新读取失败关闭', () => {
    const f = fixture(); const shelf = f.make(); const entry = shelf.add(f.file(1), 'cat', '发送时说明'); const token = `<photo:${entry.id}>`;
    assert.ok(shelf.resolve(token)); writeFileSync(join(f.root, 'index.json'), '{synthetic corrupt');
    assert.equal(shelf.history(token), `${PHOTO_HISTORY_PREFIX}发送时说明`);
    assert.equal(shelf.history('普通文字没有照片令牌'), '普通文字没有照片令牌');
    assert.throws(() => shelf.list()); assert.throws(() => shelf.resolve(token)); assert.throws(() => shelf.history('<photo:ffffffffffff>'));
});

test('rename已发布JSON却报错时读回确认成功，不重放used增量', () => {
    const f = fixture(); const shelf = f.make(); const entry = shelf.add(f.file(1), 'cat', '合成猫'); const original = fileOps.renameSync;
    fileOps.renameSync = ((from, to) => { original(from, to); if (String(to).endsWith('index.json')) throw Object.assign(new Error('synthetic after rename'), { code: 'EIO' }); }) as typeof original;
    try { assert.doesNotThrow(() => shelf.used(entry.id)); } finally { fileOps.renameSync = original; }
    assert.equal(shelf.list()[0]!.used, 1); assert.equal(f.make().list()[0]!.used, 1);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'index.json'), 'utf8')).entries[0].used, 1);
});

test('异步下载期间其它实例确定猫系列，旧候选不能混入另一只猫', async () => {
    const f = fixture(); const slow = source('cat-a', 1); const hold = gate(slow); const a = f.make(slow); const b = f.make(source('cat-b', 2));
    const pending = a.discover(); await hold.ready;
    try { await b.discover(); } finally { hold.release(); }
    await pending; assert.equal(a.list('cat').length, 1); assert.equal(a.list('cat')[0]!.origin?.series, 'cat-b');
});

test('异步补图期间CLI移除登记条目，迟到结果不复活照片', async () => {
    const f = fixture(); const provider = source('cat-a', 1); const a = f.make(provider); await a.discover(); const entry = a.list()[0]!;
    rmSync(join(f.root, 'files', entry.file)); const hold = gate(provider); const pending = a.discover(); await hold.ready;
    try { assert.equal(f.make().remove(entry.id), true); } finally { hold.release(); }
    await pending; assert.equal(a.list().length, 0); assert.equal(existsSync(join(f.root, 'files', entry.file)), false);
});

test('异步下载期间其它实例填满容量，迟到结果正常跳过且不超收', async () => {
    const f = fixture(); const provider = source('cat-a', 1); const hold = gate(provider); const a = f.make(provider); const b = f.make();
    for (let n = 0; n < PHOTO_TARGET.cat! - 1; n++) a.add(f.file(n + 10), 'cat', '合成旧猫照');
    const pending = a.discover(); await hold.ready;
    try { b.add(f.file(99), 'cat', '合成最后空位'); } finally { hold.release(); }
    await pending; assert.equal(a.list('cat').length, PHOTO_TARGET.cat);
});

test('food异步提交使用fresh菜名容量，拒绝结果的seen更新也保留其它新增', async () => {
    const f = fixture(); const food: FoodSource = { search: async dish => [{ kind: 'food', title: 'synthetic-food', series: dish, pageUrl: 'https://example.org', imageUrl: 'https://example.org/image', width: 3000, height: 2000, license: 'CC0', artist: '' }],
        download: async () => ({ bytes: new Uint8Array(80 * 1024).fill(7), type: 'image/jpeg' }), judge: async () => ({ keep: true, caption: '合成饭照' }) };
    let ready!: () => void; let release!: () => void; const waiting = new Promise<void>(done => { ready = done; }); const wait = new Promise<void>(done => { release = done; });
    const original = food.download; food.download = async url => { ready(); await wait; return original(url); };
    const a = f.make(undefined, food); const b = f.make(); a.add(f.file(1), 'food', '合成菜甲旧照', '合成菜甲');
    const pending = a.discoverFood(['合成菜甲']); await waiting;
    try { b.add(f.file(2), 'food', '合成菜甲最后空位', '合成菜甲'); b.add(f.file(3), 'food', '合成菜乙', '合成菜乙'); } finally { release(); }
    await pending; assert.equal(a.list('food', '合成菜甲').length, 2); assert.equal(a.list('food', '合成菜乙').length, 1);
    const rejecting = source('cat-a', 8); const hold = gate(rejecting); rejecting.judge = async () => ({ keep: false, caption: '' });
    const c = f.make(rejecting); const rejection = c.discover(); await hold.ready;
    try { b.add(f.file(4), 'view', '拒绝结果等待期间新增'); } finally { hold.release(); }
    await rejection; assert.equal(c.list('view').length, 1); assert.ok(JSON.parse(readFileSync(join(f.root, 'index.json'), 'utf8')).seen.includes('synthetic-8'));
});

test('resolve receipt只保留最近128个caption，不需要旧文件或索引条目持续存在', () => {
    const f = fixture(); mkdirSync(join(f.root, 'files'), { recursive: true });
    const entries = Array.from({ length: 129 }, (_, n) => ({ id: n.toString(16).padStart(12, '0'), file: `${n.toString(16).padStart(12, '0')}.jpg`, kind: 'cat', caption: `合成说明${n}`, addedAt: '2026-11-05T12:00:00Z', used: 0 }));
    for (const entry of entries) writeFileSync(join(f.root, 'files', entry.file), 'synthetic');
    writeFileSync(join(f.root, 'index.json'), JSON.stringify({ version: 1, entries, seen: [] })); const shelf = f.make();
    for (const entry of entries) assert.ok(shelf.resolve(`<photo:${entry.id}>`));
    writeFileSync(join(f.root, 'index.json'), JSON.stringify({ version: 1, entries: [], seen: [] }));
    assert.equal(shelf.history(`<photo:${entries[0]!.id}>`), `<photo:${entries[0]!.id}>`);
    assert.equal(shelf.history(`<photo:${entries[1]!.id}>`), `${PHOTO_HISTORY_PREFIX}合成说明1`);
});

test('两个独立进程同时add及used都保留，JSON仍是事实源', async () => {
    const f = fixture(); const module = new URL('../src/vision/photos.ts', import.meta.url).href; const worker = join(f.root, '..', 'worker.mjs');
    writeFileSync(worker, `import { existsSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { photoShelf } from ${JSON.stringify(module)};
        const [root, key] = process.argv.slice(2); const shelf = photoShelf({ dir:root,log:()=>{} }); const input=join(root,'..',key+'.jpg');writeFileSync(input,'synthetic-'+key);
        writeFileSync(join(root,'..','ready-'+key),'ready');const until=Date.now()+5000;while(!existsSync(join(root,'..','go'))){if(Date.now()>until)throw Error('barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}
        const retry=work=>{for(let n=0;;n++){try{return work();}catch(error){if(n>=20||!error.cause?.retryable)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}};
        const entry=retry(()=>shelf.add(input,'cat','合成猫照'));for(let n=0;n<4;n++)retry(()=>shelf.used(entry.id));`);
    const workers = ['a', 'b'].map(key => {
        const child = spawn(process.execPath, [worker, f.root, key], { stdio: 'ignore' });
        return { child, done: new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }) };
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const until = Date.now() + 4000;
        while (!existsSync(join(f.root, '..', 'ready-a')) || !existsSync(join(f.root, '..', 'ready-b'))) { assert.ok(Date.now() < until, 'worker startup timeout'); await new Promise(done => setTimeout(done, 10)); }
        writeFileSync(join(f.root, '..', 'go'), 'go');
        const exits = await Promise.race([Promise.all(workers.map(item => item.done)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('worker completion timeout')), 5000); })]);
        assert.deepEqual(exits, [0, 0]); const entries = f.make().list(); assert.equal(entries.length, 2); assert.ok(entries.every(entry => entry.used === 4));
    } finally { clearTimeout(timer); for (const { child } of workers) if (child.exitCode === null) child.kill(); await Promise.allSettled(workers.map(item => item.done)); }
});

test('普通和食物发现遇明确SQLite忙时返回retry，释放后正常恢复；CLI明确提示重试', async () => {
    for (const food of [false, true]) {
        const f = fixture(); const provider = source('cat-a', 9);
        const foodProvider: FoodSource = { ...provider, search: async dish => (await provider.search('cat')).map(item => ({ ...item, kind: 'food', series: dish })), judge: async () => ({ keep: true, caption: '合成饭照' }) };
        const shelf = food ? f.make(undefined, foodProvider) : f.make(provider);
        mkdirSync(f.root, { recursive: true }); const lock = new DatabaseSync(join(f.root, PHOTO_INDEX_LOCK_FILE)); lock.exec('BEGIN IMMEDIATE');
        try {
            assert.equal(await (food ? shelf.discoverFood(['合成菜']) : shelf.discover()), 'retry');
            assert.throws(() => shelf.add(f.file(1), 'cat', '合成猫'), /忙.*重试/);
        } finally { lock.exec('ROLLBACK'); lock.close(); }
        assert.equal(await (food ? shelf.discoverFood(['合成菜']) : shelf.discover()), 'done'); assert.equal(shelf.list().length, 1);
    }
});

for (const operation of ['clean', 'resolve'] as const) test(`坏照片索引不阻断普通文本${operation}，真实照片引用仍失败关闭`, () => {
    const f = fixture(); const shelf = f.make(); const entry = shelf.add(f.file(1), 'cat', '合成猫');
    writeFileSync(join(f.root, 'index.json'), '{synthetic corrupt');
    if (operation === 'clean') {
        assert.equal(shelf.clean('普通话'), '普通话');
        assert.equal(shelf.clean('普通话<photo:broken-token>'), '普通话');
        assert.equal(shelf.clean('普通话<photo:unclosed'), '普通话');
    } else {
        assert.equal(shelf.resolve('普通话'), undefined);
        assert.equal(shelf.resolve('<photo:broken-token>'), undefined);
    }
    assert.throws(() => shelf[operation](`<photo:${entry.id}>`));
});

test('明确禁止发图时无需读坏索引，有效照片令牌也清除而保留普通文字', () => {
    const f = fixture(); const shelf = f.make(); const entry = shelf.add(f.file(1), 'cat', '合成猫');
    writeFileSync(join(f.root, 'index.json'), '{synthetic corrupt');
    assert.equal(shelf.clean(`普通话\n<photo:${entry.id}>\n继续聊天`, false), '普通话\n继续聊天');
    assert.throws(() => shelf.clean(`<photo:${entry.id}>`, true));
});
