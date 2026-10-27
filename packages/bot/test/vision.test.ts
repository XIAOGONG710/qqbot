import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chatCompletion, ModelUnreachable } from '../src/llm.ts';
import { ModelGuard } from '../src/model-guard.ts';
import { DEFAULT_VISION_PROMPT, deepSeekImageDescriber, STICKER_VISION_PROMPT, type VisionFetch } from '../src/vision/vision.ts';

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
    test('看图和文字共用日额度，后台达到限额不发请求，聊天保留额仍可用', async () => {
        const guard = new ModelGuard({ dailyCalls: 2, hardMultiplier: 1.5 });
        let calls = 0;
        const fetch: VisionFetch = async () => { calls++; return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"好"}}]}' }; };
        const textOptions = { ...options, temperature: 0, maxTokens: 30, extraBody: {} };
        await chatCompletion(textOptions, [], { guard, fetch });
        const vision = deepSeekImageDescriber({ ...options, purpose: 'background' }, fetch, okDownload, guard);
        assert.equal(await vision.describe({ url: 'https://x/a.jpg' }), '好');
        await assert.rejects(vision.describe({ url: 'https://x/a.jpg' }), error => error instanceof ModelUnreachable && /额度/.test(error.message));
        assert.equal(calls, 2, '被预算拒绝时不发出新的视觉请求');
        assert.equal(await chatCompletion(textOptions, [], { guard, fetch }), '好');
        assert.equal(guard.status().callsToday, 3);
    });

    test('空正文重试另计预算；下载失败不计预算', async () => {
        const guard = new ModelGuard({ dailyCalls: 1 });
        let calls = 0;
        const fetch: VisionFetch = async () => { calls++; return { ok: true, status: 200, text: async () => '{"choices":[]}' }; };
        const badDownload = async () => { throw new Error('download blocked'); };
        await assert.rejects(deepSeekImageDescriber(options, fetch, badDownload, guard).describe({ url: 'https://x/a.jpg' }), /download blocked/);
        assert.equal(guard.status().callsToday, 0);
        await assert.rejects(deepSeekImageDescriber({ ...options, purpose: 'background' }, fetch, okDownload, guard).describe({ url: 'https://x/a.jpg' }), /额度/);
        assert.equal(calls, 1);
    });

    test('视觉 503 参与共享熔断，400 不熔断；错误正文不外泄', async () => {
        const guard = new ModelGuard({ breakerFailures: 1 });
        let status = 400;
        let calls = 0;
        const fetch: VisionFetch = async () => { calls++; return { ok: false, status, text: async () => 'SECRET_IMAGE_INPUT' }; };
        const vision = deepSeekImageDescriber({ ...options, purpose: 'background' }, fetch, okDownload, guard);
        await assert.rejects(vision.describe({ url: 'https://x/a.jpg' }), /返回 400/);
        assert.equal(guard.status().breakerOpen, false);
        status = 503;
        await assert.rejects(vision.describe({ url: 'https://x/a.jpg' }), error => error instanceof ModelUnreachable && !error.message.includes('SECRET'));
        assert.equal(guard.status().breakerOpen, true);
        await assert.rejects(vision.describe({ url: 'https://x/a.jpg' }), /暂停后台/);
        assert.equal(calls, 2);
    });

    test('看图排队时取消不发幽灵请求，也不保留总闸队列占位', async () => {
        const guard = new ModelGuard({ concurrent: 1, backgroundConcurrent: 1 });
        let release!: () => void;
        const hold = guard.run('chat', () => new Promise<void>(resolve => { release = resolve; }));
        const controller = new AbortController();
        const fetch: VisionFetch = async () => assert.fail('取消后不能发出请求');
        const vision = deepSeekImageDescriber(options, fetch, okDownload, guard);
        const pending = vision.describe({ url: 'https://x/a.jpg', signal: controller.signal });
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(guard.status().waiting, 1);
        controller.abort(new Error('cancelled vision'));
        await assert.rejects(pending, /cancelled vision/);
        assert.equal(guard.status().waiting, 0);
        release(); await hold;
        assert.equal(guard.status().active, 0);
    });

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
        await assert.rejects(() => deepSeekImageDescriber(options, failed, okDownload).describe({ url: 'https://x/a.jpg' }), error => {
            assert.match(String(error), /返回 400/);
            assert.doesNotMatch(String(error), /bad image/);
            return true;
        });
        const empty: VisionFetch = async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":""}}]}' });
        await assert.rejects(() => deepSeekImageDescriber(options, empty, okDownload).describe({ url: 'https://x/a.jpg' }), /没有文本/);
        const malformed: VisionFetch = async () => ({ ok: true, status: 200, text: async () => 'SECRET_IMAGE_INPUT' });
        await assert.rejects(() => deepSeekImageDescriber(options, malformed, okDownload).describe({ url: 'https://x/a.jpg' }), error => {
            assert.match(String(error), /无效 JSON/);
            assert.doesNotMatch(String(error), /SECRET/);
            return true;
        });
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
