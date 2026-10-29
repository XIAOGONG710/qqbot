import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';

// 模块目录重构（10-27）把文件挪进了 src/<模块>/，往下深了一层。重构后全量测试照样全绿，但有两类东西悄悄坏了：
//   1. platform/app.ts 里「相对当前文件往上数三层」算出来的 repoRoot 变成了 packages/，设定账本（identityLedger）从此一个文件都不算哈希（34 → 0），没有任何报错；
//   2. package.json 里 5 个 npm 脚本还指向旧位置。
// 测试都是显式传路径的，抓不到这类错；这里直接核对源码里「往上数几层」的写法和脚本目标。
const botRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(botRoot, '../..');

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (
    entry.isDirectory() ? (entry.name === 'node_modules' || entry.name === 'vendor' ? [] : walk(join(dir, entry.name))) : [join(dir, entry.name)]));

const isRepoRoot = (dir: string) => existsSync(join(dir, 'characters')) && existsSync(join(dir, 'packages')) && existsSync(join(dir, 'docs'));

describe('目录重构之后的路径（防止「往上数几层」悄悄错位）', () => {
    test('测试自己算出来的仓库根是对的（否则下面的核对没有意义）', () => {
        assert.ok(isRepoRoot(repoRoot), repoRoot);
    });

    test('package.json 里每个 `node src/….ts` 脚本的目标文件都存在', () => {
        const scripts = (JSON.parse(readFileSync(join(botRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
        const missing: string[] = [];
        for (const [name, command] of Object.entries(scripts)) {
            const target = /node (src\/\S+\.ts)/.exec(command)?.[1];
            if (target && !existsSync(join(botRoot, target))) missing.push(`${name} → ${target}`);
        }
        assert.deepEqual(missing, [], `这些 npm 脚本指向不存在的文件：${missing.join('；')}`);
    });

    test('用 import.meta 往上数层级「找仓库根 / runtime」的地方，数出来的真是仓库根', () => {
        const pattern = /resolve\(\s*(?:dirname\(fileURLToPath\(import\.meta\.url\)\)|import\.meta\.dirname)\s*,\s*'((?:\.\.\/)+)([^']*)'\s*\)/g;
        const files = [...walk(join(botRoot, 'src')), ...walk(join(repoRoot, 'packages/koishi-plugin-qqbot/src'))].filter(file => file.endsWith('.ts'));
        const wrong: string[] = [];
        let checked = 0;
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            for (const match of text.matchAll(pattern)) {
                const [, ups, rest] = match as unknown as [string, string, string];
                // 正则里 `(\.\.\/)+` 会吞掉 `../../../`，最后一个没有斜杠的 `..` 落进 rest（'../../../..' → rest 是 '..'）：
                // 所以不能拿 rest === '' 判断，要把整串拆开，数前面连着几个 `..`，剩下的才是「接在后面的路径」
                const parts = `${ups}${rest}`.split('/').filter(Boolean);
                const upCount = parts.findIndex(part => part !== '..') === -1 ? parts.length : parts.findIndex(part => part !== '..');
                const remainder = parts.slice(upCount).join('/');
                // 只核对「想要的是仓库根」的写法：只有 `..`（仓库根本身），或者接 runtime/…（数据目录默认在仓库根下）
                if (remainder !== '' && !remainder.startsWith('runtime')) continue;
                checked += 1;
                const base = resolve(dirname(file), ...Array.from({ length: upCount }, () => '..'));
                if (!isRepoRoot(base)) wrong.push(`${relative(repoRoot, file)}：'${ups}${rest}' 数出来是 ${relative(repoRoot, base) || '.'}，不是仓库根`);
            }
        }
        assert.ok(checked >= 15, `只核对到 ${checked} 处（扫了 ${files.length} 个文件，${files.filter(file => file.includes('platform')).length} 个在 platform/），正则可能失效了`);
        assert.deepEqual(wrong, [], wrong.join('\n'));
    });
});
