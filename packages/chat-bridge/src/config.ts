// 配置：环境变量优先，其次 runtime/chat-bridge/config.json，最后默认值。
// 凭据（QQBOT_ONEBOT_TOKEN）只从环境变量来，不写进配置文件。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './types.ts';
import type { DeliveryRule } from './types.ts';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface RelayConfig {
    /** 他的 QQ 号 */
    ownerId: number;
    ownerName: string;
    /** 她的 QQ 号 */
    selfId: number;
    selfName: string;
    /** 上游 NapCat 的 OneBot 正向 WS 地址；不填就没有上游 */
    upstreamUrl?: string;
    /** 给 Koishi 连的端口（永远只开在 127.0.0.1） */
    onebotPort: number;
    /** 给手机连的端口 */
    appPort: number;
    /** 手机那个端口监听的地址，默认 127.0.0.1 */
    host: string;
    delivery: DeliveryRule;
    dataDir: string;
    staticDir: string;
}

const ENV_KEYS = {
    ownerId: 'CHAT_BRIDGE_OWNER_ID', ownerName: 'CHAT_BRIDGE_OWNER_NAME', selfId: 'CHAT_BRIDGE_SELF_ID', selfName: 'CHAT_BRIDGE_SELF_NAME',
    upstreamUrl: 'CHAT_BRIDGE_UPSTREAM', onebotPort: 'CHAT_BRIDGE_ONEBOT_PORT', appPort: 'CHAT_BRIDGE_APP_PORT', host: 'CHAT_BRIDGE_HOST',
    delivery: 'CHAT_BRIDGE_DELIVERY', dataDir: 'CHAT_BRIDGE_DATA', staticDir: 'CHAT_BRIDGE_STATIC',
} as const;

type Env = Record<string, string | undefined>;

/** 数据目录：CHAT_BRIDGE_DATA，默认仓库根下的 runtime/chat-bridge（不看当前目录：npm 的 workspace 脚本是在包目录里跑的） */
export function dataDirFrom(env: Env): string {
    const value = env[ENV_KEYS.dataDir]?.trim();
    if (!value) return join(repoRoot, 'runtime', 'chat-bridge');
    return isAbsolute(value) ? value : resolve(repoRoot, value);
}

/** chat-app 里放 index.html 的那个目录 */
function defaultStaticDir(): string {
    const base = join(repoRoot, 'packages', 'chat-app');
    for (const name of ['dist', 'public', 'src', '.']) {
        if (existsSync(join(base, name, 'index.html'))) return join(base, name);
    }
    return join(base, 'public');
}

export function parseConfig(env: Env, fileText: string | undefined): RelayConfig {
    let file: Record<string, unknown> = {};
    if (fileText !== undefined) {
        let parsed: unknown;
        try { parsed = JSON.parse(fileText); } catch { throw new Error('config.json 不是合法的 JSON'); }
        if (!isRecord(parsed)) throw new Error('config.json 要是一个对象');
        if ('token' in parsed) throw new Error('config.json 里不要写 token：凭据只放环境变量 QQBOT_ONEBOT_TOKEN');
        file = parsed;
    }
    const pick = (key: keyof typeof ENV_KEYS): unknown => {
        const fromEnv = env[ENV_KEYS[key]]?.trim();
        return fromEnv ? fromEnv : file[key];
    };
    const id = (key: 'ownerId' | 'selfId', label: string): number => {
        const value = Number(pick(key));
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`没有配置${label}（${ENV_KEYS[key]} 或 config.json 的 ${key}）`);
        return value;
    };
    const port = (key: 'onebotPort' | 'appPort', fallback: number): number => {
        const raw = pick(key);
        const value = raw === undefined || raw === '' ? fallback : Number(raw);
        if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new Error(`${key} 不是合法的端口`);
        return value;
    };
    const text = (key: keyof typeof ENV_KEYS): string | undefined => {
        const value = pick(key);
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };

    const ownerId = id('ownerId', '他的 QQ 号');
    const selfId = id('selfId', '她的 QQ 号');
    if (ownerId === selfId) throw new Error('他的 QQ 号和她的 QQ 号不能是同一个');
    const delivery = text('delivery') ?? 'last-active';
    if (delivery !== 'last-active' && delivery !== 'both') throw new Error('delivery 只能是 last-active 或 both');
    const upstreamUrl = text('upstreamUrl');
    if (upstreamUrl !== undefined) {
        let url: URL;
        try { url = new URL(upstreamUrl); } catch { throw new Error('上游地址不是合法的 URL'); }
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('上游地址要以 ws:// 或 wss:// 开头');
        if (url.username || url.password || url.search) throw new Error('上游地址里不要带凭据：token 放环境变量 QQBOT_ONEBOT_TOKEN');
    }
    const staticDir = text('staticDir');
    return {
        ownerId, selfId,
        ownerName: text('ownerName') ?? '他',
        selfName: text('selfName') ?? '她',
        ...(upstreamUrl !== undefined ? { upstreamUrl } : {}),
        onebotPort: port('onebotPort', 3200),
        appPort: port('appPort', 3210),
        host: text('host') ?? '127.0.0.1',
        delivery,
        dataDir: dataDirFrom(env),
        staticDir: staticDir ? (isAbsolute(staticDir) ? staticDir : resolve(repoRoot, staticDir)) : defaultStaticDir(),
    };
}

export function loadConfig(env: Env = process.env): RelayConfig {
    const path = env.CHAT_BRIDGE_CONFIG?.trim() || join(dataDirFrom(env), 'config.json');
    let fileText: string | undefined;
    try { fileText = readFileSync(path, 'utf8'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return parseConfig(env, fileText);
}
