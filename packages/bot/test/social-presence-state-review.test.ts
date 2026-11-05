import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { Schedule } from '../src/life/schedule.ts';
import { createPresence, describeSelf } from '../src/social/presence.ts';

const roots: string[] = [];
const temp = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-social-presence-'));
    roots.push(root);
    return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const schedule = {
    sleep: '02:00',
    wake: { early: '08:00', lazy: '09:00', earlySlot: '1' },
    periods: {},
    semester: { start: '2026-01-05', weeks: 60 },
    holidays: [],
    makeups: [],
    kinds: {
        hard: {}, machine: {}, water: {}, pe: {},
    },
    courses: [],
    free: {
        morning: ['读书'], afternoon: ['散步'], evening: ['休息'],
        afternoonFrom: '12:00', eveningFrom: '18:00',
    },
    where: '合成地点',
} satisfies Schedule;

const flags = {
    onlineStatus: false,
    profileLikes: false,
    signature: 'off',
    qzone: 'off',
    qzoneVisibility: 'friends',
} as const;

function construct(dir: string, calls: string[] = []) {
    return createPresence({
        flags,
        transport: { sendLike: async () => { calls.push('like'); } },
        schedule,
        likeTargets: [10001],
        dir,
        now: () => new Date(2026, 10, 5, 20, 0).getTime(),
        log: () => {},
    });
}

test('存在感进度是外部动作事实：坏 JSON 失败关闭且保留原文件', () => {
    const dir = temp();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'presence.json');
    const original = '{"version":1,"qzone":[';
    writeFileSync(path, original);

    assert.throws(() => construct(dir), /存在感状态.*无效.*拒绝启动/);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.deepEqual(readdirSync(dir), ['presence.json'], '不能隔离成空状态后重做公开动作');
});

test('畸形字段不能绕过浅层 schema 后丢掉当天动作进度', () => {
    const dir = temp();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'presence.json');
    const malformed = JSON.stringify({ version: 1, qzone: [], photosUsed: [], likedDay: 7 });
    writeFileSync(path, malformed);
    const calls: string[] = [];

    assert.throws(() => construct(dir, calls), /存在感状态.*无效.*拒绝启动/);
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(path, 'utf8'), malformed);
});

test('合法的最小 v1 状态保持兼容', async () => {
    const dir = temp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'presence.json'), JSON.stringify({ version: 1, qzone: [], photosUsed: [] }));
    const presence = construct(dir);
    await presence.tick();
    assert.equal(presence.selfNote(Date.now()), undefined);
});

test('合法 v1 的全部既有可选字段保持兼容', () => {
    const dir = temp();
    mkdirSync(dir, { recursive: true });
    const now = new Date(2026, 10, 5, 20, 0).getTime();
    writeFileSync(join(dir, 'presence.json'), JSON.stringify({
        version: 1,
        status: { label: '在线', at: now - 1_000 },
        likedDay: '2026-11-05',
        signature: { text: '合成签名', at: now - 2_000, next: now + 86_400_000, draft: false },
        qzone: [{ at: now - 3_000, text: '合成说说', photo: 'synthetic.jpg', tid: 'tid-synthetic', mode: 'on' }],
        qzoneAttemptDay: '2026-11-05',
        browse: { at: now - 4_000, action: 'synthetic-read', count: 2, note: '合成浏览' },
        browseAttemptAt: now - 4_000,
        peek: { at: now - 5_000, uin: 10001, count: 1, note: '合成好友动态' },
        peekAttemptAt: now - 5_000,
        peekSeen: ['synthetic-id'],
        peekRetryAt: now + 1_000,
        strangers: { at: now - 6_000, action: 'synthetic-strangers', count: 1, note: '合成陌生动态' },
        strangersAttemptAt: now - 6_000,
        photosUsed: ['synthetic.jpg'],
        pokesOut: [now - 7_000],
        pokeOutAttemptDay: '2026-11-05',
    }));

    assert.match(construct(dir).selfNote(now)!, /合成签名.*合成说说.*合成浏览.*合成好友动态.*合成陌生动态/s);
});

test('未来的空间观察不提前进入提示词', () => {
    const now = new Date(2026, 10, 5, 20, 0).getTime();
    const future = now + 60_000;
    assert.equal(describeSelf({ qzone: [], browse: { at: future, note: 'FUTURE_BROWSE' } }, now), undefined);
    assert.equal(describeSelf({ qzone: [], peek: { at: future, note: 'FUTURE_PEEK' } }, now), undefined);
    assert.equal(describeSelf({ qzone: [], strangers: { at: future, note: 'FUTURE_STRANGERS' } }, now), undefined);
    assert.match(describeSelf({ qzone: [], browse: { at: now, note: 'CURRENT_BROWSE' } }, now)!, /CURRENT_BROWSE/);
});
