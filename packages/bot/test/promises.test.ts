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
        assert.match(user!.content, /^还没做的事：\n- p-1：2026-10-10 去拍银杏\n\n还挂着的事：\n（没有）\n\n聊天记录：\n/);
        assert.match(promisePrompt('x', [promise({})], names)[1]!.content, /- p-1：下次 给他讲结局/);
    });

    test('提示词：挂着的事三类只写发生了什么，还挂着的给 id（ADR 0023）', () => {
        const [system, user] = promisePrompt('x', [], names, [
            { id: 'a-1', kind: 'waiting', what: '阿明周四下午字节面试', date: '2026-10-08', said: '2026-10-07', episode: 'ep-1' },
            { id: 'u-1', kind: 'unsettled', what: '10月6日说好一起看电影，他加班没去成', said: '2026-10-06', episode: 'ep-0' },
        ]);
        for (const rule of ['waiting', 'unanswered', 'unsettled', '不写谁什么感受', '不要「难过」']) assert.ok(system!.content.includes(rule), rule);
        // 第一批：随口的问句都挂上了、她约他没接的进了「没了结」
        for (const rule of ['随口的关心和闲聊里的问句不算', '她约他、他没接茬的算这一类', '一段聊天最多记一条', '她提了他还没答应的不算']) {
            assert.ok(system!.content.includes(rule), rule);
        }
        assert.match(user!.content, /还挂着的事：\n- a-1：等结果 2026-10-08 阿明周四下午字节面试\n- u-1：没了结 10月6日说好一起看电影，他加班没去成\n/);
    });

    test('解析：有日子的、「下次」的（null 或写错的日期都当下次），没写什么的不要；没有 JSON 抛错', () => {
        assert.deepEqual(parsePromises('好的\n{"add":[{"what":"去拍银杏","date":"2026-10-10"},{"what":"给他讲结局","date":null},{"what":"推荐歌","date":"周末"},{"date":"2026-10-11"}],"resolved":["p-1",3]}'), {
            add: [{ what: '去拍银杏', date: '2026-10-10' }, { what: '给他讲结局' }, { what: '推荐歌' }],
            waiting: [], unanswered: [], unsettled: [], world: [], feelings: [],
            resolved: ['p-1'],
        });
        assert.throws(() => parsePromises('没有'), /没有 JSON/);
    });

    test('解析挂着的事：写成情绪的不记（ADR 0023，「不做带情绪的记忆」）', () => {
        const parsed = parsePromises(JSON.stringify({
            add: [],
            waiting: [{ what: '阿明周四下午字节面试', date: '2026-10-08' }, { what: '他下次体检', date: 'x' }],
            unanswered: [{ what: '他国庆回不回家', date: '2026-10-01' }, { what: '他吃了没' }],
            unsettled: [{ what: '说好一起看电影，他加班没去成' }, { what: '她对他放鸽子很失望' }],
            resolved: ['a-1'],
        }));
        assert.deepEqual(parsed.waiting, [{ what: '阿明周四下午字节面试', date: '2026-10-08' }, { what: '他下次体检' }]);
        assert.deepEqual(parsed.unanswered, [{ what: '他国庆回不回家' }], '没回答的不带日子，一段最多一条');
        assert.deepEqual(parsed.unsettled, [{ what: '说好一起看电影，他加班没去成' }]);
        assert.deepEqual(parsed.feelings, ['她对他放鸽子很失望']);
    });

    test('同一次抽取带回已完成的世界动作；未知动作和坏时间丢掉，seen/subject 只收正确类型', () => {
        const [system] = promisePrompt('x', [], names);
        for (const rule of ['world', '已经做完', '计划、将来时、猜测、玩笑、否定句', 'feed_cat', 'pick_parcel', 'finish_homework', 'family_call']) {
            assert.ok(system!.content.includes(rule), rule);
        }
        const parsed = parsePromises(JSON.stringify({
            world: [
                { kind: 'feed_cat', at: '2026-10-07T20:31', seen: false },
                { kind: 'pick_parcel', at: '坏时间', subject: ' 发圈 ' },
                { kind: 'invent_money', at: '2026-10-07T20:32' },
                { kind: 'finish_homework', at: '2026-10-07T21:00', subject: 3, seen: 'yes' },
            ],
        }));
        assert.deepEqual(parsed.world, [
            { kind: 'feed_cat', at: '2026-10-07T20:31', seen: false },
            { kind: 'finish_homework', at: '2026-10-07T21:00' },
        ]);
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
        const world: { qq: number; episode: string; kind?: string }[] = [];
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
            onWorldActions: (contact, episode, actions) => world.push({ qq: contact.qq, episode: episode.id, kind: actions[0]?.kind }),
        });
        return { keeper, logs, asked, world, setNow: (d: Date) => { clock = d.getTime(); }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }

    test('世界动作复用同一次片段抽取，回调一次；片段标成已抽后不重复回写', async () => {
        const history = [
            msg('2026-10-08T20:00:00', 'user', '土豆呢'),
            msg('2026-10-08T20:01:00', 'assistant', '刚下楼喂完，今天见着它了'),
        ];
        const { keeper, asked, world, cleanup } = setup(history, [JSON.stringify({
            add: [], resolved: [], world: [{ kind: 'feed_cat', at: '2026-10-08T20:01', seen: true }],
        })], at('2026-10-08T22:00:00'));
        try {
            await keeper.sync();
            await keeper.sync();
            assert.equal(asked.length, 1);
            assert.deepEqual(world, [{ qq: 1, episode: `ep-${at('2026-10-08T20:00:00').getTime()}`, kind: 'feed_cat' }]);
        } finally {
            cleanup();
        }
    });

    test('世界动作落盘失败时不标已抽，下一次同步会重新抽并回写', async () => {
        const history = [
            msg('2026-10-08T20:00:00', 'user', '土豆呢'),
            msg('2026-10-08T20:01:00', 'assistant', '刚喂完'),
        ];
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-promises-world-retry-'));
        let extracts = 0;
        let writes = 0;
        const logs: string[] = [];
        const keeper = promiseKeeper({
            contacts: [amin], history: { load: () => history }, names: () => names, schedule,
            extract: async () => {
                extracts++;
                return JSON.stringify({ add: [], resolved: [], world: [{ kind: 'feed_cat', at: '2026-10-08T20:01' }] });
            },
            onWorldActions: () => {
                writes++;
                if (writes === 1) throw new Error('disk full');
            },
            dir, log: message => logs.push(message), now: () => at('2026-10-08T22:00:00').getTime(),
        });
        try {
            await keeper.sync();
            assert.equal(extracts, 1);
            assert.ok(logs.some(line => /世界动作写入失败.*下次再试.*disk full/.test(line)));
            await keeper.sync();
            await keeper.sync();
            assert.equal(extracts, 2, '第二次成功后标成已抽，第三次不再抽');
            assert.equal(writes, 2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

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

    test('挂着的事（ADR 0023）：同一次抽取记下；等结果的到那天晚上才放，没回答、没了结的在之后的聊天里放；回了 3 次不放；了结、过期放下', async () => {
        const history = [
            msg('2026-10-07T20:00:00', 'user', '明天下午我要去字节面试'),
            msg('2026-10-07T20:01:00', 'assistant', '加油！对了你国庆回不回家'),
            msg('2026-10-07T20:02:00', 'user', '今天食堂的菜好咸'),
        ];
        const { keeper, logs, asked, setNow, cleanup } = setup(history, [
            JSON.stringify({
                add: [],
                waiting: [{ what: '阿明周四下午字节面试', date: '2026-10-08' }],
                unanswered: [{ what: '他国庆回不回家' }],
                unsettled: [{ what: '10月6日说好一起看电影，他加班没去成' }, { what: '她有点失望' }],
                resolved: [],
            }),
        ], at('2026-10-07T22:00:00'));
        try {
            await keeper.sync();
            assert.equal(asked.length, 1, '和她答应的事是同一次调用');
            assert.ok(logs.includes('[1] 挂着的事：记下「阿明周四下午字节面试」（等结果，2026-10-08）'));
            assert.ok(logs.includes('[1] 挂着的事：写成了情绪、没记 1 条（只记发生了什么）'));
            const what = (due: ReturnType<typeof keeper.openLoops>) => ({
                waiting: due.waiting.map(l => l.what), unanswered: due.unanswered.map(l => l.what), unsettled: due.unsettled.map(l => l.what),
            });

            // 周四下午：面试还没到点；没回答、没了结的在这段新聊天里放
            const afternoon = [...history, msg('2026-10-08T15:00:00', 'user', '在吗')];
            assert.deepEqual(what(keeper.openLoops(amin, afternoon, at('2026-10-08T15:00:00'))), {
                waiting: [], unanswered: ['他国庆回不回家'], unsettled: ['10月6日说好一起看电影，他加班没去成'],
            });
            // 周四晚上：面试该有结果了
            const evening = [...history, msg('2026-10-08T21:00:00', 'user', '在吗')];
            assert.deepEqual(what(keeper.openLoops(amin, evening, at('2026-10-08T21:00:00'))).waiting, ['阿明周四下午字节面试']);
            // 抽出它的那段聊天里不放（原话就在眼前）
            assert.deepEqual(what(keeper.openLoops(amin, history, at('2026-10-07T20:03:00'))).unanswered, []);
            // 这段聊天她已经回了 3 次
            const talked = [...evening];
            for (let i = 0; i < 3; i++) {
                talked.push(msg(`2026-10-08T21:0${i + 1}:00`, 'assistant', '嗯'), msg(`2026-10-08T21:0${i + 1}:30`, 'user', '嗯嗯'));
            }
            assert.deepEqual(what(keeper.openLoops(amin, talked, at('2026-10-08T21:05:00'))), { waiting: [], unanswered: [], unsettled: [] });

            assert.match(asked[0]![1]!.content, /还挂着的事：\n（没有）/, '第一次抽的时候还没有挂着的');
        } finally {
            cleanup();
        }

        // 了结和过期：直接用一个有状态的 keeper
        const day1 = [
            msg('2026-10-07T20:00:00', 'user', '明天下午我要去字节面试'),
            msg('2026-10-07T20:01:00', 'assistant', '加油'),
        ];
        const day2 = [...day1, msg('2026-10-08T21:00:00', 'user', '面试过了'), msg('2026-10-08T21:01:00', 'assistant', '厉害！')];
        let history2 = day1;
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-loops-'));
        const logs2: string[] = [];
        const asked2: OpenAIMessage[][] = [];
        let clock = at('2026-10-07T22:00:00').getTime();
        const replies = [
            JSON.stringify({ add: [], waiting: [{ what: '阿明周四下午字节面试', date: '2026-10-08' }], unsettled: [{ what: '说好的电影没看成' }], resolved: [] }),
        ];
        const keeper2 = promiseKeeper({
            contacts: [amin], history: { load: () => history2 }, names: () => names, schedule,
            extract: async messages => {
                asked2.push(messages);
                const first = replies.shift();
                if (first) return first;
                const id = /- (a-\d+-1)：等结果/.exec(messages[1]!.content)?.[1];
                return JSON.stringify({ add: [], resolved: id ? [id] : [] });
            },
            dir, log: m => logs2.push(m), now: () => clock,
        });
        try {
            await keeper2.sync();
            history2 = day2;
            clock = at('2026-10-08T23:00:00').getTime();
            await keeper2.sync();
            assert.match(asked2[1]![1]!.content, /- a-\d+-1：等结果 2026-10-08 阿明周四下午字节面试/);
            assert.ok(logs2.includes('[1] 挂着的事：了结「阿明周四下午字节面试」'));
            clock = at('2026-10-12T09:00:00').getTime();
            await keeper2.sync();
            assert.ok(logs2.includes('[1] 挂着的事：过了几天，放下「说好的电影没看成」'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
