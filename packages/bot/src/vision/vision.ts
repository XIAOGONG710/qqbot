// DeepSeek 看图（ADR 0055）：用和聊天模型相同的 key 调 OpenAI 兼容的 Chat Completions。
// 图片只放在 user 消息里；公网 URL 必须先经 safe-image 下载并转成 data URL，模型永远不回源。

import { fetch as undiciFetch } from 'undici';
import { AsyncGate } from '../social/async-gate.ts';
import { DEFAULTS, type AppConfig } from '../platform/config.ts';
import type { ImageDescriber } from './media.ts';
import { modelDispatcher, modelGuard, ModelUnreachable } from '../language/llm.ts';
import { GuardRejected, type ModelGuard, type ModelPurpose } from '../language/model-guard.ts';
import { fetchRemoteImage, imageDataUrl, REMOTE_IMAGE_MAX_BYTES, validateImageDataUrl } from './safe-image.ts';
import { stateObject } from '../memory/state-schema.ts';

export interface DeepSeekVisionOptions {
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    /** 换掉默认的看图要求（表情包要先抄图上的字，见 STICKER_VISION_PROMPT） */
    prompt?: string;
    /** 聊天看图优先于后台表情收藏；默认 chat。 */
    purpose?: ModelPurpose;
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
) => Promise<{ ok: boolean; status: number; body?: ReadableStream<Uint8Array> | null; text(): Promise<string> }>;

const defaultFetch: VisionFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: modelDispatcher });
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
export const VISION_REFERENCE_MAX_COUNT = 4;
export const VISION_REFERENCE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export function imageDownloader(timeoutMs: number): ImageDownload {
    return async (url, signal) => imageDataUrl(await fetchRemoteImage(url, { timeoutMs, maxBytes: MAX_IMAGE_BYTES, ...(signal ? { signal } : {}) }));
}

let shared: ImageDownload | undefined;
const defaultDownload = (): ImageDownload => (shared ??= imageDownloader(4000));

/** 200 但正文是空的（DSH 对抗审查 10-10：deepseek-flash 低频出现，不是推理吃光预算）：同一张图再问一次，还空才算没看出来 */
export const EMPTY_RETRIES = 1;
export const MAX_VISION_RESPONSE_BYTES = 1024 * 1024;

function checkTimeout(timeoutMs: number): void {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError('vision.timeoutMs 应为正有限32位整数');
}

/** 每个实际工作阶段都独立响应取消，使外层闸门不会被不合作的供应商占住。 */
function abortable<T>(work: () => Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(value => {
            if (signal.aborted) { late?.(value); reject(signal.reason); }
            else resolve(value);
        }, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
}

type VisionResponse = Awaited<ReturnType<VisionFetch>>;
function cancelBody(response: VisionResponse): void {
    if (response.body) void response.body.cancel().catch(() => undefined);
}

async function responseText(response: VisionResponse, signal: AbortSignal): Promise<string> {
    if (!response.body) {
        const text = await abortable(() => response.text(), signal);
        if (Buffer.byteLength(text, 'utf8') > MAX_VISION_RESPONSE_BYTES) throw new Error('看图模型回复过大');
        return text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
        for (;;) {
            const { done, value } = await abortable(() => reader.read(), signal);
            if (done) break;
            total += value.byteLength;
            if (total > MAX_VISION_RESPONSE_BYTES) throw new Error('看图模型回复过大');
            chunks.push(value);
        }
        return Buffer.concat(chunks, total).toString('utf8');
    } finally {
        cancel();
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
}

export function deepSeekImageDescriber(options: DeepSeekVisionOptions, doFetch: VisionFetch = defaultFetch, download?: ImageDownload, guard?: ModelGuard): ImageDescriber {
    checkTimeout(options.timeoutMs);
    return {
        async describe({ url: original, dataUrl, referenceDataUrls, signal }) {
            signal?.throwIfAborted();
            const lifetime = new AbortController();
            const cancel = () => lifetime.abort(signal!.reason);
            signal?.addEventListener('abort', cancel, { once: true });
            const timer = setTimeout(() => lifetime.abort(new ModelUnreachable('看图模型暂时不可达或请求超时')), options.timeoutMs);
            try {
                // The model only ever receives bytes that passed the local checks; no fallback to the original URL.
                const url = dataUrl
                    ? validateImageDataUrl(dataUrl, REMOTE_IMAGE_MAX_BYTES)
                    : original.startsWith('data:')
                        ? validateImageDataUrl(original, REMOTE_IMAGE_MAX_BYTES)
                        : validateImageDataUrl(await abortable(() => (download ?? defaultDownload())(original, lifetime.signal), lifetime.signal), REMOTE_IMAGE_MAX_BYTES);
                if ((referenceDataUrls?.length ?? 0) > VISION_REFERENCE_MAX_COUNT) throw new Error('too many reference images');
                const references = (referenceDataUrls ?? []).map(value => validateImageDataUrl(value, REMOTE_IMAGE_MAX_BYTES));
                const referenceBytes = references.reduce((sum, value) => {
                    const encoded = value.slice(value.indexOf(',') + 1);
                    return sum + Buffer.from(encoded, 'base64').length;
                }, 0);
                if (referenceBytes > VISION_REFERENCE_MAX_TOTAL_BYTES) throw new Error('reference images are too large');
                lifetime.signal.throwIfAborted();
                return await visionGate.run(async () => {
                    for (let attempt = 0; ; attempt++) {
                        lifetime.signal.throwIfAborted();
                        const text = await ask(url, references, lifetime.signal, signal);
                        if (text) return text;
                        if (attempt >= EMPTY_RETRIES) throw new Error('看图模型返回里没有文本');
                    }
                }, lifetime.signal);
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
            }
        },
    };

    async function ask(url: string, references: readonly string[], lifetime: AbortSignal, caller?: AbortSignal): Promise<string | undefined> {
        try {
            // 每一次真正的视觉请求（包括空正文重试）单独占预算，下载失败不消耗模型额度。
            return await (guard ?? modelGuard()).run(options.purpose ?? 'chat', () => askOnce(url, references, lifetime), error => error instanceof ModelUnreachable && !caller?.aborted, lifetime);
        } catch (error) {
            if (caller?.aborted) throw caller.reason;
            if (error instanceof GuardRejected) throw new ModelUnreachable(`看图调用被挡住（${error.message}）`, { cause: error });
            throw error;
        }
    }

    async function askOnce(url: string, references: readonly string[], lifetime: AbortSignal): Promise<string | undefined> {
        try {
            let response: VisionResponse;
            try { response = await abortable(() => doFetch(`${options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
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
                            ...references.map(reference => ({ type: 'image_url' as const, image_url: { url: reference } })),
                        ],
                    }],
                    max_tokens: 200,
                    stream: false,
                    thinking: { type: 'disabled' },
                }),
                signal: lifetime,
            }), lifetime, cancelBody); }
            catch (error) {
                if (lifetime.aborted) throw lifetime.reason;
                throw new ModelUnreachable('看图模型请求失败', { cause: error });
            }
            if (!response.ok) {
                cancelBody(response);
                // 错误正文可能回显图片或其他敏感输入，不把它带进运行日志。
                const message = `看图模型返回 ${Number.isInteger(response.status) ? response.status : '未知状态'}`;
                if (response.status === 429 || response.status >= 500) throw new ModelUnreachable(message);
                throw new Error(message);
            }
            let body: string;
            try { body = await responseText(response, lifetime); }
            catch (error) {
                if (lifetime.aborted) throw lifetime.reason;
                if (error instanceof Error && error.message === '看图模型回复过大') throw error;
                throw new ModelUnreachable('看图模型回复读取失败', { cause: error });
            }
            let json: unknown;
            try { json = JSON.parse(body); }
            catch { throw new Error('看图模型返回无效 JSON'); }
            const choice = stateObject(json) && Array.isArray(json.choices) ? json.choices[0] : undefined;
            const content = stateObject(choice) && stateObject(choice.message) ? choice.message.content : undefined;
            return typeof content === 'string' && content.trim() ? content.trim() : undefined;
        } catch (error) {
            if (lifetime.aborted) throw lifetime.reason;
            if (error instanceof ModelUnreachable) throw error;
            if (error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) {
                throw new ModelUnreachable('看图模型暂时不可达或请求超时', { cause: error });
            }
            throw error;
        }
    }
}

/**
 * 两个运行入口共用：没配 vision 就完全不调外部看图接口。`prompt` 给表情包收藏用，聊天里的图片仍用默认要求。
 * 带 prompt 的默认按后台算（收藏不抢聊天）；读他刚发来的表情包（ADR 0206）是聊天路上的，传 purpose 'chat'。
 */
export function configuredImageDescriber(config: Pick<AppConfig, 'llm' | 'vision'>, prompt?: string, purpose?: ModelPurpose): ImageDescriber | undefined {
    if (!config.vision) return;
    return deepSeekImageDescriber({
        baseUrl: config.vision.baseUrl ?? DEFAULTS.vision.baseUrl,
        model: config.vision.model,
        apiKey: config.llm.apiKey,
        timeoutMs: config.vision.timeoutMs,
        purpose: purpose ?? (prompt ? 'background' : 'chat'),
        ...(prompt ? { prompt } : {}),
    }, defaultFetch, imageDownloader(Math.min(4000, config.vision.timeoutMs)));
}
