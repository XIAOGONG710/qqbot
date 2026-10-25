// 她对 QQ 账号的控制面（ADR 0142）。
//
// 用户 10-25：「让她完全控制自己的 QQ 账号，风险由我实名承担。」控制面按「能造成多大后果」分四档，
// 每档各有闸：默认全关（mode off）；开了也只放行登记过的动作，没登记的一律拒绝——NapCat 有两百来个动作，
// 白名单比黑名单可靠。写动作还要过允许清单（好友 / 群）和一小时内的次数上限；危险动作（踢人、禁言、删好友、
// 群发）要再单独开一个闸。每次动作都留审计（只记动作、对象、放没放行、为什么，不记正文）。
//
// 这里只管「闸」和「记账」，不直接连 NapCat：call 由调用方给（机器人里走 OneBot，探针里走直连）。
// 机器人自己收发消息的那条线**不经过**这里（那边已经有出口检查、限流、隐私开关）。

export type ControlMode = 'off' | 'read' | 'on';

export interface AccountPolicy {
    /** 总闸：off 什么都不能做；read 只能看（盘点、读列表）；on 才放行写动作 */
    mode: ControlMode;
    /** 允许她动作的好友（QQ 号）；空 = 一个都不许 */
    friends: readonly number[];
    /** 允许她动作的群；空 = 一个群都不许 */
    groups: readonly number[];
    /** 一小时内最多几次写动作（读不算）；默认 6 */
    perHour: number;
    /** 危险动作闸：踢人 / 禁言 / 删好友 / 群发 / 建群。默认关 */
    dangerous: boolean;
}

export const DEFAULT_ACCOUNT_POLICY: AccountPolicy = { mode: 'off', friends: [], groups: [], perHour: 6, dangerous: false };

export type ActionTier = 'read' | 'profile' | 'social' | 'dangerous';

export interface AccountActionDef {
    tier: ActionTier;
    target: 'none' | 'friend' | 'group';
    /** 给日志和审计看的一句话（不含正文） */
    label: string;
}

/** 登记过的动作；查不到的动作用不了。动作名与参数照 NapCat 源码，线上是否可用由盘点回答 */
export const ACCOUNT_ACTIONS: Readonly<Record<string, AccountActionDef>> = {
    // 只看
    get_login_info: { tier: 'read', target: 'none', label: '读登录信息' },
    get_friend_list: { tier: 'read', target: 'none', label: '读好友列表' },
    get_group_list: { tier: 'read', target: 'none', label: '读群列表' },
    get_group_info: { tier: 'read', target: 'group', label: '读群资料' },
    get_group_member_list: { tier: 'read', target: 'group', label: '读群成员' },
    get_stranger_info: { tier: 'read', target: 'friend', label: '读陌生人资料' },
    get_profile_like: { tier: 'read', target: 'none', label: '读资料卡点赞' },
    get_recent_contact: { tier: 'read', target: 'none', label: '读最近联系' },
    get_msg: { tier: 'read', target: 'none', label: '读一条消息' },
    get_friend_msg_history: { tier: 'read', target: 'friend', label: '读好友聊天记录' },
    get_group_msg_history: { tier: 'read', target: 'group', label: '读群聊天记录' },
    get_qzone_msg_list: { tier: 'read', target: 'none', label: '读空间动态' },
    get_qzone_feeds: { tier: 'read', target: 'none', label: '读空间动态（备用名）' },
    // 改账号自己的样子
    set_self_longnick: { tier: 'profile', target: 'none', label: '改个性签名' },
    set_qq_profile: { tier: 'profile', target: 'none', label: '改昵称 / 资料' },
    set_qq_avatar: { tier: 'profile', target: 'none', label: '换头像' },
    set_group_card: { tier: 'profile', target: 'group', label: '改群名片' },
    set_group_remark: { tier: 'profile', target: 'group', label: '改群备注' },
    // 社交动作
    set_friend_add_request: { tier: 'social', target: 'friend', label: '同意 / 拒绝好友申请' },
    set_group_add_request: { tier: 'social', target: 'group', label: '同意 / 拒绝入群申请' },
    send_like: { tier: 'social', target: 'friend', label: '资料卡点赞' },
    friend_poke: { tier: 'social', target: 'friend', label: '戳一戳' },
    send_private_msg: { tier: 'social', target: 'friend', label: '发私聊' },
    send_group_msg: { tier: 'social', target: 'group', label: '发群消息' },
    set_group_notice: { tier: 'social', target: 'group', label: '发群公告' },
    upload_group_file: { tier: 'social', target: 'group', label: '传群文件' },
    set_msg_emoji_like: { tier: 'social', target: 'none', label: '表情回应' },
    set_online_status: { tier: 'social', target: 'none', label: '改在线状态' },
    mark_private_msg_as_read: { tier: 'social', target: 'friend', label: '标已读' },
    delete_msg: { tier: 'social', target: 'none', label: '撤回消息' },
    send_qzone_msg: { tier: 'social', target: 'none', label: '发说说' },
    // 危险动作（还要 policy.dangerous）
    delete_friend: { tier: 'dangerous', target: 'friend', label: '删好友' },
    set_group_kick: { tier: 'dangerous', target: 'group', label: '踢人' },
    set_group_ban: { tier: 'dangerous', target: 'group', label: '禁言' },
    set_group_whole_ban: { tier: 'dangerous', target: 'group', label: '全员禁言' },
    set_group_admin: { tier: 'dangerous', target: 'group', label: '设管理员' },
    set_group_leave: { tier: 'dangerous', target: 'group', label: '退群' },
    create_group: { tier: 'dangerous', target: 'none', label: '建群' },
};

export type AccountDecision = { allowed: true; def: AccountActionDef } | { allowed: false; reason: string };

export interface AccountAuditEntry {
    at: number;
    action: string;
    target?: number;
    allowed: boolean;
    /** 拒绝的原因，或动作失败时的错误信息（不含正文） */
    reason?: string;
}

export interface AccountDeps {
    policy: AccountPolicy;
    call: (action: string, params: Record<string, unknown>) => Promise<unknown>;
    now?: () => number;
    log?: (message: string) => void;
    /** 审计落点；给了就每条调一次（调用方自己写文件），不给只在内存里留最近 200 条 */
    audit?: (entry: AccountAuditEntry) => void;
}

export interface AccountInventory {
    ok: boolean;
    login?: { uin?: number; nickname?: string };
    friends: number;
    groups: number;
    /** 这台 NapCat 上没有（或调用失败）的读动作 */
    unsupported: string[];
}

export interface Account {
    policy(): AccountPolicy;
    check(action: string, params?: Record<string, unknown>): AccountDecision;
    run<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;
    /** 只读盘点：好友多少、群多少、哪些读动作没有。不改任何东西 */
    inventory(): Promise<AccountInventory>;
    auditLog(): readonly AccountAuditEntry[];
}

const AUDIT_KEEP = 200;
const ONE_HOUR = 3_600_000;

function numberOrUndefined(raw: unknown): number | undefined {
    const value = typeof raw === 'number' ? raw : Number(raw);
    return Number.isSafeInteger(value) && value !== 0 ? value : undefined;
}

/** params 里的对象：user_id / group_id 可能是数字也可能是字符串（NapCat 两种都收） */
export function accountTarget(action: string, params: Record<string, unknown>): number | undefined {
    const def = ACCOUNT_ACTIONS[action];
    if (!def || def.target === 'none') return undefined;
    return numberOrUndefined(def.target === 'friend' ? params.user_id : params.group_id);
}

export function createAccount(deps: AccountDeps): Account {
    const now = deps.now ?? (() => Date.now());
    const recent: AccountAuditEntry[] = [];
    const writes: number[] = [];
    const policy = deps.policy;

    const record = (entry: AccountAuditEntry): void => {
        recent.push(entry);
        if (recent.length > AUDIT_KEEP) recent.shift();
        try { deps.audit?.(entry); } catch { /* 审计写不进去不能反过来让动作失败 */ }
    };

    function check(action: string, params: Record<string, unknown> = {}): AccountDecision {
        const def = ACCOUNT_ACTIONS[action];
        if (!def) return { allowed: false, reason: `没登记的动作：${action}` };
        if (policy.mode === 'off') return { allowed: false, reason: '控制面关着' };
        if (def.tier === 'read') return { allowed: true, def };
        if (policy.mode !== 'on') return { allowed: false, reason: '只读档不放行写动作' };
        if (def.tier === 'dangerous' && !policy.dangerous) return { allowed: false, reason: '危险动作闸关着' };
        if (def.target !== 'none') {
            const target = accountTarget(action, params);
            if (target === undefined) return { allowed: false, reason: '没给对象（user_id / group_id）' };
            const list = def.target === 'friend' ? policy.friends : policy.groups;
            if (!list.includes(target)) return { allowed: false, reason: `${def.target === 'friend' ? '好友' : '群'} ${target} 不在允许清单里` };
        }
        const t = now();
        while (writes.length && writes[0]! <= t - ONE_HOUR) writes.shift();
        if (writes.length >= policy.perHour) return { allowed: false, reason: `一小时 ${policy.perHour} 次已经用完了` };
        return { allowed: true, def };
    }

    async function run<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
        const verdict = check(action, params);
        const target = accountTarget(action, params);
        if (!verdict.allowed) {
            record({ at: now(), action, ...(target !== undefined ? { target } : {}), allowed: false, reason: verdict.reason });
            throw new Error(`控制面拒绝 ${action}：${verdict.reason}`);
        }
        if (verdict.def.tier !== 'read') writes.push(now());
        try {
            const data = await deps.call(action, params);
            record({ at: now(), action, ...(target !== undefined ? { target } : {}), allowed: true });
            return data as T;
        } catch (error) {
            record({ at: now(), action, ...(target !== undefined ? { target } : {}), allowed: true, reason: error instanceof Error ? error.message : String(error) });
            throw error;
        }
    }

    async function inventory(): Promise<AccountInventory> {
        const unsupported: string[] = [];
        const readOne = async (action: string, params: Record<string, unknown> = {}): Promise<unknown> => {
            try { return await deps.call(action, params); } catch { unsupported.push(action); return undefined; }
        };
        const login = await readOne('get_login_info') as { user_id?: unknown; nickname?: unknown } | undefined;
        const friends = await readOne('get_friend_list');
        const groups = await readOne('get_group_list');
        const listLength = (value: unknown): number => Array.isArray(value) ? value.length : 0;
        const uin = numberOrUndefined(login?.user_id);
        return {
            ok: true,
            ...(login ? { login: { ...(uin !== undefined ? { uin } : {}), ...(typeof login.nickname === 'string' ? { nickname: login.nickname } : {}) } } : {}),
            friends: listLength(friends),
            groups: listLength(groups),
            unsupported,
        };
    }

    return {
        policy: () => policy,
        check,
        run,
        inventory,
        auditLog: () => recent,
    };
}
