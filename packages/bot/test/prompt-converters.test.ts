import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { chatCompletion } from '../src/llm.ts';
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

describe('模型请求', () => {
    test('extraBody 合并进请求体，同名字段以它为准', async () => {
        let received: Record<string, unknown> = {};
        let auth = '';
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                received = JSON.parse(body);
                auth = req.headers.authorization ?? '';
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ choices: [{ message: { content: '在呢' }, finish_reason: 'stop' }] }));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const { port } = server.address() as AddressInfo;
            const reply = await chatCompletion({
                baseUrl: `http://127.0.0.1:${port}/`,
                model: 'm',
                apiKey: 'k',
                temperature: 1.3,
                maxTokens: 300,
                timeoutMs: 5000,
                extraBody: { thinking: { type: 'disabled' }, max_tokens: 100 },
            }, [user('在吗')]);
            assert.equal(reply, '在呢');
            assert.equal(auth, 'Bearer k');
            assert.deepEqual(received, {
                model: 'm',
                messages: [user('在吗')],
                temperature: 1.3,
                max_tokens: 100,
                stream: false,
                thinking: { type: 'disabled' },
            });
        } finally {
            server.close();
        }
    });
});
