// 配置：非机密项放在 JSON 文件里（默认 runtime/bot/config.json，可用 QQBOT_CONFIG 指定），
// 机密项只从环境变量读取：
//   QQBOT_LLM_API_KEY   模型接口的 key（必填）
//   QQBOT_ONEBOT_TOKEN  NapCat OneBot 网络配置里的 token（NapCat 没设 token 时可不填）

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DEFAULT_WORLD_INFO_SETTINGS, type WorldInfoSettings } from './st/world-info.ts';

export interface BotConfig {
    onebot: { url: string; token: string };
    llm: {
        baseUrl: string;
        model: string;
        apiKey: string;
        temperature: number;
        maxTokens: number;
        timeoutMs: number;
    };
    prompt: { maxContext: number; worldInfo: WorldInfoSettings };
    /** 角色卡路径；世界书按卡里的 extensions.world 在同目录找 <world>.json */
    characterCard: string;
    /** M1 只回复这一个人的私聊 */
    contact: { qq: number; name: string };
    /** 运行数据目录（聊天记录等） */
    dataDir: string;
}

type Json = Record<string, unknown>;

export function loadConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env): BotConfig {
    const path = resolvePath(repoRoot, env.QQBOT_CONFIG || 'runtime/bot/config.json');
    if (!existsSync(path)) {
        throw new Error(`找不到配置文件 ${path}，参照 packages/bot/config.example.json 创建`);
    }
    const file = JSON.parse(readFileSync(path, 'utf8')) as Json;
    const section = (key: string): Json => {
        const value = file[key];
        if (typeof value !== 'object' || value === null) throw new Error(`配置缺少 ${key}`);
        return value as Json;
    };
    const str = (obj: Json, key: string, where: string): string => {
        const value = obj[key];
        if (typeof value !== 'string' || !value) throw new Error(`配置 ${where}.${key} 应为非空字符串`);
        return value;
    };
    const num = (obj: Json, key: string, where: string, fallback?: number): number => {
        const value = obj[key] ?? fallback;
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`配置 ${where}.${key} 应为数字`);
        return value;
    };

    const apiKey = env.QQBOT_LLM_API_KEY;
    if (!apiKey) throw new Error('缺少环境变量 QQBOT_LLM_API_KEY');

    const onebot = section('onebot');
    const llm = section('llm');
    const prompt = (file.prompt ?? {}) as Json;
    const contact = section('contact');
    const qq = num(contact, 'qq', 'contact');
    if (!Number.isInteger(qq) || qq <= 0) throw new Error('配置 contact.qq 应为 QQ 号');

    return {
        onebot: { url: str(onebot, 'url', 'onebot'), token: env.QQBOT_ONEBOT_TOKEN ?? '' },
        llm: {
            baseUrl: str(llm, 'baseUrl', 'llm'),
            model: str(llm, 'model', 'llm'),
            apiKey,
            // 默认值同 ST 默认预设（Default.json）
            temperature: num(llm, 'temperature', 'llm', 1),
            maxTokens: num(llm, 'maxTokens', 'llm', 300),
            timeoutMs: num(llm, 'timeoutMs', 'llm', 120_000),
        },
        prompt: {
            maxContext: num(prompt, 'maxContext', 'prompt', 8192),
            worldInfo: { ...DEFAULT_WORLD_INFO_SETTINGS, ...((prompt.worldInfo ?? {}) as Partial<WorldInfoSettings>) },
        },
        characterCard: resolvePath(repoRoot, str(file, 'characterCard', '')),
        contact: { qq, name: str(contact, 'name', 'contact') },
        dataDir: resolvePath(repoRoot, typeof file.dataDir === 'string' ? file.dataDir : 'runtime/bot'),
    };
}

function resolvePath(repoRoot: string, path: string): string {
    return isAbsolute(path) ? path : resolve(repoRoot, path);
}
