import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { OpenAIMessage } from '../src/prompt.ts';
import { PROMPT_PLACEHOLDER, postProcessPrompt } from '../src/st/prompt-converters.ts';

const sys = (content: string): OpenAIMessage => ({ role: 'system', content });
const user = (content: string): OpenAIMessage => ({ role: 'user', content });
const bot = (content: string): OpenAIMessage => ({ role: 'assistant', content });
const names = { user: '阿明', char: '小红' };

// buildPrompt 的典型输出：开头若干 system，聊天记录（对方连发两条），最后是 post_history_instructions
const prompt = [sys('main'), sys('设定'), sys('[Start a new Chat]'), user('在吗'), bot('在'), user('今天'), user('好累'), sys('只输出消息')];

describe('提示词后处理（同 ST postProcessPrompt）', () => {
    test('不处理时原样返回', () => {
        assert.deepEqual(postProcessPrompt(prompt, '', names), prompt);
    });

    test('merge：只合并相邻同角色消息，中途的 system 保留', () => {
        assert.deepEqual(postProcessPrompt(prompt, 'merge', names), [
            sys('main\n\n设定\n\n[Start a new Chat]'),
            user('在吗'),
            bot('在'),
            user('今天\n\n好累'),
            sys('只输出消息'),
        ]);
    });

    test('semi（ST 的 DeepSeek 接入）：中途的 system 改成 user，再合并', () => {
        assert.deepEqual(postProcessPrompt(prompt, 'semi', names), [
            sys('main\n\n设定\n\n[Start a new Chat]'),
            user('在吗'),
            bot('在'),
            user('今天\n\n好累\n\n只输出消息'),
        ]);
    });

    test('strict：system 后面不是 user 时插占位消息', () => {
        assert.deepEqual(postProcessPrompt([sys('main'), bot('早'), user('早')], 'strict', names), [
            sys('main'),
            user(PROMPT_PLACEHOLDER),
            bot('早'),
            user('早'),
        ]);
        assert.deepEqual(postProcessPrompt([bot('早')], 'strict', names), [user(PROMPT_PLACEHOLDER), bot('早')]);
        assert.deepEqual(postProcessPrompt([sys('main'), user('早')], 'semi', names), [sys('main'), user('早')]);
    });

    test('空列表补一条占位消息；不改动传入的数组', () => {
        assert.deepEqual(postProcessPrompt([], 'merge', names), [user(PROMPT_PLACEHOLDER)]);
        const input = [user('a'), user('b')];
        postProcessPrompt(input, 'semi', names);
        assert.deepEqual(input, [user('a'), user('b')]);
    });

    test('示例对话：合并时 name 换成内容前的名字，已经带名字的不重复加；不处理时保留 name', () => {
        const examples: OpenAIMessage[] = [
            sys('main'),
            sys('[Example Chat]'),
            { role: 'system', content: '在吗', name: 'example_user' },
            { role: 'system', content: '在', name: 'example_assistant' },
            { role: 'system', content: '小红: 早', name: 'example_assistant' },
            sys('[Start a new Chat]'),
            user('嗨'),
        ];
        assert.deepEqual(postProcessPrompt(examples, '', names), examples);
        assert.deepEqual(postProcessPrompt(examples, 'semi', names), [
            sys('main\n\n[Example Chat]\n\n阿明: 在吗\n\n小红: 在\n\n小红: 早\n\n[Start a new Chat]'),
            user('嗨'),
        ]);
        assert.ok(postProcessPrompt(examples, 'strict', names).every(m => !('name' in m)));
    });
});
