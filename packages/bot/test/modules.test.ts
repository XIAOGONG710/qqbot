import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { MODULES, moduleOf } from '../src/modules.ts';
import { moduleDocs } from '../src/modules-doc.ts';

// ADR 0122：模块总表——只分类、只写文档，不动运行代码
const src = resolve(import.meta.dirname, '../src');
const repoRoot = resolve(import.meta.dirname, '../../..');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(src, join(dir, entry.name)).split('\\').join('/')]));
const adrFiles = readdirSync(join(repoRoot, 'docs/adr')).filter(name => name.endsWith('.md'));

describe('模块总表', () => {
    test('src 下每个文件恰好属于一个模块（新加文件忘了登记会红）', () => {
        const files = walk(src);
        const unassigned = files.filter(file => !moduleOf(file));
        assert.deepEqual(unassigned, [], `这些文件没有归到任何模块（加进 src/modules.ts）：${unassigned.join('、')}`);
        const twice = files.filter(file => MODULES.filter(module => module.files.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))).length > 1);
        assert.deepEqual(twice, [], `这些文件被两个模块认领：${twice.join('、')}`);
    });

    test('清单里写的文件 / 目录都真实存在；模块 id 不重复', () => {
        for (const module of MODULES) {
            for (const entry of module.files) assert.ok(existsSync(join(src, entry)), `${module.id}: ${entry} 不存在`);
        }
        assert.equal(new Set(MODULES.map(module => module.id)).size, MODULES.length);
    });

    test('每个模块写的 ADR 编号都真有这份 ADR；每个模块都有说明、指标', () => {
        for (const module of MODULES) {
            assert.ok(module.scope.length > 10 && module.metrics.length > 4, module.id);
            for (const number of module.adrs) assert.ok(adrFiles.some(name => name.startsWith(`${number}-`)), `${module.id}: ADR ${number} 不存在`);
        }
    });

    test('docs/modules/ 里的文档和清单一致（改了清单忘了重新生成：node packages/bot/src/ops/modules-doc.ts）', () => {
        const docs = moduleDocs(adrFiles);
        assert.equal(Object.keys(docs).length, MODULES.length + 1);
        for (const [name, content] of Object.entries(docs)) {
            const file = join(repoRoot, 'docs/modules', name);
            assert.ok(existsSync(file), `${name} 还没生成`);
            assert.equal(readFileSync(file, 'utf8'), content, `${name} 和清单对不上，重新生成`);
        }
    });
});
