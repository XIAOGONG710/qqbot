// OpenAI 兼容的 Chat Completions 接口（POST {baseUrl}/chat/completions，非流式）。
// extraBody 对应 ST 自定义接口的 Include Body Parameters：合并进请求体，同名字段以它为准。
// 连不上（连接超时、被拒、被重置、DNS 失败）时重试，其他错误（HTTP 错误、整体超时）直接报错。

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

export interface LlmDeps {
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    log: (message: string) => void;
}

/** 连接失败后的等待时间；数组长度就是最多重试几次 */
export const RETRY_DELAYS_MS = [1000, 3000];

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
    fetch: (...args) => fetch(...args),
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

    let response: Response;
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
