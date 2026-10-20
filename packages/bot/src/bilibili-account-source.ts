// 她的 B 站号的来源（ADR 0089）：按需打开，凭证文件换了（重新扫码）就自动换上，不用重启 Koishi。
// 第一次要用时才请求 B 站；打不开（断网、风控）隔 30 分钟再试，只记一次日志；
// 没有凭证文件 / 读不了 / 已失效：记一次日志，之后只在凭证文件的修改时间变了才再试。不记凭证内容。

import { statSync } from 'node:fs';
import { credentialPath, loadCredential, openAccount, type BiliAccount, type BiliRequest } from './bilibili-account.ts';

export interface AccountSourceOptions {
    dataDir: string;
    request: BiliRequest;
    now: () => number;
    log: (message: string) => void;
}

/** 打不开账号（断网、风控）之后隔多久再试 */
export const OPEN_RETRY_MS = 30 * 60_000;

export function createAccountSource(options: AccountSourceOptions): () => Promise<BiliAccount | undefined> {
    const { request, now, log } = options;
    const path = credentialPath(options.dataDir);
    /** 凭证文件的修改时间（没有文件是 -1）：换了凭证（重新扫码）就当成新的一次 */
    const stamp = (): number => { try { return statSync(path).mtimeMs; } catch { return -1; } };
    let opened: BiliAccount | undefined;
    let openedStamp = 0;
    let gone = false;
    let goneStamp = 0;
    let nextTryAt = 0;
    let failureLogged = false;
    const giveUp = (message: string) => { gone = true; goneStamp = stamp(); log(message); };
    return async () => {
        const current = stamp();
        if (opened && current !== openedStamp) {
            opened = undefined;
            nextTryAt = 0;
            log('B 站账号：凭证文件换了，重新打开');
        }
        if (opened) return opened;
        if (gone && current !== goneStamp) { gone = false; nextTryAt = 0; failureLogged = false; }
        if (gone || now() < nextTryAt) return undefined;
        let credential;
        try {
            credential = loadCredential(path, log);
        } catch (error) {
            giveUp(`B 站账号：凭证文件读不了，这次不用账号（修好或重新扫码后自动再试）：${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
        if (!credential) {
            giveUp('B 站账号：开关开着，但没有凭证文件——先在命令行运行 `npm run bilibili-login -w @qqbot/bot` 扫码登录（不用重启，会自动用上）；这次只读热门榜');
            return undefined;
        }
        try {
            const account = await openAccount(request, credential, { log });
            if (!account) {
                giveUp('B 站账号：凭证已经失效（B 站说没登录）——重新扫码登录即可（不用重启）；这次只读热门榜');
                return undefined;
            }
            opened = account;
            openedStamp = current;
            failureLogged = false;
            log(`B 站账号：已登录「${account.name}」，按口味搜视频、读字幕`);
            return opened;
        } catch (error) {
            nextTryAt = now() + OPEN_RETRY_MS;
            if (!failureLogged) {
                failureLogged = true;
                log(`B 站账号：打开失败（断网或风控，之后不再记，30 分钟后再试）：${error instanceof Error ? error.message : String(error)}`);
            }
            return undefined;
        }
    };
}
