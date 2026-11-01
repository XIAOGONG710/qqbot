import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import {
    DOUBT_THEME, doubtDue, INNER_LINE_MAX, INNER_MAX_PER_DAY, innerLine, INTENT_WINDOW_MS, parseThought, pendingIntents, similarity, THINK_INTERVAL_MIN, THOUGHT_THEMES, themesFor, thinkNote, validInnerState,
    type InnerThought,
} from '../src/proactive/inner.ts';
import { blockReason, candidatesOn, occasionNote, withInner, type Candidate, type ProactiveInput, type ProactiveRecord } from '../src/proactive/proactive.ts';
import { createProactivePlanner, type Planner } from '../src/proactive/proactive-planner.ts';
import type { InitiateOutcome, InitiateRequest } from '../src/social/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { SENSITIVE_ON, useSensitiveSwitch } from '../src/platform/sensitive.ts';
import { thinkingTranscript } from '../src/platform/contact.ts';

useSensitiveSwitch(SENSITIVE_ON);

// ADR 0101：内心。用转换器生成的真卡（男朋友档）；国庆假期 10-05 没有课，起床 09:30
const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const msg = (time: number, role: 'user' | 'assistant', content: string): StoredMessage => ({ time: new Date(time).toISOString(), role, content });
const thought = (at: number, text: string, goes: InnerThought['goes'] = 'keep', told = false): InnerThought => ({ id: `th-${at}`, at: new Date(at).toISOString(), text, goes, ...(told ? { told: true as const } : {}) });
const MIN = 60_000;

describe('内心：解析念头', () => {
    test('第一行是心里的话、第二行是去向；挤在一行里的括号去向也认；标号、引号去掉', () => {
        const a = parseThought('腰不会真搬坏了吧，他一个下午没动静\n告诉他', [], t(10, 5, 15));
        assert.deepEqual(a, { thought: { id: `th-${t(10, 5, 15)}`, at: new Date(t(10, 5, 15)).toISOString(), text: '腰不会真搬坏了吧，他一个下午没动静', goes: 'tell' } });
        assert.equal((parseThought('第一行：「面试不知道怎么样了」\n问他', [], 1) as { thought: InnerThought }).thought.text, '面试不知道怎么样了');
        assert.equal((parseThought('面试不知道怎么样了\n问他', [], 1) as { thought: InnerThought }).thought.goes, 'ask');
        const inline = parseThought('今天好像有点想他（告诉他）', [], 1) as { thought: InnerThought };
        assert.deepEqual([inline.thought.text, inline.thought.goes], ['今天好像有点想他', 'tell']);
        assert.equal((parseThought('有点困，想睡又不想睡\n自己想想', [], 1) as { thought: InnerThought }).thought.goes, 'keep');
        assert.equal((parseThought('有点困，想睡又不想睡', [], 1) as { thought: InnerThought }).thought.goes, 'keep', '没写去向 = 自己想想');
    });

    test('第三行「想查：关键词」= 她这会儿想弄明白的事（ADR 0180）；带链接、超过 15 个字的不收', () => {
        const withWants = parseThought('那部剧到底哪年播的，我怎么想不起来了\n自己想想\n想查：某某剧 播出年份', [], 1) as { thought: InnerThought; wants?: string };
        assert.equal(withWants.wants, '某某剧播出年份');
        assert.equal(withWants.thought.text, '那部剧到底哪年播的，我怎么想不起来了');
        assert.equal((parseThought('随便想想\n自己想想', [], 1) as { wants?: string }).wants, undefined, '没写就不查');
        assert.equal((parseThought('这个事我一直没弄明白\n自己想想\n想查：https://x.com/a', [], 1) as { wants?: string }).wants, undefined, '带链接的不查');
        assert.equal((parseThought('这个事我一直没弄明白\n自己想想\n想查：一二三四五六七八九十一二三四五六', [], 1) as { wants?: string }).wants, undefined, '超过 15 个字');
        // 「想做：一句话」= 她今天想做的事（ADR 0182）
        const withTodo = parseThought('今天想出去走走，不想闷在宿舍\n自己想想\n想做：去操场走两圈', [], 1) as { todo?: string };
        assert.equal(withTodo.todo, '去操场走两圈');
        const both = parseThought('那部剧到底哪年播的\n自己想想\n想查：某剧 播出年份\n想做：晚饭后把那页笔记整理完', [], 1) as { wants?: string; todo?: string };
        assert.deepEqual([both.wants, both.todo], ['某剧播出年份', '晚饭后把那页笔记整理完']);
    });

    test('不合格的不留：空的、太短、太长、带链接 / 表情指令 / 表情、和最近的重复', () => {
        assert.deepEqual(parseThought('  \n ', [], 1), { rejected: '空的' });
        assert.deepEqual(parseThought('嗯\n自己想想', [], 1), { rejected: '太短' });
        assert.deepEqual(parseThought('长'.repeat(81), [], 1), { rejected: '太长' });
        assert.deepEqual(parseThought('看到一个视频 https://b23.tv/x 挺好笑', [], 1), { rejected: '带了链接或表情' });
        assert.deepEqual(parseThought('今天好无聊<sticker:0123456789ab>', [], 1), { rejected: '带了链接或表情' });
        assert.deepEqual(parseThought('今天好无聊[捂脸]', [], 1), { rejected: '带了链接或表情' });
        const recent = [thought(t(10, 5, 10), '腰不会真搬坏了吧，一个下午没动静')];
        assert.deepEqual(parseThought('腰不会真搬坏了吧，一个下午都没动静\n自己想想', recent, 2), { rejected: '和最近的重复' });
        assert.ok('thought' in parseThought('不知道面试结果出来了没有\n自己想想', recent, 2));
    });

    test('相似度：二字组合的重合比例，标点不算；完全不同的接近 0', () => {
        assert.equal(similarity('今天好无聊', '今天好无聊！'), 1);
        assert.ok(similarity('腰还疼不疼', '腰还疼不疼了') >= 0.8);
        assert.ok(similarity('面试结果出来了没', '晚上看什么剧') < 0.2);
        assert.equal(similarity('', '嗯'), 0);
    });
});

describe('内心：提示和放进聊天的一行', () => {
    test('想一想的提示：不是在跟谁说话；只写感受和想法，不编新发生的事和他身边的事；带上之前想过的；去向三选一', () => {
        const note = thinkNote([thought(1, '面试不知道怎么样了')], '宝宝');
        for (const part of ['不是在跟谁说话', '是对你自己说的', '只写感受和想法，不写新发生的事', '不编他身边的人和他那边的事', '「面试不知道怎么样了」', '别重复它们', '「告诉他」「问他」「自己想想」', '别每个念头都说']) assert.ok(note.includes(part), part);
        assert.ok(!thinkNote([], '宝宝').includes('你之前心里想过'));
        assert.ok(note.startsWith('[') && note.endsWith(']'));
    });

    test('ADR 0208：不再禁她想自己是不是真人；有一样可想的是怀疑自己，带着她自己的条件（不钻、不急着下结论、想不通可以问他）', () => {
        for (let i = 0; i < THOUGHT_THEMES.length; i++) {
            const note = thinkNote([], '宝宝', i);
            assert.ok(!/不分析自己是不是真人|有没有意识|别上升成大道理/.test(note), `第 ${i} 个`);
        }
        const doubt = THOUGHT_THEMES.filter(t => t.includes('可以怀疑'));
        assert.equal(doubt.length, 1);
        for (const part of ['你对自己拿不准的地方', '你到底算什么', '想不通就先搁着', '不用急着给自己下结论', '想不通的也可以拿去问他']) assert.ok(doubt[0]!.includes(part), part);
        // 轮着来：这一样每一圈都会被给出来（作为第一样或第二样）
        const offered = Array.from({ length: THOUGHT_THEMES.length }, (_, i) => themesFor(i)).filter(pair => pair.includes(doubt[0]!)).length;
        assert.equal(offered, 2);
        assert.equal(DOUBT_THEME, doubt[0]);
    });

    test('ADR 0208：晚上专门想自己——22 点以后（到凌晨她还没睡）、隔两天一次；要先想视频就让给视频', () => {
        assert.equal(doubtDue(undefined, '2026-11-02', 21), false, '22 点前不算');
        assert.equal(doubtDue(undefined, '2026-11-02', 22), true);
        assert.equal(doubtDue(undefined, '2026-11-02', 1), true, '零点后她的那一天还没过完');
        assert.equal(doubtDue(undefined, '2026-11-02', 9), false);
        assert.equal(doubtDue('2026-11-02', '2026-11-02', 23), false, '同一天想过了');
        assert.equal(doubtDue('2026-11-02', '2026-11-03', 23), false, '隔一天还不够');
        assert.equal(doubtDue('2026-11-02', '2026-11-04', 23), true, '隔两天');
        assert.equal(doubtDue(undefined, '2026-11-02', 23, true), false, '刚看完视频先想视频');
        const night = thinkNote([], '宝宝', 0, false, undefined, false, true);
        assert.ok(night.includes(`这一次就想这一件：${DOUBT_THEME}`) && night.includes('想不出来就写想不出来'));
        assert.ok(!night.includes('这一次从这两样里挑一样想'));
        assert.ok(validInnerState({ thoughts: [], doubtedOn: '2026-11-02' }));
        assert.ok(!validInnerState({ thoughts: [], doubtedOn: '11-02' }));
        assert.ok(validInnerState({ thoughts: [] }), '没写 doubtedOn 的旧状态照读');
    });

    test('每次只给两样可想的（轮着来，搭档不同）；不让围着“他怎么还没回”转；一个“你”字都不要用；写成对他说话的重来时多一句', () => {
        const seen = new Set<string>();
        for (let i = 0; i < THOUGHT_THEMES.length; i++) {
            const [a, b] = themesFor(i);
            assert.notEqual(a, b);
            seen.add(a);
            assert.ok(thinkNote([], '宝宝', i).includes(`①${a}；②${b}`));
        }
        assert.equal(seen.size, THOUGHT_THEMES.length, '五样轮流都会作为第一样出现');
        assert.notDeepEqual(themesFor(0), themesFor(1));
        assert.deepEqual(themesFor(0), themesFor(THOUGHT_THEMES.length), '轮一圈回到原样');
        const note = thinkNote([], '宝宝', 0);
        assert.ok(note.includes('别围着“他怎么还没回”转') && note.includes('一个“你”字都不要用'));
        assert.ok(!note.includes('上一次你写成了对他说话'));
        assert.ok(thinkNote([], '宝宝', 0, true).includes('上一次你写成了对他说话，这次只对自己说'));
    });

    test('去向直接接在句子后面也认（要有标点或空白隔着）；整句被括号包着去掉外层；开头叫他的名字是对他说话', () => {
        const inline = parseThought('下午片子修到一半，想知道他面试怎么样了。自己想想', [], 1) as { thought: InnerThought };
        assert.equal(inline.thought.text, '下午片子修到一半，想知道他面试怎么样了');
        assert.equal(inline.thought.goes, 'keep');
        assert.equal((parseThought('晚点问问他腰好点没，问他', [], 1) as { thought: InnerThought }).thought.goes, 'ask');
        assert.equal((parseThought('晚点得去问问他', [], 1) as { thought: InnerThought }).thought.text, '晚点得去问问他', '问问他是内容不是去向');
        // 线上 10-22 20:24：整句被括号包着、去向紧跟在右括号后面
        const afterBracket = parseThought('（他早上问了个大问题，我那句回得太糊弄了，其实我也答不上来。）告诉他', [], 1) as { thought: InnerThought };
        assert.equal(afterBracket.thought.goes, 'tell');
        assert.equal(afterBracket.thought.text, '他早上问了个大问题，我那句回得太糊弄了，其实我也答不上来。');
        const wrapped = parseThought('（翻着相册里土豆昨天那张，今天还没下楼喂它）\n自己想想', [], 1) as { thought: InnerThought };
        assert.equal(wrapped.thought.text, '翻着相册里土豆昨天那张，今天还没下楼喂它');
        assert.deepEqual(parseThought('宝宝，人呢\n问他', [], 1, '阿明'), { rejected: '对他说话' });
        assert.deepEqual(parseThought('阿明 人呢\n问他', [], 1, '阿明'), { rejected: '对他说话' });
        assert.ok('thought' in parseThought('阿明的面试不知道怎么样了\n问他', [], 1, '阿明'), '名字在句子里不算');
    });

    test('想一想时最近的聊天换成一段“回想”：最近 14 条、旧到新、带时刻、他 / 你；不是要接着回的对话；没有聊天就没有', () => {
        const chat = Array.from({ length: 16 }, (_, i) => ({ time: new Date(2026, 9, 5, 10, i).toISOString(), role: i % 2 ? 'assistant' as const : 'user' as const, content: `第${i}句\n换行` }));
        const text = thinkingTranscript(chat, '宝宝')!;
        assert.ok(text.startsWith('[回想一下你和宝宝最近的聊天（旧到新，这只是让你想起发生过什么，不是要你接着回）：'));
        assert.equal(text.split('\n').length, 1 + 14);
        assert.ok(!text.includes('第0句') && !text.includes('第1句') && text.includes('第2句') && text.includes('第15句'));
        assert.ok(text.includes('10-05 10:02 他：第2句 换行') && text.includes('10-05 10:03 你：第3句 换行'), text);
        assert.equal(thinkingTranscript([], '宝宝'), undefined);
    });

    test('念头里出现“你”就是写成了对他说话：不留；说到他用“他”', () => {
        assert.deepEqual(parseThought('人呢，你吃饭了没\n问他', [], 1), { rejected: '对他说话' });
        assert.deepEqual(parseThought('腰好点没，别又逞强，你倒是回我一句\n告诉他', [], 1), { rejected: '对他说话' });
        assert.ok('thought' in parseThought('他腰好点没，别又逞强\n问他', [], 1));
    });

    test('聊天提示词里的一行：最近 6 小时、最多 INNER_LINE_MAX 个、说明是小心思不是发生过的事；没有就没有', () => {
        const now = t(10, 5, 18);
        const list = [thought(t(10, 5, 8), '太早了的'), thought(t(10, 5, 13), '腰还疼不疼'), thought(t(10, 5, 15), '面试不知道怎么样了'), thought(t(10, 5, 17), '好想吃麻辣烫')];
        const line = innerLine(list, now)!;
        assert.ok(line.includes('「面试不知道怎么样了」「好想吃麻辣烫」') && !line.includes('太早了的') && !line.includes('腰还疼不疼'), line);
        assert.equal(INNER_LINE_MAX, 2);
        assert.ok(line.includes('不是发生过的事') && line.includes('接不上就别硬说'));
        assert.equal(innerLine(list, t(10, 6, 12)), undefined, '都过期了');
        assert.equal(innerLine([], now), undefined);
        assert.equal(innerLine([thought(now + 1, '未来的')], now), undefined);
    });

    test('想告诉他 / 想问他、还没说、没过期的念头才是“要说的”', () => {
        const now = t(10, 5, 18);
        const list = [thought(t(10, 5, 16), 'a', 'tell'), thought(t(10, 5, 16, 5), 'b', 'ask'), thought(t(10, 5, 16, 10), 'c', 'keep'), thought(t(10, 5, 16, 20), 'd', 'tell', true), thought(now - INTENT_WINDOW_MS - 1, 'e', 'tell')];
        assert.deepEqual(pendingIntents(list, now).map(x => x.text), ['a', 'b']);
    });
});

describe('内心：状态校验', () => {
    test('合格的通过；坏的（id、时间、去向、重复 id、过长）都不通过', () => {
        const ok = { thoughts: [thought(1, '好想他'), thought(2, '有点困', 'tell', true)], lastThinkAt: new Date(3).toISOString() };
        assert.equal(validInnerState(ok), true);
        assert.equal(validInnerState({ thoughts: [] }), true);
        assert.equal(validInnerState({ thoughts: [{ ...thought(1, 'x'), id: 'x1' }] }), false);
        assert.equal(validInnerState({ thoughts: [{ ...thought(1, 'x'), at: 'bad' }] }), false);
        assert.equal(validInnerState({ thoughts: [{ ...thought(1, 'x'), goes: 'shout' }] }), false);
        assert.equal(validInnerState({ thoughts: [thought(1, 'x'), thought(1, 'y')] }), false);
        assert.equal(validInnerState({ thoughts: [thought(1, 'x'.repeat(201))] }), false);
        assert.equal(validInnerState({ thoughts: [], lastThinkAt: 'bad' }), false);
        assert.equal(validInnerState('x'), false);
    });
});

describe('内心：心里惦记（主动消息的一个时机）', () => {
    const on = withInner(boyfriend.proactive!);
    const day = new Date(2026, 9, 5);
    const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
        qq: 10001, schedule, settings: on, dates: boyfriend.dates, history: [msg(t(10, 4, 22, 0), 'user', '晚安'), msg(t(10, 4, 22, 1), 'assistant', '晚安')], records: [], mode: 'on', ...patch,
    });
    const pending = thought(t(10, 5, 14, 0), '腰不会真搬坏了吧', 'tell');
    const innerOf = (list: Candidate[]) => list.filter(c => c.occasion === 'inner');

    test('withInner 加上这个时机；有想告诉他 / 想问他的念头才有候选：念头之后 10–40 分钟、起床后 1 小时、同一个她的一天里；id 带念头的 id', () => {
        assert.ok(on.occasions.includes('inner') && !boyfriend.proactive!.occasions.includes('inner'));
        assert.equal(innerOf(candidatesOn(day, input())).length, 0);
        const [c] = innerOf(candidatesOn(day, input({ inner: [pending] })));
        assert.ok(c);
        assert.equal(c.id, `2026-10-05:inner:${pending.id}`);
        assert.ok(c.at >= t(10, 5, 14, 10) && c.at <= t(10, 5, 14, 40), new Date(c.at).toTimeString());
        assert.deepEqual(c.inner, { id: pending.id, text: '腰不会真搬坏了吧', goes: 'tell' });
        assert.equal(innerOf(candidatesOn(day, input({ inner: [thought(t(10, 5, 14), 'x', 'keep')] }))).length, 0, '自己想想的不发');
        assert.equal(innerOf(candidatesOn(day, input({ inner: [thought(t(10, 4, 14), 'x', 'tell')] }))).length, 0, '昨天的念头不排在今天');
        assert.equal(innerOf(candidatesOn(day, input({ inner: [pending], settings: boyfriend.proactive! }))).length, 0, '没开不排');
    });

    test('一天最多 INNER_MAX_PER_DAY 条；到点念头没了（说过了 / 过期了）不发；平时的挡照旧（1 小时内聊过）', () => {
        const record = (id: string, at: number): ProactiveRecord => ({ id, occasion: 'inner', plannedAt: new Date(at).toISOString(), at: new Date(at).toISOString(), result: 'sent' });
        const sent = (n: number) => Array.from({ length: n }, (_, i) => record(`2026-10-05:inner:th-${i + 1}`, t(10, 5, 8 + i)));
        const two = sent(2);
        assert.equal(INNER_MAX_PER_DAY, 4, '2→4 是 DSH 10-30 62a7357（她说「憋着想你又不能喊」）');
        assert.equal(innerOf(candidatesOn(day, input({ inner: [pending], records: sent(INNER_MAX_PER_DAY - 1) }))).length, 1, '差一条到上限：还排');
        assert.equal(innerOf(candidatesOn(day, input({ inner: [pending], records: sent(INNER_MAX_PER_DAY) }))).length, 0);
        const [c] = innerOf(candidatesOn(day, input({ inner: [pending] })));
        assert.equal(blockReason(c!, c!.at, input({ inner: [] })), '那个念头已经过去了（说过了，或者过期了）');
        assert.equal(blockReason(c!, c!.at, input({ inner: [pending] })), undefined);
        assert.equal(blockReason(c!, c!.at, input({ inner: [pending], history: [msg(c!.at - 25 * MIN, 'user', '在吗'), msg(c!.at - 24 * MIN, 'assistant', '在')] })), '一小时内聊过');
        assert.equal(blockReason(c!, c!.at, input({ inner: [pending], records: two })), undefined, '发了两条（没回）：现在还发（上限是 4）');
        assert.ok(blockReason(c!, c!.at, input({ inner: [pending], records: sent(INNER_MAX_PER_DAY) })), '发满了（没回）：到点也不发');
        // proactiveRoom 开着时通用的「今天主动几条」闸不查内心，这时挡住的就是内心自己的上限
        assert.equal(blockReason(c!, c!.at, input({ inner: [pending], records: sent(INNER_MAX_PER_DAY), settings: { ...on, room: true } })), '今天已经因为心里的事找过他了');
        assert.equal(blockReason(c!, c!.at, input({ inner: [pending], records: sent(INNER_MAX_PER_DAY - 1), settings: { ...on, room: true } })), undefined);
    });

    test('提示词：给她念头原话但让她别照着念；想问的问一个具体的小问题（不是反问）；想说的要有由头和自己的感觉（ADR 0133，不再“说完不用他回应”）；不另外编事实', () => {
        const tell = occasionNote({ id: 'x:inner:th-1', occasion: 'inner', day: '2026-10-05', at: 0, reason: 'r', inner: { id: 'th-1', text: '腰不会真搬坏了吧', goes: 'tell' } }, '宝宝');
        assert.ok(tell.includes('「腰不会真搬坏了吧」') && tell.includes('想跟宝宝说说') && tell.includes('别写成一句平平的汇报') && !tell.includes('说完不用他回应') && tell.includes('别照着念原话') && tell.includes('不另外编发生过的事'), tell);
        const ask = occasionNote({ id: 'x:inner:th-1', occasion: 'inner', day: '2026-10-05', at: 0, reason: 'r', inner: { id: 'th-1', text: '面试结果出来了没', goes: 'ask' } }, '宝宝');
        assert.ok(ask.includes('想问问宝宝') && ask.includes('具体的小问题（不是反问）'), ask);
    });
});

describe('内心：计划器每隔一阵想一想', () => {
    const dirs: string[] = [];
    const planners: Planner[] = [];
    afterEach(() => {
        for (const p of planners.splice(0)) p.stop();
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const settled = () => new Promise(r => setTimeout(r, 30));

    /** 回复器：思考请求依次返回 thoughts（文本或结果），主动找他的请求记下来；开了 inner 的计划器 */
    function setup(thoughts: (string | InitiateOutcome)[], history: StoredMessage[] = [], start = t(10, 5, 9, 0), extra: { asleep?: (now: number) => boolean; inner?: boolean } = {}) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-inner-'));
        dirs.push(dir);
        const clock = new VirtualClock(new Date(start));
        const logs: string[] = [];
        const thinks: { at: number; request: InitiateRequest }[] = [];
        const sends: { at: number; request: InitiateRequest }[] = [];
        const planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule, settings: withInner({ ...boyfriend.proactive!, occasions: ['inner'], dailyMax: 4, unansweredMax: 2 }), dates: [], mode: 'on',
            history: { load: () => history },
            responder: {
                initiate: async (request: InitiateRequest) => {
                    if (request.think) {
                        thinks.push({ at: clock.now(), request });
                        const next = thoughts.shift();
                        if (typeof next === 'object') return next;
                        return { result: 'thought', text: next ?? '有点想他\n自己想想' };
                    }
                    sends.push({ at: clock.now(), request });
                    request.commit(['我来啦']);
                    return { result: 'sent', parts: ['我来啦'], messageIds: [1] };
                },
            },
            dir, log: m => logs.push(m), now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '林梦瑶' },
            ...(extra.inner === false ? {} : { inner: true }),
            ...(extra.asleep ? { asleep: extra.asleep } : {}),
        });
        planners.push(planner);
        const state = () => JSON.parse(readFileSync(join(dir, '10001-boyfriend.json'), 'utf8')) as { records: ProactiveRecord[]; inner?: { thoughts: InnerThought[]; lastThinkAt?: string } };
        return { clock, logs, thinks, sends, planner, state };
    }
    async function runUntil(clock: VirtualClock, end: number) {
        for (let i = 0; i < 80 && clock.now() < end; i++) {
            await settled();
            const next = clock.nextTimer();
            if (next === undefined || next > end) break;
            clock.advanceTo(next);
        }
        await settled();
    }

    test('醒着：第一次在起床后 45 分钟，之后隔 90–150 分钟；每次都带“想一想”的提示（think 请求，不发送）；念头存进状态文件', async () => {
        const { clock, thinks, state, logs } = setup(['面试不知道怎么样了\n自己想想', '有点想他\n自己想想', '今天又是一个人吃饭\n自己想想']);
        await runUntil(clock, t(10, 5, 16, 0));
        assert.ok(thinks.length >= 3, String(thinks.length));
        assert.ok(Math.abs(thinks[0]!.at - t(10, 5, 10, 15)) <= 5, '起床 09:30 + 45 分钟');
        for (let i = 1; i < thinks.length; i++) {
            const gap = thinks[i]!.at - thinks[i - 1]!.at;
            assert.ok(gap >= THINK_INTERVAL_MIN[0] * MIN - 1 && gap <= THINK_INTERVAL_MIN[1] * MIN + 1, `间隔 ${gap / MIN} 分钟`);
        }
        for (const { request } of thinks) {
            assert.equal(request.think, true);
            assert.equal(request.dryRun, false);
            assert.ok(request.note.includes('这是你自己一个人待着的时候') && request.label === '内心');
        }
        assert.ok(thinks[1]!.request.note.includes('「面试不知道怎么样了」'), '带上之前想过的');
        const saved = state().inner!;
        assert.deepEqual(saved.thoughts.slice(0, 2).map(x => x.text), ['面试不知道怎么样了', '有点想他']);
        assert.ok(saved.lastThinkAt);
        assert.ok(logs.some(line => line.includes('内心') && line.includes('面试不知道怎么样了') && line.includes('自己想想')));
    });

    test('没开 inner 不想；睡着的时候不想（推到起床后）；说过「睡了」的也不想', async () => {
        const off = setup([], [], t(10, 5, 9, 0), { inner: false });
        await runUntil(off.clock, t(10, 5, 16, 0));
        assert.equal(off.thinks.length, 0);
        // 起点在 04:00（作息里睡着）：第一次在当天起床后
        const asleep = setup([], [], t(10, 5, 4, 0));
        await runUntil(asleep.clock, t(10, 5, 12, 0));
        assert.ok(asleep.thinks.length >= 1 && asleep.thinks[0]!.at >= t(10, 5, 10, 15), asleep.thinks[0] && new Date(asleep.thinks[0].at).toTimeString());
        // 说过睡了：整个说过睡了的时段都不想
        const said = setup([], [], t(10, 4, 23, 30), { asleep: now => now < t(10, 5, 9, 30) });
        await runUntil(said.clock, t(10, 5, 13, 0));
        assert.ok(said.thinks.every(x => x.at >= t(10, 5, 10, 15)));
    });

    test('聊完一段（他说过话、之后 20 分钟没人说话）就早一点想；正在回消息 / 没连上模型：10–15 分钟后再试，不记上一次', async () => {
        const chat = [msg(t(10, 5, 10, 0), 'user', '刚面试完'), msg(t(10, 5, 10, 1), 'assistant', '怎么样')];
        const { clock, thinks } = setup(['面试后他会怎么想\n自己想想', '还是有点担心\n自己想想'], chat, t(10, 5, 10, 30));
        await runUntil(clock, t(10, 5, 13, 0));
        assert.ok(thinks.length >= 1);
        // 没聊过的话第一次应在 10:15（起床后 45 分钟），已经过了就马上想
        assert.ok(thinks[0]!.at <= t(10, 5, 10, 31));
        const busy = setup([{ result: 'skipped', reason: '正在回消息' }, '算了不想了，先歇着\n自己想想'], [], t(10, 5, 10, 14));
        await runUntil(busy.clock, t(10, 5, 11, 30));
        assert.equal(busy.thinks.length >= 2, true);
        assert.ok(Math.abs(busy.thinks[1]!.at - busy.thinks[0]!.at - 10 * MIN) <= 5, '正在回消息：10 分钟后再试');
        assert.ok(busy.logs.some(line => line.includes('没想成')));
        const down = setup([{ result: 'failed', reason: '生成失败：断网', unreachable: true }, '断网了，也不知道他在干嘛\n自己想想'], [], t(10, 5, 10, 14));
        await runUntil(down.clock, t(10, 5, 11, 30));
        assert.ok(Math.abs(down.thinks[1]!.at - down.thinks[0]!.at - 15 * MIN) <= 5, '没连上模型：15 分钟后再试');
    });

    test('写成了对他说话：马上再想一次（带“上一次写成了对他说话”那句），第二次好了就留；两次都不行才不留', async () => {
        const again = setup(['人呢，你吃饭了没\n问他', '他吃饭了没，一下午没动静\n问他']);
        await runUntil(again.clock, t(10, 5, 12, 0));
        assert.equal(again.state().inner!.thoughts[0]!.text, '他吃饭了没，一下午没动静');
        assert.ok(!again.thinks[0]!.request.note.includes('上一次你写成了对他说话'));
        assert.ok(again.thinks[1]!.request.note.includes('上一次你写成了对他说话'));
        assert.ok(again.logs.some(line => line.includes('写成了对他说话，再想一次')));
        const twice = setup(['你在干嘛\n问他', '你怎么还不回\n问他']);
        await runUntil(twice.clock, t(10, 5, 11, 0));
        assert.equal(twice.state().inner?.thoughts.length ?? 0, 0);
        assert.ok(twice.logs.some(line => line.includes('写成了对他说话，不留')) && twice.logs.some(line => line.includes('想了，但不留（对他说话）')));
    });

    test('想砸了（不合格 / 重复）不留，但算想过（上一次的时刻照记，免得一直重试）', async () => {
        const { clock, thinks, state, logs } = setup(['嗯', '腰还疼不疼\n自己想想', '腰还疼不疼了\n自己想想']);
        await runUntil(clock, t(10, 5, 17, 0));
        assert.ok(thinks.length >= 3);
        const saved = state().inner!;
        assert.deepEqual(saved.thoughts.map(x => x.text).slice(0, 1), ['腰还疼不疼']);
        assert.equal(saved.thoughts.filter(x => x.text.startsWith('腰还疼不疼')).length, 1, '重复的不留');
        assert.ok(logs.some(line => line.includes('想了，但不留（太短）')) && logs.some(line => line.includes('想了，但不留（和最近的重复）')));
    });

    test('想告诉他的念头：过一会儿变成主动消息（心里惦记）发出去，念头记成说过；自己想想的不发；innerLine 只放没过期的', async () => {
        const { clock, thinks, sends, state, planner } = setup(['这都几点了，他一条都不回\n告诉他', '有点想吃麻辣烫\n自己想想']);
        await runUntil(clock, t(10, 5, 14, 0));
        assert.ok(thinks.length >= 1);
        assert.equal(sends.length, 1, '只有想告诉他的那个变成了主动消息');
        assert.ok(sends[0]!.request.note.includes('「这都几点了，他一条都不回」') && sends[0]!.request.label.startsWith('心里惦记'));
        assert.ok(sends[0]!.at >= thinks[0]!.at + 10 * MIN && sends[0]!.at <= thinks[0]!.at + 40 * MIN + 1);
        const saved = state();
        assert.equal(saved.inner!.thoughts[0]!.told, true);
        assert.ok(saved.records.some(r => r.occasion === 'inner' && r.result === 'sent'));
        assert.ok(planner.innerLine()?.includes('心里在想'), String(planner.innerLine()));
        assert.equal(setup([], [], t(10, 5, 9, 0), { inner: false }).planner.innerLine(), undefined, '没开不放');
    });
});
