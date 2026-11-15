import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { configuredDataDir, liveDataDir, REPO_ROOT } from '../src/ops/data-dir.ts';

// 命令行工具默认的数据目录（11-15）：线上数据目录早就是 runtime/bot-shadow，十几个工具却写死了 runtime/bot
describe('命令行工具默认的数据目录', () => {
    const roots: string[] = [];
    afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
    const repo = (yaml?: string) => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-data-dir-'));
        roots.push(root);
        if (yaml !== undefined) {
            mkdirSync(join(root, 'runtime', 'koishi'), { recursive: true });
            writeFileSync(join(root, 'runtime', 'koishi', 'koishi.yml'), yaml, 'utf8');
        }
        return root;
    };

    test('按 Koishi 配置里 qqbot 插件的 dataDir', () => {
        const root = repo(['plugins:', '  adapter-onebot:', '    endpoint: ws://127.0.0.1:3001', '  qqbot:abc:', '    contacts: []', '    dataDir: runtime/bot-shadow', ''].join('\n'));
        assert.equal(configuredDataDir(root), 'runtime/bot-shadow');
        assert.equal(liveDataDir(root), resolve(root, 'runtime/bot-shadow'));
    });

    test('没有配置、没写 dataDir、配置坏了：退回 runtime/bot', () => {
        assert.equal(liveDataDir(repo()), resolve(roots[0]!, 'runtime/bot'));
        const noDir = repo(['plugins:', '  qqbot:abc:', '    contacts: []', ''].join('\n'));
        assert.equal(configuredDataDir(noDir), undefined);
        assert.equal(liveDataDir(noDir), resolve(noDir, 'runtime/bot'));
        const broken = repo('plugins: [unclosed');
        assert.equal(liveDataDir(broken), resolve(broken, 'runtime/bot'));
    });

    test('绝对路径原样用；仓库根是 packages/bot 往上两层', () => {
        const target = resolve(tmpdir(), 'somewhere-else');
        const root = repo(['plugins:', '  qqbot:abc:', '    contacts: []', `    dataDir: ${JSON.stringify(target)}`, ''].join('\n'));
        assert.equal(liveDataDir(root), target);
        assert.equal(REPO_ROOT, resolve(import.meta.dirname, '../../..'));
    });
});
