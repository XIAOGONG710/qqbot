// 设备控制的装配（ADR 0148）：读密钥 → 起取件中心（电脑）→ 手机推送 → 熔断 → 审计 → 控制器；再加他发的 /屏幕 /摄像头 的看图。
//
// 密钥在 <数据目录>/secrets/devices.json（runtime 被 git 忽略；日志里从不写令牌）：
//   { "hub": { "host": "虚拟机的网卡地址", "port": 7789 }, "token": "…", "phone": { "baseUrl": "https://ntfy.sh", "topic": "随机话题", "token": "可选" } }
// 用 `npm run devices -w @qqbot/bot -- init` 生成。取件中心只绑 hub.host 这一个地址，不绑 0.0.0.0。

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { createDeviceControl, jsonlAudit, type AuditEntry, type DeviceControl, type DeviceMode, type DeviceTarget, type DispatchJob, type DispatchResult, type PolicyContext } from './device-actions.ts';
import { createDeviceHub, type DeviceHub } from './device-hub.ts';
import { createPhonePublisher } from './device-phone.ts';
import type { ImageDescriber } from '.././vision/media.ts';
import { BreakerOpen, createBreaker, guardRequest } from '.././bilibili/platform-breaker.ts';

export interface DeviceSecrets {
    hub: { host: string; port: number };
    token: string;
    phone?: { baseUrl: string; topic: string; token?: string };
}

export const devicesSecretsPath = (dataDir: string) => join(dataDir, 'secrets', 'devices.json');

export function validSecrets(value: unknown): value is DeviceSecrets {
    const v = value as Partial<DeviceSecrets> | null;
    return Boolean(v && typeof v === 'object'
        && v.hub && typeof v.hub.host === 'string' && v.hub.host !== '' && v.hub.host !== '0.0.0.0' && Number.isInteger(v.hub.port) && v.hub.port > 1024 && v.hub.port < 65536
        && typeof v.token === 'string' && v.token.length >= 32
        && (v.phone === undefined || (typeof v.phone.baseUrl === 'string' && /^https:\/\//.test(v.phone.baseUrl) && typeof v.phone.topic === 'string' && v.phone.topic.length >= 16)));
}

export function loadDeviceSecrets(path: string): DeviceSecrets | undefined {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!validSecrets(parsed)) throw new Error('devices.json 的格式不对（hub.host / hub.port / token ≥ 32 位 / phone.baseUrl 要 https、phone.topic ≥ 16 位）');
    return parsed;
}

/** 虚拟机上第一个非回环的 IPv4 地址（init 时用来填 hub.host） */
export function guessHubHost(): string | undefined {
    for (const list of Object.values(networkInterfaces())) {
        for (const info of list ?? []) if (info.family === 'IPv4' && !info.internal) return info.address;
    }
    return undefined;
}

export function newDeviceSecrets(host: string, withPhone: boolean, ntfyBase = 'https://ntfy.sh'): DeviceSecrets {
    return {
        hub: { host, port: 7789 },
        token: randomBytes(32).toString('hex'),
        ...(withPhone ? { phone: { baseUrl: ntfyBase, topic: `mengyao-${randomBytes(12).toString('hex')}` } } : {}),
    };
}

export function writeDeviceSecrets(path: string, secrets: DeviceSecrets): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
}

/** 配置里的 deviceLinks：「名字=https://地址」→ Map */
export function linksOf(entries: readonly string[]): Map<string, string> {
    return new Map(entries.map(entry => { const at = entry.indexOf('='); return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()] as const; }));
}

export const DEVICE_MAX_VOLUME = 60;

/** 看屏幕 / 摄像头的描述：不抄密码、账号、证件号、别人的聊天原文；两三句话 */
export const SCREEN_VISION_PROMPT = '这是他电脑屏幕的截图。用两三句简短中文说他大概在做什么、屏幕上主要是什么内容（哪个软件、什么主题）。不要抄任何密码、账号、手机号、证件号、银行卡号，也不要复述别人的聊天或私人信息的原文；看不清就说看不清，不要猜。';
export const CAMERA_VISION_PROMPT = '这是他电脑摄像头拍的一张照片。用一两句简短中文说画面里主要有什么（环境、物品、有没有人）。不要描述陌生人的长相细节；看不清就说看不清，不要猜。';

export type OwnerOutcome =
    | { kind: 'none' }
    /** 直接回他一句小提示（不当聊天、不进聊天记录） */
    | { kind: 'reply'; text: string }
    /** 一轮 await 之后才知道结果：看屏幕 / 摄像头 */
    | { kind: 'capture'; run: () => Promise<{ kind: 'reply'; text: string } | { kind: 'message'; text: string }> };

export interface DeviceService {
    control: DeviceControl;
    hub: DeviceHub;
    /** 他发来的一条纯文字消息是不是设备命令 */
    owner(text: string): OwnerOutcome;
    stop(): Promise<void>;
}

export interface DeviceServiceOptions {
    dataDir: string;
    mode: Exclude<DeviceMode, 'off'>;
    links: readonly string[];
    apps: readonly string[];
    /** 把一行小提示发给他（待批准的说明、批准后没做成） */
    say: (text: string) => void;
    /** 每一条审计记录同时给这个回调（时间线 ADR 0159 用；回调里不能出错影响设备控制） */
    onAudit?: (entry: AuditEntry) => void;
    /** 看图（屏幕 / 摄像头）；没配看图就看不了，截到的图也不留 */
    describe?: { screen?: ImageDescriber; camera?: ImageDescriber };
    log: (message: string) => void;
    now?: () => number;
    /** 测试注入 */
    secrets?: DeviceSecrets;
    phoneRequest?: Parameters<typeof createPhonePublisher>[0]['request'];
    hubOverrides?: Partial<Parameters<typeof createDeviceHub>[0]>;
}

export async function startDeviceService(options: DeviceServiceOptions): Promise<DeviceService | undefined> {
    const { log } = options;
    let secrets: DeviceSecrets | undefined;
    try {
        secrets = options.secrets ?? loadDeviceSecrets(devicesSecretsPath(options.dataDir));
    } catch (error) {
        log(`设备控制：密钥文件读不了，不启动（${error instanceof Error ? error.message : String(error)}）`);
        return undefined;
    }
    if (!secrets) {
        log('设备控制：开着，但没有 secrets/devices.json——先运行 `npm run devices -w @qqbot/bot -- init` 生成令牌，再把令牌填进电脑上的 device-agent.config.json；这次不启动');
        return undefined;
    }
    const devicesBreaker = createBreaker({ dataDir: options.dataDir, platform: 'devices', log, ...(options.now ? { now: options.now } : {}) });
    const phoneBreaker = createBreaker({ dataDir: options.dataDir, platform: 'phone', log, ...(options.now ? { now: options.now } : {}) });
    const hub = createDeviceHub({
        host: secrets.hub.host, port: secrets.hub.port, token: secrets.token, log,
        ...(options.now ? { now: options.now } : {}),
        onTamper: failures => devicesBreaker.trip(`取件中心 10 分钟内认证失败 ${failures} 次`),
        ...options.hubOverrides,
    });
    let hubUp = false;
    try {
        await hub.start();
        hubUp = true;
    } catch (error) {
        log(`设备控制：取件中心起不来（${secrets.hub.host}:${secrets.hub.port}：${error instanceof Error ? error.message : String(error)}），电脑这一头先不用；多半是虚拟机的地址变了，改 secrets/devices.json 的 hub.host`);
    }
    const phone = secrets.phone
        ? createPhonePublisher({
            baseUrl: secrets.phone.baseUrl, topic: secrets.phone.topic, ...(secrets.phone.token ? { token: secrets.phone.token } : {}),
            request: guardRequest(options.phoneRequest ?? ((url, init) => fetch(url, init)), phoneBreaker, { statuses: [401, 403, 429], codes: [] }),
        })
        : undefined;
    const context: PolicyContext = { links: linksOf(options.links), apps: options.apps, maxVolume: DEVICE_MAX_VOLUME };
    const draftsPath = join(options.dataDir, 'devices', 'drafts.md');

    const dispatch = async (job: DispatchJob): Promise<DispatchResult> => {
        try { devicesBreaker.check(); } catch (error) { return { ok: false, error: error instanceof BreakerOpen ? '设备控制熔断中' : '出错了' }; }
        if (job.target === 'computer') return hubUp ? hub.submit({ action: job.action, params: job.params }) : { ok: false, error: '取件中心没起来' };
        return phone ? phone(job) : { ok: false, error: '手机这一头没配' };
    };
    const control = createDeviceControl({
        mode: options.mode, context, dispatch,
        available: () => {
            const list: DeviceTarget[] = [];
            if (hubUp && hub.online()) list.push('computer');
            if (phone) list.push('phone');
            return list;
        },
        say: options.say,
        ...(options.now ? { now: options.now } : {}),
        audit: (() => {
            const write = jsonlAudit(join(options.dataDir, 'devices', 'audit.jsonl'));
            return (entry: AuditEntry) => {
                write(entry);
                try { options.onAudit?.(entry); } catch { /* 时间线出错不影响设备控制 */ }
            };
        })(),
        draft: line => { mkdirSync(dirname(draftsPath), { recursive: true }); appendFileSync(draftsPath, `- ${line}\n`); },
        log,
    });

    log(`设备控制：${options.mode === 'dryRun' ? '试运行（只写草稿，不执行）' : '开'}；电脑${hubUp ? `：取件中心 ${secrets.hub.host}:${hub.port()}，等电脑上的 device-agent 来取` : '：没起来'}；手机${phone ? '：ntfy 推送' : '：没配'}；登记的网页 ${context.links.size} 个、应用 ${context.apps.length} 个`);

    return {
        control, hub,
        owner(text) {
            const action = control.ownerSays(text);
            if (action.kind === 'none') return { kind: 'none' };
            if (action.kind === 'reply') return { kind: 'reply', text: action.text };
            return {
                kind: 'capture',
                run: async () => {
                    const result = await control.capture(action.what);
                    if (!result.ok || !result.dataUrl) return { kind: 'reply', text: `（${result.error ?? '没看成'}）` };
                    const describer = action.what === 'capture_screen' ? options.describe?.screen : options.describe?.camera;
                    if (!describer) return { kind: 'reply', text: '（截到了，但看图没开，她看不了——图我也没留）' };
                    try {
                        const seen = (await describer.describe({ url: '', dataUrl: result.dataUrl, signal: AbortSignal.timeout(20_000) })).replace(/\s+/g, ' ').trim().slice(0, 240);
                        if (!seen) return { kind: 'reply', text: '（她没看清）' };
                        const what = action.what === 'capture_screen' ? '电脑屏幕' : '电脑摄像头拍的画面';
                        return { kind: 'message', text: `[他让你看了一眼他的${what}：${seen}]${action.note ? ` ${action.note}` : ''}` };
                    } catch (error) {
                        log(`设备控制：看图失败（${error instanceof Error ? error.message : String(error)}）`);
                        return { kind: 'reply', text: '（她没看成）' };
                    }
                },
            };
        },
        stop: () => hub.stop(),
    };
}
