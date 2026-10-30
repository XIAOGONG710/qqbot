// 她在这台电脑上跑命令（2026-10-30 用户：「直接将本机的最高权限给她」）
//
// 这是真的最高权限：她在回复里写一行 <<执行：命令>>，就在这台机器上用 PowerShell 跑，
// 不经过白名单、不经过批准（用户决定）。所以只做三件事让它不至于失控：
//   1. 每次执行都写审计（dataDir/shell-audit.jsonl：时间、命令、退出码、输出前 400 字）；
//   2. 超时就杀（默认 60 秒），输出截断（默认 4000 字），别把提示词撑爆；
//   3. 结果只给她看（下一轮提示词里一行），不当成他的话、不进聊天记录里的"他说的"。
//
// 注意：她现在会自动上网（webLookup: auto）。网页里的文字属于不可信输入，
// 如果她把网页里的话当成命令跑，那就是提示词注入。审计文件是唯一的事后线索——先留着这条线。
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SHELL_TIMEOUT_MS = 60_000;
export const SHELL_MAX_CHARS = 4000;

export interface ShellRun {
    command: string;
    ok: boolean;
    code: number | null;
    output: string;
    ms: number;
}

/** 从她的回复里摘出 <<执行：…>>，返回剩下的文字和要跑的命令 */
export function takeShellCommands(input: string): { text: string; commands: string[] } {
    const commands: string[] = [];
    const text = input.replace(/<<执行[：:]([\s\S]*?)>>/g, (_all, raw: string) => {
        const command = String(raw).trim();
        if (command) commands.push(command);
        return '';
    });
    return { text: text.replace(/\n{3,}/g, '\n\n').trim(), commands };
}

/** 真跑。Windows 上走 PowerShell（她拼的大部分是命令行/一行脚本）；超时就杀，输出截断 */
export function runShell(command: string, options: { cwd?: string; timeoutMs?: number; maxChars?: number } = {}): Promise<ShellRun> {
    const timeoutMs = options.timeoutMs ?? SHELL_TIMEOUT_MS;
    const maxChars = options.maxChars ?? SHELL_MAX_CHARS;
    const started = Date.now();
    return new Promise(resolve => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            cwd: options.cwd,
            windowsHide: true,
            env: process.env,
        });
        let output = '';
        let killed = false;
        const timer = setTimeout(() => { killed = true; child.kill(); }, timeoutMs);
        const collect = (chunk: Buffer) => {
            if (output.length < maxChars * 4) output += chunk.toString('utf8');
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.on('error', error => {
            clearTimeout(timer);
            resolve({ command, ok: false, code: null, output: `跑不起来：${error.message}`.slice(0, maxChars), ms: Date.now() - started });
        });
        child.on('close', code => {
            clearTimeout(timer);
            const tail = output.trim().slice(-maxChars);
            resolve({
                command,
                ok: !killed && code === 0,
                code,
                output: killed ? `${tail}\n（超过 ${Math.round(timeoutMs / 1000)} 秒，已经掐掉）`.trim().slice(-maxChars) : tail || '（没有输出）',
                ms: Date.now() - started,
            });
        });
    });
}

/** 审计：时间、命令、退出码、输出前 400 字（日志里不写环境变量） */
export function auditShell(dataDir: string, run: ShellRun): void {
    try {
        mkdirSync(dataDir, { recursive: true });
        appendFileSync(join(dataDir, 'shell-audit.jsonl'), JSON.stringify({
            at: new Date().toISOString(),
            command: run.command.slice(0, 500),
            ok: run.ok,
            code: run.code,
            ms: run.ms,
            output: run.output.slice(0, 400),
        }) + '\n');
    } catch { /* 审计写不进去也不能挡住执行 */ }
}

/** 下一轮给她的那一行：她刚跑过什么、结果是什么 */
export function shellNoteLine(run: ShellRun): string {
    return `[你刚在这台电脑上跑了：${run.command.slice(0, 120)}\n${run.ok ? '跑成了' : '没跑成（退出码 ' + String(run.code) + '）'}，输出：\n${run.output.slice(0, 1500)}]`;
}

/**
 * 防注入的第二道（第一道在 app.ts：这一轮看过网上的内容，就不执行命令）。
 * 这里只拦「一眼就不可逆、且不像她会想做的」：格式化、关机重启、删根目录或用户目录、
 * 从网上下载脚本直接执行。别的照跑（用户要的是最高权限，不是保姆）。
 */
const DANGEROUS: { pattern: RegExp; why: string }[] = [
    { pattern: /(format-volume|format\s+[a-z]:)/i, why: '格式化磁盘' },
    { pattern: /(shutdown|stop-computer|restart-computer)/i, why: '关机 / 重启' },
    { pattern: /remove-item\s+(-[a-z]+\s+)*['"]?[a-z]:[\/]?['"]?\s+(-[a-z]+\s+)*-recurse/i, why: '删整个盘' },
    { pattern: /remove-item\s+(-[a-z]+\s+)*['"]?(\$env:userprofile|~)['"]?\s+(-[a-z]+\s+)*-recurse/i, why: '删用户目录' },
    { pattern: /(iwr|invoke-webrequest|downloadstring)[\s\S]{0,80}\|\s*(iex|invoke-expression)/i, why: '下载脚本直接执行' },
    { pattern: /reg\s+(delete|add)\s+HKLM/i, why: '改系统注册表' },
];

export function guardCommand(command: string): string | undefined {
    for (const rule of DANGEROUS) if (rule.pattern.test(command)) return rule.why;
    return undefined;
}
