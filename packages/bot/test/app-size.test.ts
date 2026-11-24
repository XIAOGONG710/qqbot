import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// app.ts 的行数上限（ADR 0336 收尾，docs/plans/2026-11-24-0336-finish.md「守线」）。
// 11-19 迁移做完时 app.ts 是 2764 行，之后新功能直接往 createApp 里接线，四天长回 3071 行；收尾又搬出去一批。
// 这条测试让它只降不升：新功能写成模块（src/modules/，在 platform/turn-modules.ts 或解释器里登记）或独立的宿主文件
// （像 life/desktop-host.ts、world/reality-feeds.ts 那样「原样搬、依赖交进去」），app.ts 里只留建它、登记停法、调用的一两行。
// 搬出去一块之后把 APP_TS_MAX_LINES 跟着调低（同一个提交）。真要调高：提交说明里写清为什么不能做成模块，并在上面那份方案的「进度」里记一笔。
const APP_TS_MAX_LINES = 2731;

test(`platform/app.ts 不超过 ${APP_TS_MAX_LINES} 行（新功能做成模块，别往 app.ts 里接线）`, () => {
    const file = join(import.meta.dirname, '..', 'src', 'platform', 'app.ts');
    const lines = readFileSync(file, 'utf8').split('\n').length;
    assert.ok(lines <= APP_TS_MAX_LINES, [
        `src/platform/app.ts 现在 ${lines} 行，超过上限 ${APP_TS_MAX_LINES} 行（多了 ${lines - APP_TS_MAX_LINES} 行）。`,
        '新功能请写成模块或独立的宿主文件，app.ts 里只留建它、登记停法、调用（做法见 docs/plans/2026-11-24-0336-finish.md、ADR 0336）；',
        '真要加，先从 app.ts 搬出去同样多的行。',
    ].join('\n'));
});
