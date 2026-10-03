// OpenAI 兼容的 Chat Completions 接口（POST {baseUrl}/chat/completions，非流式）。

import type { OpenAIMessage } from './prompt.ts';

export interface LlmOptions {
    /** 例如 https://api.deepseek.com/v1（不含 /chat/completions） */
    baseUrl: string;
    model: string;
    /** 只从环境变量读取，不写进任何文件 */
    apiKey: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
}

export async function chatCompletion(options: LlmOptions, messages: OpenAIMessage[]): Promise<string> {
    const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(url, {
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
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`模型接口返回 ${response.status}：${body.slice(0, 500)}`);

    const json = JSON.parse(body) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error(`模型接口返回里没有文本：${body.slice(0, 500)}`);
    return content;
}
