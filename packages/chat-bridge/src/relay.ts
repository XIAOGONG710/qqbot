// 把核心和三个口子接起来：Koishi 这一侧的 OneBot 服务端、上游 NapCat 客户端、App 的 HTTP + WS。
import { join } from 'node:path';
import { startAppServer } from './app-server.ts';
import type { AppServer } from './app-server.ts';
import type { RelayConfig } from './config.ts';
import { createRelayCore } from './core.ts';
import type { RelayCore } from './core.ts';
import { createDeviceStore, fileDeviceStorage } from './devices.ts';
import type { DeviceStore } from './devices.ts';
import { createLedger, fileLedgerStorage } from './ledger.ts';
import type { Ledger } from './ledger.ts';
import { createMediaStore, defaultFetcher } from './media.ts';
import type { MediaFetcher } from './media.ts';
import { startOneBotServer } from './onebot-server.ts';
import type { OneBotServer } from './onebot-server.ts';
import { connectUpstream, noUpstream } from './upstream.ts';
import type { Upstream } from './upstream.ts';
import type { Clock, Log } from './types.ts';

export interface RelayOptions {
    config: RelayConfig;
    /** QQBOT_ONEBOT_TOKEN：Koishi 这一侧要它，连上游也带它。只从环境变量来 */
    token?: string;
    log: Log;
    now?: Clock;
    fetcher?: MediaFetcher;
    upstreamTimeoutMs?: number;
    upstreamBackoffMs?: readonly number[];
    revokeSweepMs?: number;
}

export interface Relay {
    readonly onebotPort: number;
    readonly appPort: number;
    readonly devices: DeviceStore;
    readonly ledger: Ledger;
    readonly core: RelayCore;
    stop(): Promise<void>;
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
    const { config, log } = options;
    const now = options.now ?? Date.now;
    const ledger = createLedger(fileLedgerStorage(join(config.dataDir, 'log.jsonl')));
    const devices = createDeviceStore({ storage: fileDeviceStorage(join(config.dataDir, 'devices.json')), now });
    const media = createMediaStore({ dir: join(config.dataDir, 'media') });

    // 三个口子互相要用，先放占位，起好了再填
    let onebot: OneBotServer | undefined;
    let app: AppServer | undefined;
    let upstream: Upstream = noUpstream;

    const core = createRelayCore({
        config, ledger, media, now, log,
        fetcher: options.fetcher ?? defaultFetcher,
        upstream: { connected: () => upstream.connected(), call: (action, params) => upstream.call(action, params) },
        koishi: { connected: () => onebot?.connected() ?? false, push: event => onebot?.push(event) },
        apps: { broadcast: frame => app?.broadcast(frame) },
        localMediaUrl: id => `http://127.0.0.1:${onebot?.port ?? config.onebotPort}/media/${id}`,
    });

    onebot = await startOneBotServer({
        port: config.onebotPort, selfId: config.selfId, media, log, now,
        ...(options.token ? { token: options.token } : {}),
        onAction: (action, params) => core.handleAction(action, params),
    });
    try {
        app = await startAppServer({
            port: config.appPort, host: config.host, staticDir: config.staticDir, selfName: config.selfName,
            devices, ledger, media, core, log, now,
            ...(options.revokeSweepMs !== undefined ? { revokeSweepMs: options.revokeSweepMs } : {}),
        });
    } catch (error) {
        await onebot.stop();
        throw error;
    }
    if (config.upstreamUrl) {
        const server = onebot;
        upstream = connectUpstream({
            url: config.upstreamUrl, log,
            ...(options.token ? { token: options.token } : {}),
            ...(options.upstreamTimeoutMs !== undefined ? { timeoutMs: options.upstreamTimeoutMs } : {}),
            ...(options.upstreamBackoffMs ? { backoffMs: options.upstreamBackoffMs } : {}),
            onEvent(raw, event) {
                // 先原样交给 Koishi，再记自己的账
                server.pushRaw(raw);
                core.handleUpstreamEvent(event);
            },
            onState: () => core.upstreamChanged(),
        });
    }

    const servers = { onebot, app };
    return {
        onebotPort: onebot.port,
        appPort: app.port,
        devices, ledger, core,
        async stop() {
            upstream.stop();
            await core.idle().catch(() => {});
            await Promise.all([servers.onebot.stop(), servers.app.stop()]);
        },
    };
}
