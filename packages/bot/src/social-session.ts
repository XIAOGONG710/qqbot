// 一次浏览会话（ADR 0166）：熔断没开、内存够，才开浏览器；开在专用的用户数据目录里；读者建好交给调用方；用完关。
// 浏览器是按需开的（虚拟机 6 GB 内存），不常驻。

import { join } from 'node:path';
import { findBrowserExe, launchBrowser, type Browser, type Page } from './browser-cdp.ts';
import { createBreaker, type PlatformBreaker } from './platform-breaker.ts';
import { createNavBudget, memoryOk, PLATFORM_NAME, realPacing, type Pacing, type Platform, type SocialReader } from './social.ts';
import { createDouyinReader } from './social-douyin.ts';
import { createXhsReader } from './social-xhs.ts';

/** 这次不开：内存不够、没有浏览器。熔断中不走这里（直接抛 BreakerOpen） */
export class SessionRefused extends Error {
    readonly reason: 'memory' | 'noBrowser';
    constructor(message: string, reason: 'memory' | 'noBrowser') {
        super(message);
        this.name = 'SessionRefused';
        this.reason = reason;
    }
}

export interface SessionOptions {
    platform: Platform;
    dataDir: string;
    log: (message: string) => void;
    /** 扫码登录要看见窗口、要加载图片（二维码是图片） */
    visible?: boolean;
    images?: boolean;
    pacing?: Pacing;
    /** 测试注入 */
    launch?: typeof launchBrowser;
    exe?: string | undefined;
    freeBytes?: () => number;
    breaker?: PlatformBreaker;
}

export interface SocialSession {
    readonly platform: Platform;
    readonly reader: SocialReader;
    readonly page: Page;
    readonly breaker: PlatformBreaker;
    close(): Promise<void>;
}

export const profileDir = (dataDir: string, platform: Platform) => join(dataDir, 'secrets', 'browser', platform);

export async function openSocialSession(options: SessionOptions): Promise<SocialSession> {
    const { platform, dataDir, log } = options;
    const breaker = options.breaker ?? createBreaker({ dataDir, platform, log });
    breaker.check();
    if (!memoryOk(options.freeBytes?.())) throw new SessionRefused(`${PLATFORM_NAME[platform]}：内存不够（浏览器要约 450 MB），这次不开`, 'memory');
    const exe = 'exe' in options ? options.exe : findBrowserExe();
    if (!exe) throw new SessionRefused('找不到 Edge / Chrome（可以用环境变量 QQBOT_BROWSER_EXE 指定）', 'noBrowser');
    const browser: Browser = await (options.launch ?? launchBrowser)({ exe, profileDir: profileDir(dataDir, platform), log, offscreen: !options.visible, visible: Boolean(options.visible), images: Boolean(options.images) });
    let page: Page;
    try {
        page = await browser.newPage();
    } catch (error) {
        await browser.close();
        throw error;
    }
    const pacing = options.pacing ?? realPacing;
    const deps = { page, breaker, pacing, budget: createNavBudget(), log };
    const reader = platform === 'xhs' ? createXhsReader(deps) : createDouyinReader(deps);
    let closed = false;
    return {
        platform, reader, page, breaker,
        async close() {
            if (closed) return;
            closed = true;
            await page.close();
            await browser.close();
        },
    };
}
