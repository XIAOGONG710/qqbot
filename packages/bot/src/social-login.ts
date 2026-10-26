// 给她的小红书 / 抖音专号扫码登录（ADR 0166）：开真浏览器，取页面自己生成的登录二维码，在终端里画出来，用户拿专号的 App 扫。
// 登录态留在专用的浏览器目录里（<数据目录>/secrets/browser/<平台>/），不读出来、不打印、不进日志。
// 碰到验证码 / 滑块：不去解，改用 --visible 开一个看得见的窗口，由人自己点。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { qrTerminal } from './qr.ts';
import { PLATFORM_NAME, waitFor, type Pacing } from './social.ts';
import { DOUYIN_LOGIN_COOKIES } from './social-douyin.ts';
import type { SocialSession } from './social-session.ts';
import { XHS_FEED_JS, type RawXhsFeed } from './social-xhs.ts';

const LOGIN_WAIT_MS = 180_000;
const POLL_MS = 2_000;

/** 登录二维码接口的响应里，找二维码里该编码的那条链接：键名带 qr / url、值是 http(s) 链接的第一个（响应的具体结构以第一次实测为准，见 ADR 0166） */
export function findQrLink(json: unknown, depth = 0): string | undefined {
    if (depth > 4 || json === null || typeof json !== 'object') return undefined;
    for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
        if (typeof value === 'string' && /^https?:\/\/\S+$/.test(value) && /qr|url|link/i.test(key)) return value;
    }
    for (const value of Object.values(json as Record<string, unknown>)) {
        const found = findQrLink(value, depth + 1);
        if (found) return found;
    }
    return undefined;
}

/** 页面左上 / 顶部那个「登录」按钮的中心坐标（叶子元素、文字正好是「登录」、看得见、在顶部 160 px 以内） */
export const LOGIN_BUTTON_JS = `(() => { const hit = [...document.querySelectorAll('button,div,span,a')].filter(e => e.children.length === 0 && (e.textContent || '').trim() === '登录')
  .map(e => e.getBoundingClientRect()).find(r => r.width > 0 && r.height > 0 && r.top >= 0 && r.top < 160);
  return hit ? { x: Math.round(hit.left + hit.width / 2), y: Math.round(hit.top + hit.height / 2) } : null; })()`;

/** 链接只说主机、路径和参数名，不带参数值（一次性的登录凭据不进输出记录） */
export function linkShape(link: string): string {
    try {
        const url = new URL(link);
        const keys = [...url.searchParams.keys()];
        return `${url.host}${url.pathname}${keys.length ? `?${keys.join('&')}` : ''}（共 ${link.length} 字符）`;
    } catch { return `（不是链接，${link.length} 字符）`; }
}

export interface LoginDeps {
    out(line: string): void;
    pacing: Pacing;
    dataDir: string;
    /** 只取二维码、画出来、不等扫码（检查二维码这一段能不能走通） */
    qrOnly?: boolean;
    /** 等多久（毫秒），测试里缩短 */
    waitMs?: number;
}

export interface LoginResult { ok: boolean; message: string }

async function loggedInNow(session: SocialSession): Promise<boolean> {
    if (session.platform === 'xhs') return (await session.page.evaluate<RawXhsFeed | null>(XHS_FEED_JS).catch(() => null))?.loggedIn === true;
    const names = await session.page.cookieNames(['https://www.douyin.com/']).catch(() => [] as string[]);
    return DOUYIN_LOGIN_COOKIES.some(name => names.includes(name));
}

export async function runSocialLogin(session: SocialSession, deps: LoginDeps): Promise<LoginResult> {
    const { page, platform } = session;
    const name = PLATFORM_NAME[platform];
    const qrApi = platform === 'xhs' ? /\/api\/sns\/web\/v1\/login\/qrcode\/create/ : /\/passport\/web\/get_qrcode\//;

    let since = page.mark();
    const status = await session.reader.status();
    if (status.loggedIn) return { ok: true, message: `${name}已经登录了（${status.detail}）` };

    // 页面可能发了不止一次二维码请求，有的响应体被浏览器丢了（10-26 小红书第一次读不出来、过一会儿的第二次能读）：反复逐条试，读到能用的链接为止
    const readLink = (from: number) => async (): Promise<string | undefined> => {
        for (const candidate of page.responses(qrApi, from)) {
            try { const found = findQrLink(JSON.parse(await candidate.body())); if (found) return found; } catch { /* 这条读不出来，试下一条 */ }
        }
        return undefined;
    };
    // 小红书对访客自动弹登录框、自己去要二维码；抖音要点一下「登录」
    let link = await waitFor(deps.pacing, readLink(since), platform === 'xhs' ? 12_000 : 1_500, 700);
    if (!link) {
        const button = await page.evaluate<{ x: number; y: number } | null>(LOGIN_BUTTON_JS).catch(() => null);
        if (!button) return { ok: false, message: `没找到「登录」按钮，页面可能出了验证（用 --visible 看一眼）` };
        since = page.mark();
        await page.click(button.x, button.y);
        link = await waitFor(deps.pacing, readLink(since), 10_000, 700);
    }
    if (!link) {
        const shot = join(deps.dataDir, 'platforms', platform, 'login-screen.jpg');
        mkdirSync(dirname(shot), { recursive: true });
        writeFileSync(shot, await page.screenshot());
        return { ok: false, message: `没取到${name}的登录二维码链接；页面截图存在 ${shot}（里面的二维码也可以直接扫；或者加 --visible 开一个看得见的窗口）` };
    }

    deps.out(`用【她的${name}专号】的 App 扫下面的二维码并在手机上确认（${Math.round((deps.waitMs ?? LOGIN_WAIT_MS) / 1000)} 秒内有效；别用你自己的主号）：`);
    deps.out(qrTerminal(link));
    deps.out(`二维码内容的形状：${linkShape(link)}`);
    if (deps.qrOnly) return { ok: false, message: '只取二维码（--qr-only），没有等扫码' };

    const attempts = Math.ceil((deps.waitMs ?? LOGIN_WAIT_MS) / POLL_MS);
    for (let i = 0; i < attempts; i++) {
        await deps.pacing.sleep(POLL_MS);
        if (await loggedInNow(session)) {
            // 给浏览器几秒把登录态写进目录，再由调用方关浏览器
            await deps.pacing.sleep(3_000);
            return { ok: true, message: `${name}登录成功；登录态在专用的浏览器目录里（不打印）` };
        }
    }
    return { ok: false, message: `${Math.round((deps.waitMs ?? LOGIN_WAIT_MS) / 1000)} 秒内没有扫码确认，二维码已经过期，要再来一次` };
}
