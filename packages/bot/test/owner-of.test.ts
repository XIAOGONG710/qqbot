import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ownerOf, type Contact } from '../src/platform/config.ts';

// 「他」只在 ownerOf 这一处定（决定单第 28 条）：原来 9 处各自 find 一遍名单里第一个男朋友档
const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('ownerOf：名单里第一个男朋友档；没有就是 undefined', () => {
    const contacts: Contact[] = [
        { qq: 2, name: '小周', tier: 'classmate' },
        { qq: 1, name: '阿明', tier: 'boyfriend' },
        { qq: 3, name: '另一个', tier: 'boyfriend' },
    ];
    assert.equal(ownerOf(contacts)?.qq, 1);
    assert.equal(ownerOf(contacts.slice(0, 1)), undefined);
    assert.equal(ownerOf([{ qq: 9, tier: 'boyfriend' }])?.qq, 9, '只有 tier 的原始配置也能用（consistency-cli）');
});

test('src 里不再手写「名单里找第一个男朋友档」：要「他」就用 ownerOf（不然哪处改了规则，「他」会指向不同的人）', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith('.ts')) files.push(path);
        }
    };
    walk(src);
    const handWritten = /\.find\(\(?(\w+)\)? => \1\.tier === 'boyfriend'\)/;
    const offenders = files
        .filter(file => relative(src, file).replace(/\\/g, '/') !== 'platform/config.ts')
        .filter(file => handWritten.test(readFileSync(file, 'utf8')))
        .map(file => relative(src, file).replace(/\\/g, '/'));
    assert.deepEqual(offenders, []);
});
