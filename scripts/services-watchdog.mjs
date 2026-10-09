// 服务守护（2026-10-09 用户同意「挂了就自动拉起」）：每分钟查一次 NapCat、Hindsight、Koishi，挂了就用原来的启动脚本拉起来。
// 只恢复同一版代码，不更新、不快进。连续 2 次检查都不正常才动手；同一个服务 10 分钟内拉了 3 次还不行就停手、留日志等人。
// 今晚的起因：内存挤爆时 NapCat（21:29）和 Hindsight 的窗口（21:5x）先后没了，都是人手动拉起来的，中间她收不到消息、想不起记忆。
// - NapCat：3001 端口没在听，而且没有 start-napcat.ps1 的窗口（那个窗口自己会重启 NapCat）→ 新开一个窗口跑 start-napcat.ps1。
// - Hindsight：/health 不通，而且没有 hindsight-api 进程（正在启动的不算）→ 停掉孤儿守护进程，新开窗口跑 start-hindsight.ps1。
// - Koishi：没有 Koishi 进程 → 新开窗口跑 start-koishi.ps1；进程在、但 NapCat 已经好了 3 分钟以上、Koishi 日志里最后一次连接是断开
//   （21:29 那次 Koishi 断开以后再没连回去）→ 停掉 Koishi 整棵进程树再拉起。
// 维护（上线、手动重启）时先建目录 %TEMP%\qqbot-maintenance，做完删掉；有这个目录守护什么都不动。
//
// node scripts/services-watchdog.mjs [--once]（--once：只查一次、打印结果、不动手，用来自检）
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const once = process.argv.includes('--once');
const LOG = join(root, 'runtime', 'services-watchdog.log');
const MAINTENANCE = join(process.env.TEMP ?? tmpdir(), 'qqbot-maintenance');
const EVERY_MS = 60_000;
const KOISHI_STALE_MS = 3 * 60_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;

const say = (text) => {
    const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} ${text}`;
    console.log(line);
    if (!once) appendFileSync(LOG, line + '\n');
};

function portOpen(port) {
    return new Promise(done => {
        const socket = createConnection({ host: '127.0.0.1', port });
        const finish = (ok) => { socket.destroy(); done(ok); };
        socket.setTimeout(3000, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

async function hindsightHealthy() {
    try {
        const res = await fetch('http://127.0.0.1:8888/health', { signal: AbortSignal.timeout(5000) });
        return res.ok;
    } catch {
        return false;
    }
}

/** 进程的命令行（Get-CimInstance）；查不了就当没有 */
function processes() {
    try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='powershell.exe' OR Name='hindsight-api.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }"],
        { encoding: 'utf8', timeout: 30_000 });
        return out.split(/\r?\n/).filter(Boolean).map(line => {
            const [pid, name, ...rest] = line.split('\t');
            return { pid: Number(pid), name, cmd: rest.join('\t') };
        });
    } catch {
        return undefined;
    }
}

/** Koishi 日志里最后一次连接事件：connected / disconnected，和它的时间 */
function koishiConnection() {
    const dir = join(root, 'runtime', 'koishi', 'data', 'logs');
    if (!existsSync(dir)) return undefined;
    const newest = readdirSync(dir).filter(name => name.endsWith('.log')).map(name => join(dir, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!newest) return undefined;
    let last;
    for (const line of readFileSync(newest, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const text = String(entry.content ?? '');
        if (/已就绪|connect to server/.test(text)) last = { state: 'connected', at: entry.timestamp };
        else if (/NapCat 连接断开|failed to connect/.test(text)) last = { state: 'disconnected', at: entry.timestamp };
    }
    return last;
}

function openWindow(script) {
    const file = join(root, 'scripts', script);
    spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process powershell.exe -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','${file}' -WorkingDirectory '${root}'`],
    { detached: true, stdio: 'ignore' }).unref();
}

function kill(pids) {
    for (const pid of pids) {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已经没了 */ }
    }
}

const bad = { napcat: 0, hindsight: 0, koishi: 0 };
const restarts = { napcat: [], hindsight: [], koishi: [] };
const gaveUp = new Set();
let napcatUpSince = Date.now();

function allowed(service) {
    const now = Date.now();
    restarts[service] = restarts[service].filter(at => now - at < RESTART_WINDOW_MS);
    if (restarts[service].length >= MAX_RESTARTS) {
        if (!gaveUp.has(service)) say(`${service}：10 分钟内已经拉了 ${MAX_RESTARTS} 次还不行，停手，等人来看`);
        gaveUp.add(service);
        return false;
    }
    restarts[service].push(now);
    return true;
}

async function check() {
    const procs = processes();
    if (!procs) return say('这次查不了进程（PowerShell 起不来，多半内存不够），下一分钟再查');
    const napcatUp = await portOpen(3001);
    const hindsightUp = await hindsightHealthy();
    const koishiProcs = procs.filter(p => p.name === 'node.exe' && /qqbot\\node_modules\\koishi/.test(p.cmd));
    const connection = koishiConnection();
    if (!napcatUp) napcatUpSince = Infinity;
    else if (napcatUpSince === Infinity) napcatUpSince = Date.now();

    const status = {
        napcat: napcatUp,
        hindsight: hindsightUp,
        koishi: koishiProcs.length > 0
            && !(connection?.state === 'disconnected' && napcatUp && Date.now() - napcatUpSince >= KOISHI_STALE_MS
                && Date.now() - Date.parse(connection.at) >= KOISHI_STALE_MS),
    };
    if (once) {
        console.log(JSON.stringify({ ...status, koishiProcesses: koishiProcs.length, lastConnection: connection, maintenance: existsSync(MAINTENANCE) }));
        return;
    }
    for (const service of Object.keys(status)) {
        if (status[service]) {
            if (bad[service] || gaveUp.has(service)) say(`${service}：恢复正常`);
            bad[service] = 0;
            gaveUp.delete(service);
        } else {
            bad[service]++;
        }
    }
    if (existsSync(MAINTENANCE)) return;

    if (bad.napcat >= 2 && !procs.some(p => p.name === 'powershell.exe' && /start-napcat\.ps1/.test(p.cmd)) && allowed('napcat')) {
        say('napcat：3001 端口两分钟没在听，也没有 start-napcat 的窗口，拉起 NapCat');
        openWindow('start-napcat.ps1');
        bad.napcat = 0;
    }
    if (bad.hindsight >= 2 && !procs.some(p => p.name === 'hindsight-api.exe') && allowed('hindsight')) {
        say('hindsight：/health 两分钟不通，也没有 hindsight-api 进程，拉起 Hindsight（先停掉孤儿守护进程）');
        kill(procs.filter(p => p.name === 'node.exe' && /hindsight-watchdog/.test(p.cmd)).map(p => p.pid));
        openWindow('start-hindsight.ps1');
        bad.hindsight = 0;
    }
    if (bad.koishi >= 2 && allowed('koishi')) {
        if (koishiProcs.length) {
            say(`koishi：NapCat 好了 3 分钟以上，Koishi 最后一次连接还是断开（${connection?.at}），停掉 Koishi 再拉起`);
            kill(koishiProcs.filter(p => /bin\.js/.test(p.cmd)).map(p => p.pid));
            kill(koishiProcs.map(p => p.pid));
        } else {
            say('koishi：两分钟没有 Koishi 进程，拉起 Koishi');
        }
        openWindow('start-koishi.ps1');
        bad.koishi = 0;
    }
}

if (once) {
    await check();
} else {
    say(`服务守护：每 ${EVERY_MS / 1000} 秒查一次 NapCat（3001）、Hindsight（/health）、Koishi；有 ${MAINTENANCE} 时不动手`);
    await check();
    setInterval(() => void check().catch(error => say(`这次检查出错：${error instanceof Error ? error.message : String(error)}`)), EVERY_MS);
}
