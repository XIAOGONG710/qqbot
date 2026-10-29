// 常驻的她（scripts/her-resident.mjs）的本地接口守卫（ADR 0172）。
// 用户 10-29 明确给了工作模式整机权限（danger-full-access）。整机权限是给「他从 QQ 发来的任务」的，
// 不是给本机任何进程、也不是给他浏览器里打开的任何网页：这里挡的就是后面这两类。
//   1. Host 必须是 127.0.0.1:<端口> / localhost:<端口>（挡 DNS 重绑定）；
//   2. 带 Origin 头的一律拒绝（浏览器跨站请求都会带；「简单 POST」不触发预检，没有这条网页就能直接排任务）；
//   3. 除 GET /health 以外都要共享令牌（X-Her-Token，定长比较）；令牌是常驻进程第一次启动时随机生成、只存在用户目录下的文件里；
//   4. POST 必须是 application/json（否则 text/plain 的跨站请求能绕开预检）。
// 只管「这个请求让不让进」，不管任务做什么。

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TOKEN_HEADER = 'x-her-token';
export const TOKEN_FILE = 'RESIDENT_TOKEN';

/** 常驻进程自己的目录（日志、令牌）。和 scripts/her-resident.mjs 的 HER_DIR 一致 */
export const residentDir = (env: NodeJS.ProcessEnv = process.env): string => env.HER_DIR ?? join(homedir(), '.dsh', 'her');

/** 工作模式 / 常驻进程起智能体用的权限模式：用户 10-29 给的是整机权限；以后要降档只改这一个环境变量 */
export const permissionMode = (env: NodeJS.ProcessEnv = process.env): string => env.HER_PERMISSION_MODE || 'danger-full-access';

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** 读令牌；没有、格式不对返回 undefined（调用方当「没有令牌」处理，不要硬编码一个） */
export function readToken(dir: string): string | undefined {
    try {
        const text = readFileSync(join(dir, TOKEN_FILE), 'utf8').trim();
        return TOKEN_PATTERN.test(text) ? text : undefined;
    } catch {
        return undefined;
    }
}

/** 没有就生成一个并存盘（只在常驻进程里调用）；已经有合格的就原样用 */
export function ensureToken(dir: string): string {
    const existing = readToken(dir);
    if (existing) return existing;
    mkdirSync(dir, { recursive: true });
    const token = randomBytes(32).toString('hex');
    const path = join(dir, TOKEN_FILE);
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows 上权限靠用户目录的 ACL，chmod 不一定有效 */ }
    return token;
}

export type GuardVerdict = { ok: true } | { ok: false; status: 400 | 401 | 403 | 415; error: string };

export interface GuardRequest {
    method?: string | undefined;
    url?: string | undefined;
    headers: Record<string, string | string[] | undefined>;
}

const one = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function sameToken(given: string | undefined, token: string): boolean {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function checkRequest(request: GuardRequest, options: { token: string; port: number }): GuardVerdict {
    const host = one(request.headers.host)?.toLowerCase();
    if (host !== `127.0.0.1:${options.port}` && host !== `localhost:${options.port}`) return { ok: false, status: 400, error: 'bad host' };
    if (one(request.headers.origin) !== undefined) return { ok: false, status: 403, error: 'cross-origin requests are not allowed' };
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'GET' && request.url === '/health') return { ok: true };
    if (!sameToken(one(request.headers[TOKEN_HEADER]), options.token)) return { ok: false, status: 401, error: 'token required' };
    if (method === 'POST' && !(one(request.headers['content-type']) ?? '').toLowerCase().startsWith('application/json')) {
        return { ok: false, status: 415, error: 'application/json required' };
    }
    return { ok: true };
}
