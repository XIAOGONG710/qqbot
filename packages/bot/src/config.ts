// 配置：非机密项放在 JSON 文件里（默认 runtime/bot/config.json，可用 QQBOT_CONFIG 指定），
// 机密项只从环境变量读取：
//   QQBOT_LLM_API_KEY   模型接口的 key（必填）
//   QQBOT_ONEBOT_TOKEN  NapCat OneBot 网络配置里的 token（NapCat 没设 token 时可不填）
// Koishi 插件（ADR 0008）没有 onebot 一节（连接归 adapter-onebot），其余部分和 config.json 同形，走同一个 parseAppConfig。

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { PROMPT_POST_PROCESSING, type PromptPostProcessing } from './st/prompt-converters.ts';
import { DEFAULT_WORLD_INFO_SETTINGS, type WorldInfoSettings } from './st/world-info.ts';

/** 名单里能用的档位（ADR 0003），从亲到疏 */
export const CONTACT_TIERS = ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger'] as const;
export type ContactTier = (typeof CONTACT_TIERS)[number];
/** 名单外的好友用的档位 */
export const UNLISTED_TIER = 'unlisted';
export type Tier = ContactTier | typeof UNLISTED_TIER;

/** 独立入口（main.ts）的配置：连 NapCat 的 onebot 一节 + 其余部分 */
export interface BotConfig extends AppConfig {
    onebot: { url: string; token: string };
}

/** 两个入口共用的部分 */
export interface AppConfig {
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
    /** pinExamples：同 ST 的 Example Messages Behavior 选 Always include examples，默认否（同 ST 默认的逐步挤出） */
    prompt: { maxContext: number; worldInfo: WorldInfoSettings; pinExamples: boolean };
    /** 角色卡路径，{tier} 换成档位名；世界书按卡里的 extensions.world 在同目录找 <world>.json */
    characterCard: string;
    /** 名单：按各自的档位回复这些人的私聊。name 是提示词里的 {{user}} */
    contacts: Contact[];
    /** 名单外的好友私聊时是否用 unlisted 档回复（ADR 0003 决策 2），默认是 */
    unlistedFriends: boolean;
    /** 按角色卡上的作息（ADR 0007）：时间块里写她现在在干什么。默认是；深夜测试时关掉 */
    schedule: boolean;
    /** 长期记忆（ADR 0004 决策 3，Hindsight 服务）；配置里没有 memory 就不用 */
    memory?: {
        /** Hindsight API 地址，例如 http://127.0.0.1:8888 */
        baseUrl: string;
        /** 写入、建库等请求的超时 */
        timeoutMs: number;
        /** 生成前召回的超时：超时就不带记忆，不拖住回复 */
        recallTimeoutMs: number;
        /** bank ID 前缀，后面接 QQ 号的哈希 */
        bankPrefix: string;
    };
    /** 运行数据目录（聊天记录等） */
    dataDir: string;
}

export interface Contact {
    qq: number;
    name: string;
    tier: Tier;
    /** 一两句“他是谁”，放在 ST 人设描述（personaDescription）的位置 */
    persona?: string;
}

type Json = Record<string, unknown>;

export function loadConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env): BotConfig {
    const path = resolvePath(repoRoot, env.QQBOT_CONFIG || 'runtime/bot/config.json');
    if (!existsSync(path)) {
        throw new Error(`找不到配置文件 ${path}，参照 packages/bot/config.example.json 创建`);
    }
    const file = JSON.parse(readFileSync(path, 'utf8')) as Json;
    const app = parseAppConfig(file, repoRoot, env);
    const onebot = section(file, 'onebot');
    return { onebot: { url: str(onebot, 'url', 'onebot'), token: env.QQBOT_ONEBOT_TOKEN ?? '' }, ...app };
}

/** config.json 里除 onebot 之外的部分（Koishi 插件的配置也是这个形状）：校验、补默认值，相对路径按仓库根目录解析 */
export function parseAppConfig(file: Json, repoRoot: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
    const apiKey = env.QQBOT_LLM_API_KEY;
    if (!apiKey) throw new Error('缺少环境变量 QQBOT_LLM_API_KEY');

    const llm = section(file, 'llm');
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
        const tier = (value as Json).tier;
        if (!CONTACT_TIERS.includes(tier as ContactTier)) {
            throw new Error(`配置 ${where}.tier 应为 ${CONTACT_TIERS.join(' / ')} 之一`);
        }
        const contact: Contact = { qq, name: str(value as Json, 'name', where), tier: tier as ContactTier };
        const persona = (value as Json).persona;
        if (persona !== undefined) {
            if (typeof persona !== 'string') throw new Error(`配置 ${where}.persona 应为字符串`);
            if (persona) contact.persona = persona;
        }
        return contact;
    });
    const duplicate = contacts.find((c, i) => contacts.findIndex(d => d.qq === c.qq) !== i);
    if (duplicate) throw new Error(`配置 contacts 里 QQ ${duplicate.qq} 重复`);

    const characterCard = resolvePath(repoRoot, str(file, 'characterCard', ''));
    if (!characterCard.includes('{tier}')) throw new Error('配置 characterCard 应包含 {tier}，例如 characters/linmengyao/st/linmengyao-{tier}.json');

    let memory: AppConfig['memory'];
    if (file.memory !== undefined) {
        const m = section(file, 'memory');
        memory = {
            baseUrl: str(m, 'baseUrl', 'memory'),
            timeoutMs: num(m, 'timeoutMs', 'memory', 30_000),
            recallTimeoutMs: num(m, 'recallTimeoutMs', 'memory', 3000),
            bankPrefix: typeof m.bankPrefix === 'string' && m.bankPrefix ? m.bankPrefix : 'linmengyao',
        };
    }

    return {
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
            pinExamples: bool(prompt, 'pinExamples', 'prompt', false),
        },
        characterCard,
        contacts,
        unlistedFriends: bool(file, 'unlistedFriends', '', true),
        schedule: bool(file, 'schedule', '', true),
        ...(memory ? { memory } : {}),
        dataDir: resolvePath(repoRoot, typeof file.dataDir === 'string' ? file.dataDir : 'runtime/bot'),
    };
}

function section(file: Json, key: string): Json {
    const value = file[key];
    if (typeof value !== 'object' || value === null) throw new Error(`配置缺少 ${key}`);
    return value as Json;
}

function str(obj: Json, key: string, where: string): string {
    const value = obj[key];
    if (typeof value !== 'string' || !value) throw new Error(`配置 ${where}.${key} 应为非空字符串`);
    return value;
}

function bool(obj: Json, key: string, where: string, fallback: boolean): boolean {
    const value = obj[key] ?? fallback;
    if (typeof value !== 'boolean') throw new Error(`配置 ${where}.${key} 应为 true 或 false`);
    return value;
}

function num(obj: Json, key: string, where: string, fallback?: number): number {
    const value = obj[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`配置 ${where}.${key} 应为数字`);
    return value;
}

function resolvePath(repoRoot: string, path: string): string {
    return isAbsolute(path) ? path : resolve(repoRoot, path);
}
