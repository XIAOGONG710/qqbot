import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { loadMemes, memesPath, refreshMemes, saveMemes, type MemeEntry } from '../src/language/memes.ts';
import * as memeStore from '../src/language/memes.ts';

const cli = fileURLToPath(new URL('../src/ops/meme-cli.ts', import.meta.url));
const storeUrl = new URL('../src/language/memes.ts', import.meta.url).href;
const jsonUrl = new URL('../src/memory/json-file.ts', import.meta.url).href;
const tick = () => new Promise<void>(done => setImmediate(done));
const day = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-memes-concurrency-')), path = memesPath(root), now = new Date();
    const entry: MemeEntry = { term: '合成喵梗', meaning: '这是最初的合成测试意思', example: '合成原示例', confidence: 'high', firstSeen: day(now), lastSeen: day(now), seen: 1 };
    saveMemes(path, { version: 1, entries: [entry] });
    return { root, path, now, entry, cleanup() { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-memes-concurrency-')); rmSync(root, { recursive: true, force: true }); } };
}
function author(root: string, command: string, ...args: string[]) {
    // Never invoke the real CLI without an explicit, verified temporary data root.
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-memes-concurrency-'));
    const result = spawnSync(process.execPath, [cli, command, ...args, '--dir', root], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr); return result;
}
function heldRefresh(path: string, now: Date, term: string) {
    let release!: (text: string) => void, entered = false;
    const held = new Promise<string>(done => { release = done; });
    const task = refreshMemes({ path, now: () => now, log: () => {}, fetchLists: async () => ({ popular: [], hot: [term], weibo: [], baidu: [] }), ask: async () => { entered = true; return held; }, gather: async () => [] });
    return { task, release: () => release(JSON.stringify({ 词: term, 来源: '合成榜' })), async ready() { for (let i = 0; i < 20 && !entered; i++) await tick(); assert.equal(entered, true); } };
}

test('较旧刷新晚完成只合并事实，不倒退较新轮次刷新时间', async () => {
    const f = fixture(), older = heldRefresh(f.path, f.now, f.entry.term);
    try {
        await older.ready();
        const later = new Date(f.now.getTime() + 1000);
        await refreshMemes({ path: f.path, now: () => later, log: () => {}, fetchLists: async () => ({ popular: [], hot: [f.entry.term], weibo: [], baidu: [] }),
            ask: async () => JSON.stringify({ 词: f.entry.term }), gather: async () => [] });
        older.release(); await older.task;
        const fresh = loadMemes(f.path); assert.equal(fresh.refreshedAt, later.toISOString()); assert.equal(fresh.entries[0]!.seen, 3);
    } finally { older.release(); await older.task; f.cleanup(); }
});

function worker(root: string, code: string, ...args: string[]) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-memes-concurrency-'));
    const file = join(root, `worker-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`); writeFileSync(file, code);
    const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); }); child.once('error', error => { stderr += error.message; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const done = new Promise<{ code: number | null; signal: string | null; stderr: string }>(resolve => child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); }));
    return { child, done, async kill() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); return done; } };
}
async function checkpoint(path: string) { const end = Date.now() + 6000; while (!existsSync(path)) { assert.ok(Date.now() < end, '合成进程未到达检查点'); await new Promise(done => setTimeout(done, 10)); } }

test('真实CLI remove已成功后，旧后台刷新不能复活作者删除的梗', async () => {
    const f = fixture(), pending = heldRefresh(f.path, f.now, f.entry.term);
    try {
        await pending.ready(); author(f.root, 'remove', f.entry.term); assert.equal(loadMemes(f.path).entries.length, 0);
        pending.release(); await pending.task;
        assert.equal(loadMemes(f.path).entries.some(entry => entry.term === f.entry.term), false);
    } finally { pending.release(); await pending.task; f.cleanup(); }
});

test('真实CLI add与旧后台刷新相交，作者新条目和后台独立事实均保留', async () => {
    const f = fixture(), pending = heldRefresh(f.path, f.now, f.entry.term);
    try {
        await pending.ready(); author(f.root, 'add', '合成新梗', '这是作者新增的合成测试意思', '--example', '合成新示例');
        const added = loadMemes(f.path).entries.find(entry => entry.term === '合成新梗'); assert.ok(added);
        pending.release(); await pending.task; const entries = loadMemes(f.path).entries;
        assert.deepEqual(entries.find(entry => entry.term === '合成新梗'), added);
        assert.equal(entries.find(entry => entry.term === f.entry.term)?.seen, 2, '独立后台再遇事实仍应用一次');
    } finally { pending.release(); await pending.task; f.cleanup(); }
});

test('真实CLI更新同词解释后旧后台结果不能覆盖作者新版本', async () => {
    const f = fixture(), pending = heldRefresh(f.path, f.now, f.entry.term);
    try {
        await pending.ready(); author(f.root, 'add', f.entry.term, '这是作者修正后的合成测试意思', '--example', '合成修正示例');
        const authored = loadMemes(f.path).entries.find(entry => entry.term === f.entry.term); assert.ok(authored);
        pending.release(); await pending.task;
        assert.deepEqual(loadMemes(f.path).entries.find(entry => entry.term === f.entry.term), authored);
    } finally { pending.release(); await pending.task; f.cleanup(); }
});

test('真实CLI删除再按原文重加的ABA作者版本不能被旧刷新加回旧增量', async () => {
    const f = fixture(), pending = heldRefresh(f.path, f.now, f.entry.term);
    try {
        await pending.ready(); author(f.root, 'remove', f.entry.term); author(f.root, 'add', f.entry.term, f.entry.meaning, '--example', f.entry.example);
        const authored = loadMemes(f.path).entries.find(entry => entry.term === f.entry.term); assert.ok(authored);
        pending.release(); await pending.task;
        assert.deepEqual(loadMemes(f.path).entries.find(entry => entry.term === f.entry.term), authored, '最终正文相同也必须识别独立作者操作');
    } finally { pending.release(); await pending.task; f.cleanup(); }
});

test('后台新词模型期间作者先add再remove，最终空位也不能被旧学习复活', async () => {
    const f = fixture(), term = '合成新学梗'; let release!: (text: string) => void, entered = false, calls = 0;
    const held = new Promise<string>(done => { release = done; });
    const task = refreshMemes({ path: f.path, now: () => f.now, log: () => {}, fetchLists: async () => ({ popular: [], hot: [term], weibo: [], baidu: [] }),
        ask: async () => { if (++calls === 1) { entered = true; return held; } return JSON.stringify({ 是梗: true, 意思: '这是用于合成测试的一个玩笑', 例句: '合成测试用例', 把握: '高', 适合聊天: true }); }, gather: async () => ['合成证据说明'] });
    try {
        for (let i = 0; i < 20 && !entered; i++) await tick(); assert.equal(entered, true);
        author(f.root, 'add', term, '这是作者临时加入的合成测试意思'); author(f.root, 'remove', term);
        assert.equal(loadMemes(f.path).entries.some(entry => entry.term === term), false);
        release(JSON.stringify({ 词: term, 来源: '合成榜' })); await task;
        assert.equal(loadMemes(f.path).entries.some(entry => entry.term === term), false);
    } finally { release(''); await task; f.cleanup(); }
});

test('两个独立进程锁内fresh增量全部持久，仅明确busy可重试', { timeout: 20_000 }, async () => {
    const f = fixture();
    const code = `import{updateMemes}from${JSON.stringify(storeUrl)};const path=process.argv[2];for(let i=0;i<6;i++){const end=Date.now()+6000;for(;;){try{updateMemes(path,fresh=>{const entries=fresh.entries.map(e=>({...e,seen:e.seen+1}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);return{...fresh,entries};});break;}catch(error){if(error?.retryable!==true||Date.now()>end)throw error;await new Promise(done=>setTimeout(done,5));}}}`;
    const a = worker(f.root, code, f.path), b = worker(f.root, code, f.path);
    try {
        const results = await Promise.all([a.done, b.done]); for (const result of results) assert.equal(result.code, 0, result.stderr);
        assert.equal(loadMemes(f.path).entries[0]!.seen, 13);
    } finally { await Promise.all([a.kill(), b.kill()]); f.cleanup(); }
});

test('真实busy不执行增量回调，强杀持锁进程后OS释放且旧JSON保留', { timeout: 20_000 }, async () => {
    const f = fixture(), point = join(f.root, 'locked');
    const code = `import{withMemeStoreLock}from${JSON.stringify(storeUrl)};import{writeFileSync}from'node:fs';withMemeStoreLock(process.argv[2],()=>{writeFileSync(process.argv[3],'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);});`;
    const held = worker(f.root, code, f.path, point);
    try {
        await checkpoint(point); const bytes = readFileSync(f.path, 'utf8'); let called = false;
        assert.throws(() => memeStore.updateMemes(f.path, fresh => { called = true; return fresh; }), error => (error as { retryable?: boolean }).retryable === true);
        assert.equal(called, false); assert.equal(readFileSync(f.path, 'utf8'), bytes);
        await held.kill(); author(f.root, 'add', '锁恢复新梗', '这是恢复后的合成测试意思');
        assert.deepEqual(new Set(loadMemes(f.path).entries.map(entry => entry.term)), new Set([f.entry.term, '锁恢复新梗']));
    } finally { await held.kill(); f.cleanup(); }
});

for (const phase of ['before', 'after'] as const) test(`真实CLI发布${phase}时强杀，后续作者按实际JSON事实继续且无永久锁`, { timeout: 20_000 }, async () => {
    const f = fixture(), point = join(f.root, 'publication');
    const code = `import{fileOps}from${JSON.stringify(jsonUrl)};import{writeFileSync}from'node:fs';const[path,phase,point,root]=process.argv.slice(2);const rename=fileOps.renameSync;fileOps.writeDelaysMs=[0];fileOps.renameSync=(from,to)=>{if(String(to)!==path)return rename(from,to);if(phase==='after')rename(from,to);writeFileSync(point,'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);throw Error('checkpoint expired');};process.argv=[process.execPath,${JSON.stringify(cli)},'add','进程边界新梗','这是进程边界的合成测试意思','--dir',root];await import(${JSON.stringify(new URL('../src/ops/meme-cli.ts', import.meta.url).href)});`;
    const held = worker(f.root, code, f.path, phase, point, f.root);
    try {
        const before = readFileSync(f.path, 'utf8'); await checkpoint(point); await held.kill();
        if (phase === 'before') assert.equal(readFileSync(f.path, 'utf8'), before);
        assert.equal(loadMemes(f.path).entries.some(entry => entry.term === '进程边界新梗'), phase === 'after');
        author(f.root, 'add', '恢复后新梗', '这是恢复后的合成测试意思');
        const terms = loadMemes(f.path).entries.map(entry => entry.term);
        assert.ok(terms.includes(f.entry.term) && terms.includes('恢复后新梗')); assert.equal(terms.includes('进程边界新梗'), phase === 'after');
    } finally { await held.kill(); f.cleanup(); }
});

for (const after of [false, true]) test(`真实CLI原子发布${after ? '后EIO承认已发生事实' : '前EROFS保原失败'}`, () => {
    const f = fixture(), hook = join(f.root, 'fault.mjs');
    try {
        const before = readFileSync(f.path, 'utf8');
        writeFileSync(hook, `import{fileOps}from${JSON.stringify(jsonUrl)};const rename=fileOps.renameSync;fileOps.writeDelaysMs=[0];fileOps.renameSync=(from,to)=>{if(String(to)!==${JSON.stringify(f.path)})return rename(from,to);${after ? 'rename(from,to);' : ''}throw Object.assign(Error('synthetic publication failure'),{code:${JSON.stringify(after ? 'EIO' : 'EROFS')}});};`);
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, cli, 'add', '故障边界新梗', '这是故障边界的合成测试意思', '--dir', f.root], { encoding: 'utf8', timeout: 10_000 });
        if (after) { assert.equal(result.status, 0, result.stderr); assert.ok(loadMemes(f.path).entries.some(entry => entry.term === '故障边界新梗')); }
        else { assert.notEqual(result.status, 0); assert.equal(readFileSync(f.path, 'utf8'), before); }
        author(f.root, 'add', '故障恢复新梗', '这是故障恢复后的合成意思'); assert.ok(loadMemes(f.path).entries.some(entry => entry.term === '故障恢复新梗'));
    } finally { f.cleanup(); }
});

test('坏协调文件失败关闭且不泄露或重建原JSON/锁文件', () => {
    const f = fixture(), coordinator = `${f.path}.coordination.sqlite`, privateText = 'SYNTHETIC_PRIVATE_COORDINATOR';
    try {
        const before = readFileSync(f.path, 'utf8'); writeFileSync(coordinator, privateText); let called = false;
        assert.throws(() => memeStore.updateMemes(f.path, fresh => { called = true; return fresh; }), error => error instanceof Error
            && !error.message.includes(privateText) && (error as { retryable?: boolean }).retryable !== true);
        assert.equal(called, false); assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(readFileSync(coordinator, 'utf8'), privateText);
    } finally { f.cleanup(); }
});

test('坏JSON/schema/版本元数据保原失败关闭，不当legacy空白继续作者写入', () => {
    for (const invalid of ['json', 'schema', 'revision', 'authorRevision', 'entryRevision'] as const) {
        const f = fixture();
        try {
            const raw = JSON.parse(readFileSync(f.path, 'utf8')) as Record<string, unknown>;
            if (invalid === 'schema') raw.entries = null;
            if (invalid === 'revision') raw.revision = -1;
            if (invalid === 'authorRevision') raw.authorRevision = 0.5;
            if (invalid === 'entryRevision') (raw.entries as Record<string, unknown>[])[0]!.authorRevision = -1;
            const text = invalid === 'json' ? '{"private":"SYNTHETIC_PRIVATE_BROKEN_JSON' : JSON.stringify(raw); writeFileSync(f.path, text); let called = false;
            assert.throws(() => memeStore.updateMemes(f.path, fresh => { called = true; return fresh; }), error => error instanceof Error && !error.message.includes('SYNTHETIC_PRIVATE_BROKEN_JSON'));
            assert.equal(called, false); assert.equal(readFileSync(f.path, 'utf8'), text);
        } finally { f.cleanup(); }
    }
});

test('合法缺省版本legacy按零兼容，首次作者增量保留原条目和新操作', () => {
    const f = fixture();
    try {
        writeFileSync(f.path, JSON.stringify({ version: 1, entries: [f.entry] }));
        assert.equal(loadMemes(f.path).entries[0]!.seen, 1);
        author(f.root, 'add', '兼容新梗', '这是兼容旧版本的合成测试意思');
        const state = loadMemes(f.path);
        assert.equal(state.entries.find(entry => entry.term === f.entry.term)?.meaning, f.entry.meaning);
        assert.ok(state.entries.some(entry => entry.term === '兼容新梗'));
    } finally { f.cleanup(); }
});

test('版本及seen到MAX_SAFE边界时拒绝溢出提交且保留原事实', async () => {
    for (const field of ['revision', 'authorRevision', 'seen'] as const) {
        const f = fixture(); let task: Promise<unknown> | undefined;
        try {
            const raw = JSON.parse(readFileSync(f.path, 'utf8')) as Record<string, unknown>;
            if (field === 'seen') (raw.entries as Record<string, unknown>[])[0]!.seen = Number.MAX_SAFE_INTEGER;
            else { raw.revision = Number.MAX_SAFE_INTEGER; if (field === 'authorRevision') raw.authorRevision = Number.MAX_SAFE_INTEGER; }
            const text = JSON.stringify(raw); writeFileSync(f.path, text);
            if (field === 'seen') {
                task = refreshMemes({ path: f.path, now: () => f.now, log: () => {}, fetchLists: async () => ({ popular: [], hot: [f.entry.term], weibo: [], baidu: [] }), ask: async () => JSON.stringify({ 词: f.entry.term, 来源: '合成榜' }), gather: async () => [] });
                await assert.rejects(task);
            } else assert.throws(() => memeStore.updateMemes(f.path, fresh => ({ ...fresh, entries: fresh.entries.map(entry => ({ ...entry, seen: entry.seen + 1 })) })));
            assert.equal(readFileSync(f.path, 'utf8'), text);
        } finally { await task?.catch(() => {}); f.cleanup(); }
    }
});
