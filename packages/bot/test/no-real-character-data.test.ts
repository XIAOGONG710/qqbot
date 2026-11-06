import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

// 测试不读真实角色资料（ADR 0333）：真实卡含隐私，测试失败时的输出会把原文带出去。
// 要卡用 test/fixtures/card.ts 的合成角色。
// 必须读真实资料的测试（校验真实资料本身）放在 character-tools 的 test-real/，不进 npm test，用 npm run test:real 在本机跑。

const repoRoot = resolve(import.meta.dirname, '../../..');

/** 守卫自己的自测里写着违规样例；不要往这里加别的文件，读真实资料的测试放 test-real/ */
const ALLOWED = new Set(['packages/bot/test/no-real-character-data.test.ts']);

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

test('npm test 不跑 test-real/ 里读真实资料的测试', () => {
    for (const pkg of readdirSync(join(repoRoot, 'packages'))) {
        let manifest: { scripts?: Record<string, string> };
        try { manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', pkg, 'package.json'), 'utf8')); } catch { continue; }
        assert.ok(!manifest.scripts?.test?.includes('test-real'), `${pkg} 的 test 脚本不该包含 test-real/`);
    }
    const tools = JSON.parse(readFileSync(join(repoRoot, 'packages/character-tools/package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(tools.scripts.test, 'node --test "test/**/*.test.ts"');
    assert.match(tools.scripts['test:real'] ?? '', /test-real\//);
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
