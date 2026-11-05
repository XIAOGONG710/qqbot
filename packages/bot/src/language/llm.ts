// OpenAI 兼容的 Chat Completions 接口（POST {baseUrl}/chat/completions，非流式）。
// extraBody 对应 ST 自定义接口的 Include Body Parameters：合并进请求体，同名字段以它为准。
// 连不上（连接超时、被拒、被重置、DNS 失败）时重试，其他错误（HTTP 错误、整体超时）直接报错。
// 连接超时 3 秒（Node 自带 fetch 固定 10 秒，改不了，所以用 undici 包的 fetch）：10-04 在这台虚拟机上逐次新建连接，
// 要么 10–40ms 连上，要么卡满 10 秒也连不上，没有慢慢连上的；线上 32 次生成有 11 次第一次连接卡满 10 秒，重试就好。

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { fallbackLookup } from '../platform/dns-fallback.ts';
import { GuardRejected, ModelGuard, type ModelPurpose } from './model-guard.ts';
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
    /**
     * 备用线路（2026-10-31）：免费网关开着的时候让她走免费线路，
     * 免费组 12:00–14:00 / 23:30 之后关着 —— 那时候自动退回这条。
     */
    fallback?: { baseUrl: string; apiKey: string; model?: string };
}

/** 后台抽取（她答应的事、挂着的事、待跟进的事）的输出上限：开思考时思考也算在 max_tokens 里，4096 偶尔不够，正文就是空的（10-07 线上和模拟器里都有） */
export const EXTRACT_MAX_TOKENS = 8192;

/** 后台抽取用的模型配置：同一个模型，输出上限放到 EXTRACT_MAX_TOKENS */
export function forExtraction(options: LlmOptions): LlmOptions {
    return { ...options, maxTokens: Math.max(options.maxTokens, EXTRACT_MAX_TOKENS) };
}

/** 用到的 fetch 的那一部分（测试注入假的） */
export type Fetch = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface LlmDeps {
    /** Caller lifetime; cancellation must also prevent queued dispatch and retries. */
    signal?: AbortSignal;
    fetch: Fetch;
    sleep: (ms: number) => Promise<void>;
    log: (message: string) => void;
    /** 聊天（默认）先于后台任务（抽取、日记、总结、表情判断）；见 model-guard.ts */
    purpose?: ModelPurpose;
    /** 测试注入；不传用进程里共用的那个 */
    guard?: ModelGuard;
}

/** 建立连接的超时 */
export const CONNECT_TIMEOUT_MS = 3000;
/** 连接失败后的等待时间；数组长度就是最多重试几次。连接全失败最多多等约 20 秒（5 次 × 3 秒 + 7 秒） */
export const RETRY_DELAYS_MS = [1000, 1000, 2000, 3000];

/** 模型接口的域名：系统解析器断了的时候用上次解析到的地址（dns-fallback.ts）。QQBOT_DNS_FALLBACK_HOSTS 可追加（逗号分隔） */
const DNS_FALLBACK_HOSTS = ['api.deepseek.com', ...(process.env.QQBOT_DNS_FALLBACK_HOSTS ?? '').split(',').map(host => host.trim()).filter(Boolean)];

/** 聊天、看图共用：连接超时 3 秒 + DNS 兜底 */
export const modelDispatcher = new Agent({
    connect: {
        timeout: CONNECT_TIMEOUT_MS,
        lookup: fallbackLookup({ hosts: DNS_FALLBACK_HOSTS, file: process.env.QQBOT_DNS_CACHE ?? join(tmpdir(), 'qqbot-dns-cache.json'), log: message => console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`) }),
    },
});
const dispatcher = modelDispatcher;

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

/**
 * 这一次没连上模型：网络断了、DNS 解析不了（重试完了还不行）、别的网络错误、整体超时、对面过载（429、5xx）。
 * 和「模型回了、但回的不对」分开：后台抽取遇到这个不算失败次数，等网络好了再抽（10-08 上午断网 40 分钟，一段「待跟进」三次都没连上就不再抽了）
 */
export class ModelUnreachable extends Error {}

const defaultDeps: LlmDeps = {
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log: () => {},
};

let sharedGuard: ModelGuard | undefined;
let sharedGuardLog: ((message: string) => void) | undefined;

/** 进程里共用的总闸（ADR 0070 第 7 项）；环境变量 QQBOT_MODEL_DAILY_CALLS / QQBOT_MODEL_CONCURRENT 可调，默认值远高于实际用量 */
export function modelGuard(log?: (message: string) => void): ModelGuard {
    // 看图可能早于第一条文字回复创建总闸；后来的日志回调仍应接入。
    if (log) sharedGuardLog = log;
    if (!sharedGuard) {
        const positive = (text: string | undefined) => (Number.isFinite(Number(text)) && Number(text) >= 1 ? Math.floor(Number(text)) : undefined);
        const dailyCalls = positive(process.env.QQBOT_MODEL_DAILY_CALLS);
        const concurrent = positive(process.env.QQBOT_MODEL_CONCURRENT);
        sharedGuard = new ModelGuard({
            log: message => sharedGuardLog?.(message),
            ...(dailyCalls ? { dailyCalls } : {}),
            ...(concurrent ? { concurrent, backgroundConcurrent: Math.max(1, Math.floor(concurrent / 2)) } : {}),
        });
    }
    return sharedGuard;
}

/** 模拟器、批量评测这类自己控制并发的入口：换成不设限的总闸 */
export function unlimitedModelGuard(): void {
    sharedGuard = new ModelGuard({ concurrent: 1024, backgroundConcurrent: 1024, dailyCalls: Number.MAX_SAFE_INTEGER, breakerFailures: Number.MAX_SAFE_INTEGER });
}

export async function chatCompletion(
    options: LlmOptions,
    messages: OpenAIMessage[],
    deps: Partial<LlmDeps> = {},
): Promise<string> {
    deps.signal?.throwIfAborted();
    const guard = deps.guard ?? modelGuard(deps.log);
    try {
        return await guard.run(deps.purpose ?? 'chat', () => complete(options, messages, deps), error => error instanceof ModelUnreachable);
    } catch (error) {
        // 被总闸挡住的不算模型坏了：和「没连上」一样，后台任务等好了再来（promises.ts 等已经这样处理 ModelUnreachable）
        if (error instanceof GuardRejected) throw new ModelUnreachable(`模型调用被挡住（${error.message}）`, { cause: error });
        throw error;
    }
}

async function complete(
    options: LlmOptions,
    messages: OpenAIMessage[],
    deps: Partial<LlmDeps>,
    triedFallback = false,
): Promise<string> {
    try {
        return await completeOnce(options, messages, deps);
    } catch (error) {
        const fb = options.fallback;
        if (!fb || triedFallback) throw error;
        // 主线路不可用（关窗 / 限流 / 挂掉）：退到备用线路再试一次；这条要留日志，不然看不出来她走的是哪条
        (deps.log ?? ((line: string) => console.warn(line)))(`模型线路不可用（${error instanceof Error ? error.message.slice(0, 80) : String(error)}），退回备用线路`);
        return complete({ ...options, baseUrl: fb.baseUrl, apiKey: fb.apiKey, ...(fb.model ? { model: fb.model } : {}), fallback: undefined }, messages, deps, true);
    }
}

async function completeOnce(
    options: LlmOptions,
    messages: OpenAIMessage[],
    deps: Partial<LlmDeps>,
): Promise<string> {
    const signal = deps.signal;
    signal?.throwIfAborted();
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
            signal?.throwIfAborted();
            const timeout = AbortSignal.timeout(options.timeoutMs);
            response = await doFetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
            signal?.throwIfAborted();
            break;
        } catch (error) {
            signal?.throwIfAborted();
            const code = networkErrorCode(error);
            const reason = code ? `${code}：${errorCause(error)}` : String(error);
            if (!code || !RETRYABLE_CODES.has(code) || attempt >= RETRY_DELAYS_MS.length) {
                const Failure = code || isTimeout(error) ? ModelUnreachable : Error;
                throw new Failure(`模型接口请求失败（${reason}）`, { cause: error });
            }
            log(`模型接口连接失败（${code}），${RETRY_DELAYS_MS[attempt]! / 1000} 秒后重试`);
            signal?.throwIfAborted();
            if (signal && !deps.sleep) {
                await new Promise<void>((done, reject) => {
                    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
                    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done(); }, RETRY_DELAYS_MS[attempt]!);
                    signal.addEventListener('abort', abort, { once: true });
                });
            } else await sleep(RETRY_DELAYS_MS[attempt]!);
            signal?.throwIfAborted();
        }
    }

    let body: string;
    try {
        body = await response.text();
        signal?.throwIfAborted();
    } catch (error) {
        signal?.throwIfAborted();
        const code = networkErrorCode(error);
        if (code || isTimeout(error)) throw new ModelUnreachable('模型接口响应正文读取失败', { cause: error });
        throw error;
    }
    if (!response.ok) {
        const Failure = response.status === 429 || response.status >= 500 ? ModelUnreachable : Error;
        throw new Failure(`模型接口返回 ${response.status}：${body.replace(/\s+/g, ' ').slice(0, 200)}`);
    }

    const json = JSON.parse(body) as { choices?: { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error(`模型接口返回里没有文本：${body.slice(0, 500)}`);
    // 开思考时思考也算在 max_tokens 里：偶尔想太久，正文就是空的（10-07 线上抽「她答应的事」两次「没有 JSON」）
    if (!content.trim()) {
        const finish = json.choices?.[0]?.finish_reason;
        const reasoning = json.choices?.[0]?.message?.reasoning_content;
        const thought = typeof reasoning === 'string' && reasoning ? `，思考 ${[...reasoning].length} 字` : '';
        // 10-11：没到上限也会空（finish=stop）——思考里把回复写完了，正文什么都没有；记下来才分得清是哪一种
        log(finish === 'length' ? `模型输出被截断：思考用完了 max_tokens，正文是空的${thought}` : `模型正文是空的（finish=${finish ?? '无'}${thought}）`);
    }
    return content;
}

function networkErrorCode(error: unknown): string | undefined {
    if (!(error instanceof TypeError)) return undefined;
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' ? code : undefined;
}

/** 整体超时（AbortSignal.timeout）抛的是 TimeoutError */
function isTimeout(error: unknown): boolean {
    return error instanceof Error && error.name === 'TimeoutError';
}

function errorCause(error: unknown): string {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
}
