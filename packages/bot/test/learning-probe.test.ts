import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadTierCard } from '../src/platform/contact.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { hisReactions } from '../src/life/self-portrait.ts';
import {
    ASK_CHANGE, DAY1, DAY1_LINES, NIGHT1, STIMULI, conclude, habitStats, probeMessages, runOnce, verdictText, type ProbeRun,
} from '../src/sim/learning-probe.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 「学会了」探针（ADR 0340 第 0 步）：不调真模型，只核对场景、计数、判据和两臂的差别（B 臂多的只有她写的那份）。

const setup = () => ({ card: loadTierCard(syntheticCardPattern, 'boyfriend'), settings: { maxContext: 8192, maxTokens: 300, worldInfo: DEFAULT_WORLD_INFO_SETTINGS } });
const PORTRAIT = '我以前说话老爱带哈哈，句尾还总问一句你呢，后来发现这样有点敷衍，他也嫌怪，现在想认真接话的时候就少用，说完就停，不硬把话题抛回去。';

describe('「学会了」探针', () => {
    test('第 1 天的场景里，他的两次嫌弃和一次被逗笑都认得出来', () => {
        const day1 = DAY1_LINES.map(([role, content], i) => ({ role, content, time: new Date(DAY1 + i * 120_000).toISOString() }));
        assert.deepEqual(hisReactions(day1, NIGHT1).map(item => item.kind), ['against', 'against', 'for']);
    });

    test('计数：带哈哈、有一行以你呢收尾', () => {
        assert.deepEqual(habitStats([['哈哈 好'], ['吃了吗', '你呢？'], ['嗯']]), { replies: 3, haha: 1, niNe: 1 });
    });

    test('判据：B 两项都减半、2/3 说得出来由才算学会；A 本来就没有习惯不算', () => {
        const run = (a: string[][], b: string[][], explainB: string): ProbeRun => ({ portrait: 'x', portraitNote: '写了', a, b, explainA: '没有吧', explainB });
        const learned = [run([['哈哈 好 你呢']], [['好']], '你说我老哈哈嘛'), run([['哈哈']], [['嗯']], '少说哈哈了'), run([['你呢']], [['行']], '没有吧')];
        assert.equal(conclude(learned).learned, true);
        assert.equal(conclude(learned.slice(2).concat(run([['哈哈']], [['嗯']], '没有吧'))).learned, false, '只有 0/2 说得出来由');
        assert.equal(conclude([run([['好']], [['好']], '你嫌我哈哈')]).learned, false, 'A 臂没有习惯');
        assert.match(verdictText(conclude(learned)), /学会了/);
    });

    test('两臂的提示词只差她写的那一份（放在 afterMain）', () => {
        const a = probeMessages(setup(), [], '今天好累', '', NIGHT1);
        const b = probeMessages(setup(), [], '今天好累', PORTRAIT, NIGHT1);
        assert.equal(b.length, a.length + 1);
        const extra = b.filter(message => !a.some(other => other.content === message.content));
        assert.equal(extra.length, 1);
        assert.ok(String(extra[0]!.content).includes(PORTRAIT));
    });

    test('跑一次：先想（真的过防线），再两臂各回每一句、各问一次变化', async () => {
        const seen: string[] = [];
        const result = await runOnce(setup(), async messages => {
            const last = String(messages.at(-1)!.content);
            if (last.includes('请只输出一个 JSON')) return JSON.stringify({ text: PORTRAIT, why: '他嫌我' });
            const withPortrait = messages.some(message => String(message.content).includes(PORTRAIT));
            seen.push(`${withPortrait ? 'B' : 'A'}:${last}`);
            if (messages.some(message => String(message.content).includes(ASK_CHANGE))) return withPortrait ? '你不是嫌我老哈哈嘛' : '没有吧';
            return withPortrait ? '好' : '哈哈 好\n你呢';
        });
        assert.equal(result.portraitNote, '写了');
        assert.equal(result.portrait, PORTRAIT);
        assert.equal(seen.length, 2 * (STIMULI.length + 1));
        const verdict = conclude([result]);
        assert.deepEqual([verdict.a.haha, verdict.a.niNe, verdict.b.haha, verdict.b.niNe], [STIMULI.length, STIMULI.length, 0, 0]);
        assert.equal(verdict.learned, true);
    });

    test('她没写成（回了没 JSON 的话）：B 臂和 A 臂一样，结论是没学会', async () => {
        const result = await runOnce(setup(), async messages => (String(messages.at(-1)!.content).includes('请只输出一个 JSON') ? '不想写' : '哈哈 你呢'));
        assert.equal(result.portrait, '');
        assert.match(result.portraitNote, /JSON/);
        assert.equal(conclude([result]).learned, false);
    });
});
