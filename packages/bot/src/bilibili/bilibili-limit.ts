// B 站写动作的节奏闸（ADR 0168 第 2 期）：照 bili-cli 的「本地限流 + 审计」化用，但不做在它那边。
// 只读动作（刷、看、搜）不过这里；评论 / 私信 / 动态 / 投稿各自一个滑窗，超了返回 retryAfterMs，调用方等或放弃。
// 审计只记「动作、对象、结果」，不记正文。

export type BiliAction = 'comment' | 'dm' | 'dynamic' | 'upload';

export interface BiliLimitRule {
    /** 一小时最多几次 */
    perHour: number;
    /** 两次之间至少隔多久 */
    minGapMs: number;
}

export const BILI_LIMITS: Readonly<Record<BiliAction, BiliLimitRule>> = {
    comment: { perHour: 30, minGapMs: 10_000 },
    dm: { perHour: 20, minGapMs: 10_000 },
    dynamic: { perHour: 6, minGapMs: 60_000 },
    upload: { perHour: 2, minGapMs: 300_000 },
};

export type BiliLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number; reason: string };

/** 每个动作一个滑窗；take 一次算一次（成功失败都算，免得失败重试把窗口刷爆） */
export class BiliLimiter {
    readonly #history = new Map<BiliAction, number[]>();
    readonly #last = new Map<BiliAction, number>();

    take(action: BiliAction, now = Date.now()): BiliLimitDecision {
        const rule = BILI_LIMITS[action];
        const list = this.#history.get(action) ?? [];
        const windowStart = now - 3_600_000;
        while (list.length && list[0]! <= windowStart) list.shift();
        const last = this.#last.get(action);
        if (last !== undefined && now - last < rule.minGapMs) {
            return { allowed: false, retryAfterMs: rule.minGapMs - (now - last), reason: `两次之间要隔 ${Math.ceil(rule.minGapMs / 1000)} 秒` };
        }
        if (list.length >= rule.perHour) {
            return { allowed: false, retryAfterMs: Math.max(1, list[0]! + 3_600_000 - now), reason: `一小时 ${rule.perHour} 次用完了` };
        }
        list.push(now);
        this.#history.set(action, list);
        this.#last.set(action, now);
        return { allowed: true };
    }
}

export interface BiliAuditEntry {
    at: number;
    action: BiliAction | 'read' | 'login';
    /** 对象：视频 bvid / 用户 uid / 稿件 id；不必填 */
    target?: string;
    ok: boolean;
    /** 失败原因或拒绝原因（不含正文） */
    note?: string;
}

/** 一行一条 JSON，交给调用方 appendFile；返回字符串便于测试 */
export function auditLine(entry: BiliAuditEntry): string {
    return `${JSON.stringify(entry)}\n`;
}
