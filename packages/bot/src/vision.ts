// DeepSeek 看图（ADR 0055）：用和聊天模型相同的 key 调 OpenAI 兼容的 Chat Completions。
// 图片只放在 user 消息里；QQ 的公网 URL 直接交给模型下载，不在 bot 里落盘。

import { Agent, fetch as undiciFetch } from 'undici';
import { DEFAULTS, type AppConfig } from './config.ts';
import type { ImageDescriber } from './media.ts';

export interface DeepSeekVisionOptions {
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
}

export type VisionFetch = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const dispatcher = new Agent({ connect: { timeout: 3000 } });
const defaultFetch: VisionFetch = (url, init) => undiciFetch(url, { ...init, dispatcher });

/**
 * 一次只说明一张图，正文会再由 media.ts 截短。关思考，避免简单看图把 8 秒上限耗在推理过程上。
 * DeepSeek 官方的多模态格式：user.content = text + image_url 两个内容块。
 */
/** 把图先下到本机、转成 data URL（DeepSeek 自己下载外网图会失败：10-10 冒烟，维基的图 400「Failed to download image」；base64 0.8 秒认出来） */
export type ImageDownload = (url: string) => Promise<string | undefined>;

/** 单张最多这么大（字节）；更大的、下不来的退回直接给地址 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function imageDownloader(timeoutMs: number): ImageDownload {
    return async url => {
        if (!url.startsWith('http://') && !url.startsWith('https://')) return undefined;
        try {
            const response = await undiciFetch(url, { dispatcher, signal: AbortSignal.timeout(timeoutMs) });
            if (!response.ok) return undefined;
            const type = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
            if (!type.startsWith('image/')) return undefined;
            const bytes = Buffer.from(await response.arrayBuffer());
            if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return undefined;
            return `data:${type};base64,${bytes.toString('base64')}`;
        } catch {
            return undefined;
        }
    };
}

/** 200 但正文是空的（DSH 对抗审查 10-10：deepseek-flash 低频出现，不是推理吃光预算）：同一张图再问一次，还空才算没看出来 */
export const EMPTY_RETRIES = 1;

export function deepSeekImageDescriber(options: DeepSeekVisionOptions, doFetch: VisionFetch = defaultFetch, download?: ImageDownload): ImageDescriber {
    return {
        async describe({ url: original }) {
            const url = (download ? await download(original) : undefined) ?? original;
            for (let attempt = 0; ; attempt++) {
                const text = await ask(url);
                if (text) return text;
                if (attempt >= EMPTY_RETRIES) throw new Error('看图模型返回里没有文本');
            }
        },
    };

    async function ask(url: string): Promise<string | undefined> {
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
                        { type: 'text', text: '用一两句简短中文客观描述这张图里主要有什么。不要猜看不清的细节，不要复述这条要求。' },
                        { type: 'image_url', image_url: { url } },
                    ],
                }],
                max_tokens: 200,
                stream: false,
                thinking: { type: 'disabled' },
            }),
            signal: AbortSignal.timeout(options.timeoutMs),
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`看图模型返回 ${response.status}：${body.slice(0, 500)}`);
        const json = JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] };
        const content = json.choices?.[0]?.message?.content;
        return typeof content === 'string' && content.trim() ? content.trim() : undefined;
    }
}

/** 两个运行入口共用：没配 vision 就完全不调外部看图接口。 */
export function configuredImageDescriber(config: Pick<AppConfig, 'llm' | 'vision'>): ImageDescriber | undefined {
    if (!config.vision) return;
    return deepSeekImageDescriber({
        baseUrl: config.vision.baseUrl ?? DEFAULTS.vision.baseUrl,
        model: config.vision.model,
        apiKey: config.llm.apiKey,
        timeoutMs: config.vision.timeoutMs,
    }, defaultFetch, imageDownloader(Math.min(4000, config.vision.timeoutMs)));
}
