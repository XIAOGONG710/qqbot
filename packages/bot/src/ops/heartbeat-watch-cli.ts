// node src/ops/heartbeat-watch-cli.ts [--dir <数据目录，默认 runtime/bot>] [--max-minutes 15] [--every 60] [--once]
// 看 heartbeat.json 多久没更新（超过 --max-minutes 分钟且没有维护旗就告警）。不改任何东西，除了下面的告警输出。
// 告警通道可插拔，默认两处：控制台一行；数据目录里的 ALERT.txt（故障时写，恢复时删）。
// 推送留空，用哪个服务由用户定：设环境变量 QQBOT_ALERT_COMMAND（比如调 ntfy / Bark 的 curl），故障和恢复时各运行一次，
// 消息在环境变量 QQBOT_ALERT_MESSAGE 里（不要把消息拼进命令行）。没设就不推送。
// --once：只看一次、打印结论、退出（退出码 0 正常或无需告警，1 告警）。不带就一直跑，每 --every 秒看一次，要停就关掉它。
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkHeartbeat, HEARTBEAT_STALE_MS, watchStep, type AlertSink } from '../heartbeat.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const dataDir = resolve(option('--dir') ?? resolve(import.meta.dirname, '../../../../runtime/bot'));
const maxAgeMs = Number(option('--max-minutes') ?? HEARTBEAT_STALE_MS / 60_000) * 60_000;
const everyMs = Number(option('--every') ?? 60) * 1000;
const once = args.includes('--once');
if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || !Number.isFinite(everyMs) || everyMs <= 0) {
    console.error('--max-minutes 和 --every 要是正数');
    process.exit(2);
}
const maintenanceFlag = join(process.env.TEMP ?? tmpdir(), 'qqbot-maintenance');
const alertFile = join(dataDir, 'ALERT.txt');
const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });

// 推送命令是子进程：Windows 上父进程一退出它就被带走，所以 --once 要等它跑完（最多 30 秒）再退出
const pushes: Promise<void>[] = [];
function push(message: string): void {
    const command = process.env.QQBOT_ALERT_COMMAND;
    if (!command) return;
    pushes.push(new Promise<void>(done => {
        const child = spawn(command, { shell: true, stdio: 'ignore', timeout: 30_000, env: { ...process.env, QQBOT_ALERT_MESSAGE: message } });
        child.on('error', error => { console.error(`[${stamp()}] 告警命令跑不起来：${error.message}`); done(); });
        child.on('close', () => done());
    }));
}

const sink: AlertSink = {
    raise(message) {
        console.log(`[${stamp()}] 告警：${message}`);
        writeFileSync(alertFile, `${stamp()} ${message}\n`, 'utf8');
        push(message);
    },
    clear(message) {
        console.log(`[${stamp()}] 恢复：${message}`);
        rmSync(alertFile, { force: true });
        push(message);
    },
};

let alerting = existsSync(alertFile);
function tick(): boolean {
    const verdict = checkHeartbeat(dataDir, new Date(), { maxAgeMs, maintenance: existsSync(maintenanceFlag) });
    alerting = watchStep(verdict, alerting, sink);
    if (once) {
        const detail = verdict.state === 'ok' || verdict.state === 'stale' ? `，最后一次心跳 ${Math.round(verdict.ageMs / 1000)} 秒前` : '';
        console.log(`[${stamp()}] 心跳：${verdict.state}${detail}`);
    }
    return alerting;
}

if (once) {
    const failing = tick();
    await Promise.allSettled(pushes);
    process.exit(failing ? 1 : 0);
} else {
    console.log(`[${stamp()}] 心跳守望：看 ${dataDir}\\heartbeat.json，超过 ${Math.round(maxAgeMs / 60_000)} 分钟没更新就告警；每 ${everyMs / 1000} 秒一次；有 ${maintenanceFlag} 时免检`);
    tick();
    setInterval(tick, everyMs);
}
