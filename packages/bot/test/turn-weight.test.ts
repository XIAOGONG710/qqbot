import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ChatMessage, OpenAIMessage } from '../src/language/prompt.ts';
import {
    createTurnWeigher, DEEP_KINDS, KIND_LABEL, parseWeight, ROUTED_HINTS, trivialSaid, TURN_KINDS, WEIGH_CONTEXT, WEIGH_SYSTEM, WEIGH_TIMEOUT_MS, wantsDepth, weighMessages,
} from '../src/language/turn-weight.ts';

const him = (content: string): ChatMessage => ({ role: 'user', content });
const her = (content: string): ChatMessage => ({ role: 'assistant', content });

describe('语义路由（ADR 0202）：解析', () => {
    test('JSON 里 kind 在清单里就认；前后有别的话、大小写、空格都行；why 只留 20 个字', () => {
        assert.deepEqual(parseWeight('{"kind":"heavy","why":"爷爷认不得他"}'), { kind: 'heavy', why: '爷爷认不得他' });
        assert.deepEqual(parseWeight('好的：\n```json\n{ "kind": " About-Her " }\n```'), { kind: 'about-her' });
        assert.equal(parseWeight(`{"kind":"light","why":"${'很长'.repeat(30)}"}`)!.why!.length, 21);
        for (const kind of TURN_KINDS) assert.equal(parseWeight(JSON.stringify({ kind }))!.kind, kind);
    });

    test('不在清单里的 kind、不是 JSON、缺 kind、kind 不是字符串：都当没分类出来', () => {
        for (const bad of ['{"kind":"serious"}', '{"kind":""}', '{"why":"x"}', '{"kind":3}', 'light', '', '{坏的', '}{', '[]']) assert.equal(parseWeight(bad), undefined, bad);
    });

    test('light 以外都算值得认真；没分类出来不算', () => {
        assert.equal(wantsDepth({ kind: 'light' }), false);
        assert.equal(wantsDepth(undefined), false);
        for (const kind of TURN_KINDS.filter(k => k !== 'light')) assert.equal(wantsDepth({ kind }), true, kind);
        assert.deepEqual([...DEEP_KINDS].sort(), TURN_KINDS.filter(k => k !== 'light').sort());
        for (const kind of TURN_KINDS) assert.ok(KIND_LABEL[kind], kind);
    });

    test('提示词里多放的小提示只有三种（沉重 / 质疑 / 问他们俩），而且只给方向；问她自己和要看法不放（怎么谈自己由用户定，深思那一句够了）', () => {
        assert.deepEqual(Object.keys(ROUTED_HINTS).sort(), ['challenge', 'heavy', 'us']);
        assert.match(ROUTED_HINTS.heavy!, /先接住他.*别急着给建议.*别写成一句警句/);
        assert.match(ROUTED_HINTS.challenge!, /别急着辩白/);
        assert.match(ROUTED_HINTS.us!, /具体的事/);
        assert.equal(ROUTED_HINTS['about-her'], undefined);
        assert.equal(ROUTED_HINTS.opinion, undefined);
    });
});

describe('语义路由：什么时候不值得花一次调用', () => {
    test('去掉语气词、标点、表情占位符之后只剩两个字以内：不问', () => {
        for (const text of ['嗯', '嗯嗯', '哈哈哈', '好哒', '[微笑]', '[捂脸]哈哈', '？？', '。。。', '为啥', '', '   ']) assert.equal(trivialSaid(text), true, JSON.stringify(text));
    });

    test('有实际内容的要问：短但有意思的（「怕被关掉」「变了吗」）也要', () => {
        for (const text of ['爷爷认不得我了', '你怕被关掉吗', '我变了吗', '你说的是不是套路', '我想辞职了', '在干嘛呢']) assert.equal(trivialSaid(text), false, text);
    });
});

describe('语义路由：给模型的消息', () => {
    test('系统提示写清六类和「拿不准归 light」；用户消息是前几条对话（他 / 她）+ 他刚说的', () => {
        for (const kind of TURN_KINDS) assert.ok(WEIGH_SYSTEM.includes(`- ${kind}：`), kind);
        assert.match(WEIGH_SYSTEM, /拿不准.*light/);
        assert.match(WEIGH_SYSTEM, /只输出一行 JSON/);
        const messages = weighMessages([him('晚上吃撑了'), her('活该'), him('我在纠结考研')], '你觉得我该考吗');
        assert.deepEqual(messages.map(m => m.role), ['system', 'user']);
        assert.match(messages[1]!.content, /最近的对话：\n他：晚上吃撑了\n她：活该\n他：我在纠结考研\n\n他刚说的（要判断的就是这一句）：你觉得我该考吗/);
    });

    test('只带最近 WEIGH_CONTEXT 条；每条最多 80 个字、他刚说的最多 200 个字（太长的截断）；没有前文就没有那一段', () => {
        const long = Array.from({ length: 10 }, (_, i) => him(`第${i}条${'字'.repeat(100)}`));
        const content = weighMessages(long, '字'.repeat(300))[1]!.content;
        assert.equal(content.split('\n').filter(line => line.startsWith('他：')).length, WEIGH_CONTEXT);
        assert.ok(!content.includes('第3条') && content.includes('第4条'));
        assert.ok(content.split('\n').find(line => line.startsWith('他：第9条'))!.length <= 85);
        assert.ok(content.split('他刚说的（要判断的就是这一句）：')[1]!.length <= 202);
        assert.ok(!weighMessages([], '在吗')[1]!.content.includes('最近的对话'));
    });
});

describe('语义路由：带超时和上限的调用', () => {
    const setup = (ask: (messages: OpenAIMessage[]) => Promise<string>, extra: { timeoutMs?: number; perHour?: number; now?: () => number } = {}) => {
        const logs: string[] = [];
        return { logs, weigh: createTurnWeigher({ ask, log: line => logs.push(line), ...extra }) };
    };

    test('正常：问一次，解析出来；太短的不问直接 light', async () => {
        let asks = 0;
        const { weigh } = setup(async () => { asks++; return '{"kind":"heavy","why":"亲人"}'; });
        assert.deepEqual(await weigh({ history: [him('我回去看了爷爷')], said: '他有点认不得我了' }), { kind: 'heavy', why: '亲人' });
        assert.equal(asks, 1);
        assert.deepEqual(await weigh({ history: [], said: '嗯嗯' }), { kind: 'light' });
        assert.equal(asks, 1, '太短的不花这一次调用');
    });

    test('模型出错 / 回得读不懂：返回 undefined（调用方按关键词），记一行日志，不抛', async () => {
        const failing = setup(async () => { throw new Error('连不上'); });
        assert.equal(await failing.weigh({ history: [], said: '你怕不怕被关掉' }), undefined);
        assert.match(failing.logs[0]!, /没问成（连不上），这一轮按关键词/);
        const garbled = setup(async () => '我觉得这是重的');
        assert.equal(await garbled.weigh({ history: [], said: '你怕不怕被关掉' }), undefined);
        assert.match(garbled.logs[0]!, /读不懂/);
    });

    test('超时：不等了，返回 undefined；日志不含他说的话', async () => {
        const { weigh, logs } = setup(() => new Promise(() => undefined), { timeoutMs: 30 });
        const started = Date.now();
        assert.equal(await weigh({ history: [], said: '这是一句不该进日志的话' }), undefined);
        assert.ok(Date.now() - started < 1000);
        assert.match(logs[0]!, /超过 30 毫秒/);
        assert.ok(!logs.join('').includes('不该进日志'));
        assert.equal(WEIGH_TIMEOUT_MS, 3000);
    });

    test('每小时最多问 perHour 次，超了返回 undefined（按关键词），下一个小时重新数', async () => {
        let clock = 10 * 3_600_000;
        let asks = 0;
        const { weigh } = setup(async () => { asks++; return '{"kind":"light"}'; }, { perHour: 2, now: () => clock });
        assert.ok(await weigh({ history: [], said: '今天吃了什么好吃的' }));
        assert.ok(await weigh({ history: [], said: '今天吃了什么好吃的' }));
        assert.equal(await weigh({ history: [], said: '今天吃了什么好吃的' }), undefined);
        assert.equal(asks, 2);
        clock += 3_600_000;
        assert.ok(await weigh({ history: [], said: '今天吃了什么好吃的' }));
        assert.equal(asks, 3);
    });
});
