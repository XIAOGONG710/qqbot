import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import {
    applyQuestionsDecision, CONTEXT_MESSAGES, emptyQuestionsState, EXPIRE_NIGHTS, findCandidates, findQuestion, loadQuestionsState, MAX_OPEN, MAX_THOUGHTS, MIN_SHARED,
    parseQuestionsDecision, PER_NIGHT, pickQuestions, ponderIfDue, ponderMessages, questionsPath, saveQuestionsState, takeCandidates, thoughtProblem, thoughtsLine, thoughtsReader,
    THOUGHT_MAX, THOUGHT_MIN, type OpenQuestion, type QuestionGuard, type Thought,
} from '../src/life/open-questions.ts';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-oq-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date(2026, 9, 31, 22, 30).getTime();
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const him = (content: string, hoursAgo: number): StoredMessage => ({ time: at(hoursAgo), role: 'user', content });
const her = (content: string, hoursAgo: number): StoredMessage => ({ time: at(hoursAgo), role: 'assistant', content });
const ASK = '你想成为自己想成为的样子，还是我喜欢的样子？';
const guard: QuestionGuard = { people: ['阿明', '苏雨桐'] };

const question = (patch: Partial<OpenQuestion> = {}): OpenQuestion => ({ id: 'q-2026-10-31-1', at: NOW - 3_600_000, his: ASK, hers: '不知道', context: ['他：我觉得你剪短发更好看', '你：是吗'], nights: 0, ...patch });
const thought = (patch: Partial<Thought> = {}): Thought => ({ id: 'o-1', q: ASK, text: '我大概是想先做我自己，但你喜欢的那个样子里有一部分我也是愿意的', at: 1, ...patch });
const text = (n: number) => '想'.repeat(n);

describe('没想完的问题：存取', () => {
    test('读不到 / 坏了 / 缺字段：补默认，不抛错；认得出的照读，超出的截断', () => {
        const dir = temp();
        assert.deepEqual(loadQuestionsState(dir), emptyQuestionsState());
        writeFileSync(questionsPath(dir), '{坏的');
        assert.deepEqual(loadQuestionsState(dir), emptyQuestionsState());
        writeFileSync(questionsPath(dir), JSON.stringify({
            open: [{ id: 'q-1', at: 5, his: ASK, hers: '不知道', context: Array.from({ length: 12 }, (_, i) => `他：${i}`), nights: 1 }, { id: 'x' }, 'bad'],
            thoughts: [{ id: 'o-1', q: ASK, text: '一条想法', at: 2 }, { id: 'o-2', q: 'x', text: '   ', at: 3 }],
            seen: [1, 'a', 2], rejected: [{ at: 1, text: 't', reason: 'r' }, { nope: 1 }], lastReflectionAt: 7,
        }));
        const state = loadQuestionsState(dir);
        assert.equal(state.open.length, 1);
        assert.equal(state.open[0]!.context.length, CONTEXT_MESSAGES);
        assert.equal(state.thoughts.length, 1);
        assert.deepEqual(state.seen, [1, 2]);
        assert.equal(state.rejected.length, 1);
        assert.equal(state.lastReflectionAt, 7);
    });

    test('存了再读：原样回来', () => {
        const dir = temp();
        const state = emptyQuestionsState();
        state.open.push(question());
        state.thoughts.push(thought());
        saveQuestionsState(dir, state);
        assert.deepEqual(loadQuestionsState(dir).open, state.open);
        assert.deepEqual(thoughtsReader(dir)(), state.thoughts);
    });
});

describe('白天只留意：找答不上来的问题', () => {
    test('他问了冲着她的问题、她答了「不知道」：一问一答成一个候选，带前面聊的', () => {
        const found = findCandidates([him('我觉得你剪短发更好看', 5), her('是吗', 5), him(ASK, 3), her('不知道', 3)], NOW, []);
        assert.equal(found.length, 1);
        assert.equal(found[0]!.his, ASK);
        assert.equal(found[0]!.hers, '不知道');
        assert.deepEqual(found[0]!.context, ['他：我觉得你剪短发更好看', '你：是吗']);
        assert.equal(found[0]!.at, Date.parse(at(3)));
    });

    test('「没想好 / 想不明白 / 说不上来」之类也算；她答得出的不算', () => {
        for (const reply of ['这个我还没想好', '想不明白诶', '说不上来', '不太清楚']) {
            assert.equal(findCandidates([him(ASK, 3), her(reply, 3)], NOW, []).length, 1, reply);
        }
        assert.equal(findCandidates([him(ASK, 3), her('当然是我自己想成为的样子', 3)], NOW, []).length, 0);
    });

    test('不是冲着她问的（没有「你」、不像问题）不算', () => {
        assert.equal(findCandidates([him('今天食堂有糖醋排骨', 3), her('不知道诶', 3)], NOW, []).length, 0);
        assert.equal(findCandidates([him('谁知道明天下不下雨呢', 3), her('不知道', 3)], NOW, []).length, 0);
        assert.equal(findCandidates([him('你好', 3), her('不知道', 3)], NOW, []).length, 0);
    });

    test('他连发的几条合成一句（时间取最后一条）；她接着回的几条合成她的回答', () => {
        const found = findCandidates([him('我问你个事', 3.01), him(ASK, 3), her('啊', 2.99), her('我不知道诶', 2.98)], NOW, []);
        assert.equal(found.length, 1);
        assert.equal(found[0]!.his, `我问你个事 / ${ASK}`);
        assert.equal(found[0]!.hers, '啊 我不知道诶');
        assert.equal(found[0]!.at, Date.parse(at(3)));
    });

    test('记过的（seen）不重复；超出窗口的不看；撤回、私信这类不是说话的不算', () => {
        const messages = [him(ASK, 3), her('不知道', 3)];
        assert.equal(findCandidates(messages, NOW, [Date.parse(at(3))]).length, 0);
        assert.equal(findCandidates([him(ASK, 80), her('不知道', 80)], NOW, []).length, 0);
        assert.equal(findCandidates([him(ASK, 3), her('[B 站私信] 不知道', 3)], NOW, []).length, 0);
    });

    test('合进状态：新的并进去、记下时间点；已有的不重复；超过 MAX_OPEN 丢最老的', () => {
        const state = emptyQuestionsState();
        const one = { at: 1000, his: ASK, hers: '不知道', context: [] };
        assert.equal(takeCandidates(state, [one], NOW), 1);
        assert.equal(takeCandidates(state, [one], NOW), 0);
        assert.deepEqual(state.seen, [1000]);
        takeCandidates(state, Array.from({ length: MAX_OPEN + 3 }, (_, i) => ({ at: 2000 + i, his: `问题${i}你呢`, hers: '不知道', context: [] })), NOW);
        assert.equal(state.open.length, MAX_OPEN);
        assert.equal(state.open.at(-1)!.his, `问题${MAX_OPEN + 2}你呢`);
    });

    test('今晚想哪几个：没过期的，新的在前，最多 PER_NIGHT 个', () => {
        const open = Array.from({ length: PER_NIGHT + 2 }, (_, i) => question({ id: `q-${i}`, at: 100 + i }));
        open.push(question({ id: 'q-old', at: 999, nights: EXPIRE_NIGHTS }));
        const picked = pickQuestions({ open });
        assert.equal(picked.length, PER_NIGHT);
        assert.equal(picked[0]!.id, `q-${PER_NIGHT + 1}`);
        assert.ok(!picked.some(item => item.id === 'q-old'));
    });
});

describe('夜里她自己想：解析和落地', () => {
    test('从回复里取 JSON（带围栏 / 前后有话）；id 可以是数字；空 = 什么也没想出来；取不出 = undefined', () => {
        const parsed = parseQuestionsDecision('想好了：\n```json\n{"thoughts":[{"id":"q-1","text":"我想先做我自己"},{"id":2,"text":"第二条"},{"id":"q-3","text":"  "},{"nope":1}],"drop":["q-4",5,{}]}\n```');
        assert.deepEqual(parsed, { thoughts: [{ id: 'q-1', text: '我想先做我自己' }, { id: '2', text: '第二条' }], drop: ['q-4', '5'] });
        assert.deepEqual(parseQuestionsDecision('{"thoughts":[]}'), { thoughts: [], drop: [] });
        assert.equal(parseQuestionsDecision('没有 JSON'), undefined);
        assert.equal(parseQuestionsDecision('{坏的}'), undefined);
    });

    test('找问题：id 全等、最后一段相等、「第几个」都认；找不到返回 undefined', () => {
        const shown = [question({ id: 'q-2026-10-31-1' }), question({ id: 'q-2026-10-31-2' })];
        assert.equal(findQuestion(shown, 'q-2026-10-31-2'), shown[1]);
        assert.equal(findQuestion(shown, '2'), shown[1]);
        assert.equal(findQuestion(shown, '1'), shown[0]);
        assert.equal(findQuestion(shown, '9'), undefined);
        assert.equal(findQuestion(shown, ''), undefined);
    });

    test('一条能不能收：只查长度、底线、别人的名字、一模一样；不查文风和观点（警句、「很有意思」、偏向哪边都收）', () => {
        const state = emptyQuestionsState();
        assert.match(thoughtProblem(text(THOUGHT_MIN - 1), state, guard)!, /太短/);
        assert.match(thoughtProblem(text(THOUGHT_MAX + 1), state, guard)!, /太长/);
        assert.match(thoughtProblem('我其实只是个程序，哪来的想成为什么样子呢', state, guard)!, /程序/);
        assert.match(thoughtProblem('要是苏雨桐问我我就说我想做自己啦', state, guard)!, /别人的名字/);
        state.thoughts.push(thought({ text: '我想先做我自己，但你喜欢的我也会听一点' }));
        assert.match(thoughtProblem('我想先做我自己，但你喜欢的我也会听一点', state, guard)!, /一模一样/);
        for (const ok of ['不是为了让你喜欢才变成什么样，是我自己想变成什么样', '我还没想明白，卡在不知道我自己到底想要什么', '很有意思，我选你喜欢的那个，因为我也想看看']) {
            assert.equal(thoughtProblem(ok, state, guard), undefined, ok);
        }
    });

    test('落地：想出来的并进「自己想过的」、从没想完里拿掉；同一件事以前的想法被新的取代', () => {
        const state = emptyQuestionsState();
        state.open.push(question());
        state.thoughts.push(thought({ id: 'o-0', text: '以前我想的是先做我自己，别的再说' }));
        const applied = applyQuestionsDecision(state, { thoughts: [{ id: 'q-2026-10-31-1', text: '后来我觉得不用二选一，我想做的样子里本来就有一部分是你喜欢的' }], drop: [] }, [state.open[0]!], guard, NOW);
        assert.equal(applied.added, 1);
        assert.equal(state.open.length, 0);
        assert.equal(state.thoughts.length, 1);
        assert.match(state.thoughts[0]!.text, /不用二选一/);
        assert.equal(state.thoughts[0]!.q, ASK);
    });

    test('落地：放下的拿掉；没想出来的多过一个晚上，过了 EXPIRE_NIGHTS 个晚上就丢；同一个问题一晚只收一条', () => {
        const state = emptyQuestionsState();
        state.open.push(question({ id: 'q-a', his: '你知道那部电影讲什么吗' }), question({ id: 'q-b', his: '你想不想换个发型' }), question({ id: 'q-c', his: '你以后想做什么工作呢', nights: EXPIRE_NIGHTS - 1 }));
        const shown = [...state.open];
        const applied = applyQuestionsDecision(state, {
            thoughts: [{ id: 'q-b', text: '我想换，可是又怕换了不像我自己，所以一直拖着没动' }, { id: 'q-b', text: '第二条也是关于换发型的想法，写得够长了呀' }],
            drop: ['q-a'],
        }, shown, guard, NOW);
        assert.equal(applied.added, 1);
        assert.equal(applied.dropped, 1);
        assert.ok(applied.lines.some(line => line.includes('已经写过一条')));
        assert.deepEqual(state.open, [], 'a 放下、b 想出来了、c 过了期');
    });

    test('没成的记下原因（最近 10 条）；找不到的 id 略过；不多想的问题只是 nights + 1', () => {
        const state = emptyQuestionsState();
        state.open.push(question());
        const applied = applyQuestionsDecision(state, { thoughts: [{ id: 'q-2026-10-31-1', text: '短' }, { id: 'q-nope', text: '这条找不到对应的问题但是写得够长了' }], drop: [] }, [state.open[0]!], guard, NOW);
        assert.equal(applied.added, 0);
        assert.equal(state.rejected.length, 1);
        assert.match(state.rejected[0]!.reason, /太短/);
        assert.ok(applied.lines.some(line => line.includes('没有「q-nope」')));
        assert.equal(state.open[0]!.nights, 1);
    });

    test('想出来的最多留 MAX_THOUGHTS 条（丢最老的）', () => {
        const state = emptyQuestionsState();
        for (let i = 0; i < MAX_THOUGHTS; i++) state.thoughts.push(thought({ id: `o-${i}`, q: `完全不相干的问题${i}号甲乙丙丁`, text: `第${i}条想法，各不一样的内容${'甲乙丙丁戊己庚辛'[i % 8]}`, at: i }));
        state.open.push(question());
        applyQuestionsDecision(state, { thoughts: [{ id: 'q-2026-10-31-1', text: '这一条是新的，写的是关于成为什么样子的想法啊' }], drop: [] }, [state.open[0]!], guard, NOW);
        assert.equal(state.thoughts.length, MAX_THOUGHTS);
        assert.equal(state.thoughts.at(-1)!.text.startsWith('这一条是新的'), true);
        assert.ok(!state.thoughts.some(item => item.id === 'o-0'));
    });
});

describe('想的时候她看到什么', () => {
    test('给她：当时前面聊的、他的话、她当时的回答、她以前自己想过的；格式说明；**不替她定怎么想、不要求给答案、不说选哪边**', () => {
        const messages = ponderMessages({ char: '林梦瑶', persona: '在读大学生', now: NOW, questions: [question()], thoughts: [thought({ q: '你会不会换专业', text: '我想过要不要换，但还没到非换不可的时候' })] });
        const all = messages.map(m => m.content).join('\n');
        assert.match(all, /### q-2026-10-31-1/);
        assert.match(all, /他：我觉得你剪短发更好看/);
        assert.match(all, new RegExp(`他说：「${ASK}」`));
        assert.match(all, /你当时答的：「不知道」/);
        assert.match(all, /他问过「你会不会换专业」，你想的是：我想过要不要换/);
        assert.match(all, /没想出来就别写/);
        assert.match(all, /卡在哪儿也好/);
        assert.doesNotMatch(all, /必须|一定要|先选一个|选一个|给出答案|给他一个答案|站在|应该选/);
    });

    test('没有以前想过的就写「还没有」；没有前文就不写「当时前面聊的」', () => {
        const all = ponderMessages({ char: '林梦瑶', persona: '', now: NOW, questions: [question({ context: [] })], thoughts: [] }).map(m => m.content).join('\n');
        assert.match(all, /你以前自己想过的：\n（还没有）/);
        assert.doesNotMatch(all, /当时前面聊的/);
    });
});

describe('什么时候想', () => {
    const deps = (dir: string, history: StoredMessage[], generate: (messages: OpenAIMessage[]) => Promise<string>, now = NOW) => {
        const logs: string[] = [];
        return {
            logs,
            deps: { dataDir: dir, now: () => now, generate, history: () => history, persona: () => '在读大学生', names: { char: '林梦瑶', user: '宝宝' }, others: () => ['阿明'], log: (line: string) => { logs.push(line); } },
        };
    };

    test('白天不想；夜里没有答不上来的问题也不想（不调用模型）', async () => {
        let calls = 0;
        const generate = async () => { calls++; return '{"thoughts":[]}'; };
        const day = deps(temp(), [him(ASK, 3), her('不知道', 3)], generate, new Date(2026, 9, 31, 14, 0).getTime());
        assert.deepEqual(await ponderIfDue(day.deps), { ran: false });
        const quiet = deps(temp(), [him('你吃了吗', 3), her('吃了', 3)], generate);
        assert.deepEqual(await ponderIfDue(quiet.deps), { ran: false });
        assert.equal(calls, 0);
    });

    test('夜里：找到答不上来的、让她想、想出来的存下；日志只记个数不记内容；之后同一晚不再想', async () => {
        const dir = temp();
        let prompt = '';
        const run = deps(dir, [him('我觉得你剪短发更好看', 5), her('是吗', 5), him(ASK, 3), her('不知道', 3)], async messages => {
            prompt = messages.map(m => m.content).join('\n');
            return '{"thoughts":[{"id":"q-2026-10-31-1","text":"我想先做我自己，不过你喜欢的样子里我愿意靠近的那一部分，也算我自己想要的"}]}';
        });
        const result = await ponderIfDue(run.deps);
        assert.equal(result.ran, true);
        assert.equal(result.applied?.added, 1);
        assert.match(prompt, /我觉得你剪短发更好看/);
        const state = loadQuestionsState(dir);
        assert.equal(state.thoughts.length, 1);
        assert.equal(state.open.length, 0);
        assert.equal(state.lastReflectionAt, NOW);
        assert.ok(run.logs.some(line => line.includes('想出 1 条')));
        assert.ok(run.logs.every(line => !line.includes('先做我自己') && !line.includes('剪短发') && !line.includes(ASK)), '日志不含内容');
        assert.deepEqual(await ponderIfDue(run.deps), { ran: false }, '同一晚（距上次想 < 20 小时）不再想');
        assert.ok(readFileSync(questionsPath(dir), 'utf8').includes('先做我自己'), '她的东西在文件里');
    });

    test('模型没想出来：问题留着，下一个晚上还给她；连着 EXPIRE_NIGHTS 个晚上没想出来就丢', async () => {
        const dir = temp();
        const history = [him(ASK, 3), her('不知道', 3)];
        for (let night = 0; night < EXPIRE_NIGHTS; night++) {
            const run = deps(dir, history, async () => '{"thoughts":[]}', NOW + night * 24 * 3_600_000);
            history.length = 0;
            history.push(him(ASK, 3 + night * 24), her('不知道', 3 + night * 24));
            const result = await ponderIfDue(run.deps);
            assert.equal(result.ran, true, `第 ${night + 1} 晚`);
            assert.equal(loadQuestionsState(dir).open.length, night + 1 < EXPIRE_NIGHTS ? 1 : 0, `第 ${night + 1} 晚之后`);
        }
    });

    test('模型出错 / 没有 JSON：记一次尝试、不记已想过，2 小时后再试；问题还在', async () => {
        const dir = temp();
        const run = deps(dir, [him(ASK, 3), her('不知道', 3)], async () => '我想想啊……');
        const result = await ponderIfDue(run.deps);
        assert.equal(result.ran, true);
        assert.match(result.error ?? '', /没有可用的 JSON/);
        const state = loadQuestionsState(dir);
        assert.equal(state.lastReflectionAt, 0);
        assert.equal(state.lastAttemptAt, NOW);
        assert.equal(state.attempts.n, 1);
        assert.equal(state.open.length, 1);
        assert.ok(run.logs.some(line => line.includes('今晚没想成')));
    });
});

describe('放进提示词', () => {
    test('他再问到同一件事（共有至少 MIN_SHARED 个有意义的二字词）才放；说法不同但同一件事也认', () => {
        const line = thoughtsLine([thought()], '那你到底想成为自己想成为的样子，还是我喜欢的样子啊');
        assert.ok(line);
        assert.match(line!, /你自己后来想过的（是你自己想的，不是设定/);
        assert.match(line!, /他问过「你想成为自己想成为的样子/);
        assert.match(line!, /我大概是想先做我自己/);
        assert.ok(MIN_SHARED >= 2);
    });

    test('没聊到的一条都不放；只共有一个词不算；没有想法 / 没有他的话也不放', () => {
        assert.equal(thoughtsLine([thought()], '晚上吃什么'), undefined);
        assert.equal(thoughtsLine([thought({ q: '你想成为什么样子', text: '我想做我自己' })], '今天天气样子不错'), undefined, '只共有「样子」一个词');
        assert.equal(thoughtsLine([], ASK), undefined);
        assert.equal(thoughtsLine([thought()], undefined), undefined);
    });

    test('最多两条，重叠多的在前；那一行不说该不该用、怎么用、该选哪边，也不提“夜里想的”', () => {
        const list = [thought({ id: 'a', at: 1 }), thought({ id: 'b', at: 2, q: '你想成为什么样子的人，是我喜欢的样子吗', text: '我想成为让我自己喜欢的样子的人' }), thought({ id: 'c', at: 3, q: '想成为自己想成为的样子吗', text: '我想成为自己想成为的样子，别的再说' })];
        const line = thoughtsLine(list, ASK)!;
        assert.equal(line.split('\n').filter(l => l.startsWith('- ')).length, 2);
        assert.doesNotMatch(line, /必须|一定|应该|选|夜里|昨晚|晚上想/);
    });
});
