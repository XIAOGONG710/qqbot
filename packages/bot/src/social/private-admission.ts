import type { Log } from '../platform/log.ts';
import type { MessageEvent } from '../platform/onebot.ts';
import type { Responder } from './responder.ts';

// 谁的私聊她回：只有名单里的人。原来名单外的好友（配置 unlistedFriends，ADR 0003 决策 2 / 0209）可以按 unlisted 档临时建回复器，
// 连着陌生人的规矩（签名写明是 AI、未成年人、只打招呼、每天上限）；51 天从没上过线，11-24 连开关一起删了（减法单子 二.2，用户拍板）。
// 原来在 app.ts（processMessage 开头那一段），ADR 0336 第 6 步搬到这里。
export interface PrivateAdmissionDeps {
    responders: Map<number, Responder>;
    log: Log;
}

export function privateAdmission({ responders, log }: PrivateAdmissionDeps) {
    /** 这条私聊回不回：名单里的人给回复器，不在名单就 undefined（原因已记日志） */
    function admit(event: MessageEvent): Responder | undefined {
        const responder = responders.get(event.user_id);
        if (!responder) log(`忽略 QQ ${event.user_id} 的私聊（不在名单）`);
        return responder;
    }

    return { admit };
}
