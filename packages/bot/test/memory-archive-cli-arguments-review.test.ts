import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const cli = new URL('../../../scripts/archive-test-data.mjs', import.meta.url).href;
const backend = new URL('../src/memory/archive.ts', import.meta.url).href;
const UUID = '11111111-1111-4111-8111-111111111111';
function fixture(work: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-archive-cli-args-review-'));
    try { work(root); } finally { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-archive-cli-args-review-')); rmSync(root, { recursive: true, force: true }); }
}
function run(args: string[]) {
    // Run the real CLI parser with a capture-only backend. If interception ever
    // stops matching, reject other file modules instead of accessing runtime.
    const script = `import{registerHooks}from'node:module';registerHooks({load(url,context,next){
        if(url===${JSON.stringify(backend)})return{format:'module',shortCircuit:true,source:"export function archiveTestData(options){console.log('SYNTHETIC_CAPTURE:'+JSON.stringify(options));return{stamp:'synthetic',moves:[],since:[],prefix:[],skipped:[]};}"};
        if(url.startsWith('file:')&&url!==${JSON.stringify(cli)})throw Error('Unexpected module; synthetic backend not used');return next(url,context);
    }});process.argv=[process.execPath,'synthetic-cli',...${JSON.stringify(args)}];await import(${JSON.stringify(cli)});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024 });
    assert.equal(child.error, undefined); const captures = child.stdout.split(/\r?\n/).filter(line => line.startsWith('SYNTHETIC_CAPTURE:'));
    return { ...child, captures: captures.map(line => JSON.parse(line.slice('SYNTHETIC_CAPTURE:'.length)) as { dataDir: string; configFiles: string[]; prefix?: string; resume?: string; dryRun: boolean }) };
}

test('归档CLI所有取值参数缺值或下一项是flag时，不能回落默认路径或调用写入后端', () => fixture(root => {
    for (const name of ['--data', '--koishi', '--config', '--prefix', '--resume']) for (const suffix of [[], ['--dry-run'], ['--no-config']]) {
        const result = run([name, ...suffix]);
        assert.equal(result.status, 2, `${name} ${suffix.join(' ')} must reject before archiving`); assert.equal(result.captures.length, 0);
        assert.match(result.stderr, /需要|缺少/);
    }
}));

test('空值或全空白不能把data解析成仓库根目录或恢复成默认真实配置', () => fixture(root => {
    for (const name of ['--data', '--koishi', '--config', '--prefix', '--resume']) for (const value of ['', '   ']) {
        const result = run([name, value]); assert.equal(result.status, 2, `${name} empty value must reject`); assert.equal(result.captures.length, 0);
    }
}));

test('重复参数及未知参数均在任何归档调用前拒绝，不静默选择某个目标', () => fixture(root => {
    for (const name of ['--data', '--koishi', '--config', '--prefix', '--resume']) {
        const value = name === '--resume' ? UUID : root, result = run([name, value, name, value]); assert.equal(result.status, 2); assert.equal(result.captures.length, 0);
    }
    for (const name of ['--dry-run', '--no-config']) { const result = run([name, name]); assert.equal(result.status, 2); assert.equal(result.captures.length, 0); }
    const unknown = run(['--data', root, '--unknown-option']); assert.equal(unknown.status, 2); assert.equal(unknown.captures.length, 0);
}));

test('显式config与no-config相互冲突，顺序不改变拒绝结果', () => fixture(root => {
    for (const args of [['--config', join(root, 'config.json'), '--no-config'], ['--no-config', '--config', join(root, 'config.json')]]) {
        const result = run(['--data', root, '--koishi', root, ...args]); assert.equal(result.status, 2); assert.equal(result.captures.length, 0);
    }
}));

test('有效路径/前缀/演练与原resume调用仍按原参数交给后端', () => fixture(root => {
    const config = join(root, 'a config.json'), koishi = join(root, 'koishi instance');
    const ordinary = run(['--data', root, '--koishi', koishi, '--config', config, '--prefix', 'synthetic-new', '--dry-run']);
    assert.equal(ordinary.status, 0, ordinary.stderr); assert.deepEqual(ordinary.captures, [{ dataDir: root, configFiles: [join(koishi, 'koishi.yml'), config], prefix: 'synthetic-new', dryRun: true }]);
    const resumed = run(['--data', root, '--resume', UUID, '--koishi', koishi, '--no-config']);
    assert.equal(resumed.status, 0, resumed.stderr); assert.deepEqual(resumed.captures, [{ dataDir: root, configFiles: [join(koishi, 'koishi.yml')], resume: UUID, dryRun: false }]);
}));
