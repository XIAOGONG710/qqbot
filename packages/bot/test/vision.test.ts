import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_VISION_PROMPT, deepSeekImageDescriber, STICKER_VISION_PROMPT, type VisionFetch } from '../src/vision.ts';

const options = {
    baseUrl: 'https://api.deepseek.com/',
    model: 'deepseek-flash',
    apiKey: 'secret',
    timeoutMs: 8000,
};

/** 本机下载器的替身：模型只会收到验过签名的 data URL，永远收不到原始地址 */
const pngUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString('base64')}`;
const okDownload = async () => pngUrl;

describe('DeepSeek 看图（ADR 0055）', () => {
    test('表情包用自己的要求（先抄图上的字），聊天里的图仍用默认要求', async () => {
        const prompts: string[] = [];
        const fetch: VisionFetch = async (_url, init) => {
            prompts.push(JSON.parse(init.body).messages[0].content[0].text);
            return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '文字：收到，办不到｜画面：浣熊望窗' } }] }) };
        };
        await deepSeekImageDescriber(options, fetch, okDownload).describe({ url: 'https://x/a.jpg' });
        await deepSeekImageDescriber({ ...options, prompt: STICKER_VISION_PROMPT }, fetch, okDownload).describe({ url: 'https://x/a.jpg' });
        assert.deepEqual(prompts, [DEFAULT_VISION_PROMPT, STICKER_VISION_PROMPT]);
        assert.match(STICKER_VISION_PROMPT, /原样抄下来/);
    });

    test('按官方 Chat Completions 多模态格式发本机下载后的 data URL，复用聊天模型的 key', async () => {
        let seenUrl = '';
        let seenInit!: Parameters<VisionFetch>[1];
        const fetch: VisionFetch = async (url, init) => {
            seenUrl = url;
            seenInit = init;
            return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: ' 一只橘猫趴在窗台上。 ' } }] }) };
        };
        const vision = deepSeekImageDescriber(options, fetch, okDownload);
        assert.equal(await vision.describe({ url: 'https://gchat.qpic.cn/a.jpg' }), '一只橘猫趴在窗台上。');
        assert.equal(seenUrl, 'https://api.deepseek.com/chat/completions');
        assert.equal(seenInit.headers.Authorization, 'Bearer secret');
        const body = JSON.parse(seenInit.body);
        assert.equal(body.model, 'deepseek-flash');
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.deepEqual(body.messages[0].content[1], { type: 'image_url', image_url: { url: pngUrl } });
    });

    test('HTTP 错误和没有正文都失败，让 media.ts 退回只有「[图片]」', async () => {
        const failed: VisionFetch = async () => ({ ok: false, status: 400, text: async () => 'bad image' });
        await assert.rejects(() => deepSeekImageDescriber(options, failed, okDownload).describe({ url: 'https://x/a.jpg' }), /返回 400：bad image/);
        const empty: VisionFetch = async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":""}}]}' });
        await assert.rejects(() => deepSeekImageDescriber(options, empty, okDownload).describe({ url: 'https://x/a.jpg' }), /没有文本/);
    });

    test('200 但正文空（DSH 10-10：低频）：同一张图再问一次；还空才失败；HTTP 错误不重问', async () => {
        const replies = ['{"choices":[{"message":{"content":""}}]}', JSON.stringify({ choices: [{ message: { content: '一张宿舍书桌的照片' } }] })];
        const urls: string[] = [];
        const flaky: VisionFetch = async (_url, init) => {
            urls.push(JSON.parse(init.body).messages[0].content[1].image_url.url);
            return { ok: true, status: 200, text: async () => replies.shift()! };
        };
        const download = async () => `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString('base64')}`;
        assert.equal(await deepSeekImageDescriber(options, flaky, download).describe({ url: 'https://x/a.jpg' }), '一张宿舍书桌的照片');
        assert.ok(urls.every(url => url.startsWith('data:image/png;base64,')));
        let calls = 0;
        const empty: VisionFetch = async () => { calls++; return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"  "}}]}' }; };
        await assert.rejects(() => deepSeekImageDescriber(options, empty, okDownload).describe({ url: 'https://x/a.jpg' }), /没有文本/);
        assert.equal(calls, 2);
        calls = 0;
        const failed: VisionFetch = async () => { calls++; return { ok: false, status: 400, text: async () => 'Failed to download image' }; };
        await assert.rejects(() => deepSeekImageDescriber(options, failed, okDownload).describe({ url: 'https://x/a.jpg' }), /返回 400/);
        assert.equal(calls, 1);
    });

    test('配置下载器后下载失败就停止，不把原始 URL 回退给模型；外部 data URL 也先验签', async () => {
        let calls = 0;
        const fetch: VisionFetch = async () => {
            calls++;
            return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '不应调用' } }] }) };
        };
        const download = async () => { throw new Error('blocked by safe downloader'); };
        await assert.rejects(() => deepSeekImageDescriber(options, fetch, download).describe({ url: 'https://x/a.jpg' }), /blocked/);
        assert.equal(calls, 0);
        await assert.rejects(() => deepSeekImageDescriber(options, fetch, download).describe({
            url: 'https://x/a.jpg', dataUrl: 'data:image/png;base64,AAAA',
        }), /content does not match/);
        assert.equal(calls, 0);
    });
});
