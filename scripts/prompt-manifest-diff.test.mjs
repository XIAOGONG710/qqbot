import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// 只读工具：SELF.json 逐行比提示词指纹清单的哈希（ADR 0347 第 2 层验收）。数据是编的；只看输出里有没有正文、退出码对不对。

const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const script = join(import.meta.dirname, 'prompt-manifest-diff.mjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const fixture = (selfLines, prompt) => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-diff-'));
    mkdirSync(join(dir, 'logs'));
    const pieces = prompt.map(([slot, text, module]) => ({ slot, module, list: 'now', chars: text.length, sha256: hash(text) }));
    writeFileSync(join(dir, 'logs', 'prompt-manifest-2026-11-22.jsonl'), `${JSON.stringify({ v: 1, qq: 10001, at: '2026-11-22T13:00:00.000Z', kind: 'reply', pieces })}\n`);
    writeFileSync(join(dir, 'SELF.json'), JSON.stringify({ at: '2026-11-22T13:02:00.000Z', lines: selfLines.map(([slot, text]) => ({ slot, text })) }));
    return dir;
};

test('全部一致：退出码 0，只列槽名和模块', () => {
    const dir = fixture([['state', '[你现在：在图书馆]'], ['inner', '[想去看海]']], [['time', '[九点]', 'time-block'], ['state', '[你现在：在图书馆]', 'her-now'], ['inner', '[想去看海]', 'inner']]);
    try {
        const out = run(dir, '--self', join(dir, 'SELF.json'), '--qq', '10001');
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stdout, /一致.*state（her-now）/);
        assert.match(out.stdout, /合计：一致 2/);
        assert.doesNotMatch(out.stdout, /time/, '不在 SELF 槽里的不比');
        for (const secret of ['图书馆', '看海', '九点']) assert.ok(!out.stdout.includes(secret), secret);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('有一行对不上：退出码 1，说是哪个槽，不说内容', () => {
    const dir = fixture([['state', '[你现在：在宿舍]']], [['state', '[你现在：在图书馆]', 'her-now']]);
    try {
        const out = run(dir, '--self', join(dir, 'SELF.json'));
        assert.equal(out.status, 1);
        assert.match(out.stdout, /不一致.*state/);
        assert.ok(!out.stdout.includes('宿舍') && !out.stdout.includes('图书馆'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('没有清单 / 没有 SELF：退出码 2，说清楚缺什么', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-diff-'));
    try {
        writeFileSync(join(dir, 'SELF.json'), JSON.stringify({ lines: [] }));
        const none = run(dir, '--self', join(dir, 'SELF.json'));
        assert.equal(none.status, 2);
        assert.match(none.stderr, /没有提示词指纹清单/);
        const noSelf = run(dir, '--self', join(dir, 'nope.json'));
        assert.equal(noSelf.status, 2);
        assert.match(noSelf.stderr, /读不了 SELF\.json/);
        assert.equal(run().status, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
