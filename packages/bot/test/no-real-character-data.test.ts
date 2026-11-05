import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

// 测试不读真实角色资料（ADR 0260）：真实卡含隐私，测试失败时的输出会把原文带出去。
// 要卡用 test/fixtures/card.ts 的合成角色。

const repoRoot = resolve(import.meta.dirname, '../../..');

/**
 * 按设计必须读真实资料的测试：它们校验的就是真实资料本身（st/ 与 source/ 一致、档位隐私检查）。
 * 不要往这里加别的文件。
 */
const ALLOWED = new Set(['packages/character-tools/test/convert.test.ts', 'packages/bot/test/no-real-character-data.test.ts']);

/** 同一行里既有真实角色目录，又是从仓库根（repoRoot / import.meta.dirname / '../../..'）解析出来的路径 */
const REAL_DIR = /characters\/linmengyao|'characters',\s*'linmengyao'/;
const FROM_REPO = /repoRoot|import\.meta\.dirname|\.\.\/\.\.\/\.\./;
/** 只把路径字符串交给配置解析（不读文件，parseAppConfig / loadConfig 只校验和解析路径）不算违规 */
const CONFIG_ONLY = /\b(parseAppConfig|loadConfig)\(/;
const violates = (line: string) => REAL_DIR.test(line) && FROM_REPO.test(line) && !CONFIG_ONLY.test(line);

function testFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'fixtures' ? [] : testFiles(path);
        return entry.name.endsWith('.ts') ? [path] : [];
    });
}

test('测试不从仓库里读取真实角色资料（只用合成角色）', () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(join(repoRoot, 'packages'))) {
        const dir = join(repoRoot, 'packages', pkg, 'test');
        let files: string[];
        try { files = testFiles(dir); } catch { continue; }
        for (const file of files) {
            const rel = relative(repoRoot, file).replaceAll('\\', '/');
            if (ALLOWED.has(rel)) continue;
            readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
                if (violates(line)) offenders.push(`${rel}:${index + 1}`);
            });
        }
    }
    assert.deepEqual(offenders, [], '改用 test/fixtures/card.ts 的合成角色卡');
});

test('守卫本身能查出违规写法', () => {
    const bad = [
        "const card = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend');",
        "const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));",
        "readSource(resolve(import.meta.dirname, '../../../characters/linmengyao/source'))",
    ];
    const ok = [
        "mkdirSync(join(root, 'characters/linmengyao/source'), { recursive: true });",
        "characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json',",
        "const fromFile = parseAppConfig({ ...minimal, characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json' }, repoRoot, env);",
    ];
    for (const line of bad) assert.ok(violates(line), line);
    for (const line of ok) assert.ok(!violates(line), line);
});
