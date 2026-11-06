import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const cli = process.env.SYNTHETIC_MOMENT_CLI ?? resolve(import.meta.dirname, '../src/ops/moment-cli.ts');
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'qqbot-moment-cli-')); dirs.push(dir); return dir; }
const add = ['add', '--id', 'synthetic', '--kind', 'sad', '--strength', '2', '--cause', '合成事件'];

test('moment-cli畸形或自动滚动日期用安全用法错误退出，保留原文件', () => {
    for (const at of ['bad-private-date', '2026-02-30 20:00', '2026-11-05T24:00:00Z', '9999-12-31T23:00:00-02:00']) {
        const dir = fixture(); const original = '{"moments":[],"extension":"keep"}'; writeFileSync(join(dir, 'moments.json'), original);
        const result = spawnSync(process.execPath, [cli, ...add, '--dir', dir, '--at', at], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 2); assert.match(result.stderr, /用法|日期|时刻/);
        assert.doesNotMatch(result.stderr, /RangeError|bad-private-date|at file:/);
        assert.equal(readFileSync(join(dir, 'moments.json'), 'utf8'), original);
    }
});

test('moment-cli坏JSON不回显作者原文，不覆盖或隔离文件', () => {
    const dir = fixture(); const original = '{"moments": [PRIVATE_SYNTHETIC_CAUSE}'; writeFileSync(join(dir, 'moments.json'), original);
    const result = spawnSync(process.execPath, [cli, 'list', '--dir', dir], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2); assert.match(result.stderr, /格式|读取|文件/);
    assert.doesNotMatch(result.stderr, /PRIVATE_SYNTHETIC_CAUSE|SyntaxError|at file:/);
    assert.equal(readFileSync(join(dir, 'moments.json'), 'utf8'), original);
});

test('moment-cli增删保留未知顶层和条目字段，低年份正常持久化', () => {
    const dir = fixture(); const existing = { id: 'old', at: '0099-11-05T12:00:00Z', kind: 'joy', strength: 1, cause: '合成旧事', extension: 'entry-keep' };
    writeFileSync(join(dir, 'moments.json'), JSON.stringify({ moments: [existing], extension: { keep: true } }));
    execFileSync(process.execPath, [cli, ...add, '--dir', dir, '--at', '0099-11-06T12:00:00Z'], { encoding: 'utf8', timeout: 5000 });
    let saved = JSON.parse(readFileSync(join(dir, 'moments.json'), 'utf8'));
    assert.deepEqual(saved.extension, { keep: true }); assert.deepEqual(saved.moments[0], existing);
    assert.equal(saved.moments[1].at, '0099-11-06T12:00:00.000Z');
    execFileSync(process.execPath, [cli, 'remove', 'synthetic', '--dir', dir], { encoding: 'utf8', timeout: 5000 });
    saved = JSON.parse(readFileSync(join(dir, 'moments.json'), 'utf8'));
    assert.deepEqual(saved, { moments: [existing], extension: { keep: true } });
});

test('moment-cli缺选项值不得回退默认时刻或数据目录', () => {
    for (const tail of [['--at'], ['--half-life'], ['--dir']]) {
        const dir = fixture(); const result = spawnSync(process.execPath, [cli, ...add, '--dir', dir, ...tail], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 2); assert.doesNotMatch(result.stderr, /RangeError|at file:/);
        assert.equal(existsSync(join(dir, 'moments.json')), false);
    }
});

test('两独立moment-cli写者发布区互斥，明确忙后重试保留两件作者事件', { timeout: 15000 }, async () => {
    const dir = fixture(); const hook = join(dir, 'hook.mjs');
    writeFileSync(hook, `import { fileOps } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/memory/json-file.ts')).href)};
        import { writeFileSync,existsSync } from 'node:fs';import {join} from 'node:path';
        const original=fileOps.renameSync;fileOps.renameSync=(from,to)=>{if(String(to).endsWith('moments.json')){writeFileSync(join(process.env.SYNTHETIC_MOMENT_DIR,'ready-'+process.env.SYNTHETIC_MOMENT_ID),'ready');const until=Date.now()+6000;while(!existsSync(join(process.env.SYNTHETIC_MOMENT_DIR,'go'))){if(Date.now()>until)throw Error('synthetic timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return original(from,to);};`);
    const children = ['one', 'two'].map(id => {
        let stderr = '';
        const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, cli, ...add.slice(0, 2), id, ...add.slice(3), '--dir', dir], { env: { ...process.env, SYNTHETIC_MOMENT_DIR: dir, SYNTHETIC_MOMENT_ID: id }, stdio: ['ignore', 'ignore', 'pipe'] });
        child.stderr.on('data', bytes => { stderr += bytes; });
        const done = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
        return { id, child, done, stderr: () => stderr };
    });
    try {
        const until = Date.now() + 5000; let overlap = false;
        for (;;) {
            const inside = children.filter(item => existsSync(join(dir, 'ready-' + item.id))).length;
            if (inside === 2) { overlap = true; break; }
            if (inside === 1 && children.some(item => item.child.exitCode === 2 && /繁忙/.test(item.stderr()))) break;
            assert.ok(Date.now() < until, 'writers did not reach held publication or explicit busy');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        writeFileSync(join(dir, 'go'), 'go');
        const exits = await Promise.all(children.map(item => item.done));
        const durableCount = JSON.parse(readFileSync(join(dir, 'moments.json'), 'utf8')).moments.length;
        assert.equal(overlap, false, `two authors passed into publication concurrently: ${JSON.stringify({ exits, durableCount })}`);
        for (let i = 0; i < children.length; i++) {
            if (exits[i] === 2) {
                assert.match(children[i]!.stderr(), /繁忙/);
                execFileSync(process.execPath, [cli, ...add.slice(0, 2), children[i]!.id, ...add.slice(3), '--dir', dir], { encoding: 'utf8', timeout: 5000 });
            } else assert.equal(exits[i], 0);
        }
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'moments.json'), 'utf8')).moments.map((item: { id: string }) => item.id).sort(), ['one', 'two']);
    } finally {
        for (const item of children) if (item.child.exitCode === null) item.child.kill();
        await Promise.allSettled(children.map(item => item.done));
    }
});

for (const published of [false, true]) test(`moment-cli在JSON发布${published ? '后' : '前'}被强杀，后续写者释放锁并从真实JSON恢复`, { timeout: 15000 }, async () => {
    const dir = fixture(); const hook = join(dir, 'crash-hook.mjs');
    writeFileSync(hook, `import {fileOps} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/memory/json-file.ts')).href)};import {writeFileSync} from 'node:fs';
        const original=fileOps.renameSync;fileOps.renameSync=(from,to)=>{if(String(to).endsWith('moments.json')){${published ? 'original(from,to);' : ''}writeFileSync(${JSON.stringify(join(dir, 'held'))},'held');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);${published ? 'return;' : ''}}return original(from,to);};`);
    const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, cli, ...add, '--dir', dir], { stdio: 'ignore' });
    const done = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    try {
        const until = Date.now() + 5000;
        while (!existsSync(join(dir, 'held'))) { assert.ok(Date.now() < until, 'child did not hold publication'); await new Promise(resolve => setTimeout(resolve, 10)); }
        child.kill(); await done;
        assert.equal(existsSync(join(dir, 'moments.json')), published);
        execFileSync(process.execPath, [cli, ...add.slice(0, 2), 'next', ...add.slice(3), '--dir', dir], { encoding: 'utf8', timeout: 5000 });
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'moments.json'), 'utf8')).moments.map((item: { id: string }) => item.id), published ? ['synthetic', 'next'] : ['next']);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await done; }
});

for (const published of [false, true]) test(`moment-cli在JSON发布${published ? '后' : '前'}报告IO异常，不误重建或误判已应用结果`, () => {
    const dir = fixture(); const hook = join(dir, 'io-hook.mjs');
    writeFileSync(hook, `import {fileOps} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/memory/json-file.ts')).href)};fileOps.writeDelaysMs=[0];
        const original=fileOps.renameSync;fileOps.renameSync=(from,to)=>{if(String(to).endsWith('moments.json')){${published ? 'original(from,to);' : ''}throw Object.assign(Error('PRIVATE_SYNTHETIC_IO'),{code:'EIO'});}return original(from,to);};`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, cli, ...add, '--dir', dir], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, published ? 0 : 2); assert.doesNotMatch(result.stderr, /PRIVATE_SYNTHETIC_IO/);
    assert.equal(existsSync(join(dir, 'moments.json')), published);
    execFileSync(process.execPath, [cli, ...add.slice(0, 2), 'next', ...add.slice(3), '--dir', dir], { encoding: 'utf8', timeout: 5000 });
    assert.equal(JSON.parse(readFileSync(join(dir, 'moments.json'), 'utf8')).moments.length, published ? 2 : 1);
});

test('moment-cli坏协调文件失败关闭，保留JSON和坏库原字节且错误不泄漏', () => {
    const dir = fixture(); const state = '{"moments":[],"extension":"keep"}'; const bad = 'PRIVATE_BAD_COORDINATOR';
    writeFileSync(join(dir, 'moments.json'), state); writeFileSync(join(dir, 'moments.coordination.sqlite'), bad);
    const result = spawnSync(process.execPath, [cli, ...add, '--dir', dir], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2); assert.match(result.stderr, /协调文件不可用/); assert.doesNotMatch(result.stderr, /PRIVATE_BAD_COORDINATOR/);
    assert.equal(readFileSync(join(dir, 'moments.json'), 'utf8'), state); assert.equal(readFileSync(join(dir, 'moments.coordination.sqlite'), 'utf8'), bad);
});

test('moment-cli本地DST缺口不滚动，正常重叠时刻沿用原生选择', () => {
    const dir = fixture(); const options = { encoding: 'utf8' as const, timeout: 5000, env: { ...process.env, TZ: 'America/New_York' } };
    const invalid = spawnSync(process.execPath, [cli, ...add, '--dir', dir, '--at', '2026-03-08 02:30'], options);
    assert.equal(invalid.status, 2); assert.equal(existsSync(join(dir, 'moments.json')), false);
    execFileSync(process.execPath, [cli, ...add, '--dir', dir, '--at', '2026-11-01 01:30'], options);
    assert.equal(JSON.parse(readFileSync(join(dir, 'moments.json'), 'utf8')).moments[0].at, '2026-11-01T05:30:00.000Z');
});
