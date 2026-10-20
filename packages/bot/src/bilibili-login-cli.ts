// node src/bilibili-login-cli.ts [--data-dir <目录>] [--check] [--no-open]
// 给她的 B 站号扫码登录（ADR 0089）。默认数据目录是仓库根目录下的 runtime/bot（线上那份在 qqbot/runtime/bot）；
// --check 只确认现有凭证还能不能用；--no-open 不自动打开二维码图片（只在终端里画）。
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { realRequest } from './bilibili-account.ts';
import { checkLogin, runLogin } from './bilibili-login.ts';

const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const given = value('--data-dir');
const dataDir = given ? resolve(process.env.INIT_CWD ?? process.cwd(), given) : resolve(import.meta.dirname, '../../../runtime/bot');
const deps = {
    request: realRequest,
    dataDir,
    now: Date.now,
    out: (line: string) => console.log(line),
    sleep: (ms: number) => new Promise<void>(done => setTimeout(done, ms)),
};

console.log(`数据目录：${dataDir}`);
if (args.includes('--check')) {
    const result = await checkLogin(deps);
    console.log(result.ok ? `凭证有效：「${result.name}」（uid ${result.mid}）` : `不能用：${result.message}`);
    process.exit(result.ok ? 0 : 1);
}

const result = await runLogin({
    ...deps,
    showQr: ({ svgPath, terminal }) => {
        console.log(`\n${terminal}\n`);
        console.log(`图片版：${svgPath}`);
        if (!args.includes('--no-open') && process.platform === 'win32') {
            try { spawn('explorer.exe', [svgPath], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 打不开就用终端里的 */ }
        }
    },
});
if (!result.ok) console.error(`没登录成功：${result.message}`);
process.exit(result.ok ? 0 : 1);
