// 配置：非机密项放在 JSON 文件里（默认 runtime/bot/config.json，可用 QQBOT_CONFIG 指定），
// 机密项只从环境变量读取：
//   QQBOT_LLM_API_KEY   模型接口的 key（必填）
//   QQBOT_ONEBOT_TOKEN  NapCat OneBot 网络配置里的 token（NapCat 没设 token 时可不填）

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { PROMPT_POST_PROCESSING, type PromptPostProcessing } from './st/prompt-converters.ts';
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
        /** 同 ST 自定义接口的 Prompt Post-Processing；默认不处理 */
        promptPostProcessing: PromptPostProcessing;
        /** 同 ST 自定义接口的 Include Body Parameters */
        extraBody: Record<string, unknown>;
    };
    prompt: { maxContext: number; worldInfo: WorldInfoSettings };
    /** 角色卡路径；世界书按卡里的 extensions.world 在同目录找 <world>.json */
    characterCard: string;
    /** 白名单：只回复这些人的私聊。name 是提示词里的 {{user}}。M1 都按男朋友处理（分档见 roadmap M2） */
    contacts: Contact[];
    /** 运行数据目录（聊天记录等） */
    dataDir: string;
}

export interface Contact {
    qq: number;
    name: string;
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
    const postProcessing = llm.promptPostProcessing ?? '';
    if (!PROMPT_POST_PROCESSING.includes(postProcessing as PromptPostProcessing)) {
        throw new Error(`配置 llm.promptPostProcessing 应为 ${PROMPT_POST_PROCESSING.map(v => JSON.stringify(v)).join(' / ')} 之一`);
    }
    const extraBody = llm.extraBody ?? {};
    if (typeof extraBody !== 'object' || extraBody === null || Array.isArray(extraBody)) {
        throw new Error('配置 llm.extraBody 应为对象');
    }
    if (!Array.isArray(file.contacts) || file.contacts.length === 0) throw new Error('配置 contacts 应为非空数组');
    const contacts = (file.contacts as unknown[]).map((value, i): Contact => {
        const where = `contacts[${i}]`;
        if (typeof value !== 'object' || value === null) throw new Error(`配置 ${where} 应为对象`);
        const qq = num(value as Json, 'qq', where);
        if (!Number.isInteger(qq) || qq <= 0) throw new Error(`配置 ${where}.qq 应为 QQ 号`);
        return { qq, name: str(value as Json, 'name', where) };
    });
    const duplicate = contacts.find((c, i) => contacts.findIndex(d => d.qq === c.qq) !== i);
    if (duplicate) throw new Error(`配置 contacts 里 QQ ${duplicate.qq} 重复`);

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
            promptPostProcessing: postProcessing as PromptPostProcessing,
            extraBody: extraBody as Record<string, unknown>,
        },
        prompt: {
            maxContext: num(prompt, 'maxContext', 'prompt', 8192),
            worldInfo: { ...DEFAULT_WORLD_INFO_SETTINGS, ...((prompt.worldInfo ?? {}) as Partial<WorldInfoSettings>) },
        },
        characterCard: resolvePath(repoRoot, str(file, 'characterCard', '')),
        contacts,
        dataDir: resolvePath(repoRoot, typeof file.dataDir === 'string' ? file.dataDir : 'runtime/bot'),
    };
}

function resolvePath(repoRoot: string, path: string): string {
    return isAbsolute(path) ? path : resolve(repoRoot, path);
}
