import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_VISION_PROMPT, deepSeekImageDescriber, STICKER_VISION_PROMPT, type VisionFetch } from '../src/vision.ts';

const options = {
    baseUrl: 'https://api.deepseek.com/',
    model: 'deepseek-flash',
    apiKey: 'secret',
    timeoutMs: 8000,
};

describe('DeepSeek 看图（ADR 0055）', () => {
    test('表情包用自己的要求（先抄图上的字），聊天里的图仍用默认要求', async () => {
        const prompts: string[] = [];
        const fetch: VisionFetch = async (_url, init) => {
            prompts.push(JSON.parse(init.body).messages[0].content[0].text);
            return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '文字：收到，办不到｜画面：浣熊望窗' } }] }) };
        };
        await deepSeekImageDescriber(options, fetch).describe({ url: 'https://x/a.jpg' });
        await deepSeekImageDescriber({ ...options, prompt: STICKER_VISION_PROMPT }, fetch).describe({ url: 'https://x/a.jpg' });
        assert.deepEqual(prompts, [DEFAULT_VISION_PROMPT, STICKER_VISION_PROMPT]);
        assert.match(STICKER_VISION_PROMPT, /原样抄下来/);
    });

    test('按官方 Chat Completions 多模态格式发公网 URL，复用聊天模型的 key', async () => {
        let seenUrl = '';
        let seenInit!: Parameters<VisionFetch>[1];
        const fetch: VisionFetch = async (url, init) => {
            seenUrl = url;
            seenInit = init;
            return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: ' 一只橘猫趴在窗台上。 ' } }] }) };
        };
        const vision = deepSeekImageDescriber(options, fetch);
        assert.equal(await vision.describe({ url: 'https://gchat.qpic.cn/a.jpg' }), '一只橘猫趴在窗台上。');
        assert.equal(seenUrl, 'https://api.deepseek.com/chat/completions');
        assert.equal(seenInit.headers.Authorization, 'Bearer secret');
        const body = JSON.parse(seenInit.body);
        assert.equal(body.model, 'deepseek-flash');
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.deepEqual(body.messages[0].content[1], { type: 'image_url', image_url: { url: 'https://gchat.qpic.cn/a.jpg' } });
    });

    test('HTTP 错误和没有正文都失败，让 media.ts 退回只有「[图片]」', async () => {
        const failed: VisionFetch = async () => ({ ok: false, status: 400, text: async () => 'bad image' });
        await assert.rejects(() => deepSeekImageDescriber(options, failed).describe({ url: 'https://x/a.jpg' }), /返回 400：bad image/);
        const empty: VisionFetch = async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":""}}]}' });
        await assert.rejects(() => deepSeekImageDescriber(options, empty).describe({ url: 'https://x/a.jpg' }), /没有文本/);
    });

    test('200 但正文空（DSH 10-10：低频）：同一张图再问一次；还空才失败；HTTP 错误不重问', async () => {
        const replies = ['{"choices":[{"message":{"content":""}}]}', JSON.stringify({ choices: [{ message: { content: '一张宿舍书桌的照片' } }] })];
        const urls: string[] = [];
        const flaky: VisionFetch = async (_url, init) => {
            urls.push(JSON.parse(init.body).messages[0].content[1].image_url.url);
            return { ok: true, status: 200, text: async () => replies.shift()! };
        };
        const download = async () => 'data:image/jpeg;base64,AAAA';
        assert.equal(await deepSeekImageDescriber(options, flaky, download).describe({ url: 'https://x/a.jpg' }), '一张宿舍书桌的照片');
        assert.deepEqual(urls, ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,AAAA']);
        let calls = 0;
        const empty: VisionFetch = async () => { calls++; return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"  "}}]}' }; };
        await assert.rejects(() => deepSeekImageDescriber(options, empty).describe({ url: 'https://x/a.jpg' }), /没有文本/);
        assert.equal(calls, 2);
        calls = 0;
        const failed: VisionFetch = async () => { calls++; return { ok: false, status: 400, text: async () => 'Failed to download image' }; };
        await assert.rejects(() => deepSeekImageDescriber(options, failed).describe({ url: 'https://x/a.jpg' }), /返回 400/);
        assert.equal(calls, 1);
    });
});
