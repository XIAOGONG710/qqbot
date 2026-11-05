// npm run feedback-digest -w packages/bot -- [--days 7] [--dir <数据目录>]
// 只读：读数据目录里的 feedback/*.jsonl，把摘要打印到终端（里面有聊天原文，不写文件、不进仓库）。
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { feedbackDigest, readFeedback } from './feedback-digest.ts';

const args = process.argv.slice(2);
try {
    const options = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i]!; const value = args[i + 1];
        if (!['--days', '--dir'].includes(name) || options.has(name) || !value || value.startsWith('--')) throw new Error('参数无效');
        options.set(name, value);
    }
    const days = Number(options.get('--days') ?? 7);
    if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(days * 86_400_000)) throw new Error('天数无效');
    const dataDir = resolve(options.get('--dir') ?? resolve(import.meta.dirname, '../../../../runtime/bot'));
    try { if (!statSync(dataDir).isDirectory()) throw new Error('不是目录'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    console.log(feedbackDigest(readFeedback(dataDir), new Date(), days));
} catch {
    // 目录/JSON错误可能带路径或聊天原文，不打印异常对象。
    console.error('反馈摘要失败：请检查参数（--days 正数、--dir 数据目录）及反馈文件读取权限');
    process.exitCode = 2;
}
