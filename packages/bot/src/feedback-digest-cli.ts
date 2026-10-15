// npm run feedback-digest -w packages/bot -- [--days 7] [--dir <数据目录>]
// 只读：读数据目录里的 feedback/*.jsonl，把摘要打印到终端（里面有聊天原文，不写文件、不进仓库）。
import { resolve } from 'node:path';
import { feedbackDigest, readFeedback } from './feedback-digest.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const days = Number(option('--days') ?? 7);
if (!Number.isFinite(days) || days <= 0) {
    console.error('--days 要是正数');
    process.exit(2);
}
const dataDir = resolve(option('--dir') ?? resolve(import.meta.dirname, '../../../runtime/bot'));
console.log(feedbackDigest(readFeedback(dataDir), new Date(), days));
