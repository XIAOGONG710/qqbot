// token 估算。ST 在没有对应分词器时用同样的办法：UTF-8 字节数 / 3.35，向上取整
// （public/scripts/tokenizers.js guesstimate、BYTES_PER_TOKEN）。
// 只用于世界书预算和聊天记录截断，与模型真实计数有出入。

const BYTES_PER_TOKEN = 3.35;
const encoder = new TextEncoder();

export function estimateTokens(text: string): number {
    return Math.ceil(encoder.encode(text).length / BYTES_PER_TOKEN);
}
