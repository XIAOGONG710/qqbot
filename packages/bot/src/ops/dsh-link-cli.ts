// DSH 连接检查 / 受控咨询：
//   node src/ops/dsh-link-cli.ts probe
//   node src/ops/dsh-link-cli.ts ask "请审阅当前真人式数值的联动风险"
// 默认只做探针；不会读取聊天记录，也不会把 key 打到屏幕或日志里。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { createDshLink, dshOptionsFromLlm } from '../dsh-link.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [command, ...rest] = process.argv.slice(2);

if (command === '--help' || command === '-h') {
    console.log('用法：npm run dsh:link --workspace @qqbot/bot -- [probe|ask <问题>]');
    console.log('  probe          检查 DSH 接口连通性（默认命令）');
    console.log('  ask <问题>     发起一次受控咨询，不读取聊天记录');
    process.exit(0);
}

const config = loadConfig(repoRoot);
const link = createDshLink(dshOptionsFromLlm(config.llm, {
    ...(config.dsh.baseUrl ? { baseUrl: config.dsh.baseUrl } : {}),
    ...(config.dsh.model ? { model: config.dsh.model } : {}),
    ...(config.dsh.timeoutMs === undefined ? {} : { timeoutMs: config.dsh.timeoutMs }),
}), { log: message => console.error(`[dsh] ${message}`) });

if (!command || command === 'probe') {
    const result = await link.probe();
    console.log(JSON.stringify({ ...result, apiKey: undefined }, null, 2));
    process.exit(result.ok ? 0 : 1);
}

if (command === 'ask') {
    const question = rest.join(' ').trim();
    if (!question) throw new Error('用法：dsh-link-cli.ts ask <问题>');
    console.log(await link.advise({ question }));
    process.exit(0);
}

throw new Error(`未知命令：${command}（可用 probe / ask）`);
