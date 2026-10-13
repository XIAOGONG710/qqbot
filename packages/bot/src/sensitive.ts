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
