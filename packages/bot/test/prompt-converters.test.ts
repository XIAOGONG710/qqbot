import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { OpenAIMessage } from '../src/prompt.ts';
import { PROMPT_PLACEHOLDER, postProcessPrompt } from '../src/st/prompt-converters.ts';

const sys = (content: string): OpenAIMessage => ({ role: 'system', content });
const user = (content: string): OpenAIMessage => ({ role: 'user', content });
const bot = (content: string): OpenAIMessage => ({ role: 'assistant', content });

// buildPrompt 的典型输出：开头若干 system，聊天记录（对方连发两条），最后是 post_history_instructions
const prompt = [sys('main'), sys('设定'), sys('[Start a new Chat]'), user('在吗'), bot('在'), user('今天'), user('好累'), sys('只输出消息')];

describe('提示词后处理（同 ST postProcessPrompt）', () => {
    test('不处理时原样返回', () => {
        assert.deepEqual(postProcessPrompt(prompt, ''), prompt);
    });

    test('merge：只合并相邻同角色消息，中途的 system 保留', () => {
        assert.deepEqual(postProcessPrompt(prompt, 'merge'), [
            sys('main\n\n设定\n\n[Start a new Chat]'),
            user('在吗'),
            bot('在'),
            user('今天\n\n好累'),
            sys('只输出消息'),
        ]);
    });

    test('semi（ST 的 DeepSeek 接入）：中途的 system 改成 user，再合并', () => {
        assert.deepEqual(postProcessPrompt(prompt, 'semi'), [
            sys('main\n\n设定\n\n[Start a new Chat]'),
            user('在吗'),
            bot('在'),
            user('今天\n\n好累\n\n只输出消息'),
        ]);
    });

    test('strict：system 后面不是 user 时插占位消息', () => {
        assert.deepEqual(postProcessPrompt([sys('main'), bot('早'), user('早')], 'strict'), [
            sys('main'),
            user(PROMPT_PLACEHOLDER),
            bot('早'),
            user('早'),
        ]);
        assert.deepEqual(postProcessPrompt([bot('早')], 'strict'), [user(PROMPT_PLACEHOLDER), bot('早')]);
        assert.deepEqual(postProcessPrompt([sys('main'), user('早')], 'semi'), [sys('main'), user('早')]);
    });

    test('空列表补一条占位消息；不改动传入的数组', () => {
        assert.deepEqual(postProcessPrompt([], 'merge'), [user(PROMPT_PLACEHOLDER)]);
        const input = [user('a'), user('b')];
        postProcessPrompt(input, 'semi');
        assert.deepEqual(input, [user('a'), user('b')]);
    });
});
