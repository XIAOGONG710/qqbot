import type { Module } from '../interpreter/interpreter.ts';
import type { AppConfig } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import { friendRequestVerdict, type Account } from '../social/account.ts';

// 好友申请（ADR 0142）：qqControl 是 on 时名单内的同意、名单外的留给人（开关合并：原 qqFriendGate 的 allow 档），经账号控制面回 NapCat。
// 原来是 app.ts 里 App 的 receiveFriendRequest，ADR 0336 第 6 步原样搬成解释器的模块（接 friendRequest 事件）。
export interface FriendRequestDeps {
    config: Pick<AppConfig, 'qqControl' | 'qqAllowFriends'>;
    stopped: () => boolean;
    /** 账号控制面：qqControl 没开或入口没给通用 OneBot 调用时没有。App 里建得比解释器晚，事件来了再取 */
    account: () => Pick<Account, 'run'> | undefined;
    /** 已派发的回执算 App 的收尾（停止时等它，同 App 的 sendOwnedNotice） */
    sendOwnedNotice: (send: () => Promise<unknown>, success: () => void, failure: (error: unknown) => void) => Promise<void>;
    log: Log;
}

export function friendRequestsModule({ config, stopped, account: accountNow, sendOwnedNotice, log }: FriendRequestDeps): Module {
    return {
        id: 'friend-requests',
        on: {
            friendRequest: ({ request: { userId, flag } }) => {
                if (stopped()) return;
                const gate = config.qqControl === 'on' ? 'allow' : 'off';
                const account = accountNow();
                if (!account || gate === 'off') return;
                const verdict = friendRequestVerdict(gate, config.qqAllowFriends ?? [], userId);
                if (verdict === 'ignore') {
                    log(`[好友申请] ${userId} 不在名单里，留着给你处理`);
                    return;
                }
                void sendOwnedNotice(() => account.run('set_friend_add_request', { flag, approve: verdict === 'accept' }),
                    () => log(`[好友申请] ${userId} ${verdict === 'accept' ? '同意' : '驳回'}`),
                    error => log(`[好友申请] ${userId} 处理失败：${error instanceof Error ? error.message : String(error)}`));
            },
        },
    };
}
