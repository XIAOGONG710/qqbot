// 配置：非机密项放在 JSON 文件里（默认 runtime/bot/config.json，可用 QQBOT_CONFIG 指定），
// 机密项只从环境变量读取：
//   QQBOT_LLM_API_KEY   模型接口的 key（必填）
//   QQBOT_ONEBOT_TOKEN  NapCat OneBot 网络配置里的 token（NapCat 没设 token 时可不填）
// Koishi 插件（ADR 0008）没有 onebot 一节（连接归 adapter-onebot），其余部分和 config.json 同形，走同一个 parseAppConfig。

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { MEDIA_TIMEOUTS } from './media.ts';
import { FESTIVAL_MODES, type FestivalMode } from './festivals.ts';
import { PROACTIVE_MODES, type ProactiveMode } from './proactive.ts';
import { PROMPT_POST_PROCESSING, type PromptPostProcessing } from './st/prompt-converters.ts';
import { DEFAULT_WORLD_INFO_SETTINGS, type WorldInfoSettings } from './st/world-info.ts';

/** 看图能用的提供方（ADR 0055）。DeepSeek 复用聊天模型的 QQBOT_LLM_API_KEY，不另要 key。 */
export const VISION_PROVIDERS = ['deepseek'] as const;

/** 图片表情分阶段开关（ADR 0063）：先只收藏核对，再允许真实发送。 */
export const STICKER_MODES = ['off', 'collect', 'send'] as const;
export type StickerMode = (typeof STICKER_MODES)[number];

/** 名单里能用的档位（ADR 0003），从亲到疏 */
export const CONTACT_TIERS = ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger'] as const;
export type ContactTier = (typeof CONTACT_TIERS)[number];
/** 名单外的好友用的档位 */
export const UNLISTED_TIER = 'unlisted';
export type Tier = ContactTier | typeof UNLISTED_TIER;

/**
 * 配置里留空的项用的值。parseAppConfig 和 Koishi 插件的表单（Schema 的 .default()，ADR 0009）共用这一份，
 * 插件的测试保证两边一致。模型参数同 ST 默认预设（Default.json）。
 */
export const DEFAULTS = {
    llm: { temperature: 1, maxTokens: 300, timeoutMs: 120_000, promptPostProcessing: '' as PromptPostProcessing },
    prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
    memory: { timeoutMs: 30_000, recallTimeoutMs: 3000, bankPrefix: 'linmengyao' },
    vision: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: MEDIA_TIMEOUTS.vision },
    unlistedFriends: false,
    schedule: true,
    moody: true,
    speechCheck: true,
    herDays: true,
    autonomousLife: false,
    projectChoice: false,
    lifeInPrompt: false,
    grievance: false,
    npcAsks: false,
    feedbackCommands: false,
    realWeather: true,
    festivals: 'off' as FestivalMode,
    media: true,
    stickers: 'off' as StickerMode,
    candidates: 1,
    contextTurns: 0,
    contextContacts: [] as readonly number[],
    proactive: 'off' as ProactiveMode,
    dataDir: 'runtime/bot',
} as const;

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
    /** 名单外的好友私聊时是否用 unlisted 档回复（ADR 0003 决策 2），默认否；即使打开也有固定限流 */
    unlistedFriends: boolean;
    /** 按角色卡上的作息（ADR 0007）：时间块里写她现在在干什么。默认是；深夜测试时关掉 */
    schedule: boolean;
    /**
     * 看心情不回（ADR 0013 决策 4）：正聊着、对方一串只回了「哈哈」「嗯」这类反应时，偶尔不回；隔一分钟以上再来一条一定回。
     * 默认是；要开着作息
     */
    moody: boolean;
    /** 出口检查里查说话的毛病（ADR 0014）：助手腔、算账、怪对方没说、和她最近几次回复重复。默认是 */
    speechCheck: boolean;
    /**
     * 她自己的日子（ADR 0015）：每日心情（时间块里一行）、在读的书（聊到书或她在看书时一段）、看书的空闲活动、进度数字的出口检查。
     * 默认是；卡上没有心情和书（陌生人、名单外、旧卡）时没有
     */
    herDays: boolean;
    /**
     * 没人聊天时她一件件过日子（ADR 0040 规则自主选择器）：按作息、课表、饭点、世界里的事、一天的打算排行动，过完落进事件账（world/events.json）。
     * 默认关；开了以后从开的那一刻排起，行动还不进提示词（影子模式）。要开着她自己的日子，卡上要有作息和世界
     */
    autonomousLife: boolean;
    /**
     * 项目组合接管空闲安排（ADR 0056）：三天内未完成的课程作业优先于原来的柔性计划，状态行和生活执行器共用同一次决策。
     * 默认关；要开着 autonomousLife，先以影子账验证。
     */
    projectChoice: boolean;
    /**
     * 生活账接进提示词的第一步（ADR 0040 之后）：她这几天有几天练拍照修图、上一回是什么时候，按账上已经落账的写一行，只给看得到她爱好的档位。
     * 默认关；要开着 autonomousLife（账是它记的）
     */
    lifeInPrompt: boolean;
    /** 有起因的小别扭与和好（ADR 0074）：男朋友档，他隔了 ≥ 3 天才来、她发的一直没回时，头一两轮淡一点，他一哄就软下来。默认关 */
    grievance: boolean;
    /** 闺蜜的约（ADR 0061）：约、迟到、改约、取消进她的一天和「你那边」；默认关 */
    npcAsks: boolean;
    /**
     * 反馈通道（ADR 0073）：男朋友档对她的话回一个字「假」或「像」，记进 feedback/YYYY-MM.jsonl，不当聊天、她不回应。默认关
     */
    feedbackCommands: boolean;
    /** 公共节日（ADR 0076）：off 关；notes 她在时间块里知道今天、临近是什么节（平安夜、除夕、情人节……）；greet 再让她在情侣之间一定会说一句的节日里主动说（新年零点、除夕、平安夜、情人节……）。默认 off */
    festivals: FestivalMode;
    /** 真实天气（ADR 0048）：她的世界里的天气按济南（在学校）/ 青岛（放假在家）实际的，每 30 分钟从 Open-Meteo 取一次；取不到照旧按日期生成。默认是 */
    realWeather: boolean;
    /**
     * 听语音、看图上的字（ADR 0052）：他发的语音用 QQ 自带的语音转文字、照片和截图用 NapCat 的 OCR 取上面的字，写进聊天记录；
     * 转不出来、超时照旧「[语音]」「[图片]」。默认是
     */
    media: boolean;
    /** 图片表情（ADR 0063）：off 关闭；collect 只收藏核对；send 才会进提示词并真实发送。默认 off */
    stickers?: StickerMode;
    /** 看图（ADR 0055）：有这一节才把普通图片交给 DeepSeek；复用 QQBOT_LLM_API_KEY */
    vision?: { provider: (typeof VISION_PROVIDERS)[number]; model: string; baseUrl?: string; timeoutMs: number };
    /** 他难过、说亲密话、收尾时一次生成几个候选、按规则挑一个（ADR 0041）。默认 1（不挑）；3 是三倍的模型调用（并行，不加时间） */
    candidates: number;
    /**
     * 原文只放最近几轮、更早的整理成要点（ADR 0043）：0 关（默认，最近 80 条）；开了是至少留几轮原文（实验用 10），切口每 4 轮挪一次。
     * 要点在后台整理，没整理好的那一轮照旧最近 80 条。只对开了长期记忆的联系人
     */
    contextTurns: number;
    /** contextTurns 只对这几个 QQ 开（灰度）；空 = 名单里开了记忆的都开 */
    contextContacts: readonly number[];
    /**
     * 主动消息（ADR 0011）：off 关（默认）；dryRun 试运行，照算照生成，只写日志不发；on 开。
     * 只对卡上写了 proactive 的档位（现在只有男朋友档），要开着作息
     */
    proactive: ProactiveMode;
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
    /** 别人提起他时她知道的（ADR 0016）：名单里别人的话里出现他的称呼时给她看；没写就是别人提起他时她不认识 */
    intro?: string;
    /**
     * 这个人是否知道她是程序（ADR 0067）。true：知道，被认真问到是不是 AI 时按原卡（不承认 / 绕开）；
     * false 或没写：不知道（或还没确认），用承认版卡，被认真问到时承认。默认安全：漏填不会对不知情的人否认
     */
    knowsBot?: boolean;
    /**
     * 反馈通道（ADR 0073）：这个人也可以对她的话回「假」/「像」。男朋友档不用写（本来就可以）；
     * 其余档位要一个一个人地写 true，不会因为档位相同就放开。他知道有这个功能，才写。默认没有
     */
    feedback?: boolean;
}

/** 这个联系人是不是可以用反馈通道（ADR 0073）：男朋友档，或名单里单独写了 feedback: true */
export function canGiveFeedback(contact: Pick<Contact, 'tier' | 'feedback'>): boolean {
    return contact.tier === 'boyfriend' || contact.feedback === true;
}

/** 这个联系人用哪一张卡（ADR 0067）：名单外那一档本来就是承认版；名单内知道的用原卡，其余用「<档位>-open」 */
export function cardKey(contact: Pick<Contact, 'tier' | 'knowsBot'>): string {
    return contact.tier === UNLISTED_TIER || contact.knowsBot === true ? contact.tier : `${contact.tier}-open`;
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
    const postProcessing = llm.promptPostProcessing ?? DEFAULTS.llm.promptPostProcessing;
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
        const intro = (value as Json).intro;
        if (intro !== undefined) {
            if (typeof intro !== 'string') throw new Error(`配置 ${where}.intro 应为字符串`);
            if (intro.trim()) contact.intro = intro.trim();
        }
        const knowsBot = (value as Json).knowsBot;
        if (knowsBot !== undefined) {
            if (typeof knowsBot !== 'boolean') throw new Error(`配置 ${where}.knowsBot 应为 true 或 false（她是程序，这个人知不知道）`);
            contact.knowsBot = knowsBot;
        }
        const feedback = (value as Json).feedback;
        if (feedback !== undefined) {
            if (typeof feedback !== 'boolean') throw new Error(`配置 ${where}.feedback 应为 true 或 false（这个人是否可以对她的话回「假」/「像」）`);
            if (feedback) contact.feedback = true;
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
            timeoutMs: num(m, 'timeoutMs', 'memory', DEFAULTS.memory.timeoutMs),
            recallTimeoutMs: num(m, 'recallTimeoutMs', 'memory', DEFAULTS.memory.recallTimeoutMs),
            bankPrefix: typeof m.bankPrefix === 'string' && m.bankPrefix ? m.bankPrefix : DEFAULTS.memory.bankPrefix,
        };
    }

    let vision: AppConfig['vision'];
    if (file.vision !== undefined) {
        const v = section(file, 'vision');
        const provider = str(v, 'provider', 'vision');
        if (!VISION_PROVIDERS.some(candidate => candidate === provider)) {
            throw new Error(`配置 vision.provider「${provider}」不认识：应为 ${VISION_PROVIDERS.join(' / ')} 之一`);
        }
        vision = {
            provider: provider as (typeof VISION_PROVIDERS)[number],
            model: str(v, 'model', 'vision'),
            ...(typeof v.baseUrl === 'string' && v.baseUrl ? { baseUrl: v.baseUrl } : {}),
            timeoutMs: num(v, 'timeoutMs', 'vision', MEDIA_TIMEOUTS.vision),
        };
    }

    return {
        llm: {
            baseUrl: str(llm, 'baseUrl', 'llm'),
            model: str(llm, 'model', 'llm'),
            apiKey,
            temperature: num(llm, 'temperature', 'llm', DEFAULTS.llm.temperature),
            maxTokens: num(llm, 'maxTokens', 'llm', DEFAULTS.llm.maxTokens),
            timeoutMs: num(llm, 'timeoutMs', 'llm', DEFAULTS.llm.timeoutMs),
            promptPostProcessing: postProcessing as PromptPostProcessing,
            extraBody: extraBody as Record<string, unknown>,
        },
        prompt: {
            maxContext: num(prompt, 'maxContext', 'prompt', DEFAULTS.prompt.maxContext),
            worldInfo: { ...DEFAULTS.prompt.worldInfo, ...((prompt.worldInfo ?? {}) as Partial<WorldInfoSettings>) },
            pinExamples: bool(prompt, 'pinExamples', 'prompt', DEFAULTS.prompt.pinExamples),
        },
        characterCard,
        contacts,
        unlistedFriends: bool(file, 'unlistedFriends', '', DEFAULTS.unlistedFriends),
        schedule: bool(file, 'schedule', '', DEFAULTS.schedule),
        moody: bool(file, 'moody', '', DEFAULTS.moody),
        speechCheck: bool(file, 'speechCheck', '', DEFAULTS.speechCheck),
        herDays: bool(file, 'herDays', '', DEFAULTS.herDays),
        autonomousLife: bool(file, 'autonomousLife', '', DEFAULTS.autonomousLife),
        projectChoice: bool(file, 'projectChoice', '', DEFAULTS.projectChoice),
        lifeInPrompt: bool(file, 'lifeInPrompt', '', DEFAULTS.lifeInPrompt),
        grievance: bool(file, 'grievance', '', DEFAULTS.grievance),
        npcAsks: bool(file, 'npcAsks', '', DEFAULTS.npcAsks),
        feedbackCommands: bool(file, 'feedbackCommands', '', DEFAULTS.feedbackCommands),
        realWeather: bool(file, 'realWeather', '', DEFAULTS.realWeather),
        festivals: festivalMode(file.festivals),
        media: bool(file, 'media', '', DEFAULTS.media),
        stickers: stickerMode(file.stickers),
        ...(vision ? { vision } : {}),
        candidates: candidateCount(file.candidates),
        contextTurns: contextTurnCount(file.contextTurns),
        contextContacts: qqList(file.contextContacts, 'contextContacts'),
        proactive: proactiveMode(file.proactive),
        ...(memory ? { memory } : {}),
        dataDir: resolvePath(repoRoot, typeof file.dataDir === 'string' ? file.dataDir : DEFAULTS.dataDir),
    };
}

function candidateCount(value: unknown): number {
    if (value === undefined) return DEFAULTS.candidates;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) throw new Error('配置 candidates 应为 1–5 的整数');
    return value;
}

function contextTurnCount(value: unknown): number {
    if (value === undefined) return DEFAULTS.contextTurns;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 40) throw new Error('配置 contextTurns 应为 0–40 的整数（0 是关）');
    return value;
}

function qqList(value: unknown, key: string): readonly number[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(qq => typeof qq === 'number' && Number.isInteger(qq) && qq > 0)) throw new Error(`配置 ${key} 应为 QQ 号（数字）的数组`);
    return value;
}

function proactiveMode(value: unknown): ProactiveMode {
    if (value === undefined) return DEFAULTS.proactive;
    if (!PROACTIVE_MODES.includes(value as ProactiveMode)) throw new Error(`配置 proactive 应为 ${PROACTIVE_MODES.map(v => JSON.stringify(v)).join(' / ')} 之一`);
    return value as ProactiveMode;
}

function festivalMode(value: unknown): FestivalMode {
    if (value === undefined) return DEFAULTS.festivals;
    if (!FESTIVAL_MODES.includes(value as FestivalMode)) throw new Error(`配置 festivals 应为 ${FESTIVAL_MODES.map(v => JSON.stringify(v)).join(' / ')} 之一`);
    return value as FestivalMode;
}

function stickerMode(value: unknown): StickerMode {
    if (value === undefined) return DEFAULTS.stickers;
    if (!STICKER_MODES.includes(value as StickerMode)) {
        throw new Error(`配置 stickers 应为 ${STICKER_MODES.map(v => JSON.stringify(v)).join(' / ')} 之一`);
    }
    return value as StickerMode;
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
