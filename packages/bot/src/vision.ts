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
export function deepSeekImageDescriber(options: DeepSeekVisionOptions, doFetch: VisionFetch = defaultFetch): ImageDescriber {
    return {
        async describe({ url }) {
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
            if (typeof content !== 'string' || !content.trim()) throw new Error(`看图模型返回里没有文本：${body.slice(0, 500)}`);
            return content.trim();
        },
    };
}

/** 两个运行入口共用：没配 vision 就完全不调外部看图接口。 */
export function configuredImageDescriber(config: Pick<AppConfig, 'llm' | 'vision'>): ImageDescriber | undefined {
    if (!config.vision) return;
    return deepSeekImageDescriber({
        baseUrl: config.vision.baseUrl ?? DEFAULTS.vision.baseUrl,
        model: config.vision.model,
        apiKey: config.llm.apiKey,
        timeoutMs: config.vision.timeoutMs,
    });
}
