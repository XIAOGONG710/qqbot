// 测试数据归档（ADR 0014 决策 6）：只挪不删。Koishi 停着的时候跑：
//
//   node scripts/archive-test-data.mjs --dry-run        先看要做什么
//   node scripts/archive-test-data.mjs                  归档：聊天记录、记忆写入进度、主动消息记录挪进 archive，tiers.json 记起点，换 bank 前缀
//
// 选项：--prefix <新前缀>（默认旧前缀接上月日时分）、--data <数据目录>（默认 runtime/bot）、
//      --koishi <实例目录>（默认 QQBOT_KOISHI_DIR 或 runtime/koishi，改其中 koishi.yml 的 bank 前缀）、
//      --config <config.json>（默认 runtime/bot/config.json，独立入口用的）、--no-config（不改 config.json）
// 做法见 packages/bot/src/archive.ts 开头。

import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveTestData } from '../packages/bot/src/memory/archive.ts';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const option = name => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };

const dryRun = flag('--dry-run');
const noConfig = flag('--no-config');
const prefix = option('--prefix');
const dataDir = resolve(repoRoot, option('--data') ?? 'runtime/bot');
const koishiDir = resolve(repoRoot, option('--koishi') ?? process.env.QQBOT_KOISHI_DIR ?? 'runtime/koishi');
const configJson = resolve(repoRoot, option('--config') ?? 'runtime/bot/config.json');
if (args.length) {
    console.error(`不认识的参数：${args.join(' ')}（用法见文件开头）`);
    process.exit(2);
}

// QQ 号只留尾号（输出可能贴进聊天或报告里）
const rel = path => relative(repoRoot, path).replace(/(?<=[\\/])\d{5,}(?=[-.])/g, qq => `…${qq.slice(-2)}`);
let result;
try {
    result = archiveTestData({
        dataDir,
        configFiles: [resolve(koishiDir, 'koishi.yml'), ...(noConfig ? [] : [configJson])],
        ...(prefix ? { prefix } : {}),
        dryRun,
    });
} catch (error) {
    console.error(`没有归档：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

console.log(dryRun ? `（试一下，什么都没动）归档 ${result.stamp}：` : `归档 ${result.stamp}：`);
console.log(`  记起点：${result.since.map(s => `…${s.qq.slice(-2)}（${s.tier}）`).join('、') || '没有 tiers.json，不记'}`);
if (result.tiersBackup) console.log(`  旧的换档记录另存为 ${rel(result.tiersBackup)}`);
for (const { from, to } of result.moves) console.log(`  挪 ${rel(from)} → ${rel(to)}`);
if (result.moves.length === 0) console.log('  没有要挪的文件');
for (const p of result.prefix) console.log(`  bank 前缀 ${p.from ?? '（默认）'} → ${p.to}：${rel(p.file)}`);
for (const s of result.skipped) console.log(`  没改 ${rel(s.file)}：${s.reason}`);
if (!dryRun) console.log('完成。启动 Koishi 后，新 bank 在第一段聊天结束时建（日志「bank … 已写入 mission」）');
