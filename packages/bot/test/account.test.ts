import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ACCOUNT_ACTIONS, createAccount, DEFAULT_ACCOUNT_POLICY, friendRequestVerdict, type AccountPolicy } from '../src/account.ts';

const policy = (patch: Partial<AccountPolicy> = {}): AccountPolicy => ({ ...DEFAULT_ACCOUNT_POLICY, mode: 'on', friends: [10001], groups: [90001], ...patch });

function fakeCall(record: string[] = [], fail: ReadonlySet<string> = new Set()) {
    return async (action: string, params: Record<string, unknown>): Promise<unknown> => {
        record.push(`${action}:${JSON.stringify(params)}`);
        if (fail.has(action)) throw new Error('napcat 没有这个动作');
        if (action === 'get_login_info') return { user_id: 2561299676, nickname: '梦瑶' };
        if (action === 'get_friend_list') return [{ user_id: 1 }, { user_id: 2 }];
        if (action === 'get_group_list') return [{ group_id: 1 }];
        return { ok: true };
    };
}

describe('账号控制面的闸（ADR 0142）', () => {
    test('默认关着：连读动作都不放行，写动作报原因', () => {
        const account = createAccount({ policy: DEFAULT_ACCOUNT_POLICY, call: fakeCall() });
        assert.equal(account.check('get_friend_list').allowed, false);
        const verdict = account.check('send_private_msg', { user_id: 10001 });
        assert.equal(verdict.allowed, false);
        assert.match(verdict.allowed ? '' : verdict.reason, /关着/);
    });

    test('只读档：读动作放行，写动作拒绝', () => {
        const account = createAccount({ policy: policy({ mode: 'read' }), call: fakeCall() });
        assert.equal(account.check('get_friend_list').allowed, true);
        assert.equal(account.check('send_private_msg', { user_id: 10001 }).allowed, false);
    });

    test('没登记的动作一律拒绝（防哪天多一个动作就悄悄能用）', () => {
        const account = createAccount({ policy: policy(), call: fakeCall() });
        const verdict = account.check('set_group_kick_everyone', { group_id: 90001 });
        assert.equal(verdict.allowed, false);
        assert.match(verdict.allowed ? '' : verdict.reason, /没登记/);
    });

    test('写动作要过允许清单：不在名单里的好友 / 群拒绝，名单里的放行', async () => {
        const calls: string[] = [];
        const account = createAccount({ policy: policy(), call: fakeCall(calls) });
        assert.equal(account.check('send_private_msg', { user_id: 20002 }).allowed, false);
        assert.equal(account.check('send_group_msg', { group_id: 99999 }).allowed, false);
        assert.equal(account.check('send_private_msg', { user_id: '10001' }).allowed, true);
        await account.run('send_private_msg', { user_id: 10001, message: '在吗' });
        assert.deepEqual(calls, ['send_private_msg:{"user_id":10001,"message":"在吗"}']);
    });

    test('危险动作要单独开闸：开了危险闸也不过允许清单', () => {
        const closed = createAccount({ policy: policy(), call: fakeCall() });
        assert.equal(closed.check('set_group_kick', { group_id: 90001, user_id: 10001 }).allowed, false);
        const open = createAccount({ policy: policy({ dangerous: true }), call: fakeCall() });
        assert.equal(open.check('set_group_kick', { group_id: 90001, user_id: 10001 }).allowed, true);
        assert.equal(open.check('set_group_kick', { group_id: 1, user_id: 10001 }).allowed, false);
    });

    test('一小时的上限：写满 perHour 次之后拒绝，读不算', async () => {
        let clock = 1_000_000;
        const account = createAccount({ policy: policy({ perHour: 2 }), call: fakeCall(), now: () => clock });
        for (let i = 0; i < 2; i++) await account.run('send_like', { user_id: 10001, times: 1 });
        for (let i = 0; i < 5; i++) await account.run('get_friend_list');
        assert.equal(account.check('send_like', { user_id: 10001 }).allowed, false);
        clock += 3_600_001;
        assert.equal(account.check('send_like', { user_id: 10001 }).allowed, true);
    });

    test('每次动作都留审计（拒绝也记，记动作和对象，不记正文）', async () => {
        const audit: unknown[] = [];
        const account = createAccount({ policy: policy(), call: fakeCall(), now: () => 42, audit: entry => audit.push(entry) });
        await account.run('send_private_msg', { user_id: 10001, message: '这句话不该进审计' });
        await assert.rejects(account.run('delete_friend', { user_id: 10001 }));
        await assert.rejects(account.run('send_private_msg', { user_id: 20002 }));
        const text = JSON.stringify(audit);
        assert.equal(text.includes('这句话不该进审计'), false);
        assert.equal((audit as { action: string; allowed: boolean }[]).length, 3);
    });

    test('动作名都在登记表里，且 tier / target 合法', () => {
        for (const [name, def] of Object.entries(ACCOUNT_ACTIONS)) {
            assert.match(name, /^[a-z_]+$/);
            assert.ok(['read', 'profile', 'social', 'dangerous'].includes(def.tier));
            assert.ok(['none', 'friend', 'group'].includes(def.target));
        }
    });

    test('盘点：好友 / 群数出来，调不通的动作列出来', async () => {
        const account = createAccount({ policy: policy(), call: fakeCall([], new Set(['get_group_list'])), now: () => 0 });
        const inventory = await account.inventory();
        assert.equal(inventory.friends, 2);
        assert.equal(inventory.groups, 0);
        assert.deepEqual(inventory.unsupported, ['get_group_list']);
        assert.equal(inventory.login?.uin, 2561299676);
    });
});

describe('好友申请怎么处理（ADR 0142）', () => {
    test('关：不碰；名单内：同意；名单外：allow 留着、all 驳回', () => {
        assert.equal(friendRequestVerdict('off', [10001], 10001), 'ignore');
        assert.equal(friendRequestVerdict('allow', [10001], 10001), 'accept');
        assert.equal(friendRequestVerdict('all', [10001], 10001), 'accept');
        assert.equal(friendRequestVerdict('allow', [10001], 20002), 'ignore');
        assert.equal(friendRequestVerdict('all', [10001], 20002), 'reject');
        assert.equal(friendRequestVerdict('all', [], 20002), 'reject');
    });
});

describe('登录态不进控制面（P1）', () => {
    test('get_cookies 没登记：控制面调不动，qq-admin 即使误调也被拒', async () => {
        assert.equal('get_cookies' in ACCOUNT_ACTIONS, false);
        const account = createAccount({ policy: policy({ mode: 'read' }), call: fakeCall() });
        const verdict = account.check('get_cookies');
        assert.equal(verdict.allowed, false);
        await assert.rejects(account.run('get_cookies'), /没登记/);
    });
});
