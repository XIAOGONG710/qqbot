// OpenAI 兼容的 Chat Completions 接口（POST {baseUrl}/chat/completions，非流式）。
// extraBody 对应 ST 自定义接口的 Include Body Parameters：合并进请求体，同名字段以它为准。
// 连不上（连接超时、被拒、被重置、DNS 失败）时重试，其他错误（HTTP 错误、整体超时）直接报错。
// 连接超时 3 秒（Node 自带 fetch 固定 10 秒，改不了，所以用 undici 包的 fetch）：10-04 在这台虚拟机上逐次新建连接，
// 要么 10–40ms 连上，要么卡满 10 秒也连不上，没有慢慢连上的；线上 32 次生成有 11 次第一次连接卡满 10 秒，重试就好。

import { Agent, fetch as undiciFetch } from 'undici';
import type { OpenAIMessage } from './prompt.ts';

export interface LlmOptions {
    /** 例如 https://api.deepseek.com（不含 /chat/completions） */
    baseUrl: string;
    model: string;
    /** 只从环境变量读取，不写进任何文件 */
    apiKey: string;
    temperature: number;
    maxTokens: number;
    /** 单次请求的超时 */
    timeoutMs: number;
    /** 例如 DeepSeek 关思考模式：{ "thinking": { "type": "disabled" } } */
    extraBody: Record<string, unknown>;
}

/** 用到的 fetch 的那一部分（测试注入假的） */
export type Fetch = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface LlmDeps {
    fetch: Fetch;
    sleep: (ms: number) => Promise<void>;
    log: (message: string) => void;
}

/** 建立连接的超时 */
export const CONNECT_TIMEOUT_MS = 3000;
/** 连接失败后的等待时间；数组长度就是最多重试几次。连接全失败最多多等约 20 秒（5 次 × 3 秒 + 7 秒） */
export const RETRY_DELAYS_MS = [1000, 1000, 2000, 3000];

const dispatcher = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } });

/** undici 的网络错误码（fetch 抛出的 TypeError 的 cause.code），出现时视为没连上，可以重试 */
const RETRYABLE_CODES = new Set([
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
]);

const defaultDeps: LlmDeps = {
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log: () => {},
};

export async function chatCompletion(
    options: LlmOptions,
    messages: OpenAIMessage[],
    deps: Partial<LlmDeps> = {},
): Promise<string> {
    const { fetch: doFetch, sleep, log } = { ...defaultDeps, ...deps };
    const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const init = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
            model: options.model,
            messages,
            temperature: options.temperature,
            max_tokens: options.maxTokens,
            stream: false,
            ...options.extraBody,
        }),
    };

    let response: Awaited<ReturnType<Fetch>>;
    for (let attempt = 0; ; attempt++) {
        try {
            response = await doFetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
            break;
        } catch (error) {
            const code = networkErrorCode(error);
            const reason = code ? `${code}：${errorCause(error)}` : String(error);
            if (!code || !RETRYABLE_CODES.has(code) || attempt >= RETRY_DELAYS_MS.length) {
                throw new Error(`模型接口请求失败（${reason}）`, { cause: error });
            }
            log(`模型接口连接失败（${code}），${RETRY_DELAYS_MS[attempt]! / 1000} 秒后重试`);
            await sleep(RETRY_DELAYS_MS[attempt]!);
        }
    }

    const body = await response.text();
    if (!response.ok) throw new Error(`模型接口返回 ${response.status}：${body.slice(0, 500)}`);

    const json = JSON.parse(body) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error(`模型接口返回里没有文本：${body.slice(0, 500)}`);
    return content;
}

function networkErrorCode(error: unknown): string | undefined {
    if (!(error instanceof TypeError)) return undefined;
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' ? code : undefined;
}

function errorCause(error: unknown): string {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
}
