// 陌生人推荐流探针（ADR 0144）：在虚拟机上跑一次，回答「这三条候选接口现在哪条能用」。
//
// 用法：
//   node scripts/qzone-strangers-probe.ts [--config <onebot11.json>] [--url <ws://...>] [--show]
// 只读：拿她号在 qzone.qq.com 的登录态，逐条候选发 GET，打印每条的 HTTP 状态、解析出的条数；
// 默认不打印正文（--show 才打印前两条的前 40 字）。全都不行就退出码 1。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jsonpBody, sessionFromCookies, type QzoneSession } from '../packages/bot/src/qzone-remote.ts';
import { extractPosts, STRANGER_FEED_ENDPOINTS } from '../packages/bot/src/qzone-strangers.ts';
import { connect, serverFromConfig, type Connection } from './napcat-probe.ts';

export interface ProbeArgs { config?: string; url?: string; show: boolean }

export function parseArgs(argv: readonly string[]): ProbeArgs {
    const args: ProbeArgs = { show: false };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]!;
        const value = (): string => { const next = argv[++i]; if (next === undefined) throw new Error(`${flag} 后面要有值`); return next; };
        switch (flag) {
            case '--config': args.config = value(); break;
            case '--url': args.url = value(); break;
            case '--show': args.show = true; break;
            default: throw new Error(`不认识的参数：${flag}`);
        }
    }
    return args;
}

const HEADERS = (session: QzoneSession): Record<string, string> => ({
    cookie: session.cookie,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    referer: 'https://user.qzone.qq.com/',
});

export async function probeStrangers(connection: Connection, show: boolean, log: (line: string) => void): Promise<number> {
    const raw = (await connection.call('get_cookies', { domain: 'qzone.qq.com' }))?.data;
    const session = sessionFromCookies(raw);
    if (!session) {
        log('拿不到 qzone 登录态（get_cookies 没有 p_skey / skey）——这条路的前提不成立');
        return 1;
    }
    log(`登录态：uin ${session.uin ?? '?'}，g_tk ${session.gtk}`);
    let working = 0;
    for (const endpoint of STRANGER_FEED_ENDPOINTS) {
        try {
            const response = await fetch(endpoint.url(session), { headers: HEADERS(session) });
            if (!response.ok) {
                log(`${endpoint.name}: HTTP ${response.status}`);
                continue;
            }
            const items = extractPosts(jsonpBody(await response.text()), 8);
            log(`${endpoint.name}: HTTP ${response.status}，解析出 ${items.length} 条`);
            if (items.length) {
                working++;
                if (show) for (const item of items.slice(0, 2)) log(`  · ${item.text.slice(0, 40)}`);
            }
        } catch (error) {
            log(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    log(working ? `可以用的候选：${working} 条` : '三条候选都读不到：接口变了或被风控');
    return working ? 0 : 1;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const configPath = args.config ?? resolve(import.meta.dirname, '..', 'runtime/napcat/workdir/config/onebot11.json');
    const server = serverFromConfig(readFileSync(configPath, 'utf8'));
    const url = args.url ?? `${server.url}${server.token ? `?access_token=${encodeURIComponent(server.token)}` : ''}`;
    const connection = await connect(url);
    try {
        process.exitCode = await probeStrangers(connection, args.show, line => console.log(line));
    } finally {
        connection.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
