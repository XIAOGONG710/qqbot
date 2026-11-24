import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MessageEvent } from '../src/platform/onebot.ts';
import { privateAdmission } from '../src/social/private-admission.ts';
import type { Responder } from '../src/social/responder.ts';

// 谁的私聊她回（social/private-admission.ts）：只有名单里的人。名单外好友（unlistedFriends，ADR 0209）11-24 连开关一起删了。
const HIM = 1001;
let nextId = 1;
const message = (userId: number, text: string): MessageEvent => ({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 9000, user_id: userId, message_id: nextId++,
    time: 1_795_000_000, message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: userId, nickname: '路人甲' },
});

function harness() {
    const logs: string[] = [];
    const responders = new Map<number, Responder>([[HIM, { who: 'him' } as unknown as Responder]]);
    return { admission: privateAdmission({ responders, log: line => { logs.push(line); } }), logs };
}

describe('谁的私聊她回', () => {
    test('名单里的人：直接给他的回复器，不限流、不记日志', () => {
        const h = harness();
        for (let i = 0; i < 50; i++) assert.equal((h.admission.admit(message(HIM, '在吗')) as unknown as { who: string }).who, 'him');
        assert.deepEqual(h.logs, []);
    });

    test('名单外的私聊一律不回，记一行原因', () => {
        const h = harness();
        assert.equal(h.admission.admit(message(4242, '你好呀，今天天气怎么样')), undefined);
        assert.deepEqual(h.logs, ['忽略 QQ 4242 的私聊（不在名单）']);
    });
});
