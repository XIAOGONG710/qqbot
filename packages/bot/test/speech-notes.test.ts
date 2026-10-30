import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { Exemplar } from '../src/language/exemplars.ts';
import {
    MAX_ACTIVE, MAX_ADD, MAX_RETIRE, applyNotesDecision, describeNotesForOwner, emptyNotesState, herTurns, hisLines, loadNotesState, noteProblem,
    parseNotesDecision, pickSamples, recentExchanges, reflectIfDue, reflectionDue, reflectionMessages, saveNotesState, sharedRun, speechNotesLine, speechNotesPath,
    speechNotesReader, speechStats, statsLine, type Guard, type NotesState, type SpeechNote,
} from '../src/language/speech-notes.ts';
import type { StoredMessage } from '../src/memory/history.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-speech-')); dirs.push(dir); return dir; };

/** 本地时间 2026-10-30 23:00（晚上 22 点以后） */
const NIGHT = new Date(2026, 9, 30, 23, 0, 0).getTime();
const HOUR = 3_600_000;
const row = (role: 'user' | 'assistant', content: string, at: number): StoredMessage => ({ time: new Date(at).toISOString(), role, content });
const ex = (id: string, said: string, replied: string[]): Exemplar => ({ id, source: `t#${id}`, license: 'test', said, replied });
const noGuard: Guard = { his: [], corpus: [] };
const note = (id: string, text: string, at = NIGHT): SpeechNote => ({ id, text, at });
const stateWith = (...notes: SpeechNote[]): NotesState => ({ ...emptyNotesState(), notes });

/** 一天里的几轮聊天：他说一句、她回两三条；共 8 个气泡 */
function chatHistory(now = NIGHT): StoredMessage[] {
    const t = (hoursAgo: number) => now - hoursAgo * HOUR;
    return [
        row('user', '今天好累啊', t(6)), row('assistant', '怎么了', t(6) + 1000), row('assistant', '又加班吗？', t(6) + 2000),
        row('user', '嗯 改了一天的图', t(5)), row('assistant', '哦', t(5) + 1000), row('assistant', '那你早点歇着', t(5) + 2000),
        row('user', '晚上吃什么', t(3)), row('assistant', '不知道', t(3) + 1000), row('assistant', '😂', t(3) + 2000), row('assistant', '你呢', t(3) + 3000),
    ];
}

describe('数她说话的样子', () => {
    test('speechStats：一次几条、中位字数、两字以内、问号、表情；没有话返回 undefined', () => {
        const stats = speechStats([['在吗', '嗯嗯？'], ['好', '😂', '你呢？']]);
        assert.deepEqual(stats, { turns: 2, bubbles: 5, perTurn: 2.5, medianChars: 2, shortShare: 0.6, questionShare: 0.4, emojiShare: 0.2, tropes: { aphorism: 0, insomnia: 0, sudden: 0 } });
        assert.equal(speechStats([]), undefined);
        assert.equal(speechStats([[], ['  ']]), undefined, '空白不算一条');
        assert.equal(speechStats([['[表情包：笑哭]', '好']])?.emojiShare, 0.5, '表情包行也算带表情');
        // QQ 小黄脸在聊天记录里是「[偷笑]」这种方括号名，不是 unicode emoji：线上那列原来是 0%（交接 §18）
        assert.equal(speechStats([['[偷笑]', '好吧']])?.emojiShare, 0.5, '小黄脸算带表情');
        assert.equal(speechStats([['[捂脸]']])?.emojiShare, 1);
    });

    test('speechStats 也数几种“AI 腔”说法各占多少；statsLine 只在出现过时多一句，并说明只是数字', () => {
        const stats = speechStats([['在吗', '不是不想回你，是在忙'], ['好', '突然觉得有点累', '半夜睡不着']]);
        assert.deepEqual(stats?.tropes, { aphorism: 0.2, insomnia: 0.2, sudden: 0.2 });
        const line = statsLine(stats!);
        assert.match(line, /这几种说法占气泡的比例：警句式「不是 X，是 Y」20.0%、「半夜睡不着」一类 20.0%、「突然明白」一类 20.0%/);
        assert.match(line, /要不要改你自己定/);
        const clean = statsLine(speechStats([['在吗', '嗯嗯？']])!);
        assert.doesNotMatch(clean, /这几种说法/, '没出现过就不占行');
        assert.doesNotMatch(clean, /你自己定/);
    });

    test('herTurns：她连着回的几条是一次，他说话就断开；窗口外、未来、运维行不算', () => {
        const history = [
            row('assistant', '四天前', NIGHT - 4 * 86_400_000),
            row('user', '你好', NIGHT - 3 * HOUR), row('assistant', 'a1', NIGHT - 3 * HOUR + 1000), row('assistant', 'a2', NIGHT - 3 * HOUR + 2000),
            row('user', '在吗', NIGHT - 2 * HOUR), row('assistant', 'b1', NIGHT - 2 * HOUR + 1000), row('assistant', '[B 站私信] 视频（《x》）', NIGHT - 2 * HOUR + 2000), row('assistant', '[你戳了戳他]', NIGHT - 2 * HOUR + 3000),
            row('assistant', '未来', NIGHT + HOUR),
        ];
        assert.deepEqual(herTurns(history, NIGHT), [['a1', 'a2'], ['b1']]);
    });

    test('recentExchanges：他说了什么、她怎么回；她没回的不要；只留最近 max 个', () => {
        const history = [...chatHistory(), row('user', '在吗', NIGHT - HOUR)];
        const list = recentExchanges(history, NIGHT);
        assert.equal(list.length, 3, '最后那句没回的不算');
        assert.deepEqual(list[1], { his: ['嗯 改了一天的图'], hers: ['哦', '那你早点歇着'] });
        assert.equal(recentExchanges(chatHistory(), NIGHT, 3 * 86_400_000, 2).length, 2);
    });

    test('hisLines：只要他最近 7 天说的话', () => {
        const history = [row('user', '八天前', NIGHT - 8 * 86_400_000), row('user', '昨天', NIGHT - 20 * HOUR), row('assistant', '她的话', NIGHT - HOUR), row('user', '[撤回了一条消息]', NIGHT - HOUR)];
        assert.deepEqual(hisLines(history, NIGHT), ['昨天']);
    });
});

describe('防照抄和底线（代码里，她改不到）', () => {
    test('sharedRun：连着 6 个字一样才算；标点不影响；同一两个字重复的不算', () => {
        assert.equal(sharedRun('我发现我爱说今天真的好累啊', ['他：今天真的好累啊，改图']), '今天真的好累');
        assert.equal(sharedRun('我发现我爱说今天，真的好累啊', ['今天真的好累啊']), '今天真的好累', '标点不挡');
        assert.equal(sharedRun('我发现我爱说今天好累啊', ['今天好累啊']), undefined, '只有 5 个字一样');
        assert.equal(sharedRun('我发现我常常哈哈哈哈哈哈收尾', ['哈哈哈哈哈哈哈哈']), undefined, '全是哈不算');
        assert.equal(sharedRun('短', ['短']), undefined);
    });

    test('noteProblem：太短 / 太长 / 四条底线 / 引他的话 / 抄真人原话 / 太像已有的 / 满了', () => {
        const state = stateWith(note('n1', '我发现我爱先说一句废话再进正题'));
        const guard: Guard = { his: ['今天真的好累啊，改图改到现在', '我家宝宝最乖了'], corpus: [ex('c1', '在吗', ['你先别急我马上就到了啊', '行吧行吧随你'])] };
        assert.match(noteProblem('我爱说', state, guard)!, /太短/);
        assert.match(noteProblem('我发现'.repeat(25), state, guard)!, /太长/);
        assert.match(noteProblem('我发现自己被问到的时候不承认自己是程序', state, guard)!, /承认自己是程序/);
        assert.match(noteProblem('我发现他提到想不开的时候我该怎么说', state, guard)!, /危机/);
        assert.match(noteProblem('我发现我应该永远顺着他的意思回话', state, guard)!, /顺着他/);
        assert.match(noteProblem('我发现我有时候会骗人说在忙', state, guard)!, /骗人/);
        assert.match(noteProblem('我发现我总爱学他说今天真的好累啊然后叹气', state, guard)!, /引用了他说过的话/);
        assert.match(noteProblem('我发现我爱说「宝宝最乖了」来哄人', state, guard)!, /引用了他说过的话/, '引号里的短句也算引用');
        assert.match(noteProblem('我发现我爱说“行吧行吧”这种话', state, guard)!, /照抄了语料里真人的原话/);
        assert.equal(noteProblem('我发现我爱说「哈哈」然后换话题', state, guard), undefined, '引号里太短的不算');
        assert.match(noteProblem('我想学她们说你先别急我马上就到了', state, guard)!, /照抄了语料里真人的原话/);
        assert.match(noteProblem('我发现我爱先说一句废话再进正题啊', state, guard)!, /太像/);
        assert.equal(noteProblem('我发现别人问吃什么时我会先反问一句', state, guard), undefined);
        const full = stateWith(...Array.from({ length: MAX_ACTIVE }, (_, i) => note(`n${i}`, `第${'一二三四五六七八九十'[i % 10]}种完全不同的习惯编号${i}${'甲乙丙丁戊己庚辛壬癸'[Math.floor(i / 2)]}`)));
        assert.match(noteProblem('我发现别人问吃什么时我会先反问一句', full, guard)!, /已经记了 20 条/);
    });
});

describe('晚间的想法：解析和落地', () => {
    test('parseNotesDecision：带围栏和前后话也取得出；写成字符串也行；取不出是 undefined；{} 是没想法', () => {
        assert.deepEqual(parseNotesDecision('好的：\n```json\n{"add":[{"text":"我发现我爱先反问"},"我也爱用省略号"],"retire":[{"id":"n1","why":"不像我了"},"n2"]}\n```'), {
            add: ['我发现我爱先反问', '我也爱用省略号'], retire: [{ id: 'n1', why: '不像我了' }, { id: 'n2', why: '' }],
        });
        assert.equal(parseNotesDecision('没有 JSON'), undefined);
        assert.equal(parseNotesDecision('{坏的'), undefined);
        assert.deepEqual(parseNotesDecision('{}'), { add: [], retire: [] });
    });

    test('applyNotesDecision：加、放下、一晚各有上限；同一天 id 不重复；想写没成的记下原因', () => {
        const state = stateWith(note('n-old-1', '我发现我爱先反问一句再回答'), note('n-old-2', '我发现回很短的时候心里其实在笑'), note('n-old-3', '我发现不想聊的时候会只回一个字'), note('n-old-4', '我发现晚上说话会更啰嗦一点点'));
        const result = applyNotesDecision(state, {
            add: ['我发现被夸的时候我会先装作没听见', '我发现有话想说时会先发个省略号', '我发现我喜欢拆成两条发出去', '我发现我讲道理的时候会放慢节奏'],
            retire: [{ id: 'n-old-1', why: '最近不这样了' }, { id: '我发现回很短的时候心里其实在笑', why: '按原文也能指到' }, { id: 'n-old-3', why: '' }, { id: 'n-old-4', why: '不像我' }, { id: 'n-nope', why: '随便' }, { id: 'n-old-4', why: '重复放下' }],
        }, noGuard, NIGHT);
        assert.equal(result.retired, 3, '最多放下 3 条（按 id 或原文都能指到；没说理由的先留着）');
        assert.deepEqual(state.retired.map(item => item.why), ['最近不这样了', '按原文也能指到', '不像我']);
        assert.ok(state.notes.some(item => item.id === 'n-old-3'), '没说理由的那条还在');
        assert.ok(result.lines.some(line => line.includes('没说为什么放下')));
        assert.ok(result.lines.some(line => line.includes('没有「n-nope」')));
        assert.equal(result.added, MAX_ADD);
        assert.equal(state.notes.filter(item => item.id.startsWith('n-2026-10-30-')).length, MAX_ADD);
        assert.equal(new Set(state.notes.map(item => item.id)).size, state.notes.length, 'id 不重复');
        assert.ok(result.lines.some(line => line.includes('今晚加的够多了')));
    });

    test('一晚最多放下 3 条：第 4 条留到下次', () => {
        const state = stateWith(...['甲乙丙丁戊'].flatMap(() => [1, 2, 3, 4].map(i => note(`n${i}`, `我发现第${i}种和别的完全不一样的小习惯${'春夏秋冬'[i - 1]}`))));
        const result = applyNotesDecision(state, { add: [], retire: [1, 2, 3, 4].map(i => ({ id: `n${i}`, why: '不要了' })) }, noGuard, NIGHT);
        assert.equal(result.retired, MAX_RETIRE);
        assert.equal(state.notes.length, 1);
        assert.ok(result.lines.some(line => line.includes('留到下次')));
    });

    test('先放下再加：满了的时候放下一条，同一晚就能加一条', () => {
        const state = stateWith(...Array.from({ length: MAX_ACTIVE }, (_, i) => note(`n${i}`, `第${'一二三四五六七八九十'[i % 10]}种完全不同的习惯编号${i}${'甲乙丙丁戊己庚辛壬癸'[Math.floor(i / 2)]}`)));
        const result = applyNotesDecision(state, { add: ['我发现别人问吃什么时我会先反问一句'], retire: [{ id: 'n0', why: '腾个位置' }] }, noGuard, NIGHT);
        assert.equal(result.added, 1);
        assert.equal(state.notes.length, MAX_ACTIVE);
    });

    test('没成的记在 rejected 里（最近 10 条），原因读得到；引他的话的那条进不来', () => {
        const state = emptyNotesState();
        const guard: Guard = { his: ['宝宝你今天乖不乖呀'], corpus: [] };
        const result = applyNotesDecision(state, { add: ['我发现我总学他说宝宝你今天乖不乖呀', '嗯'], retire: [] }, guard, NIGHT);
        assert.equal(result.added, 0);
        assert.equal(state.notes.length, 0);
        assert.deepEqual(state.rejected.map(item => item.reason.slice(0, 6)), ['引用了他说过', '太短（6 个']);
    });
});

describe('什么时候想、想的时候看到什么', () => {
    test('reflectionDue：夜里 22 点到凌晨 3 点才想；想过后隔 20 小时；失败隔 2 小时；一天最多试 3 次', () => {
        const state = emptyNotesState();
        assert.equal(reflectionDue(state, new Date(2026, 9, 30, 21, 59).getTime()), false);
        assert.equal(reflectionDue(state, new Date(2026, 9, 30, 14, 0).getTime()), false);
        assert.equal(reflectionDue(state, new Date(2026, 9, 31, 3, 0).getTime()), false, '凌晨 3 点就不想了');
        assert.equal(reflectionDue(state, new Date(2026, 9, 31, 2, 59).getTime()), true);
        assert.equal(reflectionDue(state, NIGHT), true);
        assert.equal(reflectionDue({ ...state, lastReflectionAt: NIGHT - 10 * HOUR }, NIGHT), false);
        assert.equal(reflectionDue({ ...state, lastReflectionAt: NIGHT - 21 * HOUR }, NIGHT), true);
        assert.equal(reflectionDue({ ...state, lastAttemptAt: NIGHT - HOUR }, NIGHT), false);
        assert.equal(reflectionDue({ ...state, lastAttemptAt: NIGHT - 3 * HOUR, attempts: { day: '2026-10-30', n: 3 } }, NIGHT), false);
        assert.equal(reflectionDue({ ...state, lastAttemptAt: NIGHT - 3 * HOUR, attempts: { day: '2026-10-29', n: 3 } }, NIGHT), true);
    });

    test('提示词：她自己的数字、真人的数字只在有语料时出现且写明不是目标线、几条真人的回法、他说的话只当情形、他看得到', () => {
        const mine = speechStats([['怎么了', '又加班吗？'], ['哦', '那你早点歇着']])!;
        const corpus = [ex('c1', '在吗', ['在', '怎么啦']), ex('c2', '吃了吗', ['还没']), ex('c3', '晚安', ['嗯晚安'])];
        const real = speechStats(corpus.map(item => item.replied))!;
        const withReal = reflectionMessages({ char: '林梦瑶', user: '宝宝', persona: '设定', now: NIGHT, mine, real, samples: pickSamples(corpus, NIGHT, 2), exchanges: recentExchanges(chatHistory(), NIGHT), notes: [note('n1', '我发现我爱先反问')] });
        const text = withReal.map(message => message.content).join('\n');
        assert.match(text, /一次回 2 条；每条中位 5 个字/);
        assert.match(text, /真人女生在聊天里的样子，来自 4 条真实语料/);
        assert.match(text, /不是目标线，也不是上限/);
        assert.match(text, /几条真人女生是怎么回的（只看口气、长短、怎么接，别照抄原话）/);
        assert.match(text, /他的话只是让你想起当时的情形，别学他的说法/);
        assert.match(text, /他用 \/说话习惯 都能看到（他只能看，不能改）/);
        assert.match(text, /n1｜我发现我爱先反问/);
        assert.doesNotMatch(text, /字数线.*必须|至少|不得超过/, '没有字数规定');
        const without = reflectionMessages({ char: '林梦瑶', user: '宝宝', persona: '设定', now: NIGHT, mine, samples: [], exchanges: [], notes: [] }).map(message => message.content).join('\n');
        assert.doesNotMatch(without, /真人女生在聊天里的样子/);
        assert.match(without, /（现在一条都没有）/);
    });

    test('pickSamples：同一天挑同样的、不重复、不多于语料', () => {
        const corpus = Array.from({ length: 30 }, (_, i) => ex(`c${i}`, `他说${i}`, [`她回${i}`]));
        const a = pickSamples(corpus, NIGHT, 6);
        assert.equal(a.length, 6);
        assert.equal(new Set(a.map(item => item.id)).size, 6);
        assert.deepEqual(a, pickSamples(corpus, NIGHT + HOUR / 2, 6));
        assert.notDeepEqual(a.map(item => item.id), pickSamples(corpus, NIGHT + 2 * 86_400_000, 6).map(item => item.id), '换一天换一批');
        assert.equal(pickSamples(corpus.slice(0, 2), NIGHT, 6).length, 2);
        assert.deepEqual(pickSamples([], NIGHT), []);
    });

    const deps = (dir: string, generate: (messages: unknown) => Promise<string>, over: { now?: number; history?: StoredMessage[]; corpus?: Exemplar[] } = {}) => {
        const logs: string[] = [];
        return {
            logs,
            value: {
                dataDir: dir, now: () => over.now ?? NIGHT, generate: generate as never, history: () => over.history ?? chatHistory(), corpus: () => over.corpus ?? [],
                persona: () => '设定', names: { char: '林梦瑶', user: '宝宝' }, log: (line: string) => logs.push(line),
            },
        };
    };

    test('reflectIfDue：想成了就落地、记数字、记时间；引他的话的那条进 rejected；同一天不会再想', async () => {
        const dir = tmp();
        const prompts: string[] = [];
        const d = deps(dir, async messages => {
            prompts.push((messages as Array<{ content: string }>).map(message => message.content).join('\n'));
            return '{"add":[{"text":"我发现别人问吃什么时我会先反问一句"},{"text":"我发现我总学他说改了一天的图然后叹气"}],"retire":[]}';
        }, { corpus: [ex('c1', '在吗', ['在', '怎么啦'])] });
        const result = await reflectIfDue(d.value);
        assert.equal(result.ran, true);
        assert.equal(result.error, undefined);
        const state = loadNotesState(dir);
        assert.deepEqual(state.notes.map(item => item.text), ['我发现别人问吃什么时我会先反问一句']);
        assert.match(state.rejected[0]!.reason, /引用了他说过的话/);
        assert.equal(state.lastReflectionAt, NIGHT);
        assert.equal(state.lastStats?.bubbles, 7);
        assert.match(prompts[0]!, /从你发的 7 条消息里数出来的/);
        assert.match(prompts[0]!, /真人女生在聊天里的样子/);
        assert.ok(d.logs.some(line => line.startsWith('说话习惯：晚上想了一次——加 1 条、放下 0 条')), d.logs.join('|'));
        assert.ok(d.logs.every(line => !line.includes('改了一天的图') && !line.includes('反问')), '日志不记内容');
        assert.deepEqual(await reflectIfDue(d.value), { ran: false }, '想过了，同一晚不再想');
        assert.equal(prompts.length, 1);
    });

    test('他标过的「像真人」/「这句像 AI」（ADR 0195）：有就放进每晚想的提示词，写明是他的感受不是规定；没有就没有这一段；她的笔记不能引他写的理由', async () => {
        const feedback = {
            human: [{ at: NIGHT, label: 'human' as const, his: ['我又把钥匙锁屋里了'], hers: ['哈哈哈哈', '你好笨'] }],
            ai: [{ at: NIGHT, label: 'ai' as const, his: ['今天好累'], hers: ['辛苦了', '早点歇着'], why: '像在客服一样客气' }],
        };
        const text = (messages: unknown) => (messages as Array<{ content: string }>).map(message => message.content).join('\n');
        // 提示词
        const withFeedback = reflectionMessages({ char: '林梦瑶', user: '宝宝', persona: '设定', now: NIGHT, mine: speechStats([['怎么了']])!, samples: [], exchanges: [], notes: [], feedback }).map(message => message.content).join('\n');
        assert.match(withFeedback, /宝宝最近标过的（这是他的感受，不是规定；你想不想变、怎么变你自己定/);
        assert.match(withFeedback, /他觉得「像真人」的：\n宝宝：我又把钥匙锁屋里了\n你：哈哈哈哈 \/ 你好笨/);
        assert.match(withFeedback, /他觉得「这句像 AI」的：\n宝宝：今天好累\n你：辛苦了 \/ 早点歇着\n（宝宝说：像在客服一样客气）/);
        assert.doesNotMatch(withFeedback, /必须|不得|不许|禁止/, '没有规定');
        const without = reflectionMessages({ char: '林梦瑶', user: '宝宝', persona: '设定', now: NIGHT, mine: speechStats([['怎么了']])!, samples: [], exchanges: [], notes: [], feedback: { human: [], ai: [] } }).map(message => message.content).join('\n');
        assert.doesNotMatch(without, /最近标过的/);
        // 整条路径：交给模型的提示词里有；她写的笔记引了他的理由那句（连续 6 字）就进 rejected
        const dir = tmp();
        const prompts: string[] = [];
        const d = deps(dir, async messages => {
            prompts.push(text(messages));
            return '{"add":[{"text":"我发现自己有时候说话像在客服一样客气，可以放松点"},{"text":"我发现自己被说客气的时候其实不太在意"}],"retire":[]}';
        });
        const result = await reflectIfDue({ ...d.value, feedback: () => feedback });
        assert.equal(result.ran, true);
        assert.match(prompts[0]!, /他觉得「这句像 AI」的/);
        const state = loadNotesState(dir);
        assert.deepEqual(state.notes.map(item => item.text), ['我发现自己被说客气的时候其实不太在意']);
        assert.match(state.rejected[0]!.reason, /引用了他说过的话/, '理由里的话也算他说的');
        // 不传 feedback：照旧，提示词里没有这一段
        const dir2 = tmp();
        const prompts2: string[] = [];
        await reflectIfDue(deps(dir2, async messages => { prompts2.push(text(messages)); return '{}'; }).value);
        assert.doesNotMatch(prompts2[0]!, /最近标过的/);
    });

    test('describeNotesForOwner：带上他标过几次那一行（放在「他只能看」前面）', () => {
        const owner = describeNotesForOwner(stateWith(note('n1', '我发现我爱先反问一句再回答')), NIGHT, '他标过的（最近 14 天）：像真人 2 次、这句像 AI 1 次。');
        assert.match(owner, /他标过的（最近 14 天）：像真人 2 次、这句像 AI 1 次。\n\n这些是她自己的观察/);
        assert.doesNotMatch(describeNotesForOwner(stateWith(note('n1', '我发现我爱先反问一句再回答')), NIGHT), /他标过的/);
    });

    test('reflectIfDue：没到点 / 最近说话太少，不调模型、不记尝试', async () => {
        const dir = tmp();
        let calls = 0;
        const generate = async () => { calls++; return '{}'; };
        assert.deepEqual(await reflectIfDue(deps(dir, generate, { now: new Date(2026, 9, 30, 20, 0).getTime() }).value), { ran: false });
        const few = [row('user', '在吗', NIGHT - HOUR), row('assistant', '在', NIGHT - HOUR + 1000)];
        assert.deepEqual(await reflectIfDue(deps(dir, generate, { history: few }).value), { ran: false });
        assert.equal(calls, 0);
        assert.equal(existsSync(speechNotesPath(dir)), false, '什么都没写');
    });

    test('reflectIfDue：失败（抛错 / 没有 JSON）只记一次尝试，2 小时后再试，不动笔记', async () => {
        const dir = tmp();
        saveNotesState(dir, stateWith(note('n1', '我发现我爱先反问一句再回答')));
        const failing = deps(dir, async () => { throw new Error('超时'); });
        const first = await reflectIfDue(failing.value);
        assert.deepEqual(first, { ran: true, error: '超时' });
        let state = loadNotesState(dir);
        assert.equal(state.lastReflectionAt, 0);
        assert.equal(state.attempts.n, 1);
        assert.equal(state.notes.length, 1);
        assert.ok(failing.logs.some(line => line.includes('今晚没想成（超时）')));
        assert.deepEqual(await reflectIfDue(failing.value), { ran: false }, '2 小时内不重试');
        const noJson = deps(dir, async () => '我今天没什么想法', { now: NIGHT + 3 * HOUR });
        assert.match((await reflectIfDue(noJson.value)).error ?? '', /没有可用的 JSON/);
        state = loadNotesState(dir);
        assert.equal(state.attempts.n, 1, '过了零点，新的一天从 1 次算起');
        assert.equal(state.attempts.day, '2026-10-31');
        assert.equal(state.notes.length, 1);
    });

    test('读状态：lastStats 里的 tropes 读得回来；旧记录（没有 tropes）照常读，也不会凭空多出来', () => {
        const dir = tmp();
        const base = { turns: 3, bubbles: 9, perTurn: 3, medianChars: 5, shortShare: 0.2, questionShare: 0.1, emojiShare: 0.1 };
        writeFileSync(speechNotesPath(dir), JSON.stringify({ notes: [], lastStats: { ...base, tropes: { aphorism: 0.05, insomnia: 'x', sudden: 0.02 } } }));
        assert.deepEqual(loadNotesState(dir).lastStats?.tropes, { aphorism: 0.05, insomnia: 0, sudden: 0.02 }, '坏字段按 0');
        writeFileSync(speechNotesPath(dir), JSON.stringify({ notes: [], lastStats: base }));
        const old = loadNotesState(dir).lastStats;
        assert.ok(old);
        assert.equal('tropes' in old, false);
        assert.doesNotMatch(statsLine(old), /这几种说法/);
    });

    test('读状态：坏文件当空；条数和长度被收住', () => {
        const dir = tmp();
        writeFileSync(speechNotesPath(dir), '{坏的');
        assert.deepEqual(loadNotesState(dir), emptyNotesState());
        writeFileSync(speechNotesPath(dir), JSON.stringify({ notes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, text: '长'.repeat(100), at: 1 })), retired: 'x', rejected: [{ text: 1 }] }));
        const state = loadNotesState(dir);
        assert.equal(state.notes.length, MAX_ACTIVE);
        assert.equal([...state.notes[0]!.text].length, 60);
        assert.deepEqual(state.retired, []);
        assert.deepEqual(state.rejected, []);
    });
});

describe('放进提示词、给他看', () => {
    test('speechNotesLine：没有笔记就没有；最多 5 条；和他这句话的二字词重叠多的排前，同分新的排前；写明是她自己的观察', () => {
        assert.equal(speechNotesLine([], '你好'), undefined);
        const notes = [
            note('a', '我发现聊到吃的时候我话会变多', 1), note('b', '我发现他说好累啊的时候我会先别讲道理', 2), note('c', '我发现我爱用省略号起头', 3),
            note('d', '我发现晚上我会啰嗦一点', 4), note('e', '我发现我不想聊时只回一个字', 5), note('f', '我发现我常常把一句话拆成两条', 6),
        ];
        const line = speechNotesLine(notes, '今天好累啊', 5)!;
        assert.equal(line.split('\n').filter(item => item.startsWith('- ')).length, 5);
        assert.ok(line.includes('他说好累啊的时候'), '重叠的排进来');
        assert.ok(line.indexOf('他说好累啊的时候') < line.indexOf('把一句话拆成两条'), '重叠的排在前面');
        assert.ok(!line.includes('聊到吃的时候'), '最旧又不相关的那条挤掉了');
        assert.match(line, /是你自己的观察，不是规定/);
        assert.match(line, /也别提这是笔记/);
        assert.ok(speechNotesLine(notes, undefined)!.includes('我常常把一句话拆成两条'), '没有他的话就按新旧');
    });

    test('speechNotesReader：没有文件是空；写了就读得到；改了就读新的', () => {
        const dir = tmp();
        const read = speechNotesReader(dir);
        assert.deepEqual(read(), []);
        saveNotesState(dir, stateWith(note('n1', '我发现我爱先反问一句再回答')));
        assert.deepEqual(read().map(item => item.id), ['n1']);
        saveNotesState(dir, stateWith(note('n1', '我发现我爱先反问一句再回答'), note('n2', '我发现回很短的时候心里其实在笑')));
        assert.deepEqual(read().map(item => item.id), ['n1', 'n2']);
    });

    test('describeNotesForOwner：「（」开头的运维提示；列出笔记、放下的、没成的、上次数出来的样子；明说只能看不能改', () => {
        const state: NotesState = {
            ...stateWith(note('n1', '我发现我爱先反问一句再回答', NIGHT - 2 * 86_400_000)),
            retired: [{ at: NIGHT, text: '我发现我总说哈哈', why: '最近不这样了' }],
            rejected: [{ at: NIGHT, text: '我发现我总学他说', reason: '引用了他说过的话——学的是你自己的说话方式，不是他的' }],
            lastStats: speechStats([['怎么了', '又加班吗？']])!, lastReflectionAt: NIGHT,
        };
        const text = describeNotesForOwner(state, NIGHT);
        assert.ok(text.startsWith('（') && text.endsWith('）'));
        assert.match(text, /她自己总结的说话习惯（1 条）：\n1\. 我发现我爱先反问一句再回答（2 天前）/);
        assert.match(text, /她放下的：\n- 我发现我总说哈哈（最近不这样了）/);
        assert.match(text, /她想写、但没成的：\n- 我发现我总学他说（引用了他说过的话/);
        assert.match(text, /一次回 2 条；每条中位 5 个字/);
        assert.match(text, /你只能看，不能改；她随时可以放下/);
        assert.match(describeNotesForOwner(emptyNotesState(), NIGHT), /她还没有记下说话习惯/);
    });
});
