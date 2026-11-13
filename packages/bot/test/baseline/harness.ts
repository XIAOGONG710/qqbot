// 行为基线（ADR 0336 第 2 步）：在合成角色上用假模型、假 QQ、假时钟跑真实的 App（startApp），
// 把每一次对外调用记下来——发给模型的完整提示词（和用的哪个模型）、每个 QQ 动作和它的时刻、最后留在数据目录里的每个文件——写成一份纯文本快照。
// 架构迁移的每一步都必须让快照逐字不变；有意改变行为的提交才改快照，并写明原因。
// 只用合成角色（ADR 0260），不连网：长期记忆、真实天气、B 站、网页、DSH 都关着；设备只在 devices 场景里换上假的服务（见 scenarios.ts 开头的覆盖说明）。

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { startApp, type App, type Transport } from '../../src/platform/app.ts';
import { DEFAULTS, type AppConfig, type Contact } from '../../src/platform/config.ts';
import type { HistoryMessage } from '../../src/memory/backfill.ts';
import type { MessageEvent, PokeEvent, RecallEvent } from '../../src/platform/onebot.ts';
import type { OpenAIMessage } from '../../src/language/prompt.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../../src/st/world-info.ts';
import { syntheticCardPattern, useSyntheticTerms } from '../fixtures/card.ts';
import { FakeClock } from './clock.ts';
import type { LlmAction } from '../../src/executor/executor.ts';
import { createDeviceControl } from '../../src/platform/device-actions.ts';
import { DEVICE_MAX_VOLUME, linksOf, type startDeviceService } from '../../src/platform/device-service.ts';

// 快照里的时刻、作息、「今天」都按本地时间算：进程时区固定在 Asia/Shanghai（同配置的 timeZone），不随跑测试的机器变。
// 基线只在 baseline.test.ts 自己的测试进程里跑（node --test 每个文件一个进程），这里改了不影响别的测试文件。
process.env.TZ = 'Asia/Shanghai';

export const SELF = 20000;

/** 发给模型的一次调用 */
export interface LlmCall { index: number; at: number; model: string | undefined; messages: OpenAIMessage[] }
/** 假模型：按这次调用返回她的回复；可以返回 promise（用 driver.later 在虚拟时间上慢慢回） */
export type Replier = (call: LlmCall) => string | Promise<string>;

export interface Scenario {
    name: string;
    /** 一句话：这个场景在测什么 */
    about: string;
    /** 开始时刻，带 +08:00 */
    start: string;
    contacts: Contact[];
    config?: Partial<AppConfig>;
    /** NapCat 那边的私聊记录（连上时补回用） */
    history?: (start: number) => Record<number, HistoryMessage[]>;
    /** 启动之前往数据目录里放东西（以前的聊天记录……）；用真实的写入接口，不手拼文件 */
    seed?: (dataDir: string, start: number) => void;
    /** 她在本机的灵魂目录（QQBOT_SOUL_DIR）里预先放的东西（合成的日记、生活、拒绝过的、评价……）；不给就和没装过 DSH 的机器一样，目录不存在 */
    soul?: (soulDir: string, start: number) => void;
    /** 每次跑新建一个假模型（里面有轮换的计数，不能跨次共用） */
    reply?: () => Replier;
    /**
     * 设备控制（ADR 0148）：给了就换上假的设备服务——真的控制器（菜单、令牌、限额、待批准都是真的），只是电脑在线、派发记下来不执行、不监听端口。
     * readyAfterMs：服务过多久才起来（起来之前她的菜单是空的，和线上一样）。配置里还要开 deviceControl
     */
    devices?: { readyAfterMs: number };
    script: (driver: Driver) => Promise<void>;
}

export interface Driver {
    app: App;
    clock: FakeClock;
    /** 他发一条私聊；返回消息 id */
    say(qq: number, text: string, nickname?: string): number;
    poke(qq: number): void;
    recall(qq: number, messageId: number): void;
    /** 虚拟时间往前走 ms，途中到点的事都做完 */
    wait(ms: number): Promise<void>;
    /** 拨到某个时刻（带 +08:00） */
    at(iso: string): Promise<void>;
    /** 在虚拟时间上过 ms 再给出 value（假模型慢慢回） */
    later<T>(ms: number, value: T): Promise<T>;
}

interface Entry { at: number; head: string; body?: string }

/** 基线用的配置：生产默认值，连网的一律关掉 */
export function baselineConfig(dataDir: string, contacts: Contact[], overrides: Partial<AppConfig> = {}): AppConfig {
    const { memory: _memory, vision: _vision, ...defaults } = DEFAULTS;
    return {
        ...defaults,
        llm: { baseUrl: 'http://127.0.0.1:9', model: 'baseline-chat', apiKey: 'baseline', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
        dsh: { enabled: false },
        prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
        characterCard: syntheticCardPattern,
        contacts,
        realWeather: false,
        dataDir,
        timeZone: 'Asia/Shanghai',
        ...overrides,
    } as AppConfig;
}

/**
 * 假的设备服务：控制器是真的（createDeviceControl），电脑一直在线，派发只记一笔、当作做成了；不起取件中心、不监听端口、不写审计文件。
 * 服务在 readyAfterMs 之后才「起来」（虚拟时间），之前 App 拿不到它，和线上异步起服务一样。看屏幕 / 摄像头只回「看图没开」。
 */
function fakeDevices(readyAfterMs: number, record: (head: string, body?: string) => void): typeof startDeviceService {
    return async options => {
        await new Promise(resolve => setTimeout(resolve, readyAfterMs));
        const control = createDeviceControl({
            mode: options.mode,
            context: { links: linksOf(options.links), apps: options.apps, maxVolume: DEVICE_MAX_VOLUME },
            dispatch: async job => { record(`设备 派发 ${JSON.stringify(job)}`); return { ok: true }; },
            available: () => ['computer'],
            say: options.say,
            log: () => {},
        });
        record('设备 服务起来了');
        return {
            control,
            hub: undefined as never,
            isOwnerCommand: text => control.isOwnerCommand(text),
            owner(text) {
                const action = control.ownerSays(text);
                if (action.kind === 'none') return { kind: 'none' };
                if (action.kind === 'reply') return { kind: 'reply', text: action.text };
                return { kind: 'capture', run: async () => ({ kind: 'reply', text: '（截到了，但看图没开，她看不了——图我也没留）' }) };
            },
            stop: async () => { record('设备 服务停了'); },
        };
    };
}

const defaultReply: Replier = call => {
    const last = call.messages.at(-1)?.content ?? '';
    // 后台的摘录 / 分类调用多半要 JSON：给一个空的，让它们走“什么都没有”的路
    if (/JSON|json/.test(last) || /JSON|json/.test(call.messages[0]?.content ?? '')) return '[]';
    return '嗯嗯\n刚在看书';
};

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
/** 本地时间（进程时区在文件开头固定为 Asia/Shanghai） */
function stamp(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function listFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else out.push(path);
        }
    };
    walk(root);
    return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** 去掉每次跑都不一样的东西：临时目录、仓库位置、随机 uuid（按第一次出现的顺序编号） */
function normalizer(dataDir: string): (text: string) => string {
    const repo = resolve(import.meta.dirname, '../../../..');
    const forms = (path: string) => [path, path.replaceAll('\\', '\\\\'), path.replaceAll('\\', '/')];
    const replacements: [string, string][] = [...forms(dataDir).map(f => [f, '<data>'] as [string, string]), ...forms(repo).map(f => [f, '<repo>'] as [string, string])];
    const uuids = new Map<string, string>();
    return text => {
        let out = text;
        for (const [from, to] of replacements) out = out.split(from).join(to);
        // 进程号只在明确是进程号的地方换（JSON 的 pid 字段、临时文件名 tmp-<pid>、提示里的 PID <pid>）：
        // 11-09 撞过一次——那次跑的进程号是 2804，正好等于提示词里「手上还有 2804 元」，见到这个数就换会把钱数也换掉
        out = out.replace(/("pid":\s*)\d+/g, '$1<pid>').replace(new RegExp(`(tmp-|PID )${process.pid}(?!\\d)`, 'g'), '$1<pid>');
        return out.replace(UUID, id => {
            const key = id.toLowerCase();
            if (!uuids.has(key)) uuids.set(key, `<uuid-${uuids.size + 1}>`);
            return uuids.get(key)!;
        });
    };
}

/** 数据目录里一个文件的快照：SQLite 按表逐行列出，其余二进制只记长度和哈希，文本原样 */
function fileText(path: string): string {
    if (path.endsWith('.sqlite')) {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
            return tables.map(({ name }) => [`[${name}]`, ...db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => JSON.stringify(row))].join('\n')).join('\n');
        } finally { db.close(); }
    }
    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(bytes) && !text.includes('\u0000')) return text.replace(/\s+$/, '');
    return `(二进制 ${bytes.length} 字节 sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 16)})`;
}

/** 跑一个场景，返回快照正文 */
export async function runScenario(scenario: Scenario): Promise<string> {
    const start = Date.parse(scenario.start);
    if (!Number.isFinite(start)) throw new Error(`场景 ${scenario.name} 的开始时刻写错了`);
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-baseline-'));
    // 她在本机的目录（灵魂目录 ~/.dsh/linmengyao、常驻目录 ~/.dsh/her）不能用真的：在 DSH 那台机器上那里是她真实的日记、生活和心境导出，
    // 基线会读到真资料、快照跟着那台机器变，心境导出还会写进去。指到临时目录里还不存在的路径——和没装过 DSH 的机器一样
    const home = mkdtempSync(join(tmpdir(), 'qqbot-baseline-home-'));
    // 工作桥（work-bridge.ts）同理：dsh 入口指到不存在的路径——不然找常驻的 fetch 被拦下后，它会退回去真起一个 dsh 进程，
    // 在 DSH 那台上把「整理桌面文件」真的干了（DSH 11-10 报的基线 work-mode 红）。常驻地址固定成默认值：fetch 一律被拦下、不会真连，
    // 固定它只是让快照里记下的地址不随机器上的 HER_RESIDENT_URL 变
    const isolated: Record<string, string> = {
        QQBOT_SOUL_DIR: join(home, 'soul'),
        HER_DIR: join(home, 'her'),
        HER_RESIDENT_URL: 'http://127.0.0.1:7777',
        DSH_BIN: join(home, 'no-dsh', 'bin.js'),
    };
    const envBefore = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
    Object.assign(process.env, isolated);
    const clock = new FakeClock(start);
    const entries: Entry[] = [];
    clock.activity = () => entries.length;
    const record = (head: string, body?: string) => entries.push({ at: clock.now(), head, ...(body === undefined ? {} : { body }) });
    let nextSent = 5000;
    const sent = () => nextSent++;
    const call = (name: string, args: unknown[]) => record(`qq ${name} ${JSON.stringify(args)}`);
    let llmCalls = 0;
    let observed: LlmAction | undefined;
    const replier = scenario.reply?.() ?? defaultReply;
    const seen = new Map<string, string>();
    clock.install();
    useSyntheticTerms();
    // 基线不连网：走全局 fetch 的一律记下来并失败（模型调用走 pipeline.generate，不经这里）
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        record(`fetch 被拦下 ${url}`);
        throw new TypeError('fetch failed（行为基线不连网）');
    }) as typeof fetch;
    try {
        const history = scenario.history?.(start) ?? {};
        scenario.seed?.(dataDir, start);
        if (scenario.soul) {
            mkdirSync(process.env.QQBOT_SOUL_DIR!, { recursive: true });
            scenario.soul(process.env.QQBOT_SOUL_DIR!, start);
        }
        const transport: Transport = {
            sendPrivateText: async (userId, text, replyTo) => { call('sendPrivateText', replyTo === undefined ? [userId, text] : [userId, text, replyTo]); return sent(); },
            sendPrivateCard: async (userId, cardJson) => { call('sendPrivateCard', [userId, cardJson]); return sent(); },
            sendPrivateImage: async (userId, file, summary) => { call('sendPrivateImage', [userId, file, summary]); return sent(); },
            markRead: async userId => { call('markRead', [userId]); },
            reactMessage: async (messageId, emojiId) => { call('reactMessage', [messageId, emojiId]); },
            setInputStatus: async (userId, eventType) => { call('setInputStatus', eventType === undefined ? [userId] : [userId, eventType]); },
            deleteMessage: async messageId => { call('deleteMessage', [messageId]); },
            pokeFriend: async userId => { call('pokeFriend', [userId]); },
            setOnlineStatus: async (status, ext) => { call('setOnlineStatus', [status, ext]); },
            sendLike: async (userId, times) => { call('sendLike', [userId, times]); },
            setSignature: async text => { call('setSignature', [text]); },
            friendHistory: async (userId, count) => {
                call('friendHistory', [userId, count]);
                const list = history[userId];
                if (!list) throw new Error('OneBot 调用失败 retcode 1200：消息不存在');
                return list.slice(-count);
            },
        };
        const app = startApp({
            config: baselineConfig(dataDir, scenario.contacts, scenario.config),
            transport,
            log: () => {},
            sensitive: { on: () => false, describe: () => '' },
            // 执行器派发模型调用前先告诉这里完整的动作（用途、模型配置），紧接着才调假模型
            observe: action => { if (action.kind === 'llm') observed = action; },
            ...(scenario.devices ? { startDevices: fakeDevices(scenario.devices.readyAfterMs, record) } : {}),
            pipeline: {
                generate: async (messages, _log, use) => {
                    const index = ++llmCalls;
                    const at = clock.now();
                    const lines: string[] = [];
                    for (const message of messages) {
                        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
                        const where = `#${index}.${lines.length + 1}`;
                        const earlier = content.length >= 200 ? seen.get(content) : undefined;
                        if (earlier) lines.push(`--- ${message.role}（同 ${earlier}）`);
                        else {
                            if (content.length >= 200) seen.set(content, where);
                            lines.push(`--- ${message.role}`, content);
                        }
                    }
                    const action = observed;
                    observed = undefined;
                    if (!action) throw new Error('模型调用没有经过执行器');
                    const { config } = action;
                    const extra = Object.keys(config.extraBody).length ? ` extraBody=${JSON.stringify(config.extraBody)}` : '';
                    record(`llm #${index} ${action.purpose} model=${config.model} temperature=${config.temperature} maxTokens=${config.maxTokens}${extra}${use ? ' 换模型' : ''}`, lines.join('\n'));
                    const reply = await replier({ index, at, model: use?.model, messages });
                    record(`llm #${index} 回复`, reply);
                    return reply;
                },
            },
        });
        let nextMessage = 1000;
        const driver: Driver = {
            app, clock,
            say(qq, text, nickname) {
                const id = nextMessage++;
                const event: MessageEvent = {
                    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: qq, message_id: id,
                    time: Math.floor(clock.now() / 1000), message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: qq, ...(nickname ? { nickname } : {}) },
                };
                record(`他 ${qq} 发 #${id}`, text);
                app.receive(event);
                return id;
            },
            poke(qq) {
                const event: PokeEvent = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: SELF, user_id: qq, target_id: SELF, time: Math.floor(clock.now() / 1000) };
                record(`他 ${qq} 戳了她`);
                app.receivePoke(event);
            },
            recall(qq, messageId) {
                const event: RecallEvent = { post_type: 'notice', notice_type: 'friend_recall', self_id: SELF, user_id: qq, message_id: messageId };
                record(`他 ${qq} 撤回 #${messageId}`);
                app.receiveRecall(event);
            },
            wait: ms => clock.advance(ms),
            at: iso => clock.advanceTo(Date.parse(iso)),
            later: (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms)),
        };
        record('连上 NapCat');
        await clock.settle(app.connected(SELF));
        await scenario.script(driver);
        record('停止');
        await clock.settle(Promise.resolve(app.stop()));
        await clock.idle();
        const normalize = normalizer(dataDir);
        const out: string[] = [`# 行为基线：${scenario.name}`, `# ${scenario.about}`, `# 开始 ${stamp(start)}；联系人 ${scenario.contacts.map(c => `${c.qq}(${c.tier})`).join(' ')}`, ''];
        for (const entry of entries) {
            out.push(`@ ${stamp(entry.at)} ${entry.head}`);
            if (entry.body !== undefined) out.push(entry.body);
        }
        out.push('', '# 数据目录');
        for (const path of listFiles(dataDir)) {
            out.push(`== ${relative(dataDir, path).split(sep).join('/')}`, fileText(path));
        }
        return `${normalize(out.join('\n'))}\n`;
    } finally {
        globalThis.fetch = realFetch;
        clock.uninstall();
        rmSync(dataDir, { recursive: true, force: true });
        for (const [key, value] of Object.entries(envBefore)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
    }
}
