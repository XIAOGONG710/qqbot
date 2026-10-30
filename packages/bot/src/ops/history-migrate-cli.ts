// 把旧机器（VM）上的素材并进新机器（ADR 0199）。四个子命令：
//   export  旧机器上跑，只读：聊天记录 + 她自己写的日记 / 周记 / 阶段总结（从 Hindsight 公共库 GET）+ 状态存档 → 一个素材包目录
//     node packages/bot/src/ops/history-migrate-cli.ts export --live <runtime/bot> --hindsight http://127.0.0.1:8888 --common-bank <公共库 bank> --out <新目录> [--chats <QQ号,QQ号>]
//   plan    新机器上跑，只看不写：每份聊天会并进多少条、diary.json 多几个、要写几篇文档、有什么挡路（比如 Koishi 还在跑）
//     node packages/bot/src/ops/history-migrate-cli.ts plan --data <runtime/bot-shadow> --bundle <素材包目录> [--only <QQ号,QQ号>] [--create-missing]
//   apply   新机器上跑，Koishi 要先停：备份 → 并聊天 → 并 diary.json → 写文档 → 存档。不带 --yes 就只是 plan
//     node packages/bot/src/ops/history-migrate-cli.ts apply --data … --bundle … --hindsight http://127.0.0.1:8888 --common-bank linmengyao-common --yes [--wait-minutes 10]
//   verify  Koishi 重新跑一阵之后：某个联系人的记忆片段有没有都写进 Hindsight（迁移之外也能用：任何时候查「记着写过的」是不是真在 Hindsight 里）
//     node packages/bot/src/ops/history-migrate-cli.ts verify --data … --qq <QQ号> --hindsight http://127.0.0.1:8888 --bank <他的 bank>
//     公共库：--bank <公共库> --id-prefix <他的哈希:> --common（公共库不写危机相关的片段，--common 把它们从「该有的」里去掉，不然会误报缺）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HindsightClient } from '../memory/hindsight.ts';
import { applyImport, describePlan, exportBundle, expectedEpisodeIds, listDocumentIds, memoryGap, parseChatJsonl, planImport, readBundle } from './history-migrate.ts';

const [command, ...args] = process.argv.slice(2);
const option = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const need = (name: string): string => option(name) ?? (() => { throw new Error(`缺 ${name}`); })();
const flag = (name: string) => args.includes(name);
const log = (message: string) => console.log(message);

// 不用 process.exit：Windows 上 Node 收尾时还有没关的 fetch 句柄，process.exit 会打出 `Assertion failed ... uv_handle`（DSH 10-30 跑 verify 时见到）。用 exitCode，让事件循环自己收完
try {
    if (command === 'export') {
        const chats = option('--chats')?.split(',').map(s => s.trim()).filter(Boolean);
        const manifest = await exportBundle({ liveDir: need('--live'), outDir: need('--out'), hindsightUrl: need('--hindsight'), commonBank: need('--common-bank'), ...(chats ? { chats } : {}), log });
        console.log(`素材包写好了：${need('--out')}（${Object.keys(manifest.files).length} 个文件，manifest.json 里有每个文件的哈希）`);
    } else if (command === 'plan' || command === 'apply') {
        const bundle = readBundle(need('--bundle'));
        const only = option('--only')?.split(',').map(s => s.trim()).filter(Boolean);
        const base = { dataDir: need('--data'), bundle, ...(only ? { only } : {}), ...(flag('--create-missing') ? { createMissing: true } : {}) };
        if (command === 'plan' || !flag('--yes')) {
            const plan = planImport(base);
            console.log(describePlan(plan));
            console.log(plan.problems.length ? '结论：有挡路的，先处理' : command === 'apply' ? '（没带 --yes，只是看了一遍；确认以后加 --yes 真写）' : '结论：可以 apply');
            process.exitCode = plan.problems.length ? 1 : 0;
        } else {
            const waitMinutes = Number(option('--wait-minutes') ?? 0);
            const result = await applyImport({ ...base, api: new HindsightClient(need('--hindsight'), 60_000), commonBank: need('--common-bank'), waitMs: waitMinutes * 60_000, log });
            console.log(describePlan(result.plan));
            console.log(`做完了。备份在 ${result.backupDir}。下一步：启动 Koishi，等记忆自己补齐（几分钟到十几分钟），再跑 verify。`);
            if (result.docs.conflicts.length) console.log(`注意：${result.docs.conflicts.length} 篇文档新机器上已经有、内容不一样，没动：${result.docs.conflicts.join('、')}`);
        }
    } else if (command === 'verify') {
        const path = join(need('--data'), 'chats', `${need('--qq')}.jsonl`);
        if (!existsSync(path)) throw new Error(`${path} 不存在`);
        const expected = expectedEpisodeIds(parseChatJsonl(readFileSync(path, 'utf8')).rows, Date.now(), { skipCrisis: flag('--common') });
        const present = await listDocumentIds(need('--hindsight'), need('--bank'));
        const gap = memoryGap(expected, present, option('--id-prefix') ?? '');
        console.log(`应该有的片段 ${gap.expected} 个，Hindsight 里已经有 ${gap.present} 个，还缺 ${gap.missing.length} 个${gap.missing.length ? `（最早的几个：${gap.missing.slice(0, 5).join('、')}）` : ''}`);
        process.exitCode = gap.missing.length ? 1 : 0;
    } else {
        console.error('用法：export | plan | apply | verify，见文件开头的注释');
        process.exitCode = 2;
    }
} catch (error) {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
