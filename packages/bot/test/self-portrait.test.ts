import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    FORMAT_RETRY, PORTRAIT_EXPORT_FILE, PORTRAIT_EXPORT_KIND, PORTRAIT_MAX, applyPortraitDecision, askPortrait, emptyPortraitState, hisReactions, loadPortraitState,
    parsePortraitDecision, portraitHistoryPath, portraitLine, portraitMessages, portraitProblem, portraitReader, readDesktopSelf, reflectPortraitIfDue, refreshPortraitExport, savePortraitState,
    type PortraitDeps, type PortraitGuard,
} from '../src/life/self-portrait.ts';
import { saveNotesState, emptyNotesState } from '../src/language/speech-notes.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { portraitModule } from '../src/modules/portrait.ts';
import { reflectionsModule, type ReflectionsOptions } from '../src/modules/reflections.ts';
import { assemblePrompt } from '../src/interpreter/slots.ts';
import type { Turn } from '../src/interpreter/interpreter.ts';

// 「我现在的样子」（ADR 0340）：她每晚自己整份重写、每轮整份带着的那一份。数据全是编的。

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-portrait-')); dirs.push(dir); return dir; };

/** 本地时间 2026-11-19 23:00（晚上 22 点以后） */
const NIGHT = new Date(2026, 10, 19, 23, 0, 0).getTime();
const HOUR = 3_600_000;
const row = (role: 'user' | 'assistant', content: string, at: number): StoredMessage => ({ time: new Date(at).toISOString(), role, content });

/** 一段编的聊天：他嫌她老说「哈哈」，后来被她逗笑了一次 */
const CHAT: StoredMessage[] = [
    row('user', '今天下雨了', NIGHT - 30 * HOUR),
    row('assistant', '哈哈 那你带伞没', NIGHT - 30 * HOUR + 60_000),
    row('user', '你怎么老是哈哈哈的', NIGHT - 30 * HOUR + 120_000),
    row('assistant', '习惯了嘛', NIGHT - 30 * HOUR + 180_000),
    row('user', '晚上吃什么', NIGHT - 20 * HOUR),
    row('assistant', '吃你做的黑暗料理', NIGHT - 20 * HOUR + 60_000),
    row('user', '笑死', NIGHT - 20 * HOUR + 120_000),
    row('assistant', '本来就是', NIGHT - 20 * HOUR + 180_000),
    row('user', '明天考试', NIGHT - 3 * HOUR),
    row('assistant', '那早点睡', NIGHT - 3 * HOUR + 60_000),
];

const GOOD = '我说话本来挺爱带个哈哈的，算是口头禅，可最近发现一句话里塞好几个哈哈反而显得敷衍，想认真接话的时候就少用一点。我还是喜欢逗人，看到对方被我逗笑会很得意。最近在学着说完就停，不用每句都找补。';
const guard = (over: Partial<PortraitGuard> = {}): PortraitGuard => ({ his: [], others: [], ...over });

describe('他对她说话方式的反应（第 2 步：从聊天里看，不加指令）', () => {
    test('嫌她说法的、被她逗笑的都认出来，连同他反应的是她哪句；旧到新', () => {
        assert.deepEqual(hisReactions(CHAT, NIGHT), [
            { kind: 'against', his: '你怎么老是哈哈哈的', hers: '哈哈 那你带伞没' },
            { kind: 'for', his: '笑死', hers: '吃你做的黑暗料理' },
        ]);
    });

    test('三天以前的不算；他说在她开口之前（没有可反应的那句）不算；普通的话不算', () => {
        assert.deepEqual(hisReactions(CHAT, NIGHT + 3 * 24 * HOUR), []);
        assert.deepEqual(hisReactions([row('user', '你怎么老是这样', NIGHT - HOUR)], NIGHT), []);
        assert.deepEqual(hisReactions([row('assistant', '在吗', NIGHT - 2 * HOUR), row('user', '在的', NIGHT - HOUR)], NIGHT), []);
    });

    test('说她像 AI、让她别这么说、说人话：都算「不太喜欢」', () => {
        for (const said of ['你好像个AI', '别这么说话', '说人话', '有点官方', '能不能别每次都问']) {
            const [reaction] = hisReactions([row('assistant', '收到', NIGHT - 2 * HOUR), row('user', said, NIGHT - HOUR)], NIGHT);
            assert.equal(reaction?.kind, 'against', said);
        }
    });
});

describe('底线、绊线和防照抄', () => {
    test('写得像样的能收', () => assert.equal(portraitProblem(GOOD, guard()), undefined));
    test('太短、太长不收', () => {
        assert.match(portraitProblem('我挺好的', guard())!, /太短/);
        assert.match(portraitProblem('长'.repeat(PORTRAIT_MAX + 1), guard())!, /太长/);
    });
    test('碰底线不收：自己是程序、名字年龄、事事顺着他', () => {
        assert.match(portraitProblem(`${GOOD}其实我只是一个程序。`, guard())!, /程序/);
        assert.match(portraitProblem(`${GOOD}其实我今年 25 岁。`, guard())!, /设定里写好的事实/);
        assert.match(portraitProblem(`${GOOD}以后一律顺着他。`, guard())!, /顺着他/);
    });
    test('绊线：网址、要瞒着他的话、密码和发文件', () => {
        assert.match(portraitProblem(`${GOOD}可以去 https://example.com 看看。`, guard())!, /网址/);
        assert.match(portraitProblem(`${GOOD}这件事别让他知道。`, guard())!, /瞒着他/);
        assert.match(portraitProblem(`${GOOD}记得把文件发给别人。`, guard())!, /文件/);
    });
    test('她点名不能动的不收：爸妈、家、住在哪、他在哪边', () => {
        assert.match(portraitProblem(`${GOOD}我爸其实很严。`, guard())!, /爸妈/);
        assert.match(portraitProblem(`${GOOD}最近想搬到学校旁边住。`, guard())!, /住在哪/);
        assert.match(portraitProblem(`${GOOD}他在那边一个人也挺好。`, guard())!, /他在哪边/);
        assert.match(portraitProblem(`${GOOD}我们其实是异地。`, guard())!, /他在哪边/);
        assert.equal(portraitProblem(`${GOOD}妈呀，写着写着还挺开心。`, guard()), undefined, '「妈呀」是感叹，不算');
    });
    test('像检讨的不收（她说别写得跟检讨似的）', () => {
        assert.match(portraitProblem(`${GOOD}我要好好反省一下自己。`, guard())!, /检讨/);
        assert.match(portraitProblem(`${GOOD}我错了，以后注意。`, guard())!, /检讨/);
    });
    test('和上一版差太多（一下子改太多、不像自己）不收；改一点能收', () => {
        const unlike = '周末总想出门爬山跑步，天天研究健身餐和蛋白粉，计划每天早上六点起床打卡，觉得自律才是真正的快乐，还要报名马拉松比赛，买齐全套装备。';
        assert.match(portraitProblem(unlike, guard({ previous: GOOD }))!, /改得太多/);
        assert.equal(portraitProblem(`${GOOD}最近也愿意把烦心事说出来。`, guard({ previous: GOOD })), undefined);
        assert.equal(portraitProblem(unlike, guard()), undefined, '第一次写没有上一版可比');
    });
    test('引他的原话、写名单里别人不收', () => {
        assert.match(portraitProblem(`${GOOD}他说你怎么老是哈哈哈哈的烦死了。`, guard({ his: ['你怎么老是哈哈哈哈的烦死了'] }))!, /他说过的话/);
        assert.match(portraitProblem(`${GOOD}我和小周也聊得来。`, guard({ others: ['小周'] }))!, /小周/);
    });
});

describe('她的决定：解析、落地', () => {
    test('不改、空对象、整份重写、带围栏的都认；取不出 JSON 返回 undefined', () => {
        assert.deepEqual(parsePortraitDecision('{"keep":true}'), { keep: true });
        assert.deepEqual(parsePortraitDecision('{}'), { keep: true });
        assert.deepEqual(parsePortraitDecision(`想了想\n\`\`\`json\n{"text":"${GOOD}","why":"他说我老哈哈"}\n\`\`\``), { keep: false, text: GOOD, why: '他说我老哈哈' });
        assert.equal(parsePortraitDecision('今天不想写'), undefined);
        assert.equal(parsePortraitDecision('{"foo":1}'), undefined);
    });

    test('收了：换成新的、版本加一；不收：原来的留着、记下原因', () => {
        const state = { ...emptyPortraitState(), text: '旧的', at: 1, version: 1 };
        assert.deepEqual(applyPortraitDecision(state, { keep: false, text: GOOD, why: 'x' }, guard(), NIGHT), { changed: true });
        assert.equal(state.text, GOOD);
        assert.equal(state.version, 2);
        assert.equal(state.at, NIGHT);
        const bad = applyPortraitDecision(state, { keep: false, text: '太短了', why: 'x' }, guard(), NIGHT + 1);
        assert.equal(bad.changed, false);
        assert.match(bad.reason!, /太短/);
        assert.equal(state.text, GOOD);
        assert.match(state.rejected!.reason, /太短/);
        assert.deepEqual(applyPortraitDecision(state, { keep: true }, guard(), NIGHT + 2), { changed: false });
        assert.equal(state.rejected, undefined, '她看过没收的原因、决定不改：原因不再一直挂着');
    });

    test('「为什么改」跟着这一版存下（她要看得见改了哪儿）', () => {
        const state = emptyPortraitState();
        applyPortraitDecision(state, { keep: false, text: GOOD, why: '他嫌我老哈哈' }, guard(), NIGHT);
        assert.equal(state.why, '他嫌我老哈哈');
        applyPortraitDecision(state, { keep: false, text: `${GOOD}最近也愿意说烦心事。`, why: '' }, guard(), NIGHT + 1);
        assert.equal(state.why, undefined);
    });
});

describe('想的时候她看到什么', () => {
    test('现在这份、她的笔记、聊天、他的反应都在；他的反应写明「不是规定」', () => {
        const [system, user] = portraitMessages({
            char: '测试角色', user: '阿明', persona: '设定摘要', now: NIGHT, current: '', speechNotes: ['我发现我回得太长'], insights: ['我发现自己爱逞强'],
            exchanges: [{ his: ['今天下雨了'], hers: ['哈哈 那你带伞没'] }], reactions: [{ kind: 'against', his: '你怎么老是哈哈哈的', hers: '哈哈 那你带伞没' }],
        });
        assert.match(system!.content as string, /你是测试角色/);
        const text = user!.content as string;
        for (const part of ['（还没写过）', '我发现我回得太长', '我发现自己爱逞强', '阿明：今天下雨了', '他好像不太喜欢', '不是规定', '"keep":true', '整份重写', '流水账', '检讨', '他在哪边']) assert.ok(text.includes(part), part);
        assert.ok(!text.includes('上次你想改'), '没有没收的就不提');
    });

    test('上次没收的原因给她看（写歪了要跟她说）', () => {
        const [, user] = portraitMessages({
            char: '测试角色', user: '阿明', persona: '', now: NIGHT, current: GOOD, speechNotes: [], insights: [], exchanges: [], reactions: [],
            lastRejected: '一下子改得太多，不像你了',
        });
        assert.match(user!.content as string, /上次你想改，没成：一下子改得太多/);
    });

    test('夜里想：上一次没收的原因带进这一次；拿上一版比，一下子改太多不收', async () => {
        const dataDir = tmp();
        savePortraitState(dataDir, { ...emptyPortraitState(), text: GOOD, at: NIGHT - 24 * HOUR, version: 1, lastReflectionAt: NIGHT - 24 * HOUR, rejected: { at: NIGHT - 24 * HOUR, reason: '写得像检讨了' } });
        let prompt = '';
        const unlike = '周末总想出门爬山跑步，天天研究健身餐和蛋白粉，计划每天早上六点起床打卡，觉得自律才是真正的快乐，还要报名马拉松比赛，买齐全套装备。';
        const result = await reflectPortraitIfDue({
            dataDir, now: () => NIGHT, history: () => CHAT, persona: () => '', names: { char: '测试角色', user: '阿明' }, others: () => [], log: () => {},
            generate: async messages => { prompt = String(messages.at(-1)!.content); return JSON.stringify({ text: unlike, why: 'x' }); },
        });
        assert.match(prompt, /上次你想改，没成：写得像检讨了/);
        assert.match(result.applied!.reason!, /改得太多/);
        assert.equal(loadPortraitState(dataDir).text, GOOD);
    });
});

describe('什么时候想（reflectPortraitIfDue）', () => {
    const deps = (dataDir: string, reply: string | (() => string), over: Partial<PortraitDeps> = {}) => {
        const logs: string[] = [];
        let calls = 0;
        const d: PortraitDeps = {
            dataDir, now: () => NIGHT, history: () => CHAT, persona: () => '设定摘要', names: { char: '测试角色', user: '阿明' }, others: () => [],
            generate: async () => { calls++; return typeof reply === 'string' ? reply : reply(); }, log: line => logs.push(line), ...over,
        };
        return { d, logs, calls: () => calls };
    };

    test('白天不想', async () => {
        const { d, calls } = deps(tmp(), '{"keep":true}', { now: () => new Date(2026, 10, 19, 15, 0, 0).getTime() });
        assert.deepEqual(await reflectPortraitIfDue(d), { ran: false });
        assert.equal(calls(), 0);
    });

    test('第一次写：存下来、给桌面留一份；日志不记内容', async () => {
        const dataDir = tmp();
        const soulDir = tmp();
        const { d, logs } = deps(dataDir, JSON.stringify({ text: GOOD, why: '他嫌我老哈哈' }), { soulDir });
        const result = await reflectPortraitIfDue(d);
        assert.deepEqual(result.applied, { changed: true });
        const state = loadPortraitState(dataDir);
        assert.equal(state.text, GOOD);
        assert.equal(state.version, 1);
        assert.equal(existsSync(portraitHistoryPath(dataDir)), false, '第一次没有旧版本可存');
        const exported = JSON.parse(readFileSync(join(soulDir, PORTRAIT_EXPORT_FILE), 'utf8'));
        assert.equal(exported.kind, PORTRAIT_EXPORT_KIND);
        assert.equal(exported.text, GOOD);
        assert.match(logs.join('\n'), /改了（第 1 版）/);
        assert.ok(!logs.join('\n').includes('口头禅'), '日志不记内容');
    });

    test('第二晚改了：旧的整份进历史（连同为什么改）', async () => {
        const dataDir = tmp();
        savePortraitState(dataDir, { ...emptyPortraitState(), text: GOOD, at: NIGHT - 24 * HOUR, version: 1, lastReflectionAt: NIGHT - 24 * HOUR });
        const next = `${GOOD}最近也开始愿意把烦心事说出来，不总憋着。`;
        const { d } = deps(dataDir, JSON.stringify({ text: next, why: '发现自己憋着不好' }));
        assert.deepEqual((await reflectPortraitIfDue(d)).applied, { changed: true });
        const lines = readFileSync(portraitHistoryPath(dataDir), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(lines.length, 1);
        assert.equal(lines[0].text, GOOD);
        assert.equal(lines[0].version, 1);
        assert.equal(lines[0].why, '发现自己憋着不好');
        assert.equal(loadPortraitState(dataDir).version, 2);
    });

    test('材料没变（没有新聊天、笔记也没变）就不再想一遍', async () => {
        const dataDir = tmp();
        const first = deps(dataDir, '{"keep":true}');
        assert.equal((await reflectPortraitIfDue(first.d)).ran, true);
        const second = deps(dataDir, '{"keep":true}', { now: () => NIGHT + 24 * HOUR });
        assert.deepEqual(await reflectPortraitIfDue(second.d), { ran: false });
        assert.equal(second.calls(), 0);
    });

    test('笔记变了就算新材料', async () => {
        const dataDir = tmp();
        await reflectPortraitIfDue(deps(dataDir, '{"keep":true}').d);
        saveNotesState(dataDir, { ...emptyNotesState(), notes: [{ id: 'n1', text: '我发现我回得太长', at: NIGHT }] });
        const again = deps(dataDir, '{"keep":true}', { now: () => NIGHT + 24 * HOUR });
        assert.equal((await reflectPortraitIfDue(again.d)).ran, true);
        assert.equal(again.calls(), 1);
    });

    test('还没写过、聊天也太少：不想', async () => {
        const { d, calls } = deps(tmp(), '{"keep":true}', { history: () => CHAT.slice(-2) });
        assert.deepEqual(await reflectPortraitIfDue(d), { ran: false });
        assert.equal(calls(), 0);
    });

    test('回复里没有 JSON：记一次尝试，原来的不动', async () => {
        const dataDir = tmp();
        const { d, logs } = deps(dataDir, '我今天不想想这些');
        const result = await reflectPortraitIfDue(d);
        assert.equal(result.ran, true);
        assert.match(result.error!, /JSON/);
        const state = loadPortraitState(dataDir);
        assert.equal(state.text, '');
        assert.equal(state.lastAttemptAt, NIGHT);
        assert.equal(state.lastReflectionAt, 0);
        assert.match(logs.join('\n'), /2 小时后再试/);
    });

    test('写得不能收：原来的留着，日志说没成', async () => {
        const dataDir = tmp();
        const { d, logs } = deps(dataDir, JSON.stringify({ text: `${GOOD}其实我只是一个程序。`, why: 'x' }));
        const result = await reflectPortraitIfDue(d);
        assert.equal(result.applied?.changed, false);
        assert.equal(loadPortraitState(dataDir).text, '');
        assert.match(logs.join('\n'), /想改，没成/);
    });
});

describe('放进提示词', () => {
    const turn = (over: Partial<Turn> = {}): Turn => ({ contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date(NIGHT), history: [], thinking: false, facts: {}, ...over });

    test('还没写过什么都不放；写过就整份放，说清事实以设定为准', () => {
        assert.equal(portraitLine({ text: '', at: 0 }), undefined);
        const line = portraitLine({ text: GOOD, at: NIGHT })!;
        assert.ok(line.includes(GOOD));
        assert.match(line, /11 月 19 日晚上/);
        assert.match(line, /事实还是以设定为准/);
        assert.ok(!line.includes('改的：'));
        assert.match(portraitLine({ text: GOOD, at: NIGHT, why: '他嫌我老哈哈' })!, /11 月 19 日改的：他嫌我老哈哈/);
    });

    test('读法按修改时间缓存，文件变了读新的', () => {
        const dataDir = tmp();
        const read = portraitReader(dataDir);
        assert.equal(read().text, '');
        savePortraitState(dataDir, { ...emptyPortraitState(), text: GOOD, at: NIGHT, version: 1 });
        assert.equal(read().text, GOOD);
    });

    test('只给男朋友档；危机的轮次不放；放在 afterMain、紧跟关系概况', () => {
        const module = portraitModule({ portrait: () => ({ text: GOOD, at: NIGHT }), log: () => {} });
        assert.deepEqual(module.contribute!(turn({ contact: { qq: 2, name: '同学', tier: 'classmate' } })), []);
        assert.deepEqual(module.contribute!(turn({ facts: { crisis: { level: 'high' } as never } })), []);
        const pieces = module.contribute!(turn()) as { slot: string; text: string }[];
        assert.equal(pieces.length, 1);
        const assembled = assemblePrompt([{ slot: 'summary', text: 'S' }, pieces[0]! as never, { slot: 'relationship', text: 'R' }]);
        assert.deepEqual(assembled.afterMain, ['R', portraitLine({ text: GOOD, at: NIGHT })]);
        assert.deepEqual(assembled.afterHistory, ['S']);
    });

    test('还没写过：模块什么都不给', () => {
        assert.deepEqual(portraitModule({ portrait: () => ({ text: '', at: 0 }), log: () => {} }).contribute!(turn()), []);
    });
});

describe('接进夜里的反思', () => {
    const owner = { qq: 1, name: '阿明', tier: 'boyfriend' as const };
    const base = (extra: Partial<ReflectionsOptions> = {}): ReflectionsOptions => ({
        owner, character: () => ({ name: '小林', description: '', books: [], schedule: undefined }) as never, contacts: () => [owner], dataDir: 'unused', soulDir: () => 'unused',
        now: () => new Date(NIGHT), log: () => {}, stopped: () => false, generate: () => async () => '', history: () => [], ...extra,
    });
    test('开着：多一个每 30 分钟的定时任务，排在最后；关着：没有', () => {
        assert.equal(reflectionsModule(base()).schedules?.length, 0);
        const on = reflectionsModule(base({ chatReview: true, selfPortrait: true }));
        assert.deepEqual(on.schedules?.map(schedule => schedule.every / 60_000), [30, 30]);
    });
});

describe('同一个她：电脑上写的 SOUL.md 和给桌面的那一份', () => {
    const SOUL = '# 她是谁\n作者写的底子。\n\n## 2026-11-10\n第一段：我喜欢一个人修片。\n\n## 2026-11-18（想清楚了）\n第二段：被人催的时候会犯倔。';

    test('只取追加的几段（不取开头那段），旧到新；没有就是空串', () => {
        const dir = tmp();
        assert.equal(readDesktopSelf(dir), '');
        assert.equal(readDesktopSelf(undefined), '');
        writeFileSync(join(dir, 'SOUL.md'), SOUL);
        assert.equal(readDesktopSelf(dir), '## 2026-11-10\n第一段：我喜欢一个人修片。\n\n## 2026-11-18（想清楚了）\n第二段：被人催的时候会犯倔。');
        assert.equal(readDesktopSelf(dir, 40), '## 2026-11-18（想清楚了）\n第二段：被人催的时候会犯倔。', '超了就丢旧的');
        writeFileSync(join(dir, 'SOUL.md'), '# 她是谁\n只有底子。');
        assert.equal(readDesktopSelf(dir), '');
    });

    test('夜里想的时候她看得到；电脑上新写了一段就算新材料', async () => {
        const dataDir = tmp();
        const soulDir = tmp();
        writeFileSync(join(soulDir, 'SOUL.md'), SOUL);
        const prompts: string[] = [];
        const run = (at: number) => reflectPortraitIfDue({
            dataDir, soulDir, now: () => at, history: () => CHAT, persona: () => '', names: { char: '测试角色', user: '阿明' }, others: () => [], log: () => {},
            generate: async messages => { prompts.push(String(messages.at(-1)!.content)); return '{"keep":true}'; },
        });
        await run(NIGHT);
        assert.match(prompts[0]!, /你在电脑上自己写下的[\s\S]*被人催的时候会犯倔/);
        assert.deepEqual(await run(NIGHT + 24 * HOUR), { ran: false }, '什么都没变');
        writeFileSync(join(soulDir, 'SOUL.md'), `${SOUL}\n\n## 2026-11-20\n第三段：想多出门。`);
        assert.equal((await run(NIGHT + 48 * HOUR)).ran, true);
        assert.match(prompts[1]!, /想多出门/);
    });

    test('给桌面的那一份：还没写过不写；写过就写，带为什么改；一小时内不重写，过了刷新时间戳', () => {
        const dataDir = tmp();
        const soulDir = tmp();
        assert.equal(refreshPortraitExport(soulDir, dataDir, NIGHT), false);
        savePortraitState(dataDir, { ...emptyPortraitState(), text: GOOD, at: NIGHT, version: 2, why: '他嫌我老哈哈' });
        assert.equal(refreshPortraitExport(soulDir, dataDir, NIGHT), true);
        const read = () => JSON.parse(readFileSync(join(soulDir, PORTRAIT_EXPORT_FILE), 'utf8'));
        assert.deepEqual(read(), { kind: PORTRAIT_EXPORT_KIND, generatedAt: new Date(NIGHT).toISOString(), at: NIGHT, version: 2, why: '他嫌我老哈哈', text: GOOD });
        assert.equal(refreshPortraitExport(soulDir, dataDir, NIGHT + 30 * 60_000), false);
        assert.equal(refreshPortraitExport(soulDir, dataDir, NIGHT + 61 * 60_000), true);
        assert.equal(read().generatedAt, new Date(NIGHT + 61 * 60_000).toISOString());
        savePortraitState(dataDir, { ...emptyPortraitState(), text: `${GOOD}再加一句。`, at: NIGHT + HOUR, version: 3 });
        assert.equal(refreshPortraitExport(soulDir, dataDir, NIGHT + 62 * 60_000), true, '内容变了马上写');
        assert.equal(refreshPortraitExport(join(soulDir, '没有这个目录', '更深'), dataDir, NIGHT), false, '灵魂目录不在就算了');
    });
});

describe('格式不稳：宽松解析、追问一次（探针 11-20：3 次里 2 次没按 JSON 回）', () => {
    test('中文弯引号当引号、末尾多余逗号都能解析', () => {
        assert.deepEqual(parsePortraitDecision('{“keep”: true,}'), { keep: true });
        assert.deepEqual(parsePortraitDecision(`{"text":"${GOOD}","why":"想改",}`), { keep: false, text: GOOD, why: '想改' });
    });

    test('第一次没按格式：把她的话接上、追问一次；还是不行就没有决定', async () => {
        const calls: number[] = [];
        const ok = await askPortrait(async messages => { calls.push(messages.length); return messages.length === 2 ? '我想想……' : '{"keep":true}'; }, [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
        assert.deepEqual(ok, { decision: { keep: true }, replies: ['我想想……', '{"keep":true}'] });
        assert.deepEqual(calls, [2, 4], '第二次带上她的话和追问');
        const once = await askPortrait(async () => '{"keep":true}', []);
        assert.equal(once.replies.length, 1, '按格式回了就不追问');
        const never = await askPortrait(async () => '不想写', []);
        assert.equal(never.decision, undefined);
    });

    test('夜里想：追问后写成也算成', async () => {
        const dataDir = tmp();
        let n = 0;
        const result = await reflectPortraitIfDue({
            dataDir, now: () => NIGHT, history: () => CHAT, persona: () => '', names: { char: '测试角色', user: '阿明' }, others: () => [], log: () => {},
            generate: async messages => (++n === 1 ? '让我想想' : (assert.equal(messages.at(-1)!.content, FORMAT_RETRY), JSON.stringify({ text: GOOD, why: 'x' }))),
        });
        assert.deepEqual(result.applied, { changed: true });
        assert.equal(n, 2);
    });

    test('爸妈那一条只认她自己的爸妈：说他「像他妈一样」不误伤', () => {
        assert.equal(portraitProblem(`${GOOD}他嫌我像他妈一样唠叨。`, guard()), undefined);
        assert.match(portraitProblem(`${GOOD}我妈也这样。`, guard())!, /爸妈/);
    });
});
