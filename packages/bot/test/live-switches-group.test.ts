// 线上开着、开关这一层没测过的（docs/reports/2026-11-24-switch-audit.md「测试覆盖」）：groupOwn（ADR 0341，群里带着此刻自己冒一句；线上 dryRun）。
// 群里那一摊自己的 tick 怎么抽签、写什么草稿由 group-self.test.ts 管（直接调 groupRoom().tick()）；这里只管 App 按配置接不接：
// 真的 App、假时钟（定时器由行为基线的 FakeClock 接管），冷场了的群——
// groupOwn 关着时 App 不开那个每 10 分钟看一眼的定时器，怎么等都不冒；dryRun 时到点看一眼、抽中了就把她自己冒的那句写进草稿、不发；
// dryRun 时别人 @ 她的平常回话照旧真发。只用合成角色，不连网。

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { startApp } from '../src/platform/app.ts';
import type { AppConfig, GroupOwnMode } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { stateAt } from '../src/life/schedule.ts';
import { groupLog } from '../src/social/group-chat.ts';
import { freeToChime, GROUP_OWN } from '../src/social/group-self.ts';
import type { GroupMessageEvent } from '../src/platform/onebot.ts';
import { syntheticCardPattern } from './fixtures/card.ts';
import { baselineConfig } from './baseline/harness.ts';
import { FakeClock } from './baseline/clock.ts';

const SELF = 20000;
const HOUR = 3_600_000;
const GROUP = { id: 555, name: '合成宿舍群' };

/** 合成卡（群里用同学档的承认版）上她闲着的一个下午（同 group-self.test.ts） */
const freeAt = (() => {
    const schedule = loadTierCard(syntheticCardPattern, 'classmate-open').character.schedule!;
    for (let h = 0; h < 24 * 14; h++) {
        const at = new Date(Date.parse('2026-11-16T08:00:00+08:00') + h * HOUR);
        if (at.getHours() >= 9 && at.getHours() <= 21 && freeToChime(stateAt(schedule, at))) return at.getTime();
    }
    throw new Error('合成卡上找不到她闲着的时候');
})();

const atMe = (messageId: number, at: number): GroupMessageEvent => ({
    post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: SELF, user_id: 30001, group_id: GROUP.id, message_id: messageId,
    time: Math.floor(at / 1000), message: [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text: ' 你在干嘛' } }], raw_message: '',
    sender: { user_id: 30001, card: '老王', nickname: '老王' },
});

/**
 * 跑一段：群里之前热闹过、已经安静了 5 小时；App 连上之后假时钟往前走 hours 小时。
 * mention：连上之后先有人 @ 她一下（看平常回话是不是照旧真发）
 */
async function run(groupOwn: GroupOwnMode, hours: number, mention = false) {
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-live-switches-group-'));
    const home = mkdtempSync(join(tmpdir(), 'qqbot-live-switches-group-home-'));
    const envBefore = { soul: process.env.QQBOT_SOUL_DIR, her: process.env.HER_DIR };
    process.env.QQBOT_SOUL_DIR = join(home, 'soul');
    process.env.HER_DIR = join(home, 'her');
    const clock = new FakeClock(freeAt);
    clock.install();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError('fetch failed（测试不连网）'); }) as typeof fetch;
    const sentGroup: string[] = [];
    const prompts: string[] = [];
    const lines: string[] = [];
    try {
        const logs = groupLog(dataDir);
        for (let i = 0; i < 6; i++) {
            logs.append(GROUP.id, { time: new Date(freeAt - 5 * HOUR - (6 - i) * 60_000).toISOString(), from: 30001 + (i % 2), name: i % 2 ? '小李' : '老王', content: `闲聊 ${i}`, messageId: 6000 + i });
        }
        const config: AppConfig = baselineConfig(dataDir, [{ qq: 10001, name: '阿明', tier: 'boyfriend' }], {
            schedule: true, moody: false, speechCheck: false, herDays: false, herFeelings: false, proactive: 'off', qqPresence: false,
            groupChat: 'on', groups: [GROUP], groupOwn,
        });
        const app = startApp({
            config, log: line => lines.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: {
                sendPrivateText: async () => 1, friendHistory: async () => [],
                sendGroupText: async (groupId, text) => { sentGroup.push(`${groupId}:${text}`); return 8000 + sentGroup.length; },
            },
            pipeline: {
                generate: async messages => {
                    prompts.push(messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n'));
                    const first = typeof messages[0]?.content === 'string' ? messages[0].content : '';
                    return /JSON|json/.test(first) ? '[]' : '有人吗，外面好冷';
                },
                settle: { quietMs: 0, maxMs: 0 },
            },
        });
        await clock.settle(Promise.resolve(app.connected(SELF)));
        if (mention) { app.receiveGroup(atMe(7777, clock.now())); await clock.advance(60_000); }
        for (let h = 0; h < hours; h++) await clock.advance(HOUR);
        await clock.settle(Promise.resolve(app.stop()));
        const draftsFile = join(dataDir, 'groups', 'drafts.md');
        return {
            sentGroup, lines,
            groupPrompts: prompts.filter(prompt => prompt.includes('在 QQ 群里和大家聊天')),
            drafts: existsSync(draftsFile) ? readFileSync(draftsFile, 'utf8') : '',
        };
    } finally {
        globalThis.fetch = realFetch;
        clock.uninstall();
        if (envBefore.soul === undefined) delete process.env.QQBOT_SOUL_DIR; else process.env.QQBOT_SOUL_DIR = envBefore.soul;
        if (envBefore.her === undefined) delete process.env.HER_DIR; else process.env.HER_DIR = envBefore.her;
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
}

describe('groupOwn（ADR 0341）：群里带着此刻自己冒一句', () => {
    test('关着：冷场的群等一天半也不冒（App 不看），没有草稿、没发', async () => {
        const r = await run('off', 36);
        assert.equal(r.groupPrompts.length, 0);
        assert.equal(r.drafts, '');
        assert.deepEqual(r.sentGroup, []);
    });

    test('dryRun：到点看一眼、冷场那一签抽中了就写一条（quiet）草稿；一条都不真发', async () => {
        const r = await run('dryRun', 36);
        assert.ok(r.groupPrompts.length >= 1, '她看过一眼、想过说什么');
        assert.match(r.groupPrompts[0]!, /群里安静了好一阵了/);
        assert.match(r.drafts, /群「合成宿舍群」（quiet）：有人吗，外面好冷/);
        assert.deepEqual(r.sentGroup, []);
        assert.ok(GROUP_OWN.perDay >= 1);
    });

    test('dryRun：别人 @ 她的平常回话照旧真发（dryRun 只管她自己冒的那句）', async () => {
        const r = await run('dryRun', 1, true);
        assert.deepEqual(r.sentGroup, [`${GROUP.id}:有人吗，外面好冷`], r.lines.filter(line => line.includes('群')).join('\n'));
        assert.ok(!r.drafts.includes('（mentioned）'));
    });
});
