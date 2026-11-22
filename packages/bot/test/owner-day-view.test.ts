import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { Contact } from '../src/platform/config.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { splitEpisodes } from '../src/memory/episodes.ts';
import { desktopLogId, desktopLogPath, desktopTurns } from '../src/memory/desktop-log.ts';
import { DESKTOP_PREFIX, desktopMessages, ownerDayHistory, ownerDayKeeper, ownerDayView, type OwnerDayTurn } from '../src/memory/owner-day-view.ts';
import { TURN_LEAD_MS } from '../src/life/desktop-presence.ts';
import { promiseKeeper } from '../src/life/promises.ts';
import type { Schedule } from '../src/life/schedule.ts';

// 桌面上说的话进承诺账的合并视图（ADR 0347 第 3 层，方案 §2.4，开关 desktopPromises）。内容都是编的，目录都是临时的。

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const at = (iso: string) => Date.parse(`${iso}+08:00`);
const msg = (iso: string, role: 'user' | 'assistant', content: string, extra: Partial<StoredMessage> = {}): StoredMessage =>
    ({ role, content, time: new Date(at(iso)).toISOString(), ...extra });
const turn = (iso: string, user: string, assistant: string, userIso?: string): OwnerDayTurn =>
    ({ at: at(iso), ...(userIso ? { userAt: at(userIso) } : {}), user, assistant });
const ms = (message: StoredMessage) => Date.parse(message.time);

describe('合并视图：QQ 记录 + 桌面回合（方案 §2.4）', () => {
    test('没有桌面回合时原样给回 QQ 记录', () => {
        const history = [msg('2026-11-22T20:00:00', 'user', '在吗', { messageId: 11 }), msg('2026-11-22T20:01:00', 'assistant', '在呀', { messageId: 12, recalled: true })];
        const view = ownerDayView(history, []);
        assert.deepEqual(view, history);
        assert.notEqual(view, history);
    });

    test('桌面回合按时间插进去，QQ 的先后一条不动；前缀、没有 messageId、不带撤回', () => {
        const history = [
            msg('2026-11-22T14:00:00', 'user', '下午有课吗', { messageId: 1 }),
            msg('2026-11-22T14:01:00', 'assistant', '两点半有', { messageId: 2 }),
            msg('2026-11-22T16:30:00', 'user', '我回宿舍了', { messageId: 3 }),
        ];
        const view = ownerDayView(history, [turn('2026-11-22T15:10:00', '这个表帮我对一下', '好，明天帮你看完', '2026-11-22T15:09:30')]);
        assert.deepEqual(view.map(m => m.content), ['下午有课吗', '两点半有', `${DESKTOP_PREFIX}这个表帮我对一下`, `${DESKTOP_PREFIX}好，明天帮你看完`, '我回宿舍了']);
        assert.deepEqual(view.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
        for (const m of view.slice(2, 4)) assert.deepEqual(Object.keys(m).sort(), ['content', 'role', 'time']);
        assert.equal(ms(view[2]!), at('2026-11-22T15:09:30'));
        assert.equal(ms(view[3]!), at('2026-11-22T15:10:00'));
        // QQ 那几条还是原来那几个对象的内容
        assert.deepEqual([view[0], view[1], view[4]], history);
    });

    test('QQ 记录里本来就乱序的不挪；同一秒的 QQ 在前', () => {
        const history = [
            msg('2026-11-22T20:05:00', 'user', 'b'),
            msg('2026-11-22T20:00:00', 'user', 'a'),
            msg('2026-11-22T20:10:00', 'assistant', 'c'),
        ];
        const view = ownerDayView(history, [turn('2026-11-22T20:05:00', '', '桌面')]);
        assert.deepEqual(view.map(m => m.content), ['b', 'a', `${DESKTOP_PREFIX}桌面`, 'c']);
    });

    test('他开口的时刻：有 userAt 用它；没有就往前推 2 分钟，但不早于上一轮她的回答', () => {
        const messages = desktopMessages([
            turn('2026-11-22T15:00:30', '第二句', '回二'),
            turn('2026-11-22T15:00:00', '第一句', '回一'),
            turn('2026-11-22T15:30:00', '第三句', '回三'),
        ]);
        assert.deepEqual(messages.map(m => m.content.slice(DESKTOP_PREFIX.length)), ['第一句', '回一', '第二句', '回二', '第三句', '回三']);
        assert.equal(ms(messages[0]!), at('2026-11-22T15:00:00') - TURN_LEAD_MS);
        assert.equal(ms(messages[2]!), at('2026-11-22T15:00:00'), '回退不早于上一轮结束');
        assert.equal(ms(messages[4]!), at('2026-11-22T15:30:00') - TURN_LEAD_MS);
        for (let i = 1; i < messages.length; i++) assert.ok(ms(messages[i]!) >= ms(messages[i - 1]!));
    });

    test('只有一边说话的回合只出那一条', () => {
        assert.deepEqual(desktopMessages([turn('2026-11-22T15:00:00', '  ', '我先去吃饭了'), turn('2026-11-22T15:10:00', '人呢', '')]).map(m => [m.role, m.content]),
            [['assistant', `${DESKTOP_PREFIX}我先去吃饭了`], ['user', `${DESKTOP_PREFIX}人呢`]]);
    });

    test('挨得近的 QQ 和桌面切进同一个片段；同一份输入每次给出同一个片段 id', () => {
        const history = [msg('2026-11-22T20:00:00', 'user', '我上电脑了'), msg('2026-11-22T20:00:10', 'assistant', '来')];
        const desktop = [turn('2026-11-22T20:20:00.750', '这段帮我改改', '明天给你改好')];
        const episodes = splitEpisodes(ownerDayView(history, desktop));
        assert.equal(episodes.length, 1);
        assert.equal(episodes[0]!.messages.length, 4);
        assert.deepEqual(splitEpisodes(ownerDayView(history, desktop)).map(e => e.id), episodes.map(e => e.id));
        // 片段从桌面开始时，id 也是截到秒的时刻
        const desktopFirst = splitEpisodes(ownerDayView([], [turn('2026-11-22T09:00:00.750', '早', '早呀', '2026-11-22T08:59:59.250')]));
        assert.equal(desktopFirst[0]!.id, `ep-${at('2026-11-22T08:59:59')}`);
    });
});

describe('只给男朋友档（方案 §2.4、§2.8）', () => {
    const histories: Record<number, StoredMessage[]> = {
        1: [msg('2026-11-22T20:00:00', 'user', '在吗')],
        2: [msg('2026-11-22T20:00:00', 'user', '作业写完没')],
    };
    const base = { load: (qq: number) => histories[qq] ?? [] };

    test('只换男朋友那一位的记录；别人原样转交，也不去读桌面回合', () => {
        let reads = 0;
        const source = ownerDayHistory(base, { ownerQq: 1, desktop: () => { reads++; return [turn('2026-11-22T20:10:00', '电脑上那句', '嗯')]; } });
        assert.equal(source.load(2), histories[2]);
        assert.equal(reads, 0);
        assert.deepEqual(source.load(1).map(m => m.content), ['在吗', `${DESKTOP_PREFIX}电脑上那句`, `${DESKTOP_PREFIX}嗯`]);
        assert.equal(reads, 1);
    });

    test('没有男朋友档时谁都不换', () => {
        assert.equal(ownerDayHistory(base, { ownerQq: undefined, desktop: () => { throw new Error('不该读'); } }), base);
    });

    test('桌面回合读不了就抛出去（承诺账会当来源暂不可确认），不悄悄少几句', () => {
        const source = ownerDayHistory(base, { ownerQq: 1, desktop: () => { throw new Error('EBUSY'); } });
        assert.throws(() => source.load(1), /EBUSY/);
        assert.equal(source.load(2), histories[2]);
    });
});

describe('接上承诺账（假模型、临时目录）', () => {
    const amin: Contact = { qq: 1, name: '阿明', tier: 'boyfriend' };
    const xiaoyu: Contact = { qq: 2, name: '小雨', tier: 'classmate' };
    const names = { user: '阿明', char: '林梦瑶' };
    const schedule = { sleep: '02:00' } as Schedule;

    function setup(options: { wrap: boolean; desktopThrows?: boolean }) {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-owner-day-'));
        dirs.push(root);
        const dataDir = join(root, 'data');
        mkdirSync(join(dataDir, 'memory'), { recursive: true });
        const now = at('2026-11-22T23:00:00');
        // 桌面账本：desktop-log.ts 的落盘格式
        const desktopRow = { v: 1, at: new Date(at('2026-11-22T21:10:00')).toISOString(), userAt: new Date(at('2026-11-22T21:09:00')).toISOString(), user: '报告还差一节', assistant: '明天帮你看完' };
        const id = desktopLogId(at('2026-11-22T21:10:00'), desktopRow.user, desktopRow.assistant);
        writeFileSync(desktopLogPath(dataDir), `${JSON.stringify({ ...desktopRow, id })}\n`);
        const histories: Record<number, StoredMessage[]> = {
            1: [msg('2026-11-22T21:00:00', 'user', '我开电脑了'), msg('2026-11-22T21:00:30', 'assistant', '好')],
            2: [msg('2026-11-22T21:00:00', 'user', '明天交作业吗'), msg('2026-11-22T21:00:30', 'assistant', '交的')],
        };
        const base = { load: (qq: number) => histories[qq] ?? [] };
        const asked: { transcript: string }[] = [];
        const logs: string[] = [];
        const keeper = promiseKeeper({
            contacts: [amin, xiaoyu],
            history: options.wrap ? ownerDayHistory(base, {
                ownerQq: amin.qq,
                desktop: () => { if (options.desktopThrows) throw new Error('EBUSY'); return desktopTurns(dataDir, now); },
            }) : base,
            names: () => names,
            schedule,
            extract: async (messages: OpenAIMessage[]) => { asked.push({ transcript: String(messages.at(-1)?.content ?? '') }); return '{"add":[],"resolved":[]}'; },
            dir: join(root, 'promises'),
            log: m => logs.push(m),
            now: () => now,
        });
        return { keeper, asked, logs };
    }

    test('开着：男朋友档的抽取材料里有桌面上那句，同学档没有', async () => {
        const { keeper, asked } = setup({ wrap: true });
        await keeper.sync();
        assert.equal(asked.length, 2);
        const [boyfriend, classmate] = [asked.find(a => a.transcript.includes('我开电脑了')), asked.find(a => a.transcript.includes('明天交作业吗'))];
        assert.ok(boyfriend?.transcript.includes(`${DESKTOP_PREFIX}明天帮你看完`), boyfriend?.transcript);
        assert.ok(boyfriend?.transcript.includes(`${DESKTOP_PREFIX}报告还差一节`));
        assert.ok(classmate && !classmate.transcript.includes(DESKTOP_PREFIX), classmate?.transcript);
    });

    test('关着（不包这一层）：谁的材料里都没有桌面上的话', async () => {
        const { keeper, asked } = setup({ wrap: false });
        await keeper.sync();
        assert.equal(asked.length, 2);
        for (const a of asked) assert.ok(!a.transcript.includes(DESKTOP_PREFIX) && !a.transcript.includes('明天帮你看完'));
    });

    test('桌面账本读不了：男朋友档暂停（来源暂不可确认），同学档照常', async () => {
        const { keeper, asked, logs } = setup({ wrap: true, desktopThrows: true });
        await keeper.sync();
        assert.ok(logs.some(l => l.startsWith('[1] 承诺聊天来源暂不可确认')), logs.join('\n'));
        assert.deepEqual(asked.map(a => a.transcript.includes('明天交作业吗')), [true]);
    });
});

describe('时间块「这一段刚说的不再提醒」也看合并视图（ownerDayKeeper）', () => {
    const amin: Contact = { qq: 1, name: '阿明', tier: 'boyfriend' };
    const xiaoyu: Contact = { qq: 2, name: '小雨', tier: 'classmate' };
    const names = { user: '阿明', char: '林梦瑶' };
    const schedule = { sleep: '02:00' } as Schedule;
    const desktop = [turn('2026-11-22T21:10:00', '今晚十一点见个面？', '好，十一点楼下见', '2026-11-22T21:09:00')];
    const qqChat = [msg('2026-11-22T21:20:00', 'user', '我下电脑了'), msg('2026-11-22T21:21:00', 'assistant', '嗯嗯')];

    test('电脑上刚约好、接着在 QQ 上聊：包了这一层不再提醒；不包就提醒（QQ 那段的片段 id 对不上）', async () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-owner-day-keeper-'));
        dirs.push(root);
        const now = at('2026-11-22T21:25:00');
        const keeper = promiseKeeper({
            contacts: [amin],
            history: ownerDayHistory({ load: () => qqChat }, { ownerQq: 1, desktop: () => desktop }),
            names: () => names,
            schedule,
            extract: async () => JSON.stringify({ add: [{ what: '十一点楼下见面', date: '2026-11-22', meet: { time: '23:00' } }], resolved: [] }),
            dir: join(root, 'promises'),
            log: () => {},
            now: () => now,
        });
        await keeper.sync();
        assert.match(keeper.describe(amin, qqChat, new Date(now)) ?? '', /十一点楼下见面/);
        assert.equal(ownerDayKeeper(keeper, { ownerQq: 1, desktop: () => desktop }).describe(amin, qqChat, new Date(now)), undefined);
        // 桌面回合读不了：照旧用 QQ 的 chat，不让回话失败
        assert.match(ownerDayKeeper(keeper, { ownerQq: 1, desktop: () => { throw new Error('EBUSY'); } }).describe(amin, qqChat, new Date(now)) ?? '', /十一点楼下见面/);
    });

    test('别人的 chat 原样转交，不读桌面回合；没有男朋友档时原样给回', () => {
        const seen: (readonly unknown[])[] = [];
        const fake = {
            describe: (_c: Contact, chat: readonly unknown[], _now: Date) => { seen.push(chat); return undefined; },
            openLoops: (_c: Contact, chat: readonly unknown[], _now: Date) => { seen.push(chat); return { waiting: [], unanswered: [], unsettled: [] }; },
            sync: async () => {},
        };
        let reads = 0;
        const wrapped = ownerDayKeeper(fake, { ownerQq: 1, desktop: () => { reads++; return desktop; } });
        wrapped.describe(xiaoyu, qqChat, new Date());
        wrapped.openLoops(xiaoyu, qqChat, new Date());
        assert.deepEqual(seen, [qqChat, qqChat]);
        assert.equal(seen[0], qqChat);
        assert.equal(reads, 0);
        assert.equal(wrapped.sync, fake.sync);
        const owner = ownerDayKeeper(fake, { ownerQq: 1, desktop: () => desktop });
        owner.openLoops(amin, qqChat, new Date());
        assert.equal(seen.at(-1)!.length, 4);
        assert.equal(ownerDayKeeper(fake, { ownerQq: undefined, desktop: () => desktop }), fake);
    });
});
