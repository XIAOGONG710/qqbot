// 给她的 B 站号扫码登录（ADR 0089）：命令行里跑一次，用户用手机 B 站 App 扫码确认，凭证存到 <数据目录>/secrets/bilibili.json。
// 逻辑在这里（请求、睡眠、输出都注入，测试用假的）；bilibili-login-cli.ts 只负责读参数、打开图片。
// 凭证内容从不打印：只说登录了哪个账号（昵称 + uid）。

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { credentialPath, loadCredential, openAccount, qrGenerate, qrPoll, saveCredential, type BiliRequest } from './bilibili-account.ts';
import { qrSvg, qrTerminal } from './qr.ts';

export interface LoginDeps {
    request: BiliRequest;
    dataDir: string;
    out: (line: string) => void;
    /** 把二维码交给用户：图片文件路径（SVG）和能直接在终端里扫的文字版 */
    showQr: (qr: { svgPath: string; terminal: string }) => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    pollEveryMs?: number;
}

export type LoginResult =
    | { ok: true; name: string; mid: number }
    | { ok: false; reason: 'expired' | 'timeout' | 'failed'; message: string };

/** B 站的登录二维码 180 秒有效；多等 10 秒留给确认那一下 */
export const LOGIN_TIMEOUT_MS = 190_000;
const POLL_EVERY_MS = 2_000;
/** 轮询连着几次拿到看不懂的状态就放弃 */
const UNKNOWN_LIMIT = 5;

export const loginQrPath = (dataDir: string) => join(dataDir, 'secrets', 'bilibili-login-qr.svg');

/** 扫码登录：成功后凭证已经存好，并用它问过一次 B 站确认是哪个账号 */
export async function runLogin(deps: LoginDeps): Promise<LoginResult> {
    const { out } = deps;
    const svgPath = loginQrPath(deps.dataDir);
    try {
        const start = await qrGenerate(deps.request);
        mkdirSync(dirname(svgPath), { recursive: true });
        writeFileSync(svgPath, qrSvg(start.url));
        deps.showQr({ svgPath, terminal: qrTerminal(start.url) });
        out('请用【给她用的那个 B 站账号】的手机 App 扫这张码（我的 → 右上角扫一扫），然后在手机上点「确认登录」。二维码 3 分钟内有效。');
        const deadline = deps.now() + LOGIN_TIMEOUT_MS;
        let scannedTold = false;
        let unknown = 0;
        while (deps.now() < deadline) {
            const polled = await qrPoll(deps.request, start.key, deps.now);
            switch (polled.state) {
                case 'ok': {
                    saveCredential(credentialPath(deps.dataDir), polled.credential);
                    out('已保存登录凭证，正在确认是哪个账号……');
                    try {
                        const account = await openAccount(deps.request, polled.credential, { now: deps.now });
                        if (account) {
                            out(`登录成功：「${account.name}」（uid ${account.mid}）。凭证约半年有效，过期了重新跑这个命令。`);
                            return { ok: true, name: account.name, mid: account.mid };
                        }
                        return { ok: false, reason: 'failed', message: '凭证存下来了，但 B 站说还没登录——再跑一次试试' };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        out(`凭证已保存，但确认账号时出错（${message}）；之后用 --check 再确认`);
                        return { ok: true, name: '', mid: 0 };
                    }
                }
                case 'scanned':
                    if (!scannedTold) { scannedTold = true; out('已扫码，请在手机上点「确认登录」……'); }
                    break;
                case 'expired':
                    return { ok: false, reason: 'expired', message: '二维码过期了，重新运行一次' };
                case 'unknown':
                    if (++unknown >= UNKNOWN_LIMIT) return { ok: false, reason: 'failed', message: `登录接口返回了看不懂的状态（code ${String(polled.code)}：${polled.message}）` };
                    break;
                case 'waiting':
                    break;
            }
            await deps.sleep(deps.pollEveryMs ?? POLL_EVERY_MS);
        }
        return { ok: false, reason: 'timeout', message: '3 分钟内没有扫码确认，重新运行一次' };
    } catch (error) {
        return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) };
    } finally {
        rmSync(svgPath, { force: true });
    }
}

export type CheckResult =
    | { ok: true; name: string; mid: number }
    | { ok: false; reason: 'missing' | 'invalid' | 'failed'; message: string };

/** 只确认现有凭证还能不能用（--check）：不改任何东西 */
export async function checkLogin(deps: Pick<LoginDeps, 'request' | 'dataDir' | 'now'>): Promise<CheckResult> {
    let credential;
    try {
        credential = loadCredential(credentialPath(deps.dataDir));
    } catch (error) {
        return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
    if (!credential) return { ok: false, reason: 'missing', message: '还没有登录凭证，先运行登录命令' };
    try {
        const account = await openAccount(deps.request, credential, { now: deps.now });
        return account
            ? { ok: true, name: account.name, mid: account.mid }
            : { ok: false, reason: 'invalid', message: '凭证已经失效（B 站说没登录），重新运行登录命令' };
    } catch (error) {
        return { ok: false, reason: 'failed', message: `问 B 站时出错（断网或风控，不代表凭证失效）：${error instanceof Error ? error.message : String(error)}` };
    }
}
