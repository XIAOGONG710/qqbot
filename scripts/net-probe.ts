// Network probe (docs/boot-start.md): every 30 s it tests system DNS, the NAT gateway used as a DNS server, a public DNS server, direct TCP 443 to
// two public IPs and to the last resolved DeepSeek IP, and ICMP to the NAT gateway; one line per round in <log dir>/probe.log.
// Why: on 2026-10-16 (05:31 to 10-17 02:02) the VM could not open ANY new outside connection for about 20 h while QQ stayed connected. The probe log is what
// showed it was not DNS (every target timed out at once), so keep it running: it is the only record of the next outage. The NAT gateway answering ICMP
// while everything outside times out points at the host's upstream network; the gateway failing too points at VMware NAT or the virtual NIC.
// (192.168.139.1 never answers ICMP even when healthy, so it is not probed.)
// Usage: node scripts/net-probe.ts [log dir]   (default %TEMP%\qqbot-net-probe; create a file named stop in it to make the probe exit).
// Read-only on the network; changes no setting. Started by scripts/start-services-at-boot.ps1.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
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
const ping = (host: string) => new Promise<void>((resolve, reject) => {
    execFile('ping', ['-n', '1', '-w', '1500', host], { timeout: 4000, windowsHide: true }, (error, stdout) => {
        if (!error && /TTL=/i.test(stdout)) resolve(); else reject(Object.assign(new Error('no reply'), { code: 'NOREPLY' }));
    });
});
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
    // ICMP to the NAT gateway: see the header.
    const icmp = await Promise.all([GATEWAY].map(async host => `${host}=${await outcome(ping(host))}`));
    return `dns[system=${system} gateway=${gateway} ${PUBLIC_DNS}=${publicDns}] tcp[${direct.join(' ')} ${deepseek}] icmp[${icmp.join(' ')}]`;
}

for (;;) {
    if (existsSync(join(dir, 'stop'))) break;
    const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${await once()}\n`;
    appendFileSync(join(dir, 'probe.log'), line);
    await new Promise(resolve => setTimeout(resolve, 30_000));
}
