// 守护的守护（2026-10-31 用户：「又没了，你重新拉起」/「做」）
//
// 今晚 21:39 起的 services-watchdog 在 22:2x 跟 Koishi、Hindsight 一起没了——守护自己也需要人看。
// 这个脚本每 60 秒看一眼：services-watchdog 进程在不在，不在就 detached 拉起。
// 它自己很轻（只读进程列表），不会去动别的服务。
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(process.env.USERPROFILE ?? '', 'Desktop', 'qqbot-dsh-control');
const log = join(repo, 'runtime', 'watchdog-supervisor.log');
mkdirSync(join(repo, 'runtime'), { recursive: true });
const say = (line) => { try { appendFileSync(log, `${new Date().toLocaleString('zh-CN', { hour12: false })} ${line}\n`); } catch { /* 日志写不了也接着干 */ } };

function running() {
    try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'services-watchdog' } | Measure-Object).Count"], { encoding: 'utf8', timeout: 20_000 });
        return Number(out.trim()) > 0;
    } catch { return true; } // 查不了就当它在，别乱拉
}

function start() {
    const child = spawn('node', ['scripts\\services-watchdog.mjs'], { cwd: repo, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
}

say('守护的守护：上线（每 60 秒看一次 services-watchdog）');
for (;;) {
    if (!running()) {
        say('services-watchdog 不在，拉起来');
        start();
        await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    await new Promise(resolve => setTimeout(resolve, 60_000));
}
