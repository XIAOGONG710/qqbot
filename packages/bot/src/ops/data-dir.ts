// 命令行工具默认的数据目录：线上 Koishi 配置（runtime/koishi/koishi.yml）里 qqbot 插件的 dataDir；读不到配置才退回 runtime/bot。
// 为什么：线上的数据目录早就是 runtime/bot-shadow，十几个工具却写死了 runtime/bot——不带 --dir 时，作者写下的事、加的照片、追求……
// 都写进了线上看不到的旧目录（11-13 旧目录改名之后，它们会新建一个空的 runtime/bot 再写进去）。同 scripts/backup-state.mjs 的 configuredDataDir。

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';

/** 仓库根目录（packages/bot/src/ops 往上四层） */
export const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** 配置里写的 dataDir（相对仓库根或绝对路径）；没有配置、读不了、没写就是 undefined */
export function configuredDataDir(repoRoot: string = REPO_ROOT): string | undefined {
    let text: string;
    try { text = readFileSync(join(repoRoot, 'runtime', 'koishi', 'koishi.yml'), 'utf8'); } catch { return undefined; }
    let config: { plugins?: Record<string, unknown> } | undefined;
    try { config = createRequire(import.meta.url)('js-yaml').load(text) as typeof config; } catch { return undefined; }
    const plugin = Object.values(config?.plugins ?? {}).find((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object' && 'contacts' in (p as object));
    const dir = typeof plugin?.dataDir === 'string' ? plugin.dataDir.trim() : '';
    return dir || undefined;
}

/** 工具不带 --dir 时用的数据目录（绝对路径） */
export function liveDataDir(repoRoot: string = REPO_ROOT): string {
    const dir = configuredDataDir(repoRoot) ?? 'runtime/bot';
    return isAbsolute(dir) ? dir : resolve(repoRoot, dir);
}
