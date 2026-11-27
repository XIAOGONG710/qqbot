import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENV_SETTINGS, ENV_SWITCHES, envSwitchStatuses, FEATURE_GROUPS } from '../src/platform/features.ts';

// 环境变量开关收编（2026-11-28）：src 里读的每个 QQBOT_* 都得登记——功能开关进 ENV_SWITCHES，别的进 ENV_SETTINGS
const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (): Set<string> => {
    const names = new Set<string>();
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith('.ts')) for (const m of readFileSync(path, 'utf8').matchAll(/process\.env\.(QQBOT_[A-Z0-9_]+)/g)) names.add(m[1]!);
        }
    };
    walk(src);
    return names;
};

test('src 里读的每个 QQBOT_* 环境变量都登记了：开关进 ENV_SWITCHES，路径 / 密钥 / 额度进 ENV_SETTINGS', () => {
    const known = new Set([...ENV_SWITCHES.map(def => def.env), ...ENV_SETTINGS]);
    const unregistered = [...read()].filter(name => !known.has(name)).sort();
    assert.deepEqual(unregistered, [], '新加的环境变量：是功能开关就进 features.ts 的 ENV_SWITCHES（写清 requires），不是就进 ENV_SETTINGS');
});

test('登记表里没有过时的：每个登记的环境变量 src 里真的在读；开关和设置不重复；分组合法', () => {
    const used = read();
    const stale = [...ENV_SWITCHES.map(def => def.env), ...ENV_SETTINGS].filter(name => !used.has(name));
    assert.deepEqual(stale, []);
    const switches = ENV_SWITCHES.map(def => def.env);
    assert.equal(new Set(switches).size, switches.length);
    assert.deepEqual(switches.filter(name => ENV_SETTINGS.includes(name)), []);
    for (const def of ENV_SWITCHES) assert.ok((FEATURE_GROUPS as readonly string[]).includes(def.group), def.env);
});

test('envSwitchStatuses：只有等于 1 才算开', () => {
    const statuses = envSwitchStatuses({ QQBOT_FEELING_RECOVERY: '1', QQBOT_GROUP_BOUNDARIES: 'true' });
    assert.equal(statuses.find(s => s.env === 'QQBOT_FEELING_RECOVERY')?.on, true);
    assert.equal(statuses.find(s => s.env === 'QQBOT_GROUP_BOUNDARIES')?.on, false, "代码里只认 '1'");
    assert.equal(statuses.filter(s => s.on).length, 1);
});

test('上线前检查列出环境变量开关（koishi.yml 里看不到，部署时要知道它们在）', async () => {
    const { classifyChanges, goLiveReport } = await import('../src/ops/golive-check.ts');
    const notes = goLiveReport({ liveHead: 'a', targetHead: 'a', dirty: false, commits: [], exposed: [], changes: classifyChanges([]) }).notes.join('\n');
    assert.match(notes, /环境变量开关 \d+ 个.*QQBOT_FEELING_RECOVERY/);
});
