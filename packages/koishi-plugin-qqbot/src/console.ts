// 控制台的「林梦瑶」页面（ADR 0010）：前端是 client/index.js（手写的 ES 模块，不构建），这里是它的后端。
// - 入口、数据服务、监听器挂在根上下文上，每个 Koishi 进程只注册一次：qqbot 插件配置有误（红点）或重启时，页面照样能用；
// - 插件每次启动 / 停下 / 启动失败时更新模块里的状态（setConsoleState），数据服务每几秒推一次给页面；
// - 所有监听器和数据服务都要求登录（authority 4，和 plugin-config 一样），页面本身和入口文件不受登录保护；
// - 保存角色资料：先在内存里生成全部档位、做档位隐私检查，不过就不写；过了写 source/ 和 st/，插件按卡文件监听自动重启。

import type { Context } from 'koishi';
import { PHONE_ACTION_CAPABILITIES, type PhoneActionCapability } from '@qqbot/mobile-companion/protocol';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppStatus } from '../../bot/src/platform/app.ts';
import { buildCharacter, checkPrivacy, writeOutputs, type Problem } from '../../character-tools/src/build.ts';
import { checkSource, readSource, writeSource, type CharacterSource } from '../../character-tools/src/source.ts';

const require = createRequire(import.meta.url);

/** 插件此刻的情况（apply 里更新） */
export interface ConsoleState {
    /** 插件启动成功、正在回复 */
    running: boolean;
    /** 启动失败的原因（配置有误、锁被占……） */
    error?: string;
    /** 正在跑的 app 的状态 */
    status?: () => AppStatus;
    /** 角色资料：source/ 和 st/ 所在的目录、st/ 文件名的前缀（由插件配置的 characterCard 推出） */
    character?: { sourceDir: string; stDir: string; prefix: string };
}

export interface ConsoleData {
    running: boolean;
    error?: string;
    napcat?: { online: boolean; selfId?: string };
    status?: AppStatus;
    character?: { sourceDir: string; stDir: string };
    phoneActions: readonly PhoneActionCapability[];
    updatedAt: number;
}

/** moods / books（ADR 0015）是后加的文件：资料里没有这两个文件时页面不显示它们的分页 */
export type SourcePart = 'persona' | 'scenes' | 'schedule' | 'tiers' | 'moods' | 'books';

export type SaveResult =
    | { ok: true; written: string[] }
    | { ok: false; error?: string; problems?: Problem[] };

let state: ConsoleState = { running: false };
let registered = false;
let service: { refresh(): Promise<void> } | undefined;
/** NapCat 连接（根上下文的 bots，插件失败时也能看） */
let napcat: (() => { online: boolean; selfId?: string }) | undefined;

/** 插件更新自己的情况；页面马上收到 */
export function setConsoleState(patch: Partial<ConsoleState>): void {
    state = { ...state, ...patch };
    void service?.refresh();
}

/** characterCard（例如 …/characters/linmengyao/st/linmengyao-{tier}.json）→ 资料目录 */
export function characterPaths(characterCard: string): ConsoleState['character'] {
    const stDir = dirname(characterCard);
    return { stDir, sourceDir: join(dirname(stDir), 'source'), prefix: basename(characterCard).replace(/-?\{tier\}\.json$/, '') };
}

/** 页面要看的数据：插件情况 + app 状态（不含聊天内容） */
export function consoleData(): ConsoleData {
    let status: AppStatus | undefined;
    try {
        status = state.status?.();
    } catch {
        status = undefined;
    }
    return {
        running: state.running,
        ...(state.error ? { error: state.error } : {}),
        ...(napcat ? { napcat: napcat() } : {}),
        ...(status ? { status } : {}),
        ...(state.character ? { character: { sourceDir: state.character.sourceDir, stDir: state.character.stDir } } : {}),
        phoneActions: PHONE_ACTION_CAPABILITIES,
        updatedAt: Date.now(),
    };
}

function character() {
    if (!state.character) throw new Error('还不知道角色资料在哪：qqbot 插件没启动过');
    return state.character;
}

/** 用页面改过的一部分替换现有资料，校验结构、引用和档位隐私；dryRun 时不写 */
export function saveCharacter(part: SourcePart, value: unknown, dryRun = false): SaveResult {
    const paths = character();
    let source: CharacterSource;
    try {
        const current = readSource(paths.sourceDir);
        source = checkSource({ ...current, [part]: value });
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    let built: ReturnType<typeof buildCharacter>;
    try {
        built = buildCharacter(source, paths.prefix);
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const problems = checkPrivacy(built, source);
    if (problems.length) return { ok: false, problems };
    if (dryRun) return { ok: true, written: [] };
    writeSource(paths.sourceDir, source);
    const { written } = writeOutputs(paths.stDir, built);
    return { ok: true, written };
}

/** 每个 Koishi 进程注册一次，挂在根上下文上 */
export function registerConsole(ctx: Context, repoRoot: string): void {
    if (registered) return;
    registered = true;
    const root = ctx.root;
    napcat = () => {
        const bot = root.bots.find(b => b.platform === 'onebot');
        return { online: bot?.status === 1, ...(bot?.selfId ? { selfId: bot.selfId } : {}) };
    };
    root.inject(['console'], (c) => {
        const api = (c as Context & { console: ConsoleApi }).console;
        // 入口文件的路径里要有 node_modules，否则控制台返回 403（plugin-console 的 @plugin- 路由）：走工作区的链接
        const clientDir = resolve(repoRoot, 'node_modules/koishi-plugin-qqbot/client');
        api.addEntry({ dev: join(clientDir, 'index.js'), prod: clientDir });

        const { DataService } = require('@koishijs/console') as { DataService: new (ctx: Context, key: string, options: object) => { refresh(): Promise<void> } };
        class QqbotService extends DataService {
            constructor(ctx: Context) {
                super(ctx, 'qqbot', { authority: 4 });
                service = this;
            }

            async get(): Promise<ConsoleData> {
                return consoleData();
            }
        }
        c.plugin(QqbotService as never);
        // 「几点看到」「她此刻在干什么」会随时间变：定时推
        const timer = setInterval(() => void service?.refresh(), 5000);
        c.on('dispose', () => {
            clearInterval(timer);
            service = undefined;
        });

        const authority = { authority: 4 };
        api.addListener('qqbot/character/load', () => {
            const paths = character();
            return { source: readSource(paths.sourceDir) };
        }, authority);
        api.addListener('qqbot/character/check', (part: SourcePart, value: unknown) => saveCharacter(part, value, true), authority);
        api.addListener('qqbot/character/save', (part: SourcePart, value: unknown) => {
            const result = saveCharacter(part, value);
            if (result.ok) root.logger('qqbot').info(`控制台保存了角色资料（${part}），重新生成 ${result.written.length} 个文件：${result.written.join('、') || '无变化'}`);
            return result;
        }, authority);
    });
}

interface ConsoleApi {
    addEntry(files: { dev: string; prod: string }): void;
    addListener(event: string, callback: (...args: never[]) => unknown, options: { authority: number }): void;
}
