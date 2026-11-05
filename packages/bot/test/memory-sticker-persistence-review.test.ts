import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { fileOps } from '../src/memory/json-file.ts';
import { stickerShelf, type StickerEntry } from '../src/social/stickers.ts';
import * as stickerModule from '../src/social/stickers.ts';

const now = new Date('2026-11-05T12:00:00+08:00'), url = 'https://synthetic.invalid/new.png';
const message = [{ type: 'image', data: { url, sub_type: 1 } }];
function png(seed: number): Uint8Array {
    const chunk = (type: string, data: Buffer) => {
        const named = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
        for (const byte of named) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
        const header = Buffer.alloc(4), tail = Buffer.alloc(4); header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([header, named, tail]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, seed, 60, 120, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function fixture(favorites = false) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-sticker-persist-review-')), path = join(root, 'index.json'), oldBytes = png(1), bytes = png(2);
    const id = createHash('sha256').update(oldBytes).digest('hex').slice(0, 12), nextId = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const image = join(root, `${id}.png`), nextImage = join(root, `${nextId}.png`); writeFileSync(image, oldBytes);
    const entry: StickerEntry = { id, file: `${id}.png`, description: '合成旧收藏', tags: [], source: { kind: 'inbox', name: 'synthetic.png' }, createdAt: now.toISOString(), used: 0 };
    writeFileSync(path, JSON.stringify({ version: 1, entries: [entry], seen: [] }));
    let downloads = 0, adds = 0; const logs: string[] = [];
    const make = () => stickerShelf({ dir: root, libraryMax: 1, now: () => new Date(now), log: line => logs.push(line), discoveryIntervalMs: 0, favoritesGapMs: 0,
        download: async () => { downloads++; return { bytes, type: 'image/png' }; }, describe: async () => '合成新收藏', decide: async description => ({ keep: true, description, tags: [] }),
        ...(favorites ? { favorites: { add: async () => { adds++; return 'a'.repeat(32); } } } : {}),
    });
    return { root, path, image, nextImage, id, nextId, entry, bytes, make, shelf: make(), downloads: () => downloads, adds: () => adds, logs,
        read: () => JSON.parse(readFileSync(path, 'utf8')) as { entries: StickerEntry[]; seen: string[] },
        cleanup() { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-sticker-persist-review-')); rmSync(root, { recursive: true, force: true }); },
    };
}

test('容量淘汰时index发布前失败保留已提交旧图片、RAM及未消费seen', async () => {
    const f = fixture(), original = { ...fileOps };
    try {
        const before = readFileSync(f.path, 'utf8'); fileOps.writeDelaysMs = [0];
        fileOps.writeFileSync = ((target: unknown, ...args: unknown[]) => { if (String(target).startsWith(`${f.path}.tmp-`)) throw Object.assign(new Error('synthetic index EROFS'), { code: 'EROFS' }); return Reflect.apply(original.writeFileSync, fileOps, [target, ...args]); }) as typeof fileOps.writeFileSync;
        await f.shelf.consider(message, { from: 10001, messageId: 1 });
        assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(existsSync(f.image), true, '仍在已提交index里的图片不可提前删除');
        assert.ok(f.shelf.resolve(`<sticker:${f.id}>`)); assert.equal(f.shelf.resolve(`<sticker:${f.nextId}>`), undefined); assert.equal(f.shelf.status().count, 1);
        Object.assign(fileOps, original); await f.shelf.consider(message, { from: 10001, messageId: 2 });
        assert.equal(f.downloads(), 2, '失败候选的seen和pending不能吞掉重试'); assert.equal(f.read().entries[0]!.id, f.nextId); assert.ok(existsSync(f.nextImage));
    } finally { Object.assign(fileOps, original); f.cleanup(); }
});

test('index rename后报EIO按实际发布承认成功，同候选不重复下载且QQ同步继续', async () => {
    const f = fixture(true), original = { ...fileOps };
    try {
        fileOps.writeDelaysMs = [0];
        fileOps.renameSync = ((from: string, to: string) => { original.renameSync(from, to); if (String(to) === f.path) throw Object.assign(new Error('synthetic post-publish EIO'), { code: 'EIO' }); }) as typeof fileOps.renameSync;
        await f.shelf.consider(message, { from: 10001, messageId: 1 });
        Object.assign(fileOps, original);
        assert.equal(f.read().entries[0]!.id, f.nextId); assert.ok(existsSync(f.nextImage)); assert.equal(f.adds(), 1, '本地发布已确认，不应因异常跳过QQ同步');
        assert.equal(f.read().entries[0]!.qq?.md5, 'A'.repeat(32)); assert.ok(f.shelf.resolve(`<sticker:${f.nextId}>`));
        await f.shelf.consider(message, { from: 10001, messageId: 2 }); assert.equal(f.downloads(), 1); assert.equal(f.adds(), 1);
    } finally { Object.assign(fileOps, original); f.cleanup(); }
});

test('拒收候选的seen发布失败不能只在RAM永久屏蔽重试', async () => {
    const f = fixture(), original = { ...fileOps }; let descriptions = 0;
    const shelf = stickerShelf({ dir: f.root, log: () => {}, download: async () => ({ bytes: f.bytes, type: 'image/png' }), describe: async () => { descriptions++; return ''; }, decide: async () => ({ keep: false, description: '', tags: [] }) });
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = (() => { throw Object.assign(new Error('synthetic rejection EROFS'), { code: 'EROFS' }); }) as typeof fileOps.renameSync;
        await shelf.consider(message, { from: 10001, messageId: 1 }); assert.deepEqual(f.read().seen, []);
        Object.assign(fileOps, original); await shelf.consider(message, { from: 10001, messageId: 2 });
        assert.equal(descriptions, 2); assert.equal(f.read().seen.length, 1); assert.equal(f.read().entries[0]!.id, f.id);
    } finally { Object.assign(fileOps, original); f.cleanup(); }
});

test('QQ收藏ACK已确认但index写失败，恢复先补持久而不重新add，重启事实一致', async () => {
    const f = fixture(true), original = { ...fileOps };
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = (() => { throw Object.assign(new Error('synthetic ACK index EROFS'), { code: 'EROFS' }); }) as typeof fileOps.renameSync;
        await f.shelf.discover(); assert.equal(f.adds(), 1); assert.equal(f.read().entries[0]!.qq, undefined);
        Object.assign(fileOps, original); await f.shelf.discover();
        assert.equal(f.adds(), 1, '真实已确认add不能因本地副索引失败重复派发'); assert.equal(f.read().entries[0]!.qq?.md5, 'A'.repeat(32));
        await f.make().discover(); assert.equal(f.adds(), 1); assert.equal(f.read().entries[0]!.qq?.md5, 'A'.repeat(32));
    } finally { Object.assign(fileOps, original); f.cleanup(); }
});

test('首个收藏ACK待持久时阻止同批后继add，恢复先确认前一事实再派第二个', async () => {
    const f = fixture(), original = { ...fileOps }; let calls = 0;
    const secondBytes = png(3), secondId = createHash('sha256').update(secondBytes).digest('hex').slice(0, 12);
    writeFileSync(join(f.root, `${secondId}.png`), secondBytes);
    writeFileSync(f.path, JSON.stringify({ version: 1, entries: [f.entry, { ...f.entry, id: secondId, file: `${secondId}.png` }], seen: [] }));
    const shelf = stickerShelf({ dir: f.root, discoveryIntervalMs: 0, favoritesGapMs: 0, now: () => new Date(now), log() {}, describe: async () => '', decide: async () => ({ keep: false, description: '', tags: [] }),
        favorites: { add: async () => { calls++; if (calls === 2) assert.equal(f.read().entries[0]!.qq?.md5, 'A'.repeat(32), '第二次外部mutation前第一份ACK必须持久'); return (calls === 1 ? 'a' : 'b').repeat(32); } } });
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = (() => { throw Object.assign(new Error('synthetic first ACK EROFS'), { code: 'EROFS' }); }) as typeof fileOps.renameSync;
        await shelf.discover(); assert.equal(calls, 1); assert.ok(f.read().entries.every(entry => !entry.qq));
        assert.equal(shelf.resolve(`<sticker:${f.id}>`)!.qq?.md5, 'A'.repeat(32), '内存里的已确认ACK保持真实');
        Object.assign(fileOps, original); await shelf.discover();
        assert.equal(calls, 2); assert.deepEqual(f.read().entries.map(entry => entry.qq?.md5), ['A'.repeat(32), 'B'.repeat(32)]);
        await shelf.discover(); assert.equal(calls, 2);
    } finally { Object.assign(fileOps, original); f.cleanup(); }
});

test('图片wx临时文件冲突保留未知原文件，不发布候选也不删除已提交图片', async () => {
    const f = fixture(), operations = stickerModule.stickerFileOps, original = { ...operations }; let conflict: string | undefined;
    try {
        const before = readFileSync(f.path, 'utf8'), sentinel = Buffer.from('synthetic unrelated temp owner');
        operations.writeFileSync = ((target: unknown, ...args: unknown[]) => {
            if (String(target).startsWith(`${f.nextImage}.tmp-`)) {
                assert.equal((args[1] as { flag?: string }).flag, 'wx'); conflict = String(target);
                original.writeFileSync(conflict, sentinel, { flag: 'wx' });
                throw Object.assign(new Error('synthetic pre-existing file'), { code: 'EEXIST' });
            }
            return Reflect.apply(original.writeFileSync, operations, [target, ...args]);
        }) as typeof operations.writeFileSync;
        await f.shelf.consider(message, { from: 10001, messageId: 1 });
        assert.ok(conflict); assert.deepEqual(readFileSync(conflict), sentinel); assert.equal(readFileSync(f.path, 'utf8'), before); assert.ok(existsSync(f.image));
        assert.ok(f.shelf.resolve(`<sticker:${f.id}>`)); assert.equal(f.shelf.resolve(`<sticker:${f.nextId}>`), undefined);
        Object.assign(operations, original); await f.shelf.consider(message, { from: 10001, messageId: 2 });
        assert.equal(f.read().entries[0]!.id, f.nextId); assert.deepEqual(readFileSync(conflict), sentinel); assert.equal(f.downloads(), 2);
    } finally { Object.assign(operations, original); f.cleanup(); }
});

for (const phase of ['before', 'after'] as const) test(`used计数index发布${phase}异常只承认磁盘已发生的进度`, () => {
    const f = fixture(), original = { ...fileOps };
    try {
        fileOps.writeDelaysMs = [0];
        fileOps.renameSync = ((from: string, to: string) => { if (String(to) !== f.path) return original.renameSync(from, to); if (phase === 'after') original.renameSync(from, to); throw Object.assign(new Error('synthetic used publication'), { code: 'EROFS' }); }) as typeof fileOps.renameSync;
        if (phase === 'before') assert.throws(() => f.shelf.used(f.id)); else f.shelf.used(f.id);
        Object.assign(fileOps, original);
        assert.equal(f.read().entries[0]!.used, phase === 'before' ? 0 : 1);
        assert.equal(f.shelf.resolve(`<sticker:${f.id}>`)!.used, phase === 'before' ? 0 : 1);
        f.shelf.used(f.id);
        assert.equal(f.read().entries[0]!.used, phase === 'before' ? 1 : 2);
        assert.equal(f.make().resolve(`<sticker:${f.id}>`)!.used, phase === 'before' ? 1 : 2);
    } finally { Object.assign(fileOps, original); f.cleanup(); }
});

test('index已发布但读回IO未知时拒绝旧RAM供给，fresh恢复后识别新事实而不重派', async () => {
    const f = fixture(true), original = { ...fileOps }; let published = false;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.readDelaysMs = [0];
        fileOps.renameSync = ((from: string, to: string) => { original.renameSync(from, to); if (String(to) === f.path) { published = true; throw Object.assign(new Error('synthetic postpublish'), { code: 'EROFS' }); } }) as typeof fileOps.renameSync;
        fileOps.readFileSync = ((target: unknown, ...args: unknown[]) => { if (published && String(target) === f.path) throw Object.assign(new Error('synthetic unavailable confirmation'), { code: 'EIO' }); return Reflect.apply(original.readFileSync, fileOps, [target, ...args]); }) as typeof fileOps.readFileSync;
        await f.shelf.consider(message, { from: 10001, messageId: 1 });
        assert.equal(f.read().entries[0]!.id, f.nextId); assert.ok(existsSync(f.nextImage));
        assert.throws(() => f.shelf.status()); assert.throws(() => f.shelf.resolve(`<sticker:${f.id}>`)); assert.throws(() => f.shelf.prompt());
        assert.equal(f.adds(), 0, '未知index不能先镜像潜在旧RAM条目');
        Object.assign(fileOps, original);
        assert.ok(f.shelf.resolve(`<sticker:${f.nextId}>`)); assert.equal(f.shelf.resolve(`<sticker:${f.id}>`), undefined);
        await f.shelf.consider(message, { from: 10001, messageId: 2 }); assert.equal(f.downloads(), 1);
        await f.shelf.discover(); assert.equal(f.adds(), 1); assert.equal(f.read().entries[0]!.qq?.md5, 'A'.repeat(32));
    } finally { Object.assign(fileOps, original); f.cleanup(); }
});

test('已提交新index后的旧图清理失败只留孤儿，不回滚事实或重复收藏', async () => {
    const f = fixture(true), original = { ...stickerModule.stickerFileOps };
    try {
        stickerModule.stickerFileOps.unlinkSync = ((path: string) => { if (String(path) === f.image) throw Object.assign(new Error('synthetic obsolete image EACCES'), { code: 'EACCES' }); return original.unlinkSync(path); }) as typeof original.unlinkSync;
        await f.shelf.consider(message, { from: 10001, messageId: 1 });
        assert.equal(f.read().entries[0]!.id, f.nextId); assert.ok(existsSync(f.image)); assert.ok(existsSync(f.nextImage)); assert.equal(f.adds(), 1);
        assert.equal(f.make().resolve(`<sticker:${f.id}>`), undefined); assert.ok(f.make().resolve(`<sticker:${f.nextId}>`));
        await f.shelf.consider(message, { from: 10001, messageId: 2 }); assert.equal(f.downloads(), 1); assert.equal(f.adds(), 1);
    } finally { Object.assign(stickerModule.stickerFileOps, original); f.cleanup(); }
});

test('坏index与不安全元数据原文件保留且拒构造，不隔离或猜空白', () => {
    const f = fixture();
    try {
        const raw = JSON.parse(readFileSync(f.path, 'utf8'));
        const invalid = ['{synthetic broken', JSON.stringify({ ...raw, version: 99 }),
            JSON.stringify({ ...raw, entries: [{ ...f.entry, file: '../outside.png' }] }),
            JSON.stringify({ ...raw, entries: [f.entry, f.entry] }),
            JSON.stringify({ ...raw, entries: [{ ...f.entry, used: Number.MAX_SAFE_INTEGER + 1 }] })];
        for (const body of invalid) {
            writeFileSync(f.path, body); assert.throws(() => f.make());
            assert.equal(readFileSync(f.path, 'utf8'), body); assert.ok(existsSync(f.image));
            assert.equal(readdirSync(f.root).some(name => name.includes('.corrupt-')), false);
        }
    } finally { f.cleanup(); }
});

test('索引图片被换成跨目录file symlink时不供给且淘汰不删除链接目标', async t => {
    const f = fixture(), outside = fixture();
    try {
        const originalBytes = readFileSync(outside.image); unlinkSync(f.image);
        try { symlinkSync(outside.image, f.image, 'file'); }
        catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('当前Windows环境不允许创建合成file symlink'); return; } throw error; }
        assert.equal(f.shelf.resolve(`<sticker:${f.id}>`), undefined); assert.equal(f.shelf.prompt(), undefined);
        await f.shelf.consider(message, { from: 10001, messageId: 1 });
        assert.equal(f.read().entries[0]!.id, f.nextId); assert.ok(f.shelf.resolve(`<sticker:${f.nextId}>`));
        assert.deepEqual(readFileSync(outside.image), originalBytes); assert.ok(existsSync(f.image), '未知链接残留保留，不把目录外目标当已知victim删除');
    } finally { f.cleanup(); outside.cleanup(); }
});

for (const phase of ['write-before', 'rename-before', 'rename-after'] as const) test(`图片发布${phase}的异常不能破坏已提交收藏，已发布图片可独立核验`, async () => {
    const f = fixture(true);
    // Old control uses the native live binding; the new implementation exposes
    // the same explicit operations without altering the process-wide fs API.
    const operations = stickerModule.stickerFileOps ?? fs, original = { writeFileSync: operations.writeFileSync, renameSync: operations.renameSync, unlinkSync: operations.unlinkSync };
    const sync = () => { if (operations === fs) syncBuiltinESMExports(); };
    try {
        const before = readFileSync(f.path, 'utf8');
        operations.writeFileSync = ((target: unknown, ...args: unknown[]) => {
            if (phase === 'write-before' && String(target).startsWith(`${f.nextImage}.tmp-`)) throw Object.assign(new Error('synthetic image write'), { code: 'EROFS' });
            return Reflect.apply(original.writeFileSync, operations, [target, ...args]);
        }) as typeof operations.writeFileSync;
        operations.renameSync = ((from: string, to: string) => {
            if (String(to) !== f.nextImage) return original.renameSync(from, to);
            if (phase === 'rename-after') original.renameSync(from, to);
            throw Object.assign(new Error('synthetic image rename'), { code: phase === 'rename-after' ? 'EIO' : 'EROFS' });
        }) as typeof operations.renameSync; sync();
        await f.shelf.consider(message, { from: 10001, messageId: 1 }); Object.assign(operations, original); sync();
        if (phase === 'rename-after') {
            assert.equal(f.read().entries[0]!.id, f.nextId); assert.equal(f.adds(), 1); assert.ok(f.shelf.resolve(`<sticker:${f.nextId}>`));
            assert.deepEqual(new Uint8Array(readFileSync(f.nextImage)), new Uint8Array(f.bytes));
            await f.shelf.consider(message, { from: 10001, messageId: 2 }); assert.equal(f.downloads(), 1);
        } else {
            assert.equal(readFileSync(f.path, 'utf8'), before); assert.ok(existsSync(f.image)); assert.ok(f.shelf.resolve(`<sticker:${f.id}>`)); assert.equal(f.adds(), 0);
            await f.shelf.consider(message, { from: 10001, messageId: 2 }); assert.equal(f.downloads(), 2); assert.equal(f.read().entries[0]!.id, f.nextId); assert.equal(f.adds(), 1);
        }
    } finally { Object.assign(operations, original); sync(); f.cleanup(); }
});

function worker(root: string, code: string, ...args: string[]) {
    const file = join(root, 'publication-worker.mjs'); writeFileSync(file, code);
    const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); }); child.once('error', error => { stderr += error.message; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const done = new Promise<{ code: number | null; signal: string | null; stderr: string }>(resolve => child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); }));
    return { child, done, async kill() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); return done; } };
}
async function checkpoint(path: string) { const end = Date.now() + 6000; while (!existsSync(path)) { assert.ok(Date.now() < end, '合成子进程未到检查点'); await new Promise(done => setTimeout(done, 10)); } }

for (const phase of ['before', 'after'] as const) test(`真实进程在index发布${phase}强杀后，重启仍有全部已提交图片且可继续处理`, { timeout: 20_000 }, async () => {
    const f = fixture(), point = join(f.root, 'checkpoint');
    const storeUrl = new URL('../src/social/stickers.ts', import.meta.url).href, jsonUrl = new URL('../src/memory/json-file.ts', import.meta.url).href;
    const code = `import{stickerShelf}from${JSON.stringify(storeUrl)};import{fileOps}from${JSON.stringify(jsonUrl)};import{writeFileSync}from'node:fs';const[root,index,phase,point]=process.argv.slice(2);const rename=fileOps.renameSync;fileOps.writeDelaysMs=[0];fileOps.renameSync=(from,to)=>{if(String(to)!==index)return rename(from,to);if(phase==='after')rename(from,to);writeFileSync(point,'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);throw Error('checkpoint expired');};const shelf=stickerShelf({dir:root,libraryMax:1,log(){},download:async()=>({bytes:Uint8Array.from(${JSON.stringify([...f.bytes])}),type:'image/png'}),describe:async()=>'合成新收藏',decide:async description=>({keep:true,description,tags:[]})});await shelf.consider(${JSON.stringify(message)},{from:10001,messageId:1});`;
    const held = worker(f.root, code, f.root, f.path, phase, point);
    try {
        await checkpoint(point); await held.kill(); const committed = f.read();
        assert.equal(committed.entries[0]!.id, phase === 'before' ? f.id : f.nextId);
        for (const entry of committed.entries) assert.ok(existsSync(join(f.root, entry.file)), '磁盘index不能指向被提前淘汰的缺失图片');
        const restarted = f.make(); await restarted.consider(message, { from: 10001, messageId: 2 });
        assert.equal(f.read().entries[0]!.id, f.nextId); assert.ok(existsSync(f.nextImage));
        assert.equal(f.downloads(), phase === 'before' ? 1 : 0, 'restart按持久seen事实决定是否重新处理');
    } finally { await held.kill(); f.cleanup(); }
});
