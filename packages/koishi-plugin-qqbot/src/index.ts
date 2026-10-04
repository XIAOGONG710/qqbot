// Koishi 插件（ADR 0008）：adapter-onebot + packages/bot 的 app.ts。这里只做接线：
// - 配置 Schema（控制台表单），转成和 runtime/bot/config.json 同形的对象，走同一个 parseAppConfig；
// - 中间件插到最前面，NapCat 的直接私聊交给 app（不调 next，别的插件看不到），其余放行；
// - 发送、补回走适配器的原始 OneBot 接口（和 onebot.ts 发的是同一个请求）；
// - 连上就补回；adapter-onebot 6.9.4 断线后不会自己重连（上游 PR #81），这里按退避调 bot.start()；
// - 角色卡、世界书文件变了就重启插件（和控制台改配置一样：旧的停掉，新的按聊天记录 catchUp）。
// 模型 key 只从环境变量 QQBOT_LLM_API_KEY 读。

import type * as Koishi from 'koishi';
import type { Bot, Context, Session } from 'koishi';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, type Transport } from '../../bot/src/app.ts';
import type { HistoryMessage } from '../../bot/src/backfill.ts';
import { CONTACT_TIERS, parseAppConfig, type ContactTier } from '../../bot/src/config.ts';
import { createLog, type Log } from '../../bot/src/log.ts';
import { isPrivateFriendMessage, type OneBotEvent } from '../../bot/src/onebot.ts';
import { PROMPT_POST_PROCESSING, type PromptPostProcessing } from '../../bot/src/st/prompt-converters.ts';

// koishi 的 ESM 入口是坏的（@koishijs/loader/lib/index.mjs 默认导入了一个 CJS 文件）：取 loader 自己用的那份 CJS
const { Schema } = createRequire(import.meta.url)('koishi') as typeof Koishi;
/** @satorijs/protocol 的 Status：类型里是 const enum，按值比较 */
const OFFLINE = 0;
const ONLINE = 1;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const name = 'qqbot';

const TIER_LABELS: Record<ContactTier, string> = {
    boyfriend: '男朋友',
    bestie: '闺蜜',
    girl_friend: '女生熟人',
    known: '熟人',
    classmate: '同学',
    stranger: '陌生人',
};

export interface Config {
    contacts: { qq: number; name: string; tier: ContactTier; persona?: string }[];
    unlistedFriends: boolean;
    schedule: boolean;
    llm: {
        baseUrl: string;
        model: string;
        temperature?: number;
        maxTokens?: number;
        timeoutMs?: number;
        promptPostProcessing: PromptPostProcessing;
        /** JSON 文本 */
        extraBody: string;
    };
    prompt: {
        maxContext?: number;
        pinExamples: boolean;
        worldInfo: { depth?: number; budgetPercent?: number; budgetCap?: number; includeNames?: boolean; caseSensitive?: boolean; matchWholeWords?: boolean };
    };
    memory: { enabled: boolean; baseUrl?: string; timeoutMs?: number; recallTimeoutMs?: number; bankPrefix?: string };
    characterCard: string;
    dataDir: string;
}

// 数值类参数不写默认值：留空时由 parseAppConfig 补，默认值只有 config.ts 一份
export const Config: Koishi.Schema<Config> = Schema.intersect([
    Schema.object({
        contacts: Schema.array(Schema.object({
            qq: Schema.natural().required().description('QQ 号（须是小号的好友）'),
            name: Schema.string().required().description('称呼（提示词里的 {{user}}）'),
            tier: Schema.union(CONTACT_TIERS.map(tier => Schema.const(tier).description(`${tier}（${TIER_LABELS[tier]}）`))).required().description('档位'),
            persona: Schema.string().role('textarea').description('一两句「他是谁」，可选'),
        })).role('table').description('回复名单：每人按自己的档位用对应的角色卡（ADR 0003）。换档后旧记录不进提示词'),
        unlistedFriends: Schema.boolean().default(true).description('名单外的好友私聊时按 unlisted 档回复（被认真问到时承认是 AI；任何人加小号好友就能调用模型）'),
        schedule: Schema.boolean().default(true).description('按角色卡上的作息：凌晨睡觉不回、上课晚回、打字有时间。深夜测试时关掉'),
    }).description('联系人'),
    Schema.object({
        llm: Schema.object({
            baseUrl: Schema.string().required().description('OpenAI 兼容接口，不含 /chat/completions'),
            model: Schema.string().required(),
            temperature: Schema.number().description('留空为 1（同 ST 默认预设）'),
            maxTokens: Schema.natural().description('留空为 300'),
            timeoutMs: Schema.natural().description('整个请求的超时（毫秒），留空为 120000'),
            promptPostProcessing: Schema.union([...PROMPT_POST_PROCESSING]).default('').description('同 ST 自定义接口的 Prompt Post-Processing（DeepSeek 用 semi）'),
            extraBody: Schema.string().role('textarea').default('{}').description('合并进请求体的额外参数（JSON），同 ST 的 Include Body Parameters'),
        }).description('模型（key 只从环境变量 QQBOT_LLM_API_KEY 读）'),
    }),
    Schema.object({
        prompt: Schema.object({
            maxContext: Schema.natural().description('上下文 token 上限（同 ST 的 Context Size），留空为 8192'),
            pinExamples: Schema.boolean().default(false).description('示例对话常驻，不被聊天记录挤掉（同 ST 的 Always include examples）'),
            worldInfo: Schema.object({
                depth: Schema.natural().description('扫描最近几条消息，留空为 2'),
                budgetPercent: Schema.natural().description('占上下文的百分比，留空为 25'),
                budgetCap: Schema.natural().description('0 = 不封顶'),
                includeNames: Schema.boolean(),
                caseSensitive: Schema.boolean(),
                matchWholeWords: Schema.boolean(),
            }).description('世界书（留空同 ST 默认）'),
        }).description('提示词'),
    }),
    Schema.object({
        memory: Schema.object({
            enabled: Schema.boolean().default(false).description('长期记忆（Hindsight）'),
            baseUrl: Schema.string().default('http://127.0.0.1:8888'),
            timeoutMs: Schema.natural().description('写入等请求的超时（毫秒），留空为 30000'),
            recallTimeoutMs: Schema.natural().description('生成前召回的超时（毫秒），超时就不带记忆，留空为 3000'),
            bankPrefix: Schema.string().description('bank ID 前缀，留空为 linmengyao'),
        }).description('长期记忆'),
    }),
    Schema.object({
        characterCard: Schema.string().default('characters/linmengyao/st/linmengyao-{tier}.json').description('角色卡路径，{tier} 换成档位名；相对路径按仓库根目录'),
        dataDir: Schema.string().default('runtime/bot').description('聊天记录、换档记录、日志等；和独立入口 main.ts 共用时两者不能同时运行（单实例锁）'),
    }).description('文件'),
]);

const dropUndefined = (obj: object) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** 控制台表单的配置 → config.json 的形状（交给 parseAppConfig 校验、补默认值） */
export function toAppConfigInput(config: Config): Record<string, unknown> {
    let extraBody: unknown;
    try {
        extraBody = JSON.parse(config.llm.extraBody || '{}');
    } catch (error) {
        throw new Error(`配置 llm.extraBody 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    const { enabled, ...memory } = config.memory ?? { enabled: false };
    return {
        llm: dropUndefined({ ...config.llm, extraBody }),
        prompt: dropUndefined({ ...config.prompt, worldInfo: dropUndefined(config.prompt?.worldInfo ?? {}) }),
        characterCard: config.characterCard,
        contacts: config.contacts.map(contact => dropUndefined(contact)),
        unlistedFriends: config.unlistedFriends,
        schedule: config.schedule,
        ...(enabled ? { memory: dropUndefined(memory) } : {}),
        dataDir: config.dataDir,
    };
}

/** 断线后重连的等待：5 秒、10 秒、30 秒，之后每分钟一次 */
export const RECONNECT_MS = [5_000, 10_000, 30_000, 60_000];

/** 角色卡、世界书文件改动后，等这么久没有新的改动再重启（转换器一次写十几个文件） */
const CARD_RELOAD_DELAY_MS = 2000;

export function apply(ctx: Context, config: Config) {
    const appConfig = parseAppConfig(toAppConfigInput(config), repoRoot);
    // 同一份按天日志（runtime/bot/logs），grep 的核对方式不变；控制台里看 ctx.logger 那份
    const fileLog = createLog(join(appConfig.dataDir, 'logs'), undefined, () => {});
    const logger = ctx.logger('qqbot');
    const log: Log = message => {
        logger.info(message);
        fileLog(message);
    };

    // 只支持一个 NapCat 账号：用在线的那个
    const onlineBot = () => {
        const bot = ctx.bots.find(b => b.platform === 'onebot' && b.status === ONLINE);
        if (!bot) throw new Error('NapCat 未连接');
        return bot as Bot & { internal: OneBotInternal };
    };
    const transport: Transport = {
        sendPrivateText: async (userId, text) => Number(await onlineBot().internal.sendPrivateMsg(userId, [{ type: 'text', data: { text } }])),
        friendHistory: (userId, count) => onlineBot().internal.getFriendMsgHistory(String(userId), undefined, count),
    };
    const app = startApp({ config: appConfig, transport, log });
    ctx.on('dispose', () => app.stop());

    ctx.middleware((session, next) => {
        const event = (session as Session & { onebot?: OneBotEvent }).onebot;
        if (session.platform !== 'onebot' || !event || !isPrivateFriendMessage(event)) return next();
        app.receive(event);
    }, true);

    let reconnects = 0;
    let warnedTemplate = false;
    ctx.on('login-updated', ({ bot }) => {
        if (bot.platform !== 'onebot') return;
        if (bot.status === ONLINE) {
            reconnects = 0;
            log(`NapCat 账号 ${bot.selfId} 已就绪`);
            void app.connected(Number(bot.selfId));
        } else if (bot.status === OFFLINE) {
            const token = String((bot.config as { token?: unknown }).token ?? '');
            if (token.includes('${{') && !warnedTemplate) {
                warnedTemplate = true;
                log('adapter-onebot 的 token 是没插值的 ${{ }} 原文：控制台保存适配器配置时不做插值，重启 Koishi 才会生效（ADR 0008）');
            }
            const delay = RECONNECT_MS[Math.min(reconnects++, RECONNECT_MS.length - 1)]!;
            log(`NapCat 连接断开，${delay / 1000} 秒后重连`);
            // 控制台重载过适配器的话旧 bot 已作废：到点时按 sid 找现在的
            const sid = bot.sid;
            ctx.setTimeout(() => {
                const current = ctx.bots.find(b => b.sid === sid);
                if (current?.status === OFFLINE) void current.start();
            }, delay);
        }
    });
    // 插件因改配置重启时适配器还连着，不会再有上线事件
    for (const bot of ctx.bots) {
        if (bot.platform === 'onebot' && bot.status === ONLINE) void app.connected(Number(bot.selfId));
    }

    // 角色卡、世界书由转换器生成（tiers.toml → characters/<角色>/st/），变了就重启插件重新读
    const cardDir = dirname(appConfig.characterCard);
    let reloadTimer: (() => void) | undefined;
    const watcher = watch(cardDir, (_event, filename) => {
        if (!filename?.endsWith('.json')) return;
        reloadTimer?.();
        reloadTimer = ctx.setTimeout(() => {
            log(`${cardDir} 下的角色卡或世界书变了，重启插件重新读`);
            ctx.scope.restart();
        }, CARD_RELOAD_DELAY_MS);
    });
    ctx.on('dispose', () => watcher.close());
}

/** adapter-onebot 的 bot.internal 里用到的两个（Internal.defineExtract，返回值已经取出 message_id / messages） */
interface OneBotInternal {
    sendPrivateMsg(userId: number, message: { type: string; data: Record<string, unknown> }[]): Promise<number>;
    getFriendMsgHistory(userId: string, messageSeq: undefined, count: number): Promise<HistoryMessage[]>;
}
