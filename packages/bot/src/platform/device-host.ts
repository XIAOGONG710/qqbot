import type { Timeline } from '../memory/timeline.ts';
import { timelineFromDevice } from '../memory/timeline.ts';
import { configuredImageDescriber } from '../vision/vision.ts';
import type { AppConfig, Contact } from './config.ts';
import { CAMERA_VISION_PROMPT, SCREEN_VISION_PROMPT, startDeviceService, type DeviceService } from './device-service.ts';
import type { Log } from './log.ts';

// 她对他的电脑和手机的有限控制（ADR 0148，配置 deviceControl）：设备服务的起、停和起来之前的空档。
// 服务是异步起的（要监听端口），起来之前她的菜单是空的、回复里的令牌只摘不用（`service()` 返回 undefined）。
// 原来散在 app.ts 里（deviceService / startingDevice / stopDevices 和起服务那一段），ADR 0336 第 6 步原样搬到这里；
// 解析和登记回复里的设备令牌（deviceHooks）、他发的设备命令仍在 App。
export interface DeviceHostDeps {
    stopped: () => boolean;
    log: Log;
}

export interface DeviceStart {
    config: AppConfig;
    /** 男朋友档的他：只给他 */
    owner: Contact;
    timeline: Timeline | undefined;
    /** 测试注入的起服务；没有就用真的 */
    startDevices: typeof startDeviceService | undefined;
    /** 发给他的设备提示（经 App 的 transport） */
    sendText: (qq: number, text: string) => Promise<unknown>;
}

export interface DeviceHost {
    /** 起来了的设备服务；还没起来、没开、起失败时没有 */
    service(): DeviceService | undefined;
    start(options: DeviceStart): void;
    /** 停：等起服务、停服务和已派发的提示都收完 */
    stop(): Promise<void> | undefined;
}

export function deviceHost({ stopped: isStopped, log }: DeviceHostDeps): DeviceHost {
    let deviceService: DeviceService | undefined;
    let startingDevice: Promise<void> | undefined, serviceStop: Promise<void> | undefined, deviceStopDrain: Promise<void> | undefined;
    const deviceNotifications = new Set<Promise<void>>();
    function stopDeviceService(): Promise<void> | undefined {
        if (!deviceService || serviceStop) return serviceStop;
        try { serviceStop = Promise.resolve(deviceService.stop()); }
        catch (error) { serviceStop = Promise.reject(error); }
        return serviceStop;
    }
    function stopDevices(): Promise<void> | undefined {
        if (deviceStopDrain) return deviceStopDrain;
        const serviceDrain = stopDeviceService();
        const pending = [startingDevice, serviceDrain, ...deviceNotifications].filter((task): task is Promise<void> => task !== undefined);
        if (!pending.length) return undefined;
        deviceStopDrain = Promise.allSettled(pending).then(results => {
            const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failures.length) throw new AggregateError(failures.map(result => result.reason), '设备控制停止收尾未确认');
        });
        return deviceStopDrain;
    }
    function start({ config, owner: deviceOwner, timeline, startDevices, sendText }: DeviceStart): void {
        const describers = config.vision
            ? { screen: configuredImageDescriber(config, SCREEN_VISION_PROMPT), camera: configuredImageDescriber(config, CAMERA_VISION_PROMPT) }
            : undefined;
        startingDevice = (startDevices ?? startDeviceService)({
            dataDir: config.dataDir, mode: config.deviceControl as 'dryRun' | 'on', links: config.deviceLinks, apps: config.deviceApps,
            log: message => { if (!isStopped()) log(message); },
            ...(timeline ? { onAudit: (entry: Parameters<NonNullable<Parameters<typeof startDeviceService>[0]['onAudit']>>[0]) => { if (!isStopped()) timelineFromDevice(timeline)(entry); } } : {}),
            say: text => {
                if (isStopped()) return;
                // Register settlement before invoking the public transport:
                // it may synchronously re-enter App.stop while dispatching.
                let settle!: () => void;
                const pending = new Promise<void>(resolve => { settle = resolve; });
                deviceNotifications.add(pending);
                const done = () => { deviceNotifications.delete(pending); settle(); };
                const failed = (error: unknown) => {
                    try { if (!isStopped()) log(`设备控制：提示没发出去（${error instanceof Error ? error.message : String(error)}）`); }
                    catch { /* 诊断失败不能悬置已经结束的发送。 */ }
                    finally { done(); }
                };
                try { void sendText(deviceOwner.qq, text).then(done, failed); }
                catch (error) { failed(error); }
            },
            ...(describers?.screen && describers.camera ? { describe: { screen: describers.screen, camera: describers.camera } } : {}),
        }).then(async service => {
            deviceService = service;
            if (isStopped()) await stopDeviceService();
        }, error => { if (!isStopped()) log(`设备控制：启动出错（${error instanceof Error ? error.message : String(error)}）`); });
        // The constructor rollback observes the original drain (including a
        // late service.stop rejection); keep normal startup rejection handled.
        void startingDevice.catch(() => {});
    }
    return { service: () => deviceService, start, stop: stopDevices };
}
