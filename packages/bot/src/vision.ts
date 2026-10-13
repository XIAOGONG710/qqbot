// DeepSeek 看图（ADR 0055）：用和聊天模型相同的 key 调 OpenAI 兼容的 Chat Completions。
// 图片只放在 user 消息里；公网 URL 必须先经 safe-image 下载并转成 data URL，模型永远不回源。

import { fetch as undiciFetch } from 'undici';
import { AsyncGate } from './async-gate.ts';
import { DEFAULTS, type AppConfig } from './config.ts';
import type { ImageDescriber } from './media.ts';
import { fetchRemoteImage, imageDataUrl, REMOTE_IMAGE_MAX_BYTES, validateImageDataUrl } from './safe-image.ts';

export interface DeepSeekVisionOptions {
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    /** 换掉默认的看图要求（表情包要先抄图上的字，见 STICKER_VISION_PROMPT） */
    prompt?: string;
}

export const DEFAULT_VISION_PROMPT = '用一两句简短中文客观描述这张图里主要有什么。不要猜看不清的细节，不要复述这条要求。';
/**
 * 表情包的意思大多在图上的字里：10-12 真图试跑里，默认提示词常写成「配中文字」「底部有中文字」，回复模型就不知道它说了什么。
 * 先抄字再说画面和情绪，14 张里 14 张都抄全了字。
 */
export const STICKER_VISION_PROMPT = '这是一张聊天用的表情包。第一步：把图上能看清的文字原样抄下来（没有文字就写「无」）。第二步：用一句话说画面和它表达的情绪。格式：文字：…｜画面：…。不要猜看不清的细节，不要复述这条要求。';

export type VisionFetch = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const defaultFetch: VisionFetch = (url, init) => undiciFetch(url, init);
/** 聊天图片和后台表情识图共享，避免两个入口合起来打爆视觉接口。 */
const visionGate = new AsyncGate(2);

/**
 * 一次只说明一张图，正文会再由 media.ts 截短。关思考，避免简单看图把 8 秒上限耗在推理过程上。
 * DeepSeek 官方的多模态格式：user.content = text + image_url 两个内容块。
 */
/** 把图先下到本机、转成 data URL（DeepSeek 自己下载外网图会失败：10-10 冒烟，维基的图 400「Failed to download image」；base64 0.8 秒认出来） */
export type ImageDownload = (url: string, signal?: AbortSignal) => Promise<string>;

/** 单张最多这么大（字节）；更大的、下不来的就不看（不再把原始地址交给模型） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function imageDownloader(timeoutMs: number): ImageDownload {
    return async (url, signal) => imageDataUrl(await fetchRemoteImage(url, { timeoutMs, maxBytes: MAX_IMAGE_BYTES, ...(signal ? { signal } : {}) }));
}

let shared: ImageDownload | undefined;
const defaultDownload = (): ImageDownload => (shared ??= imageDownloader(4000));

/** 200 但正文是空的（DSH 对抗审查 10-10：deepseek-flash 低频出现，不是推理吃光预算）：同一张图再问一次，还空才算没看出来 */
export const EMPTY_RETRIES = 1;

export function deepSeekImageDescriber(options: DeepSeekVisionOptions, doFetch: VisionFetch = defaultFetch, download?: ImageDownload): ImageDescriber {
    return {
        async describe({ url: original, dataUrl, signal }) {
            // The model only ever receives bytes that passed the local checks; there is no fallback to the original URL.
            const url = dataUrl
                ? validateImageDataUrl(dataUrl, REMOTE_IMAGE_MAX_BYTES)
                : original.startsWith('data:')
                    ? validateImageDataUrl(original, REMOTE_IMAGE_MAX_BYTES)
                    : validateImageDataUrl(await (download ?? defaultDownload())(original, signal), REMOTE_IMAGE_MAX_BYTES);
            return visionGate.run(async () => {
                for (let attempt = 0; ; attempt++) {
                    const text = await ask(url, signal);
                    if (text) return text;
                    if (attempt >= EMPTY_RETRIES) throw new Error('看图模型返回里没有文本');
                }
            }, signal);
        },
    };

    async function ask(url: string, parent?: AbortSignal): Promise<string | undefined> {
        const timeout = AbortSignal.timeout(options.timeoutMs);
        const response = await doFetch(`${options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({
                model: options.model,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: options.prompt ?? DEFAULT_VISION_PROMPT },
                        { type: 'image_url', image_url: { url } },
                    ],
                }],
                max_tokens: 200,
                stream: false,
                thinking: { type: 'disabled' },
            }),
            signal: parent ? AbortSignal.any([parent, timeout]) : timeout,
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`看图模型返回 ${response.status}：${body.slice(0, 500)}`);
        const json = JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] };
        const content = json.choices?.[0]?.message?.content;
        return typeof content === 'string' && content.trim() ? content.trim() : undefined;
    }
}

/** 两个运行入口共用：没配 vision 就完全不调外部看图接口。`prompt` 给表情包收藏用，聊天里的图片仍用默认要求。 */
export function configuredImageDescriber(config: Pick<AppConfig, 'llm' | 'vision'>, prompt?: string): ImageDescriber | undefined {
    if (!config.vision) return;
    return deepSeekImageDescriber({
        baseUrl: config.vision.baseUrl ?? DEFAULTS.vision.baseUrl,
        model: config.vision.model,
        apiKey: config.llm.apiKey,
        timeoutMs: config.vision.timeoutMs,
        ...(prompt ? { prompt } : {}),
    }, defaultFetch, imageDownloader(Math.min(4000, config.vision.timeoutMs)));
}
