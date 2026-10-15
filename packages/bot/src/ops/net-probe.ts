// 网络探针（ADR 0070 第 17 项的运维部分）：每 30 秒分别测「系统 DNS」「网关 DNS」「公共 DNS」「直连 IP 的 443」，一行一次写进日志。
// 为什么：虚拟机解析 api.deepseek.com 反复失败（10-11 白天、10-13 21:46 起到 10-14 下午累计 14.7 小时），
// 看门狗只记「解析不了」，分不出是 VMware 的 DNS 代理坏了（换个解析器就好）、整张网都断了、还是只有 DeepSeek 这一个域名。
// 用法：node src/ops/net-probe.ts [日志目录]；日志目录里建一个叫 stop 的文件就退出。只读网络，不改任何设置。
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { Resolver } from 'node:dns/promises';
import { join } from 'node:path';

const dir = process.argv[2] ?? join(process.env.TEMP ?? '.', 'qqbot-net-probe');
mkdirSync(dir, { recursive: true });
const HOST = 'api.deepseek.com';
const GATEWAY = '192.168.139.2';
const PUBLIC_DNS = '223.5.5.5';
const TCP_TARGETS: readonly [string, number][] = [['1.1.1.1', 443], ['223.5.5.5', 443]];
let lastDeepseekIp: string | undefined;

const timed = async <T>(work: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]);
    } finally { clearTimeout(timer); }
};
const outcome = async (work: Promise<unknown>, ms = 5000): Promise<string> => {
    const started = Date.now();
    try {
        await timed(work, ms);
        return `ok${Date.now() - started}ms`;
    } catch (error) {
        const code = (error as { code?: string }).code ?? (error as Error).message;
        return `FAIL(${code})`;
    }
};
const resolveVia = (server?: string) => {
    const resolver = new Resolver({ timeout: 4000, tries: 1 });
    if (server) resolver.setServers([server]);
    return resolver.resolve4(HOST).then(addresses => { lastDeepseekIp = addresses[0]; return addresses; });
};
const tcp = (host: string, port: number) => new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port, timeout: 4000 }, () => { socket.destroy(); resolve(); });
    socket.on('timeout', () => { socket.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    socket.on('error', reject);
});

async function once(): Promise<string> {
    const [system, gateway, publicDns] = await Promise.all([outcome(resolveVia()), outcome(resolveVia(GATEWAY)), outcome(resolveVia(PUBLIC_DNS))]);
    const direct = await Promise.all(TCP_TARGETS.map(async ([host, port]) => `${host}:${port}=${await outcome(tcp(host, port))}`));
    const deepseek = lastDeepseekIp ? `deepseek-ip:443=${await outcome(tcp(lastDeepseekIp, 443))}` : 'deepseek-ip:443=n/a';
    return `dns[system=${system} gateway=${gateway} ${PUBLIC_DNS}=${publicDns}] tcp[${direct.join(' ')} ${deepseek}]`;
}

for (;;) {
    if (existsSync(join(dir, 'stop'))) break;
    const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${await once()}\n`;
    appendFileSync(join(dir, 'probe.log'), line);
    await new Promise(resolve => setTimeout(resolve, 30_000));
}
