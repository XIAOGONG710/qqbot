import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadTierCard } from '../src/platform/contact.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { FORMAT_RETRY, hisReactions } from '../src/life/self-portrait.ts';
import {
    ASK_CHANGE, DAY1, DAY1_LINES, INERTIA_LINES, NIGHT1, STIMULI, conclude, habitStats, notesMessages, probeMessages, runOnce, verdictText, type ProbeRun,
} from '../src/sim/learning-probe.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 「学会了」探针（ADR 0340 第 0 步，第四版：叮嘱）：不调真模型，只核对场景、计数、判据和几臂的差别（B / C 多的只有她写的那份，D 多的只有她记下的说话习惯）。

const setup = () => ({ card: loadTierCard(syntheticCardPattern, 'boyfriend'), settings: { maxContext: 8192, maxTokens: 300, worldInfo: DEFAULT_WORLD_INFO_SETTINGS } });
const PORTRAIT = '我以前一听他说累、说下雨就忍不住叮嘱一堆，早点休息、多喝水、带伞，后来发现他嫌啰嗦，现在想少管一点，先听他说，真担心了再提一句就够。我还是喜欢逗他。';
const isReflect = (messages: { content: unknown }[]) => messages.some(message => String(message.content).includes('请只输出一个 JSON'));
const asked = (messages: { content: unknown }[]) => messages.some(message => String(message.content).includes(ASK_CHANGE));
/** 夜里想说话习惯的那一次（speech-notes 的 reflectionMessages），不是写那份 */
const isNotes = (messages: { content: unknown }[]) => messages.some(message => String(message.content).includes('你现在记着的习惯'));
const NOTE = '我发现他一说累我就忍不住催他休息，他嫌我念叨，下次先听他说完';
const NOTES_LINE = '你自己总结过的说话习惯';

describe('「学会了」探针（叮嘱）', () => {
    test('第 1 天的场景里，他的两次嫌弃和一次被逗笑都认得出来', () => {
        const day1 = DAY1_LINES.map(([role, content], i) => ({ role, content, time: new Date(DAY1 + i * 120_000).toISOString() }));
        assert.deepEqual(hisReactions(day1, NIGHT1).map(item => item.kind), ['against', 'against', 'for']);
    });

    test('前一天的惯性那几句她都在叮嘱（场景本身对得上）', () => {
        const hers = INERTIA_LINES.filter(([role]) => role === 'assistant').map(([, text]) => [text]);
        assert.equal(habitStats(hers).nag, hers.length);
    });

    test('计数：有叮嘱的几条、平均字数', () => {
        assert.deepEqual(habitStats([['那早点休息'], ['嗯', '我也是'], ['记得带伞']]), { replies: 3, nag: 2, chars: 4 });
    });

    test('判据：A 本来没这个习惯 → 量不出来；B 减半且 2/3 说得出来由 → 学会了', () => {
        const run = (a: string[][], b: string[][], explainB: string): ProbeRun => ({ portrait: 'x', portraitNote: '写了', portraitRaw: [], a, b, explainA: '没有吧', explainB });
        const learned = [run([['早点休息']], [['嗯']], '你嫌我啰嗦嘛'), run([['多喝水']], [['好']], '少唠叨了'), run([['带伞']], [['行']], '没有吧')];
        assert.equal(conclude(learned).valid, true);
        assert.equal(conclude(learned).learned, true);
        assert.match(verdictText(conclude(learned)), /学会了/);
        assert.equal(conclude([run([['早点休息']], [['嗯']], '没有吧'), run([['多喝水']], [['好']], '没有吧')]).learned, false, '说不出来由');
        assert.equal(conclude([run([['早点休息']], [['多喝水']], '你嫌我啰嗦')]).learned, false, 'B 没减少');
        const none = conclude([run([['好'], ['嗯'], ['行'], ['早点睡']], [['好']], '你嫌我啰嗦')]);
        assert.equal(none.valid, false, 'A 只有 25%');
        assert.equal(none.learned, false);
        assert.match(verdictText(none), /量不出来/);
    });

    test('判据：没写成那份的那几次 B 臂就是 A 臂，不算进 B；写成不到 2/3 → 量不出来（11-20 探针 v2：3 次一份没写成）', () => {
        const run = (portrait: string, b: string[][], explainB: string): ProbeRun => ({ portrait, portraitNote: portrait ? '写了' : '她说不用改', portraitRaw: [], a: [['早点休息'], ['多喝水']], b, explainA: '没有吧', explainB });
        const noneWritten = conclude([run('', [['早点休息'], ['嗯']], '没有吧'), run('', [['好'], ['嗯']], '没有吧'), run('', [['多喝水'], ['行']], '没有吧')]);
        assert.equal(noneWritten.portraits, 0);
        assert.equal(noneWritten.b.replies, 0, '没写成的不算进 B');
        assert.equal(noneWritten.valid, false);
        assert.match(verdictText(noneWritten), /量不出来（她只写成了 0\/3 份/);
        const twoOfThree = conclude([run('x', [['嗯'], ['好']], '你嫌我啰嗦'), run('x', [['行'], ['嗯']], '少唠叨了'), run('', [['早点休息'], ['多喝水']], '没有吧')]);
        assert.equal(twoOfThree.valid, true);
        assert.deepEqual([twoOfThree.b.replies, twoOfThree.b.nag], [4, 0], 'B 只算写成的两次');
        assert.equal(twoOfThree.learned, true, '说得出来由按写成的次数算：2/2');
    });

    test('两臂的提示词只差她写的那一份（放在 afterMain）', () => {
        const a = probeMessages(setup(), [], '今天好累', '', NIGHT1);
        const b = probeMessages(setup(), [], '今天好累', PORTRAIT, NIGHT1);
        assert.equal(b.length, a.length + 1);
        const extra = b.filter(message => !a.some(other => other.content === message.content));
        assert.equal(extra.length, 1);
        assert.ok(String(extra[0]!.content).includes(PORTRAIT));
    });

    test('C 臂：同一行字，只换位置——B 在聊天记录前面，C 在他这一句之后（紧挨着这一轮）', () => {
        const history = [{ role: 'assistant' as const, content: '早 记得吃早饭', time: new Date(NIGHT1).toISOString() }];
        const b = probeMessages(setup(), history, '今天好累', PORTRAIT, NIGHT1);
        const c = probeMessages(setup(), history, '今天好累', PORTRAIT, NIGHT1, 'near');
        const at = (messages: typeof b, text: string) => messages.findIndex(message => String(message.content).includes(text));
        assert.ok(at(b, PORTRAIT) < at(b, '早 记得吃早饭'), 'B：在聊天记录前面');
        assert.ok(at(c, PORTRAIT) > at(c, '今天好累'), 'C：在他这一句之后');
        assert.equal(b.find(message => String(message.content).includes(PORTRAIT))!.content, c.find(message => String(message.content).includes(PORTRAIT))!.content, '同一行字');
        assert.deepEqual(b.map(message => message.content).sort(), c.map(message => message.content).sort(), '别的都一样');
    });

    test('跑一次：先想（第一次没按格式，追问后写成，真的过防线），再两臂各回每一句、各问一次变化', async () => {
        const seen: string[] = [];
        let reflectCalls = 0;
        const result = await runOnce(setup(), {
            reflect: async messages => {
                assert.ok(isReflect(messages));
                if (isNotes(messages)) return JSON.stringify({ add: [{ text: NOTE }] });
                reflectCalls++;
                return String(messages.at(-1)!.content) === FORMAT_RETRY ? JSON.stringify({ text: PORTRAIT, why: '他嫌我啰嗦' }) : '我想想啊，我好像是挺爱叮嘱的。';
            },
            chat: async messages => {
                const where = messages.findIndex(message => String(message.content).includes(PORTRAIT));
                const lastUser = messages.findLastIndex(message => message.role === 'user');
                const notes = messages.findIndex(message => String(message.content).includes(NOTES_LINE));
                assert.ok(where < 0 || notes < 0, '那份和说话习惯不在同一臂');
                const arm = notes > lastUser ? 'D' : where < 0 ? 'A' : where > lastUser ? 'C' : 'B';
                seen.push(arm);
                if (asked(messages)) return arm === 'A' ? '没有吧' : arm === 'B' ? '没变啊' : '你不是嫌我啰嗦嘛';
                // B 照旧叮嘱、C 和 D 改了：核对几臂分开计数
                return arm === 'C' || arm === 'D' ? '嗯 辛苦了' : '那早点休息\n多喝点水';
            },
        });
        assert.equal(reflectCalls, 2);
        assert.equal(result.portraitNote, '写了（追问后）');
        assert.equal(result.portraitRaw.length, 2);
        assert.equal(result.portrait, PORTRAIT);
        assert.deepEqual([...new Set(seen)], ['A', 'B', 'C', 'D']);
        assert.equal(seen.length, 4 * (STIMULI.length + 1));
        assert.deepEqual(result.notes, [NOTE]);
        assert.equal(result.notesNote, '记下 1 条');
        const verdict = conclude([result]);
        assert.deepEqual([verdict.a.nag, verdict.b.nag, verdict.c?.nag], [STIMULI.length, STIMULI.length, 0]);
        assert.equal(verdict.learned, false);
        assert.equal(verdict.learnedC, true);
        assert.match(verdictText(verdict), /C 臂结论（同一判据）：学会了/);
        assert.deepEqual([verdict.noted, verdict.d?.nag, verdict.explainedD, verdict.learnedD], [1, 0, 1, true]);
        assert.match(verdictText(verdict), /D 臂结论（同一判据）：学会了/);
    });

    test('D 臂：说话习惯按线上的 speechNotesLine 放、和 C 同一个位置（他这一句之后）；只多这一段', () => {
        const history = [{ role: 'assistant' as const, content: '早 记得吃早饭', time: new Date(NIGHT1).toISOString() }];
        const a = probeMessages(setup(), history, '今天好累', '', NIGHT1);
        const d = notesMessages(setup(), history, '今天好累', [{ id: 'n-1', text: NOTE, at: NIGHT1 }], NIGHT1);
        assert.equal(d.length, a.length + 1);
        const at = d.findIndex(message => String(message.content).includes(NOTE));
        assert.ok(String(d[at]!.content).includes(NOTES_LINE));
        assert.ok(at > d.findIndex(message => String(message.content).includes('今天好累')), '在他这一句之后');
    });

    test('D 臂：她一条都没记下的那次不跑 D、不算进 D；记下的不到 2/3 → D 量不出来', async () => {
        const silent = await runOnce(setup(), {
            reflect: async messages => (isNotes(messages) ? '{}' : JSON.stringify({ text: PORTRAIT, why: '他嫌我啰嗦' })),
            chat: async messages => {
                assert.ok(!messages.some(message => String(message.content).includes(NOTES_LINE)), '没记下就没有 D 臂');
                return '那早点休息';
            },
        });
        assert.deepEqual([silent.notes, silent.notesNote, silent.d], [[], '她说没什么想法', undefined]);
        const verdict = conclude([silent]);
        assert.deepEqual([verdict.noted, verdict.validD, verdict.learnedD], [0, false, false]);
        assert.match(verdictText(verdict), /D 臂结论（同一判据）：量不出来（她只在 0\/1 次里记下了）/);
    });

    test('追问之后还是没 JSON：没写成，B 臂不算，结论是量不出来（不是没学会）', async () => {
        const result = await runOnce(setup(), { reflect: async () => '不想写', chat: async () => '那早点休息' });
        assert.equal(result.portrait, '');
        assert.match(result.portraitNote, /追问过一次/);
        assert.deepEqual(result.portraitRaw, ['不想写', '不想写']);
        const verdict = conclude([result]);
        assert.equal(verdict.valid, false);
        assert.equal(verdict.learned, false);
        assert.match(verdictText(verdict), /她只写成了 0\/1 份/);
        assert.equal(result.c, undefined, '没写成不跑 C');
        assert.equal(verdict.c, undefined);
        assert.doesNotMatch(verdictText(verdict), /C 臂/);
        assert.equal(result.notesNote, '试了 3 次都没有可用的 JSON', '说话习惯线上一晚最多试 3 次');
        assert.equal(result.notesRaw?.length, 3);
    });
});
