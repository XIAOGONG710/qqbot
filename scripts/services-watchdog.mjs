// 服务守护（2026-10-09 用户同意「挂了就自动拉起」）：每分钟查一次 NapCat、Hindsight、Koishi，挂了就用原来的启动脚本拉起来。
// 只恢复同一版代码，不更新、不快进。连续 2 次检查都不正常才动手；同一个服务 10 分钟内拉了 3 次还不行就停手、留日志等人。
// 今晚的起因：内存挤爆时 NapCat（21:29）和 Hindsight 的窗口（21:5x）先后没了，都是人手动拉起来的，中间她收不到消息、想不起记忆。
// - NapCat：3001 端口没在听，而且没有 start-napcat.ps1 的窗口（那个窗口自己会重启 NapCat）→ 新开一个窗口跑 start-napcat.ps1。
// - Hindsight：/health 不通，而且没有 hindsight-api 进程（正在启动的不算）→ 停掉孤儿守护进程，新开窗口跑 start-hindsight.ps1。
// - Koishi：没有 Koishi 进程 → 新开窗口跑 start-koishi.ps1；进程在、但 NapCat 已经好了 3 分钟以上、Koishi 日志里最后一次连接是断开
//   （21:29 那次 Koishi 断开以后再没连回去）→ 停掉 Koishi 整棵进程树再拉起。
// 维护（上线、手动重启）时先建目录 %TEMP%\qqbot-maintenance，做完删掉；有这个目录守护什么都不动。
// 外网：每次也解析一下模型接口的域名、再连一下它的 443；最近 10 次里 7 次以上不通就记一行，最近 5 次都通了再记一行（不动手，只留痕）。
// 10-11 12:15–19:52 虚拟机解析不了外网，她连不上模型、主动消息全失败，守护只看进程和端口，一点没发现。
// 10-18 02:05 起的断网是时好时坏（DNS 偶尔成功、新连接大半超时），原来「连着 10 分钟解析不了」永远凑不齐，所以改成滑动窗口、并且加连 443。
// 告警直接发到用户的 QQ：runtime/bot/alert.json 里 enabled 为 true 并写了 qq 才发（packages/bot/src/ops/alert-qq.ts），默认什么都不发。
//
// node scripts/services-watchdog.mjs [--once]（--once：只查一次、打印结果、不动手，用来自检）
import { execFileSync, spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNetWatch } from './net-watch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const once = process.argv.includes('--once');
const LOG = join(root, 'runtime', 'services-watchdog.log');
const MAINTENANCE = join(process.env.TEMP ?? tmpdir(), 'qqbot-maintenance');
const EVERY_MS = 60_000;
const KOISHI_STALE_MS = 3 * 60_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
/** 模型接口的域名（packages/bot/src/config.ts 的默认 baseUrl，看图也走它） */
const NET_HOST = 'api.deepseek.com';
/** 最近 10 次检查里不通的有 7 次以上算断；断了以后最近 5 次都通算恢复（net-watch.mjs） */
const NET_WINDOW = 10;
const ALERT_FILE = join(root, 'runtime', 'bot', 'alert.json');

const say = (text) => {
    const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} ${text}`;
    console.log(line);
    if (!once) appendFileSync(LOG, line + '\n');
};

function tcpOpen(host, port, timeoutMs) {
    return new Promise(done => {
        const socket = createConnection({ host, port });
        const finish = (ok) => { socket.destroy(); done(ok); };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

const portOpen = (port) => tcpOpen('127.0.0.1', port, 3000);

// 2026-11-02：端口从 8888 挪到 8899（8888 被 Anaconda 的 Jupyter 占着）；
// 而且 Hindsight 根本没有 /health（404），以前一直判成“挂了”，白杀过正常进程——改成 /tree。
const HINDSIGHT_URL = process.env.QQBOT_HINDSIGHT_URL ?? 'http://127.0.0.1:8899';

async function hindsightHealthy() {
    for (const path of ['/tree', '/health']) {
        try {
            const res = await fetch(`${HINDSIGHT_URL}${path}`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) return true;
        } catch {
            // 继续试下一个
        }
    }
    return false;
}

/** 解析得了模型接口的域名（和 bot 一样走系统的 getaddrinfo），而且连得上它的 443 吗 */
async function netUp() {
    let timer;
    try {
        const { address } = await Promise.race([lookup(NET_HOST), new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('timeout')), 10_000); })]);
        return await tcpOpen(address, 443, 8000);
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** 告警发到用户的 QQ（alert.json 开了才发；发不出去只记一行，不影响守护） */
async function notify(kind, minutes) {
    try {
        const { readAlertConfig, sendAlert, dispatchNetworkAlert } = await import('../packages/bot/src/ops/alert-qq.ts');
        const config = readAlertConfig(ALERT_FILE);
        if (!config?.network) return;
        const token = process.env.QQBOT_ONEBOT_TOKEN ?? '';
        const deliveries = await dispatchNetworkAlert(config, kind, minutes, NET_HOST, (qq, text) => sendAlert({ url: 'ws://127.0.0.1:3001/', token, qq, text }));
        for (const delivery of deliveries) {
            const who = delivery.to === 'user' ? '用户' : '帮忙看虚拟机的人';
            say(delivery.ok ? `外网：已通过她的 QQ 通知${who}` : `外网：QQ 通知${who}没发出去（${delivery.reason}）`);
        }
    } catch (error) {
        say(`外网：QQ 通知出错（${error instanceof Error ? error.message : String(error)}）`);
    }
}

/** 记忆服务（Hindsight）挂了 / 回来时告诉用户（2026-11-02，F2）：她都记不住了，用户却看不出来 */
async function notifyMemory(kind, minutes) {
    try {
        const { readAlertConfig, sendAlert, memoryDownText, memoryUpText } = await import('../packages/bot/src/ops/alert-qq.ts');
        const config = readAlertConfig(ALERT_FILE);
        if (!config?.services) return;
        const text = kind === 'down' ? memoryDownText(minutes) : memoryUpText(minutes);
        const token = process.env.QQBOT_ONEBOT_TOKEN ?? '';
        const result = await sendAlert({ url: 'ws://127.0.0.1:3001/', token, qq: config.qq, text });
        say(result.ok ? `hindsight：已通过她的 QQ 告诉用户（${kind === 'down' ? '挂了' : '好了'}）` : `hindsight：QQ 通知没发出去（${result.reason}）`);
    } catch (error) {
        say(`hindsight：QQ 通知出错（${error instanceof Error ? error.message : String(error)}）`);
    }
}

/** 进程的命令行（Get-CimInstance）；查不了就当没有 */
function processes() {
    try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
            // 10-30：加上 python.exe——Hindsight 的 API 是 venv 里的 python 起的（hindsight_api.main），
            // 不是 hindsight-api.exe；原来只认 exe，于是「进程在」永远成立，/health 挂了也不拉起。
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='powershell.exe' OR Name='hindsight-api.exe' OR Name='python.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }"],
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

/**
 * 不能用 detached: true：Node 在 Windows 上会让这个中间的 powershell 没有控制台，它里面的 Start-Process 开不出窗口、也没有报错——
 * 10-11 19:57 和 10-12 09:45 两次整套停了，守护几十次「拉起」一个窗口都没开出来（start-koishi.log 一条新的 start 都没有），停了近三小时。
 * 10-12 12:52 在这台 VM 上拿无害脚本试了四种：detached: true 两种都没有窗口，detached: false 两种都开出来了（用户会话 6、可交互）。
 * 中间的 powershell 开完窗口就退出，新窗口是它的孙进程，不跟着守护走。
 */
function openWindow(script) {
    const file = join(root, 'scripts', script);
    const child = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process powershell.exe -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','${file}' -WorkingDirectory '${root}'`],
    { stdio: 'ignore', windowsHide: true });
    child.on('error', error => say(`开窗口失败（${script}）：${error.message}`));
    child.unref();
}

function kill(pids) {
    for (const pid of pids) {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已经没了 */ }
    }
}

/** 几点以后做当天的备份（凌晨 3 点：她一般睡了，数据库不忙） */
const BACKUP_HOUR = 3;

/** 记忆服务不通多久才打扰用户（分钟）：短暂重启不吭声 */
const MEMORY_ALERT_MINUTES = 10;
let memoryDownSince = 0;
let memoryAlerted = false;

const bad = { napcat: 0, hindsight: 0, koishi: 0 };
const restarts = { napcat: [], hindsight: [], koishi: [] };
const gaveUp = new Set();
let napcatUpSince = Date.now();
const netWatch = createNetWatch({ window: NET_WINDOW, badMin: 7, goodRun: 5, everyMs: EVERY_MS });

function watchNet(up) {
    const event = netWatch.push(up);
    if (event?.kind === 'down') {
        say(`外网：最近 ${NET_WINDOW} 次检查有 ${event.bad} 次连不上 ${NET_HOST}（解析或 443），大约 ${event.minutes} 分钟了，她多半连不上模型（回复、主动消息、看图都会失败）；守护不动手，查虚拟机网络 / 宿主机`);
        void notify('down', event.minutes);
    } else if (event?.kind === 'up') {
        say(`外网：恢复正常（连不上 ${NET_HOST} 大约 ${event.minutes} 分钟）`);
        void notify('up', event.minutes);
    }
}

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
    const net = await netUp();
    // 10-30 修：这里原来是 /qqbot\\node_modules\\koishi/，目录改成 qqbot-dsh-control 之后不再匹配——
    // 守护每分钟都以为「没有 Koishi 进程」，于是不停拉起新实例（最多同时四个），她的回复重复、他的话在记录里也是两遍。
    const koishiProcs = procs.filter(p => p.name === 'node.exe' && /node_modules[\\/]koishi[\\/]/.test(p.cmd));
    const connection = koishiConnection();
    if (!napcatUp) napcatUpSince = Infinity;
    else if (napcatUpSince === Infinity) napcatUpSince = Date.now();

    // 记忆服务：连续多久不通 / 有没有已经通知过（重启会清 bad.hindsight，所以单独记）
    if (hindsightUp) {
        if (memoryDownSince) {
            const minutes = Math.round((Date.now() - memoryDownSince) / 60_000);
            if (memoryAlerted && minutes >= MEMORY_ALERT_MINUTES) await notifyMemory('up', minutes);
            memoryDownSince = 0;
            memoryAlerted = false;
        }
    } else if (!memoryDownSince) {
        memoryDownSince = Date.now();
    } else if (!memoryAlerted && Date.now() - memoryDownSince >= MEMORY_ALERT_MINUTES * 60_000) {
        memoryAlerted = true;
        await notifyMemory('down', Math.round((Date.now() - memoryDownSince) / 60_000));
    }
    const status = {
        napcat: napcatUp,
        hindsight: hindsightUp,
        koishi: koishiProcs.length > 0
            && !(connection?.state === 'disconnected' && napcatUp && Date.now() - napcatUpSince >= KOISHI_STALE_MS
                && Date.now() - Date.parse(connection.at) >= KOISHI_STALE_MS),
    };
    if (once) {
        console.log(JSON.stringify({ ...status, net, koishiProcesses: koishiProcs.length, lastConnection: connection, maintenance: existsSync(MAINTENANCE) }));
        return;
    }
    watchNet(net);
    for (const service of Object.keys(status)) {
        if (status[service]) {
            if (bad[service] || gaveUp.has(service)) say(`${service}：恢复正常`);
            bad[service] = 0;
            gaveUp.delete(service);
        } else {
            bad[service]++;
        }
    }
    // 每天一份备份（F3，2026-11-02）：凌晨 3 点以后第一次检查时做，脚本自己会跳过“今天已经有了”
    const nowHour = new Date().getHours();
    if (nowHour >= BACKUP_HOUR) {
        try {
            execFileSync(process.execPath, ['scripts/backup.mjs'], { cwd: root, timeout: 15 * 60_000, stdio: 'ignore' });
        } catch (error) {
            say(`备份：没做成（${error instanceof Error ? error.message.split(String.fromCharCode(10))[0] : String(error)}）`);
        }
    }
    if (existsSync(MAINTENANCE)) return;

    if (bad.napcat >= 2 && !procs.some(p => p.name === 'powershell.exe' && /start-napcat\.ps1/.test(p.cmd)) && allowed('napcat')) {
        say('napcat：3001 端口两分钟没在听，也没有 start-napcat 的窗口，拉起 NapCat');
        openWindow('start-napcat.ps1');
        bad.napcat = 0;
    }
    // 10-30：判断「进程在不在」改成认 python 起的 hindsight_api（原来只认 hindsight-api.exe，永远判成「在」，
    // 今天 16:03 API 被停掉、79 分钟没人拉起就是这么来的）
    const hindsightProcs = procs.filter(p => p.name === 'hindsight-api.exe' || (p.name === 'python.exe' && /hindsight[_-]?api/i.test(p.cmd)));
    if (bad.hindsight >= 2 && hindsightProcs.length === 0 && allowed('hindsight')) {
        say('hindsight：/health 两分钟不通，也没有 hindsight_api 进程，拉起 Hindsight（先停掉孤儿守护进程）');
        kill(procs.filter(p => p.name === 'node.exe' && /hindsight-watchdog/.test(p.cmd)).map(p => p.pid));
        openWindow('start-hindsight.ps1');
        bad.hindsight = 0;
    } else if (bad.hindsight >= 6 && hindsightProcs.length && allowed('hindsight')) {
        // 2026-11-01：进程卡在模型初始化——python 在、端口永远不听。以前只看「进程在不在」，
        // 于是这种「挂着」永远等不到重启，她整晚写不进记忆。连着 6 分钟不通就当它死了。
        say('hindsight：/health 六分钟不通，但 python 进程还在（卡在初始化），掐掉重拉');
        kill(hindsightProcs.map(p => p.pid));
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
    say(`服务守护：每 ${EVERY_MS / 1000} 秒查一次 NapCat（3001）、Hindsight（/health）、Koishi、外网（${NET_HOST}）；有 ${MAINTENANCE} 时不动手`);
    await check();
    setInterval(() => void check().catch(error => say(`这次检查出错：${error instanceof Error ? error.message : String(error)}`)), EVERY_MS);
}
