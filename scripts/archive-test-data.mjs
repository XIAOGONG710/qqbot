// 测试数据归档（ADR 0014 决策 6）：只挪不删。Koishi 停着的时候跑：
//
//   node scripts/archive-test-data.mjs --dry-run        先看要做什么
//   node scripts/archive-test-data.mjs                  归档：聊天记录、记忆写入进度、主动消息记录挪进 archive，tiers.json 记起点，换 bank 前缀
//   node scripts/archive-test-data.mjs --resume <UUID>  中断后继续原计划；不会重新发现目标或改变原前缀
//
// 选项：--prefix <新前缀>（默认旧前缀接上月日时分）、--data <数据目录>（默认 runtime/bot）、
//      --koishi <实例目录>（默认 QQBOT_KOISHI_DIR 或 runtime/koishi，改其中 koishi.yml 的 bank 前缀）、
//      --config <config.json>（默认 runtime/bot/config.json，独立入口用的）、--no-config（不改 config.json）
// 参数不能重复；带值参数必须提供非空值；--config 与 --no-config 不能同时使用。
// 做法见 packages/bot/src/archive.ts 开头。

import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveTestData } from '../packages/bot/src/memory/archive.ts';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
const args = process.argv.slice(2);
const switches = new Set(['--dry-run', '--no-config']);
const valueOptions = new Set(['--prefix', '--resume', '--data', '--koishi', '--config']);
const parsed = new Map();
for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!switches.has(name) && !valueOptions.has(name)) {
        console.error('不认识的参数（用法见文件开头）'); process.exit(2);
    }
    if (parsed.has(name)) {
        console.error(`参数重复：${name}；不会创建新归档任务。`); process.exit(2);
    }
    if (switches.has(name)) { parsed.set(name, true); continue; }
    const value = args[++index];
    if (value === undefined || !value.trim() || value.startsWith('--')) {
        console.error(name === '--resume' ? '--resume 需要原归档任务UUID；不会创建新任务。' : `${name} 需要非空值；不会创建新归档任务。`);
        process.exit(2);
    }
    parsed.set(name, value);
}
if (parsed.has('--config') && parsed.has('--no-config')) {
    console.error('--config 与 --no-config 冲突；不会创建新归档任务。'); process.exit(2);
}
const option = name => parsed.get(name);

const dryRun = parsed.has('--dry-run');
const noConfig = parsed.has('--no-config');
const prefix = option('--prefix');
const resume = option('--resume');
const dataDir = resolve(repoRoot, option('--data') ?? 'runtime/bot');
const koishiDir = resolve(repoRoot, option('--koishi') ?? process.env.QQBOT_KOISHI_DIR ?? 'runtime/koishi');
const configJson = resolve(repoRoot, option('--config') ?? 'runtime/bot/config.json');

// QQ 号只留尾号（输出可能贴进聊天或报告里）
const rel = path => relative(repoRoot, path).replace(/(?<=[\\/])\d{5,}(?=[-.])/g, qq => `…${qq.slice(-2)}`);
let result;
try {
    result = archiveTestData({
        dataDir,
        configFiles: [resolve(koishiDir, 'koishi.yml'), ...(noConfig ? [] : [configJson])],
        ...(prefix ? { prefix } : {}),
        ...(resume ? { resume } : {}),
        dryRun,
    });
} catch (error) {
    console.error(`没有归档：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

console.log(dryRun ? `（试一下，什么都没动）归档 ${result.stamp}：` : `归档 ${result.stamp}：`);
if (result.jobId) console.log(`  归档任务：${result.jobId}（${result.complete ? '已完成' : '未完成；请用 --resume 原任务UUID 恢复'}）`);
console.log(`  记起点：${result.since.map(s => `…${s.qq.slice(-2)}（${s.tier}）`).join('、') || '没有 tiers.json，不记'}`);
if (result.tiersBackup) console.log(`  旧的换档记录另存为 ${rel(result.tiersBackup)}`);
for (const { from, to } of result.moves) console.log(`  挪 ${rel(from)} → ${rel(to)}`);
if (result.moves.length === 0) console.log('  没有要挪的文件');
for (const p of result.prefix) console.log(`  bank 前缀 ${p.from ?? '（默认）'} → ${p.to}：${rel(p.file)}`);
for (const s of result.skipped) console.log(`  没改 ${rel(s.file)}：${s.reason}`);
if (!dryRun) console.log('完成。启动 Koishi 后，新 bank 在第一段聊天结束时建（日志「bank … 已写入 mission」）');
