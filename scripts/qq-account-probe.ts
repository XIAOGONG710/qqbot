// 账号控制面探针（ADR 0142）：在你在场时把「她这个号到底能做什么」一次问完，只读，不改任何东西。
//
// 用法（在线上虚拟机里跑；不重启、不开机器人的任何开关）：
//   node scripts/qq-account-probe.ts [--config <onebot11.json>] [--url <ws://...>] [--count 8] [--out <报告.json>]
// 它做四件事：
//   1) get_login_info：确认连的是她的号；
//   2) 盘点：好友多少人、群多少个（get_friend_list / get_group_list，只数个数）；
//   3) 读空间：把 qzone-feed 里的候选动作名逐个试一遍，报告哪个能用、读回几条（不打印正文）；
//   4) 闸的演示：用 read 档建一个控制面，跑一条读动作、试一条写动作（应当被拒绝），证明默认关是真的关着。
// token 从 NapCat 的 onebot11.json 读（不打印）。报告里只有动作名、条数、错误码，没有聊天正文。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccount, DEFAULT_ACCOUNT_POLICY } from '../packages/bot/src/account.ts';
import { normalizeQzoneFeed, QZONE_READ_ACTIONS, readQzoneFeed } from '../packages/bot/src/qzone-feed.ts';
import { connect, serverFromConfig, type Connection } from './napcat-probe.ts';

interface Args { config?: string; url?: string; count: number; out?: string }

export function parseArgs(argv: readonly string[]): Args {
    const args: Args = { count: 8 };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]!;
        const value = (): string => { const next = argv[++i]; if (next === undefined) throw new Error(`${flag} 后面要有值`); return next; };
        switch (flag) {
            case '--config': args.config = value(); break;
            case '--url': args.url = value(); break;
            case '--count': args.count = Number(value()); break;
            case '--out': args.out = value(); break;
            default: throw new Error(`不认识的参数：${flag}`);
        }
    }
    if (!Number.isSafeInteger(args.count) || args.count < 1 || args.count > 20) throw new Error('--count 要在 1 到 20 之间');
    return args;
}

export interface ProbeReport {
    at: string;
    login: { uin?: number; nickname?: string } | null;
    friends: number;
    groups: number;
    readActions: { action: string; ok: boolean; count?: number; error?: string }[];
    qzone: { action: string; count: number } | null;
    gate: { readAllowed: boolean; writeDenied: string | null };
}

export async function runAccountProbe(connection: Connection, count: number): Promise<ProbeReport> {
    const call = async (action: string, params: Record<string, unknown> = {}): Promise<unknown> => {
        const response = await connection.call(action, params);
        if (response.retcode !== 0) throw new Error(`retcode ${response.retcode}${response.wording ? ` ${response.wording}` : ''}`);
        return response.data;
    };

    // 控制面按 read 档建：拉列表走它的闸，写动作应当被拒
    const account = createAccount({ policy: { ...DEFAULT_ACCOUNT_POLICY, mode: 'read' }, call });
    const login = await call('get_login_info') as { user_id?: unknown; nickname?: unknown } | undefined;
    const friends = await call('get_friend_list').catch(() => []);
    const groups = await call('get_group_list').catch(() => []);

    // 空间：候选动作逐个试（每个都直接调一次，拿到它的真实成败；不给正文）
    const readActions: ProbeReport['readActions'] = [];
    for (const action of QZONE_READ_ACTIONS) {
        try {
            const data = await call(action, { count, pos: 0 });
            readActions.push({ action, ok: true, count: normalizeQzoneFeed(data).length });
        } catch (error) {
            readActions.push({ action, ok: false, error: error instanceof Error ? error.message.slice(0, 80) : String(error).slice(0, 80) });
        }
    }
    const feed = await readQzoneFeed(call, { count });
    const writeDenied = await account.run('send_private_msg', { user_id: 1, message: 'probe' }).then(() => null).catch(error => (error instanceof Error ? error.message : String(error)));

    return {
        at: new Date().toISOString(),
        login: login ? {
            ...(Number.isSafeInteger(Number(login.user_id)) ? { uin: Number(login.user_id) } : {}),
            ...(typeof login.nickname === 'string' ? { nickname: login.nickname } : {}),
        } : null,
        friends: Array.isArray(friends) ? friends.length : 0,
        groups: Array.isArray(groups) ? groups.length : 0,
        readActions,
        qzone: feed ? { action: feed.action, count: feed.items.length } : null,
        gate: { readAllowed: account.check('get_friend_list').allowed, writeDenied },
    };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const configPath = args.config ?? resolve(import.meta.dirname, '..', 'runtime/napcat/workdir/config/onebot11.json');
    const server = serverFromConfig(readFileSync(configPath, 'utf8'));
    const url = args.url ?? `${server.url}${server.token ? `?access_token=${encodeURIComponent(server.token)}` : ''}`;
    const connection = await connect(url);
    try {
        const report = await runAccountProbe(connection, args.count);
        console.log(`账号：${report.login?.nickname ?? '?'}（${report.login?.uin ?? '?'}）  好友 ${report.friends}  群 ${report.groups}`);
        for (const item of report.readActions) {
            console.log(`  读空间 ${item.action}：${item.ok ? `可以，读到 ${item.count ?? 0} 条` : `不行（${item.error}）`}`);
        }
        console.log(`  能用的是：${report.qzone ? report.qzone.action : '没有（这台 NapCat 读不了空间动态）'}`);
        console.log(`  闸：读动作 ${report.gate.readAllowed ? '放行' : '拒绝'}；写动作 ${report.gate.writeDenied ? `拒绝（${report.gate.writeDenied}）` : '竟然放行了——检查 policy'}`);
        if (args.out) {
            mkdirSync(dirname(resolve(args.out)), { recursive: true });
            writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
            console.log(`报告（无正文）：${resolve(args.out)}`);
        }
        process.exitCode = report.qzone ? 0 : 1;
    } finally {
        connection.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
