// Koishi 插件（ADR 0008）：adapter-onebot + packages/bot 的 app.ts。这里只做接线：
// - 配置 Schema（控制台表单，ADR 0009），转成和 runtime/bot/config.json 同形的对象，走同一个 parseAppConfig；
// - 中间件插到最前面，NapCat 的直接私聊交给 app（不调 next，别的插件看不到），其余放行；
// - 发送、补回走适配器的原始 OneBot 接口（和 onebot.ts 发的是同一个请求）；
// - 连上就补回；adapter-onebot 6.9.4 断线后不会自己重连（上游 PR #81），这里按退避调 bot.start()；
// - 角色卡、世界书文件变了就重启插件（和控制台改配置一样：旧的停掉，新的按聊天记录 catchUp）。
// 模型 key 只从环境变量 QQBOT_LLM_API_KEY 读。

import type * as Koishi from 'koishi';
import type { Bot, Context, Session } from 'koishi';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, type Transport } from '../../bot/src/app.ts';
import type { HistoryMessage } from '../../bot/src/backfill.ts';
import { CONTACT_TIERS, DEFAULTS, STICKER_MODES, parseAppConfig, type AppConfig, type ContactTier, type StickerMode } from '../../bot/src/config.ts';
import { createLog, type Log } from '../../bot/src/log.ts';
import { isPrivateFriendMessage, type OneBotEvent } from '../../bot/src/onebot.ts';
import { ocrLines, type MediaReader } from '../../bot/src/media.ts';
import { textToSegments } from '../../bot/src/qq-faces.ts';
import { PROACTIVE_MODES, type ProactiveMode } from '../../bot/src/proactive.ts';
import { PROMPT_POST_PROCESSING, type PromptPostProcessing } from '../../bot/src/st/prompt-converters.ts';
import { configuredImageDescriber, STICKER_VISION_PROMPT } from '../../bot/src/vision.ts';
import { stickerDecider, stickerShelf } from '../../bot/src/stickers.ts';
import { qqFavorites } from '../../bot/src/sticker-favorites.ts';
import { bqbDiscover } from '../../bot/src/sticker-sources.ts';
import { characterPaths, registerConsole, setConsoleState } from './console.ts';

// koishi 的 ESM 入口是坏的（@koishijs/loader/lib/index.mjs 默认导入了一个 CJS 文件）：取 loader 自己用的那份 CJS
const { Schema } = createRequire(import.meta.url)('koishi') as typeof Koishi;
/** @satorijs/protocol 的 Status：类型里是 const enum，按值比较 */
const OFFLINE = 0;
const ONLINE = 1;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const name = 'qqbot';
// apply 在实例（fork）里运行：配置有误、apply 抛错时，控制台侧栏把插件标成失败（红点）。
// 不是 reusable 时只有插件主体失败，控制台看的实例仍是绿点，还弹「配置已重载」（ADR 0009 试验结果第 2 条）
export const reusable = true;
// Koishi 通用的「过滤器设置」对这个插件没用。不导出 usage：用户不要页面顶部那段说明（10-05）
export const filter = false;

const TIER_LABELS: Record<ContactTier, string> = {
    boyfriend: '男朋友',
    bestie: '闺蜜',
    girl_friend: '女生熟人',
    known: '熟人',
    classmate: '同学',
    stranger: '陌生人',
};

/** 思考（DeepSeek 的 thinking / reasoning_effort，ADR 0009 A4）；不选 = 两个参数都不传，用接口默认 */
export const THINKING = ['off', 'low', 'high', 'max'] as const;
export type Thinking = (typeof THINKING)[number];
const THINKING_LABELS: Record<Thinking, string> = { off: '关', low: '低', high: '高', max: '最高' };

const PROACTIVE_LABELS: Record<ProactiveMode, string> = { off: '关', dryRun: '试运行（只写日志不发）', on: '开' };
const STICKER_LABELS: Record<StickerMode, string> = { off: '关', collect: '只收藏核对（不发）', send: '收藏并发送' };

const POST_PROCESSING_LABELS: Record<PromptPostProcessing, string> = {
    '': '不处理',
    merge: 'merge：合并相邻的同角色消息',
    semi: 'semi：角色交替（DeepSeek 用这个）',
    strict: 'strict：用户开头、角色交替',
};

const MEMORY_BASE_URL = 'http://127.0.0.1:8888';
const CHARACTER_CARD = 'characters/linmengyao/st/linmengyao-{tier}.json';
/** 不能是空串或只有空白（表单上直接提示） */
const NOT_BLANK = /\S/;

/** QQ 号的下拉选项（小号的好友列表），插件连上 NapCat 后生成 */
const FRIENDS_SCHEMA = 'qqbot.friends';
const QQ_DESCRIPTION = '**QQ 号**：从小号的好友里选';

export interface Config {
    contacts: { qq: number; name: string; tier: ContactTier; persona?: string; intro?: string }[];
    unlistedFriends: boolean;
    schedule: boolean;
    media: boolean;
    stickers: StickerMode;
    vision: { enabled: boolean; baseUrl?: string; model?: string; timeoutMs?: number };
    moody: boolean;
    speechCheck: boolean;
    herDays: boolean;
    autonomousLife: boolean;
    projectChoice: boolean;
    lifeInPrompt: boolean;
    realWeather: boolean;
    candidates: number;
    contextTurns: number;
    contextContacts: number[];
    proactive: ProactiveMode;
    llm: {
        baseUrl: string;
        model: string;
        thinking?: Thinking;
        temperature: number;
        maxTokens: number;
        timeoutMs: number;
        promptPostProcessing: PromptPostProcessing;
        /** JSON 文本 */
        extraBody: string;
    };
    prompt: {
        maxContext: number;
        pinExamples: boolean;
        worldInfo: { depth: number; budgetPercent: number; budgetCap: number; includeNames: boolean; caseSensitive: boolean; matchWholeWords: boolean };
    };
    memory: { enabled: boolean; baseUrl?: string; timeoutMs?: number; recallTimeoutMs?: number; bankPrefix?: string };
    characterCard: string;
    dataDir: string;
}

// 键名不改（旧的 koishi.yml 要能读）；控制台把键名当标题，中文名放在说明的开头。
// 默认值都来自 config.ts 的 DEFAULTS，表单里显示的就是实际在用的值；等于默认值的项不写进 koishi.yml。
// 每个对象只放在一个组里：拆到两个组的话，schema.simplify（loader 写回、控制台的「按 JSON 编辑」都用它）
// 会用后一组的整个对象盖掉前一组的。只有嵌套的对象能折叠（ADR 0009 试验结果第 4 条）。
export const Config: Koishi.Schema<Config> = Schema.intersect([
    Schema.object({
        contacts: Schema.array(Schema.object({
            // 说明写在动态 schema 上（它会顶替这里的说明）
            qq: Schema.dynamic(FRIENDS_SCHEMA),
            name: Schema.string().required().pattern(NOT_BLANK).description('**称呼**：提示词里的 {{user}}'),
            tier: Schema.union(CONTACT_TIERS.map(tier => Schema.const(tier).description(TIER_LABELS[tier]))).required()
                .description('**档位**：按这一档的角色卡回复（ADR 0003）。换档后，之前的聊天记录不再进提示词'),
            persona: Schema.string().role('textarea', { rows: [2, 8] }).description('**他是谁**：一两句，可选'),
            intro: Schema.string().role('textarea', { rows: [1, 4] })
                .description('**别人提起时**：她认识的这个人，一两句（例如「网上认识的朋友，比较熟」）。名单里别人说起他的称呼时给她看，留空就是不认识（ADR 0016）'),
        })).description('**回复名单**：每人按自己的档位回复'),
        unlistedFriends: Schema.boolean().default(DEFAULTS.unlistedFriends)
            .description('**名单外的好友**：私聊时也回复，按 unlisted 档（被认真问到时承认是 AI；任何人加小号好友就能调用模型）'),
        schedule: Schema.boolean().default(DEFAULTS.schedule)
            .description('**作息**：按角色卡上的作息，凌晨睡觉不回、上课晚回、打字有时间。深夜测试时关掉'),
        media: Schema.boolean().default(DEFAULTS.media)
            .description('**听语音、看图上的字**（ADR 0052）：他发的语音用 QQ 自带的语音转文字，照片、截图用 NapCat 的 OCR 取上面的字（只有 Windows），她就着内容回，听完语音才回。'
                + '转不出来、没字、超时（5 秒）照旧只知道是语音、图片；表情包照旧用名字'),
        stickers: Schema.union(STICKER_MODES.map(mode => Schema.const(mode).description(STICKER_LABELS[mode]))).default(DEFAULTS.stickers)
            .description('**图片表情**（ADR 0063）：第一阶段只处理男朋友档。先用“只收藏核对”观察描述；完成真图核对和 NapCat 真发预检后，才可选“收藏并发送”。需要打开“看懂图片内容”；默认关'),
        vision: Schema.intersect([
            Schema.object({ enabled: Schema.boolean().default(false).description('**看懂图片内容**（DeepSeek，ADR 0055）') }),
            Schema.union([
                Schema.object({
                    enabled: Schema.const(true).required(),
                    baseUrl: Schema.string().default(DEFAULTS.vision.baseUrl).pattern(NOT_BLANK).description('**接口地址**：一般不用改，复用模型页的 QQBOT_LLM_API_KEY'),
                    model: Schema.string().default(DEFAULTS.vision.model).pattern(NOT_BLANK).description('**模型名**：deepseek-flash 支持图片'),
                    timeoutMs: Schema.natural().min(1).default(DEFAULTS.vision.timeoutMs).description('**看图超时**（毫秒）：失败就退回只知道是图片'),
                }),
                Schema.object({}),
            ]),
        ]).description('普通照片和截图会发给 DeepSeek；图上的字仍同时走 NapCat OCR。图片表情在上面选择 collect/send 后也会看图，用于收藏判断。'),
        moody: Schema.boolean().default(DEFAULTS.moody)
            .description('**看心情不回**（ADR 0013）：正聊着、对方一串只回了「哈哈」「嗯」这类反应时，偶尔不回（男朋友档约 15%，越疏越多，最多 35%）。'
                + '隔一分钟以上再来一条一定回；问句、图片、晚安都照样回。要开着作息'),
        speechCheck: Schema.boolean().default(DEFAULTS.speechCheck)
            .description('**说话的毛病**（ADR 0014）：发出去之前查助手腔、算账（「这会儿才想起来找我」）、怪对方没说、和她最近几次回复重复。'
                + '开头重复的「行，」这类语气词直接去掉；别的带说明重写一次，命中时这一轮晚几秒'),
        herDays: Schema.boolean().default(DEFAULTS.herDays)
            .description('**她自己的日子**（ADR 0015）：每日心情、在读的书。每天一个心情（按日期和当天课表，同一天对谁都一样），写进她说话的方式；'
                + '聊到书或她正在看书时，提示词里加上在读的三本书和进度，说错第几卷 / 章就带说明重写一次。只对卡上有心情和书的档位（陌生人、名单外没有）'),
        autonomousLife: Schema.boolean().default(DEFAULTS.autonomousLife)
            .description('**没人聊天时她一件件过日子**（ADR 0040）：按作息、课表、饭点、世界里的事和一天的打算排行动，过完记进事件账。'
                + '现在是影子模式：只记账，还不进提示词。要开着她自己的日子'),
        projectChoice: Schema.boolean().default(DEFAULTS.projectChoice)
            .description('**项目选择接管空闲安排**（ADR 0056，实验）：三天内未完成的课程作业优先于刷手机、休息、阅读和摄影；上课、吃饭、赴约等硬事件照旧优先。状态行和行动账共用同一决策。要开着上面那一项'),
        lifeInPrompt: Schema.boolean().default(DEFAULTS.lifeInPrompt)
            .description('**生活账进提示词（第一步）**：她最近三天里有几天练拍照修图、上一回是什么时候，按账上记着的写一行进时间块；只给看得到她爱好的档位。要开着上面那一项'),
        realWeather: Schema.boolean().default(DEFAULTS.realWeather)
            .description('**真实天气**（ADR 0048）：她的世界里的天气按济南（在学校）/ 青岛（放假在家）实际的，每 30 分钟从 Open-Meteo 取一次；取不到照旧按日期生成'),
        candidates: Schema.natural().min(1).max(5).default(DEFAULTS.candidates)
            .description('**挑候选**（ADR 0041）：他难过、说亲密话、收尾时一次生成几个回复、按规则挑一个（少说几句、不扯自己的事、不约「写完跟我说」）。1 是不挑；3 是这几种时候三倍的模型调用'),
        contextTurns: Schema.natural().max(40).default(DEFAULTS.contextTurns)
            .description('**最近几轮 + 要点**（ADR 0043）：0 是关（照旧放最近 80 条聊天原文）；开了是原文只放最近这么多轮（实验用 10），更早的在后台整理成几条要点。'
                + '要点没整理好的那一轮照旧放最近 80 条，不等它。只对开了长期记忆的联系人'),
        contextContacts: Schema.array(Schema.natural()).default([...DEFAULTS.contextContacts])
            .description('上面那项只对这几个 QQ 开（灰度）；空着就是名单里开了记忆的都开'),
        proactive: Schema.union(PROACTIVE_MODES.map(mode => Schema.const(mode).description(PROACTIVE_LABELS[mode]))).default(DEFAULTS.proactive)
            .description('**主动消息**（ADR 0011）：她在合适的时候先找人（早安、下课、睡前、冷场、他说过的事、重要的日子）。'
                + '只对「林梦瑶」页面档位里开了主动的档位（现在只有男朋友档），要开着作息。试运行：照算照生成，只写日志不发'),
    }).description('联系人'),
    Schema.object({
        llm: Schema.object({
            baseUrl: Schema.string().required().pattern(NOT_BLANK)
                .description('**接口地址**：OpenAI 兼容，不含 /chat/completions。key 只从环境变量 QQBOT_LLM_API_KEY 读'),
            model: Schema.string().required().pattern(NOT_BLANK).description('**模型名**'),
            thinking: Schema.union(THINKING.map(value => Schema.const(value).description(THINKING_LABELS[value])))
                .description('**思考**（DeepSeek）：开着时温度不生效，回复长度上限包含思考过程。不选 = 用接口默认（DeepSeek：开，强度高）'),
            temperature: Schema.number().min(0).max(2).step(0.1).default(DEFAULTS.llm.temperature).description('**温度**：开思考时不生效'),
            maxTokens: Schema.natural().min(1).default(DEFAULTS.llm.maxTokens)
                .description('**回复长度上限**（token）：开思考时包含思考过程，要调大'),
            extraBody: Schema.string().role('textarea', { rows: [2, 8] }).default('{}')
                .description('**其他参数**（JSON，一般不用改）：合并进请求体，同 ST 的 Include Body Parameters。思考请用上面的控件'),
            promptPostProcessing: Schema.union(PROMPT_POST_PROCESSING.map(value => Schema.const(value).description(POST_PROCESSING_LABELS[value])))
                .default(DEFAULTS.llm.promptPostProcessing).description('**Prompt Post-Processing**（一般不用改）：同 ST 自定义接口的同名设置'),
            timeoutMs: Schema.natural().default(DEFAULTS.llm.timeoutMs).description('**请求超时**（毫秒，一般不用改）：整个请求'),
        }),
    }).description('模型'),
    Schema.object({
        // 写法同 plugin-auth 的 admin：开着才多出细项，存的形状不变
        memory: Schema.intersect([
            Schema.object({ enabled: Schema.boolean().default(false).description('**长期记忆**（Hindsight）') }),
            Schema.union([
                Schema.object({
                    enabled: Schema.const(true).required(),
                    baseUrl: Schema.string().default(MEMORY_BASE_URL).pattern(NOT_BLANK).description('**地址**'),
                    timeoutMs: Schema.natural().default(DEFAULTS.memory.timeoutMs).description('**写入超时**（毫秒）'),
                    recallTimeoutMs: Schema.natural().default(DEFAULTS.memory.recallTimeoutMs)
                        .description('**召回超时**（毫秒）：生成前召回超时就不带记忆，不拖住回复'),
                    bankPrefix: Schema.string().default(DEFAULTS.memory.bankPrefix).description('**bank 前缀**：后面接 QQ 号的哈希和档位'),
                }),
                Schema.object({}),
            ]),
        ]),
    }).description('长期记忆'),
    Schema.object({
        prompt: Schema.object({
            maxContext: Schema.natural().default(DEFAULTS.prompt.maxContext).description('**上下文上限**（token）：同 ST 的 Context Size'),
            pinExamples: Schema.boolean().default(DEFAULTS.prompt.pinExamples)
                .description('**示例对话常驻**：不被聊天记录挤掉，同 ST 的 Always include examples'),
            worldInfo: Schema.object({
                depth: Schema.natural().default(DEFAULTS.prompt.worldInfo.depth).description('**扫描深度**：看最近几条消息'),
                budgetPercent: Schema.natural().max(100).default(DEFAULTS.prompt.worldInfo.budgetPercent).description('**预算**：占上下文的百分比'),
                budgetCap: Schema.natural().default(DEFAULTS.prompt.worldInfo.budgetCap).description('**预算上限**（token）：0 = 不封顶'),
                includeNames: Schema.boolean().default(DEFAULTS.prompt.worldInfo.includeNames).description('**扫描时带名字**'),
                caseSensitive: Schema.boolean().default(DEFAULTS.prompt.worldInfo.caseSensitive).description('**区分大小写**'),
                matchWholeWords: Schema.boolean().default(DEFAULTS.prompt.worldInfo.matchWholeWords).description('**整词匹配**'),
            }).collapse().description('**世界书**：同 ST 的 World Info 设置'),
        }).collapse().description('**提示词**'),
        characterCard: Schema.string().default(CHARACTER_CARD).pattern(NOT_BLANK)
            .description('**角色卡路径**：{tier} 换成档位名；相对路径按仓库根目录'),
        dataDir: Schema.string().default(DEFAULTS.dataDir).pattern(NOT_BLANK)
            .description('**数据目录**：聊天记录、换档记录、日志等。和独立入口 main.ts 共用时两者不能同时运行（单实例锁）'),
    }).description('高级（一般不用改）'),
]);

const dropUndefined = (obj: object) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** 思考控件 → 请求体里的参数（DeepSeek 文档，10-05 核对） */
export function thinkingBody(thinking: Thinking): Record<string, unknown> {
    return thinking === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: thinking };
}

function parseExtraBody(text: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(text || '{}');
    } catch (error) {
        throw new Error(`其他参数（llm.extraBody）不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('其他参数（llm.extraBody）应为 JSON 对象，例如 {}');
    return value as Record<string, unknown>;
}

/** 控制台表单的配置 → config.json 的形状（交给 parseAppConfig 校验、补默认值） */
export function toAppConfigInput(config: Config): Record<string, unknown> {
    const { thinking, extraBody: extraText, ...llm } = config.llm;
    const extraBody = parseExtraBody(extraText);
    if (thinking !== undefined) {
        if ('thinking' in extraBody || 'reasoning_effort' in extraBody) {
            throw new Error('思考（llm.thinking）选了值，其他参数里就不要再写 thinking / reasoning_effort');
        }
        Object.assign(extraBody, thinkingBody(thinking));
    }
    const { enabled, ...memory } = config.memory ?? { enabled: false };
    const { enabled: visionEnabled, ...vision } = config.vision ?? { enabled: false };
    return {
        llm: dropUndefined({ ...llm, extraBody }),
        prompt: dropUndefined({ ...config.prompt, worldInfo: dropUndefined(config.prompt?.worldInfo ?? {}) }),
        characterCard: config.characterCard,
        contacts: config.contacts.map(contact => dropUndefined(contact)),
        unlistedFriends: config.unlistedFriends,
        schedule: config.schedule,
        // 旧的 koishi.yml 没有这几项：parseAppConfig 按默认值（看心情不回开、说话的毛病开、她自己的日子开、主动消息关）
        ...(config.moody !== undefined ? { moody: config.moody } : {}),
        ...(config.speechCheck !== undefined ? { speechCheck: config.speechCheck } : {}),
        ...(config.herDays !== undefined ? { herDays: config.herDays } : {}),
        ...(config.autonomousLife !== undefined ? { autonomousLife: config.autonomousLife } : {}),
        ...(config.projectChoice !== undefined ? { projectChoice: config.projectChoice } : {}),
        ...(config.lifeInPrompt !== undefined ? { lifeInPrompt: config.lifeInPrompt } : {}),
        ...(config.realWeather !== undefined ? { realWeather: config.realWeather } : {}),
        ...(config.candidates !== undefined ? { candidates: config.candidates } : {}),
        ...(config.contextTurns !== undefined ? { contextTurns: config.contextTurns } : {}),
        ...(config.contextContacts !== undefined ? { contextContacts: config.contextContacts } : {}),
        ...(config.proactive !== undefined ? { proactive: config.proactive } : {}),
        ...(config.media !== undefined ? { media: config.media } : {}),
        ...(config.stickers !== undefined ? { stickers: config.stickers } : {}),
        ...(visionEnabled ? { vision: { provider: DEFAULTS.vision.provider, ...dropUndefined(vision) } } : {}),
        ...(enabled ? { memory: dropUndefined(memory) } : {}),
        dataDir: config.dataDir,
    };
}

/**
 * 旧写法（ADR 0009 之前）：思考写在其他参数的 JSON 里。能一一对上控件的选项时，搬到控件上，返回新配置；
 * 对不上（还有别的写法、或者控件已经选了）就返回 undefined，原样留在 JSON 里。搬完请求体不变。
 */
export function migrateThinking(config: Config): Config | undefined {
    if (config.llm.thinking !== undefined) return;
    let extra: Record<string, unknown>;
    try {
        extra = parseExtraBody(config.llm.extraBody);
    } catch {
        return;
    }
    const { thinking, reasoning_effort: effort, ...rest } = extra;
    if (typeof thinking !== 'object' || thinking === null || Object.keys(thinking).length !== 1) return;
    const type = (thinking as { type?: unknown }).type;
    let value: Thinking | undefined;
    if (type === 'disabled' && effort === undefined) value = 'off';
    else if (type === 'enabled' && (effort === 'low' || effort === 'high' || effort === 'max')) value = effort;
    if (!value) return;
    return { ...config, llm: { ...config.llm, thinking: value, extraBody: JSON.stringify(rest) } };
}

/** 抛给 Koishi 的错误只留一句话：Koishi 把 stack 打进运行日志，调用栈会把有用的那句顶出控制台的日志框 */
function plainError(prefix: string, error: unknown): Error {
    const plain = new Error(`${prefix}：${error instanceof Error ? error.message : String(error)}`);
    plain.stack = plain.message;
    return plain;
}

/** 断线后重连的等待：5 秒、10 秒、30 秒，之后每分钟一次 */
export const RECONNECT_MS = [5_000, 10_000, 30_000, 60_000];

/** 角色卡、世界书文件改动后，等这么久没有新的改动再重启（转换器一次写十几个文件） */
const CARD_RELOAD_DELAY_MS = 2000;

/** 好友列表多久重新拉一次（小号新加了好友，不用重启也能在下拉里选到） */
const FRIENDS_REFRESH_MS = 60_000;

/** 这次 Koishi 进程里拉到过好友列表没有：拉到过就一直留着上一次的（插件失败、重启时下拉仍在） */
let friendsLoaded = false;
let friendsKey = '';

export function apply(ctx: Context, config: Config) {
    // 控制台的「林梦瑶」页面（ADR 0010）：注册一次，插件失败时也在
    registerConsole(ctx, repoRoot);
    const card = config.characterCard ?? CHARACTER_CARD;
    setConsoleState({ running: false, error: undefined, status: undefined, character: characterPaths(isAbsolute(card) ? card : resolve(repoRoot, card)) });

    const migrated = migrateThinking(config);
    if (migrated) {
        ctx.logger('qqbot').info(`迁移配置：其他参数里的思考设置搬到「思考」控件（${THINKING_LABELS[migrated.llm.thinking!]}），请求体不变`);
        // 同步调用时 loader 还没登记这个实例，不会写回 koishi.yml（ADR 0009 试验结果第 3 条）；写回后插件按新配置重启
        ctx.setTimeout(() => ctx.scope.update(migrated), 0);
        return;
    }

    let appConfig: AppConfig;
    try {
        appConfig = parseAppConfig(toAppConfigInput(config), repoRoot);
    } catch (error) {
        const plain = plainError('配置有误，插件没有启动', error);
        setConsoleState({ error: plain.message });
        throw plain;
    }
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
        // 白名单的小黄脸「[捂脸]」发成 face 段（ADR 0051），和 onebot.ts 发的是同一个请求
        sendPrivateText: async (userId, text) => Number(await onlineBot().internal.sendPrivateMsg(userId, textToSegments(text))),
        sendPrivateImage: async (userId, file, summary) => Number(await onlineBot().internal.sendPrivateMsg(userId, [{ type: 'image', data: { file, summary, sub_type: 1 } }])),
        friendHistory: (userId, count) => onlineBot().internal.getFriendMsgHistory(String(userId), undefined, count),
    };

    // 听语音、看图上的字（ADR 0052）：QQ 自带的语音转文字、NapCat 的 OCR（只有 Windows）。adapter-onebot 没有 fetch_ptt_text 的方法，用它通用的 _get
    const mediaBot = () => onlineBot().internal as unknown as OneBotMediaInternal;
    const media: MediaReader = {
        voiceToText: async messageId => String((await mediaBot()._get('fetch_ptt_text', { message_id: messageId }) as { text?: unknown } | null)?.text ?? ''),
        ocr: async image => ocrLines(await mediaBot().ocrImage(image)),
    };
    const vision = configuredImageDescriber(appConfig);
    const stickerVision = configuredImageDescriber(appConfig, STICKER_VISION_PROMPT);
    const qqFav = qqFavorites((action, params) => mediaBot()._get(action, params));
    const stickers = (appConfig.stickers ?? 'off') !== 'off' && stickerVision ? stickerShelf({
        dir: join(appConfig.dataDir, 'stickers'),
        describe: image => stickerVision.describe(image),
        decide: stickerDecider(appConfig.llm, log),
        trendDiscover: bqbDiscover({ dir: join(appConfig.dataDir, 'stickers', 'sources'), log }),
        discover: qqFav.discover,
        favorites: qqFav.favorites,
        log,
    }) : undefined;
    let app: ReturnType<typeof startApp>;
    try {
        app = startApp({ config: appConfig, transport, log, media, vision, ...(stickers ? { stickers } : {}) });
    } catch (error) {
        const plain = plainError('插件没有启动', error);
        setConsoleState({ error: plain.message });
        throw plain;
    }
    setConsoleState({ running: true, error: undefined, status: () => app.status() });
    ctx.on('dispose', () => {
        app.stop();
        setConsoleState({ running: false, status: undefined });
    });

    ctx.middleware((session, next) => {
        const event = (session as Session & { onebot?: OneBotEvent }).onebot;
        if (session.platform !== 'onebot' || !event || !isPrivateFriendMessage(event)) return next();
        app.receive(event);
    }, true);

    // QQ 号的下拉：挂在根上下文上，插件失败、重启时不卸掉（ADR 0009 试验结果第 5 条）
    if (!friendsLoaded) {
        ctx.root.schema.set(FRIENDS_SCHEMA, Schema.natural().description('**QQ 号**：NapCat 还没连上，先手填；连上后可以从好友里选'));
    }
    const refreshFriends = async () => {
        let friends: OneBotFriend[];
        try {
            friends = await onlineBot().internal.getFriendList();
        } catch {
            return;
        }
        const known = new Set(friends.map(f => f.user_id));
        const strangers = config.contacts.map(c => c.qq).filter(qq => typeof qq === 'number' && !known.has(qq));
        const options = [
            ...friends.map(f => [f.user_id, `${f.remark || f.nickname}（${f.nickname}）${f.user_id}`] as const),
            ...strangers.map(qq => [qq, `${qq}（不是小号的好友，收不到私聊）`] as const),
        ];
        const key = JSON.stringify(options);
        if (friendsLoaded && key === friendsKey) return;
        friendsLoaded = true;
        friendsKey = key;
        ctx.root.schema.set(FRIENDS_SCHEMA, options.length
            ? Schema.union(options.map(([qq, label]) => Schema.const(qq).description(label))).description(QQ_DESCRIPTION)
            : Schema.natural().description('**QQ 号**：小号还没有好友，先手填'));
    };
    ctx.setInterval(() => void refreshFriends(), FRIENDS_REFRESH_MS);

    let reconnects = 0;
    let warnedTemplate = false;
    ctx.on('login-updated', ({ bot }) => {
        if (bot.platform !== 'onebot') return;
        if (bot.status === ONLINE) {
            reconnects = 0;
            log(`NapCat 账号 ${bot.selfId} 已就绪`);
            void app.connected(Number(bot.selfId));
            void refreshFriends();
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
        if (bot.platform === 'onebot' && bot.status === ONLINE) {
            void app.connected(Number(bot.selfId));
            void refreshFriends();
        }
    }

    // 角色卡、世界书由转换器生成（characters/<角色>/source/ → st/，ADR 0010），变了就重启插件重新读
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

/** NapCat get_friend_list 的一项（用到的字段） */
interface OneBotFriend {
    user_id: number;
    nickname: string;
    remark?: string;
}

/** adapter-onebot 的 bot.internal 里用到的几个（Internal.defineExtract，返回值已经取出 message_id / messages） */
interface OneBotInternal {
    sendPrivateMsg(userId: number, message: { type: string; data: Record<string, unknown> }[]): Promise<number>;
    getFriendMsgHistory(userId: string, messageSeq: undefined, count: number): Promise<HistoryMessage[]>;
    getFriendList(): Promise<OneBotFriend[]>;
}

/** 听语音、看图（ADR 0052）用到的：ocr_image 是 adapter-onebot 定义了的方法（原样返回 data），fetch_ptt_text 没有，走通用的 _get（retcode 不是 0 就抛错） */
interface OneBotMediaInternal {
    ocrImage(image: string): Promise<unknown>;
    _get(action: string, params: Record<string, unknown>): Promise<unknown>;
}
