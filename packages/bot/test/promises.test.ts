import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Contact } from '../src/config.ts';
import type { StoredMessage } from '../src/history.ts';
import type { OpenAIMessage } from '../src/prompt.ts';
import {
    describePromises, duePromises, forgotten, parsePromises, promiseKeeper, promisePrompt, SHOWN_REPLIES, type HerPromise,
} from '../src/promises.ts';
import type { Schedule } from '../src/schedule.ts';

const names = { user: '阿明', char: '林梦瑶' };
const at = (iso: string) => new Date(`${iso}+08:00`);
const msg = (iso: string, role: 'user' | 'assistant', content: string): StoredMessage => ({ role, content, time: at(iso).toISOString() });
const promise = (extra: Partial<HerPromise>): HerPromise => ({ id: 'p-1', what: '给他讲结局', said: '2026-10-05', episode: 'ep-1', ...extra });

describe('她答应的事：抽取（ADR 0018 决策 2）', () => {
    test('提示词：她要做的事、做不到的不抽、日期换算、还没做的给 id', () => {
        const [system, user] = promisePrompt('—— 2026年10月5日 ——\n林梦瑶 (20:00): 下次给你讲', [promise({ date: '2026-10-10', what: '去拍银杏' })], names);
        for (const rule of ['林梦瑶自己说的、她之后要做的事', '发照片', '打电话', '寄东西', 'YYYY-MM-DD', 'date 写 null', 'resolved']) {
            assert.ok(system!.content.includes(rule), rule);
        }
        assert.match(user!.content, /^还没做的事：\n- p-1：2026-10-10 去拍银杏\n\n聊天记录：\n/);
        assert.match(promisePrompt('x', [promise({})], names)[1]!.content, /- p-1：下次 给他讲结局/);
    });

    test('解析：有日子的、「下次」的（null 或写错的日期都当下次），没写什么的不要；没有 JSON 抛错', () => {
        assert.deepEqual(parsePromises('好的\n{"add":[{"what":"去拍银杏","date":"2026-10-10"},{"what":"给他讲结局","date":null},{"what":"推荐歌","date":"周末"},{"date":"2026-10-11"}],"resolved":["p-1",3]}'), {
            add: [{ what: '去拍银杏', date: '2026-10-10' }, { what: '给他讲结局' }, { what: '推荐歌' }],
            resolved: ['p-1'],
        });
        assert.throws(() => parsePromises('没有'), /没有 JSON/);
    });
});

describe('她答应的事：什么时候提醒、什么时候忘（ADR 0018 决策 2）', () => {
    const day = new Date(2026, 9, 10);

    test('忘：有日子的过了那天 3 天，「下次」的过了说的那天 7 天', () => {
        assert.equal(forgotten(promise({ date: '2026-10-07' }), day), false);
        assert.equal(forgotten(promise({ date: '2026-10-06' }), day), true);
        assert.equal(forgotten(promise({ said: '2026-10-03' }), day), false);
        assert.equal(forgotten(promise({ said: '2026-10-02' }), day), true);
    });

    test('提醒：有日子的那天到之后 2 天；「下次」的在说的那段聊天之后；这段聊天里她回了 3 次就不放了', () => {
        const chat = [msg('2026-10-10T20:00:00', 'user', '在吗')];
        const ids = (items: HerPromise[], c = chat) => duePromises(items, day, c).map(p => p.id);
        assert.deepEqual(ids([
            promise({ id: 'a', date: '2026-10-10' }), promise({ id: 'b', date: '2026-10-08' }), promise({ id: 'c', date: '2026-10-07' }),
            promise({ id: 'd', date: '2026-10-11' }), promise({ id: 'e' }),
        ]), ['a', 'b', 'e']);
        // 还是说的那段聊天（片段 id 是第一条消息的毫秒时间）
        const same = `ep-${at('2026-10-10T20:00:00').getTime()}`;
        assert.deepEqual(ids([promise({ id: 'e', episode: same })]), []);
        // 她这段已经回了 3 次（连发算一次）
        const talked = [msg('2026-10-10T20:00:00', 'user', '在吗')];
        for (let i = 0; i < SHOWN_REPLIES; i++) {
            talked.push(msg(`2026-10-10T20:0${i + 1}:00`, 'assistant', '在'), msg(`2026-10-10T20:0${i + 1}:10`, 'assistant', '咋了'), msg(`2026-10-10T20:0${i + 1}:30`, 'user', '嗯'));
        }
        assert.deepEqual(ids([promise({ id: 'a', date: '2026-10-10' })], talked), []);
        assert.deepEqual(ids([promise({ id: 'a', date: '2026-10-10' })], talked.slice(0, -3)), ['a'], '回了 2 次还放');
    });

    test('时间块里的一行', () => {
        assert.equal(describePromises([], day, '阿明'), undefined);
        assert.equal(
            describePromises([promise({ what: '去拍银杏', date: '2026-10-10', said: '2026-10-08' }), promise({ what: '给他讲结局', said: '2026-10-03' })], day, '阿明'),
            '你之前答应过阿明、还没做的事：去拍银杏（前天说的，打算今天）；给他讲结局（10月3日说的，说下次）。合适的时候接着说或者提一句，说过了就不用再提。',
        );
    });
});

describe('她答应的事：记下、划掉、忘掉（ADR 0018 决策 2，假模型）', () => {
    const amin: Contact = { qq: 1, name: '阿明', tier: 'boyfriend' };
    const schedule = { sleep: '02:00' } as Schedule;

    function setup(history: StoredMessage[], replies: (string | Error)[], now: Date) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-promises-'));
        const logs: string[] = [];
        const asked: OpenAIMessage[][] = [];
        let clock = now.getTime();
        const keeper = promiseKeeper({
            contacts: [amin],
            history: { load: () => history },
            names: () => names,
            schedule,
            extract: async messages => {
                asked.push(messages);
                const reply = replies.shift() ?? '{"add":[],"resolved":[]}';
                if (reply instanceof Error) throw reply;
                return reply;
            },
            dir,
            log: m => logs.push(m),
            now: () => clock,
        });
        return { keeper, logs, asked, setNow: (d: Date) => { clock = d.getTime(); }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }

    test('结束了的片段抽一次：记下、到日子提醒（按她的一天）、那天的打算', async () => {
        const history = [
            msg('2026-10-08T20:00:00', 'user', '周末干嘛'),
            msg('2026-10-08T20:01:00', 'assistant', '周六打算去拍银杏，下次给你讲那本书的结局'),
        ];
        const { keeper, logs, asked, cleanup } = setup(history, [
            '{"add":[{"what":"去拍银杏","date":"2026-10-10"},{"what":"给他讲结局","date":null}],"resolved":[]}',
        ], at('2026-10-08T22:00:00'));
        try {
            await keeper.sync();
            assert.equal(asked.length, 1);
            assert.match(asked[0]![1]!.content, /林梦瑶 \(20:01\): 周六打算去拍银杏/);
            assert.ok(logs.includes('[1] 她答应的事：记下「去拍银杏」（2026-10-10）'));
            await keeper.sync();
            assert.equal(asked.length, 1, '抽过的不再抽');

            // 第二天晚上他又来了：「下次」的该提醒，银杏还没到日子
            const chat = [...history, msg('2026-10-09T21:00:00', 'user', '在吗')];
            assert.equal(keeper.describe(amin, chat, at('2026-10-09T21:00:00')),
                '你之前答应过阿明、还没做的事：给他讲结局（昨天说的，说下次）。合适的时候接着说或者提一句，说过了就不用再提。');
            // 周六凌晨 1 点还算周五（她的一天）
            assert.doesNotMatch(keeper.describe(amin, chat, at('2026-10-10T01:00:00'))!, /银杏/);
            assert.match(keeper.describe(amin, chat, at('2026-10-10T09:00:00'))!, /去拍银杏（前天说的，打算今天）/);
            assert.deepEqual(keeper.plansOn('2026-10-10'), ['去拍银杏']);
        } finally {
            cleanup();
        }
    });

    test('晚了才抽（刚上线补抽以前的片段）：抽出来的日子已经过去的不记', async () => {
        const history = [
            msg('2026-10-05T20:00:00', 'user', '明天干嘛'),
            msg('2026-10-05T20:01:00', 'assistant', '明天去图书馆，下次给你讲结局'),
        ];
        const { keeper, logs, cleanup } = setup(history, [
            '{"add":[{"what":"去图书馆","date":"2026-10-06"},{"what":"给他讲结局","date":null}],"resolved":[]}',
        ], at('2026-10-07T12:00:00'));
        try {
            await keeper.sync();
            assert.ok(!logs.some(l => l.includes('去图书馆')), '10-06 的打算 10-07 才抽到，不记');
            assert.ok(logs.includes('[1] 她答应的事：记下「给他讲结局」（下次）'));
        } finally {
            cleanup();
        }
    });

    test('划掉、过期忘掉、抽失败 3 次放弃；太早的、只有一方说话的片段不抽', async () => {
        const first = at('2026-10-08T20:00:00').getTime();
        const history = [
            msg('2026-09-20T20:00:00', 'user', '很久以前'), msg('2026-09-20T20:01:00', 'assistant', '嗯'),
            msg('2026-10-07T09:00:00', 'assistant', '早安'),
            msg('2026-10-08T20:00:00', 'user', '周末干嘛'), msg('2026-10-08T20:01:00', 'assistant', '下次给你讲'),
            msg('2026-10-09T20:00:00', 'user', '讲吧'), msg('2026-10-09T20:01:00', 'assistant', '结局是……'),
        ];
        const { keeper, logs, asked, setNow, cleanup } = setup(history, [
            '{"add":[{"what":"给他讲结局","date":null},{"what":"去拍银杏","date":"2026-10-10"}],"resolved":[]}',
            `{"add":[],"resolved":["p-${first}-1"]}`,
        ], at('2026-10-09T22:00:00'));
        try {
            await keeper.sync();
            assert.equal(asked.length, 2, '9 月 20 日的太早、早安只有她说话，都不抽');
            assert.match(asked[1]![1]!.content, new RegExp(`- p-${first}-1：下次 给他讲结局`));
            assert.ok(logs.includes('[1] 她答应的事：划掉「给他讲结局」（做了，或者他说不用了）'));
            assert.deepEqual(keeper.plansOn('2026-10-10'), ['去拍银杏']);
            // 过了 10 日 3 天还没做：忘了
            setNow(at('2026-10-14T09:00:00'));
            await keeper.sync();
            assert.deepEqual(keeper.plansOn('2026-10-10'), []);
            assert.ok(logs.includes('[1] 她答应的事：过了日子没做，忘了「去拍银杏」'));
        } finally {
            cleanup();
        }

        const failing = setup(history.slice(3, 5), [new Error('超时'), '不是 JSON', new Error('超时'), '{"add":[]}'], at('2026-10-08T22:00:00'));
        try {
            for (let i = 0; i < 4; i++) await failing.keeper.sync();
            assert.equal(failing.asked.length, 3, '失败 3 次就不再抽');
            assert.ok(failing.logs.some(l => l.includes('抽取失败（第 3 次，不再抽）')));
        } finally {
            failing.cleanup();
        }
    });
});
