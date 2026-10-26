// 账号控制面的命令行（ADR 0142）：在线上虚拟机里对「她的号」执行一个登记过的动作，全部过闸、写审计。
//
// 用法：
//   node scripts/qq-admin.ts inventory                       # 只读盘点
//   node scripts/qq-admin.ts actions                         # 列出登记过的动作和档位
//   node scripts/qq-admin.ts run <动作> [--params '<json>'] [--mode on] [--friend 10001] [--group 90001] [--dangerous] [--yes]
// 默认 mode=read（只能跑读动作）；写动作要显式 --mode on --yes。审计打到 stdout（只记动作、对象、放行与否）。
// 连的是 NapCat 的 WebSocket（和机器人并行，NapCat 允许多个客户端）。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCOUNT_ACTIONS, ACCOUNT_MODES, createAccount, type AccountAuditEntry, type AccountPolicy, type ControlMode } from '../packages/bot/src/account.ts';
import { connect, serverFromConfig, type Connection } from './napcat-probe.ts';

export interface AdminArgs {
    command: 'inventory' | 'actions' | 'run';
    action?: string;
    params: Record<string, unknown>;
    mode: ControlMode;
    friends: number[];
    groups: number[];
    dangerous: boolean;
    yes: boolean;
    config?: string;
    url?: string;
}

export function parseArgs(argv: readonly string[]): AdminArgs {
    const args: AdminArgs = { command: 'inventory', params: {}, mode: 'read', friends: [], groups: [], dangerous: false, yes: false };
    const command = argv[0];
    if (command === 'inventory' || command === 'actions' || command === 'run') args.command = command;
    else if (command) throw new Error(`不认识的操作：${command}（有 inventory / actions / run）`);
    let index = 1;
    if (args.command === 'run') {
        const action = argv[index];
        if (!action || action.startsWith('--')) throw new Error('run 后面要跟动作名（先跑 actions 看有哪些）');
        args.action = action;
        index++;
    }
    for (; index < argv.length; index++) {
        const flag = argv[index]!;
        const value = (): string => { const next = argv[++index]; if (next === undefined) throw new Error(`${flag} 后面要有值`); return next; };
        switch (flag) {
            case '--params': args.params = JSON.parse(value()) as Record<string, unknown>; break;
            case '--mode': {
                const mode = value();
                if (!(ACCOUNT_MODES as readonly string[]).includes(mode)) throw new Error(`--mode 取 off / read / on`);
                args.mode = mode as ControlMode;
                break;
            }
            case '--friend': args.friends.push(Number(value())); break;
            case '--group': args.groups.push(Number(value())); break;
            case '--dangerous': args.dangerous = true; break;
            case '--yes': args.yes = true; break;
            case '--config': args.config = value(); break;
            case '--url': args.url = value(); break;
            default: throw new Error(`不认识的参数：${flag}`);
        }
    }
    return args;
}

export async function runAdmin(args: AdminArgs, connection: Connection, audit: (entry: AccountAuditEntry) => void, log: (line: string) => void): Promise<number> {
    if (args.command === 'actions') {
        for (const [name, def] of Object.entries(ACCOUNT_ACTIONS)) log(`${def.tier.padEnd(9)} ${name}  ${def.label}`);
        return 0;
    }
    const call = async (action: string, params: Record<string, unknown> = {}): Promise<unknown> => {
        const response = await connection.call(action, params);
        if (response.retcode !== 0) throw new Error(`retcode ${response.retcode}${response.wording ? ` ${response.wording}` : ''}`);
        return response.data;
    };
    const policy: AccountPolicy = { mode: args.mode, friends: args.friends, groups: args.groups, perHour: 6, dangerous: args.dangerous };
    const account = createAccount({ policy, call, audit });
    if (args.command === 'inventory') {
        const inventory = await account.inventory();
        log(`账号：${inventory.login?.nickname ?? '?'}（${inventory.login?.uin ?? '?'}）  好友 ${inventory.friends}  群 ${inventory.groups}`);
        if (inventory.unsupported.length) log(`调不通的读动作：${inventory.unsupported.join('、')}`);
        return 0;
    }
    if (!args.action) throw new Error('没有动作名');
    if (ACCOUNT_ACTIONS[args.action]?.tier !== 'read' && (!args.yes || args.mode !== 'on')) {
        throw new Error('写动作要显式 --mode on --yes（这是故意的）');
    }
    const result = await account.run(args.action, args.params);
    // 登录态类动作即使哪天又被登记回来，也不把值打到终端 / 对话记录里（只报名字和长度）
    const credentialish = /cookie|csrf|token|skey|ticket/.test(args.action);
    const shown = credentialish
        ? `（返回值含登录态，不回显；${Array.isArray(result) ? `${result.length} 项` : '已用'}）`
        : result === undefined ? '' : ` → ${JSON.stringify(result).slice(0, 300)}`;
    log(`完成：${args.action}${shown}`);
    return 0;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === 'actions') {
        for (const [name, def] of Object.entries(ACCOUNT_ACTIONS)) console.log(`${def.tier.padEnd(9)} ${name}  ${def.label}`);
        return;
    }
    const configPath = args.config ?? resolve(import.meta.dirname, '..', 'runtime/napcat/workdir/config/onebot11.json');
    const server = serverFromConfig(readFileSync(configPath, 'utf8'));
    const url = args.url ?? `${server.url}${server.token ? `?access_token=${encodeURIComponent(server.token)}` : ''}`;
    const connection = await connect(url);
    const log = (line: string): void => console.log(line);
    const audit = (entry: AccountAuditEntry): void => {
        console.log(`[audit] ${new Date(entry.at).toLocaleString('zh-CN')} ${entry.action}${entry.target ? ` → ${entry.target}` : ''} ${entry.allowed ? '放行' : '拦下'}${entry.reason ? `（${entry.reason}）` : ''}`);
    };
    try {
        process.exitCode = await runAdmin(args, connection, audit, log);
    } finally {
        connection.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
