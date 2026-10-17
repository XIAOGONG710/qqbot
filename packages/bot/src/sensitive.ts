// 敏感调试开关（ADR 0070 第 8 项）：聊天正文和完整提示词默认不落到日志和 last-prompt.json 里。
// QQBOT_SENSITIVE_LOGS=on 一直开到重启；=15m / =2h 开这么久，到点自动关；没设或 off 就是关。
// 同一段聊天已经在 chats/<QQ>.jsonl 里有一份原始记录，调试用的副本不应该默认再多存几份。

export interface SensitiveSwitch {
    /** 现在能不能把聊天正文、完整提示词写进日志和调试文件 */
    on(): boolean;
    /** 启动时写进日志的一句话 */
    describe(): string;
}

export const SENSITIVE_OFF: SensitiveSwitch = { on: () => false, describe: () => '敏感调试关着：日志只记长度和类型，不写聊天正文，也不留 last-prompt.json' };
/** 测试用：一直开着 */
export const SENSITIVE_ON: SensitiveSwitch = { on: () => true, describe: () => '敏感调试开着（测试）' };

// startApp 装上它拿到的开关，这样只往日志里写「由聊天提炼出来的话」的那些模块（她答应的事、待跟进、主动消息、危机出口检查……）
// 不必每个构造函数都多收一个参数。没人装的时候是关着的：默认就是不写。
let active: SensitiveSwitch = SENSITIVE_OFF;

export function useSensitiveSwitch(next: SensitiveSwitch): void {
    active = next;
}

/** 现在敏感调试开着吗（要自己拼一句不带原文的日志时用） */
export function sensitiveOn(): boolean {
    return active.on();
}

/** 日志里要放「聊天里的话，或由聊天提炼出来的话」时用：开着就是原文，关着只剩字数 */
export function logBody(text: string): string {
    return active.on() ? text : `（${[...text].length} 字）`;
}

export function sensitiveSwitch(env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): SensitiveSwitch {
    const value = (env.QQBOT_SENSITIVE_LOGS ?? '').trim().toLowerCase();
    if (value === 'on' || value === 'true' || value === '1') {
        return { on: () => true, describe: () => '⚠ 敏感调试开着（直到重启）：日志会记聊天正文，last-prompt.json 会记完整提示词；调试完去掉 QQBOT_SENSITIVE_LOGS' };
    }
    const timed = /^(\d+)\s*(m|h)$/.exec(value);
    if (timed) {
        const until = now() + Number(timed[1]) * (timed[2] === 'h' ? 3_600_000 : 60_000);
        const clock = () => new Date(until).toLocaleTimeString('zh-CN', { hour12: false });
        return { on: () => now() < until, describe: () => `⚠ 敏感调试开着，到 ${clock()} 自动关：期间日志会记聊天正文，last-prompt.json 会记完整提示词` };
    }
    return SENSITIVE_OFF;
}
