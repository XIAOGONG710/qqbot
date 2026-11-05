import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { answerOf, loadQuestions, pack, statusSummary, toScenario, type AnswerSet, type BlindQuestion } from '../src/sim/blind.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

const card = loadTierCard(syntheticCardPattern, 'boyfriend');
const llm: BotConfig['llm'] = {
    baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
    promptPostProcessing: '', extraBody: {},
};
const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };

const question: BlindQuestion = {
    id: 'be-x', relation: '男朋友', tier: 'boyfriend', user: '宝宝', scene: 6,
    lines: [
        { who: '她', at: '2026-10-13T20:01:00+08:00', text: '我们实训那块板子又烧了' },
        { who: '他', at: '2026-10-13T20:03:00+08:00', text: '你们组谁接的线' },
        { who: '她', at: '2026-10-13T20:03:30+08:00', text: '我' },
        { who: '他', at: '2026-10-13T20:05:00+08:00', text: '哈哈哈哈' },
    ],
    probe: '考察点，不给评分人',
};

function questionFile(dir: string, questions: unknown[]): string {
    const file = join(dir, 'q.json');
    writeFileSync(file, JSON.stringify({ questions }));
    return file;
}

describe('盲评生成器（T2）', () => {
    test('不开记忆的场景，事先的聊天只要早于起点（固定上文重放）；开了记忆还是要早 45 分钟', () => {
        const base = { name: 'x', tier: 'boyfriend', start: '2026-10-09T21:00:00+08:00', steps: [{ say: '在吗' }] };
        const line = { time: '2026-10-09T20:59:00+08:00', role: 'assistant', content: '刚到' };
        assert.equal(parseScenario({ ...base, memory: false, history: [line] }).history.length, 1);
        assert.throws(() => parseScenario({ ...base, history: [line] }), /45 分钟/);
        assert.throws(() => parseScenario({ ...base, memory: false, history: [{ ...line, time: '2026-10-09T21:00:00+08:00' }] }), /要早于起点/);
    });

    test('题目：最后一句要是他说的，时间不能倒退；转成场景时之前的话按原样进聊天记录', () => {
        const dir = mkdtempSync(join(tmpdir(), 'blind-'));
        try {
            assert.equal(loadQuestions(questionFile(dir, [question])).length, 1);
            assert.throws(() => loadQuestions(questionFile(dir, [{ ...question, lines: question.lines.slice(0, 3) }])), /最后一句要是他说的/);
            const backwards = [question.lines[1], question.lines[0], question.lines[3]];
            assert.throws(() => loadQuestions(questionFile(dir, [{ ...question, lines: backwards }])), /时间倒退/);
            assert.throws(() => loadQuestions(questionFile(dir, [question, question])), /id 重复/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        const scenario = toScenario(question);
        assert.equal(scenario.memory, false);
        assert.equal(scenario.start, '2026-10-13T20:05:00+08:00');
        assert.deepEqual(scenario.history.map(m => [m.role, m.content]), [['assistant', '我们实训那块板子又烧了'], ['user', '你们组谁接的线'], ['assistant', '我']]);
        assert.deepEqual(scenario.steps, [{ say: '哈哈哈哈' }]);
    });

    test('同一分钟的几句：从后往前每句早 15 秒，最后一句不动', () => {
        const sameMinute: BlindQuestion = {
            ...question,
            lines: [
                { who: '她', at: '2026-10-13T20:04:00+08:00', text: '结果钥匙落自习室了' },
                { who: '他', at: '2026-10-13T20:05:00+08:00', text: '哈哈哈哈' },
                { who: '他', at: '2026-10-13T20:05:00+08:00', text: '那你咋进的门' },
            ],
        };
        const scenario = toScenario(sameMinute);
        assert.equal(scenario.start, '2026-10-13T20:05:00+08:00');
        assert.deepEqual(scenario.history.map(m => m.time), [new Date('2026-10-13T20:04:00+08:00').toISOString(), new Date('2026-10-13T20:04:45+08:00').toISOString()]);
    });

    test('重放：她说过的话原样在提示词里，只生成她这一轮；记下时间块', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'blind-run-'));
        try {
            let seen: OpenAIMessage[] = [];
            const generate = async (messages: OpenAIMessage[]) => { seen = messages; return '笑什么笑\n第三回了都'; };
            const result = await runScenario(toScenario(question), { runId: 'blind', dataDir: dir, card, llm, prompt, generate, settle: { quietMs: 50, maxMs: 200 } });
            const answer = answerOf(question, result);
            assert.deepEqual(answer.bubbles.map(b => b.text), ['笑什么笑', '第三回了都']);
            assert.ok(answer.bubbles.every(b => b.after >= 0));
            assert.match(answer.timeBlock ?? '', /\[当前时间：2026-10-13 星期二 20:05\]/);
            const chat = seen.filter(m => m.role !== 'system').map(m => `${m.role}:${m.content}`).join('\n');
            assert.match(chat, /assistant:[^\n]*我们实训那块板子又烧了/);
            assert.match(chat, /user:[^\n]*哈哈哈哈/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('她那时：从时间块里摘时刻、在干嘛、心情、天气', () => {
        const block = [
            '[当前时间：2026-10-09 星期五 20:31]',
            '[你现在：在学校（雾岚市），住宿舍；熬夜赶作业]',
            '[你今天的心情：安静（今天有早八，起得太早了）。今天有点蔫]',
            '[你那边（今天到现在的事实）：天气：下雨，11–18℃｜团子饼：今天下雨没下楼]',
        ].join('\n');
        assert.equal(statusSummary(block), '2026-10-09 星期五 20:31 · 在学校（雾岚市），住宿舍；熬夜赶作业 · 心情安静 · 天气下雨，11–18℃');
        assert.equal(statusSummary(undefined), undefined);
    });

    test('混排：同一个种子结果一样；评分包里没有版本名，对照表里有', () => {
        const questions: BlindQuestion[] = Array.from({ length: 12 }, (_, i) => ({ ...question, id: `be-${i}` }));
        const set = (label: string): AnswerSet => ({
            label, commit: 'abc', dirty: false, status: false, createdAt: 't',
            answers: questions.map(q => ({ id: q.id, bubbles: [{ after: 5, text: `${q.id} 的回答` }], logs: [] })),
        });
        const sets = [set('O'), set('N')];
        const a = pack(questions, sets, { batch: 5, seed: 7 });
        const b = pack(questions, sets, { batch: 5, seed: 7 });
        assert.deepEqual(a, b);
        assert.equal(a.batches.length, 3);
        assert.equal(a.key.items.length, 12);
        assert.deepEqual(new Set(a.key.items.map(item => item.id)).size, 12);
        for (const item of a.key.items) assert.deepEqual(Object.values(item.answers).sort(), ['N', 'O']);
        for (const text of a.batches) {
            assert.doesNotMatch(text, /\b[ON]\b(?!.*：)/);
            assert.doesNotMatch(text, /考察点/);
        }
        assert.notDeepEqual(pack(questions, sets, { batch: 5, seed: 8 }).key, a.key);
    });
});
