// 用真浏览器（Edge / Chrome）的开发者协议（CDP）上网页（ADR 0166）。
// 小红书、抖音的网页接口每一步都要网页自己的脚本现算签名；我们不去仿造签名，也不改浏览器的指纹、不装隐身插件：
// 开一个正常的浏览器，让网页自己发请求、自己签名，我们只读它收到的内容、像人一样滚一滚。
// 被拦（验证码、风控页、风控码）就停，由 platform-breaker.ts 熔断，不去想办法绕。
//
// 只用 Node 自带的 WebSocket，没有新依赖。浏览器按需开、用完就关（虚拟机只有 6 GB 内存，不常驻）。
// 登录态放在专用的用户数据目录里（<数据目录>/secrets/browser/<平台>/），和用户自己的浏览器不共用。

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ───────── 协议连接 ─────────

/** 最小的传输形状（真的用 WebSocket，测试注入假的） */
export interface CdpTransport {
    send(text: string): void;
    close(): void;
    onMessage(listener: (text: string) => void): void;
    onClose(listener: () => void): void;
}

export interface CdpConnection {
    /** timeoutMs：这一条命令自己的超时（不给就用连接的默认值） */
    send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
    on(event: string, listener: (params: any, sessionId: string | undefined) => void): () => void;
    close(): void;
    readonly closed: boolean;
}

export class CdpError extends Error {
    readonly code: number | undefined;
    constructor(message: string, code?: number) {
        super(message);
        this.name = 'CdpError';
        this.code = code;
    }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export function createCdpConnection(transport: CdpTransport, options: { commandTimeoutMs?: number } = {}): CdpConnection {
    const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    let nextId = 0;
    let closed = false;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const listeners = new Map<string, Set<(params: any, sessionId: string | undefined) => void>>();

    const failAll = (message: string) => {
        for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(new CdpError(message)); pending.delete(id); }
    };
    transport.onMessage(text => {
        let message: { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string; params?: unknown; sessionId?: string };
        try { message = JSON.parse(text); } catch { return; }
        if (typeof message.id === 'number') {
            const entry = pending.get(message.id);
            if (!entry) return;
            pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error) entry.reject(new CdpError(message.error.message ?? '协议错误', message.error.code));
            else entry.resolve(message.result ?? {});
            return;
        }
        if (typeof message.method === 'string') {
            for (const listener of [...(listeners.get(message.method) ?? [])]) {
                try { listener(message.params ?? {}, message.sessionId); } catch { /* 一个监听出错不影响别的 */ }
            }
        }
    });
    transport.onClose(() => { closed = true; failAll('浏览器连接断了'); });

    return {
        send(method, params, sessionId, commandTimeoutMs) {
            if (closed) return Promise.reject(new CdpError('浏览器连接已经关了'));
            const id = ++nextId;
            const limit = commandTimeoutMs ?? timeoutMs;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(id); reject(new CdpError(`${method} 超时（${limit} ms）`)); }, limit);
                pending.set(id, { resolve, reject, timer });
                transport.send(JSON.stringify({ id, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }));
            });
        },
        on(event, listener) {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
            return () => { set.delete(listener); };
        },
        close() { if (!closed) { closed = true; failAll('浏览器连接已经关了'); transport.close(); } },
        get closed() { return closed; },
    };
}

/** 真的传输：Node 自带的 WebSocket；连不上就抛错 */
export function webSocketTransport(url: string, timeoutMs = 10_000): Promise<CdpTransport> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const messageListeners: Array<(text: string) => void> = [];
        const closeListeners: Array<() => void> = [];
        const timer = setTimeout(() => { reject(new CdpError('连不上浏览器的调试端口')); try { socket.close(); } catch { /* 已经断了 */ } }, timeoutMs);
        socket.addEventListener('open', () => {
            clearTimeout(timer);
            resolve({
                send: text => socket.send(text),
                close: () => { try { socket.close(); } catch { /* 已经断了 */ } },
                onMessage: listener => { messageListeners.push(listener); },
                onClose: listener => { closeListeners.push(listener); },
            });
        });
        socket.addEventListener('message', event => { const text = typeof event.data === 'string' ? event.data : String(event.data); for (const listener of messageListeners) listener(text); });
        socket.addEventListener('close', () => { for (const listener of closeListeners) listener(); });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new CdpError('连不上浏览器的调试端口')); });
    });
}

// ───────── 页面 ─────────

export interface CapturedResponse {
    /** 收到的先后序号（只增不减，裁掉旧记录之后也不乱） */
    seq: number;
    requestId: string;
    url: string;
    status: number;
    mimeType: string;
    finished: boolean;
    failed: boolean;
}

export interface Page {
    goto(url: string, options?: { timeoutMs?: number }): Promise<void>;
    evaluate<T = unknown>(expression: string): Promise<T>;
    /** 从现在起收到的响应（按 URL 正则筛）的序号，等 waitForResponse 用 */
    mark(): number;
    /** 等一个 URL 符合的响应读完（序号 since 之后的，包括已经读完的）；超时返回 undefined */
    waitForResponse(match: RegExp, options?: { since?: number; timeoutMs?: number }): Promise<{ url: string; status: number; body(): Promise<string> } | undefined>;
    /** 序号 since 之后读完的、URL 符合的全部响应 */
    responses(match: RegExp, since?: number): Array<{ url: string; status: number; body(): Promise<string> }>;
    /** 像人一样滚轮往下滚 */
    wheel(deltaY: number): Promise<void>;
    /** 真的鼠标点击（按下、松开），坐标是页面里的像素 */
    click(x: number, y: number): Promise<void>;
    /** clipTo：只截这个 CSS 选择器对应的元素（读不到就截整个视口） */
    screenshot(options?: { jpegQuality?: number; clipTo?: string }): Promise<Buffer>;
    /** 这些网址下的 cookie **名字**（用来判断登录了没有）；值不读出来、不记录 */
    cookieNames(urls: string[]): Promise<string[]>;
    url(): Promise<string>;
    close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function openPage(connection: CdpConnection, options: { viewport?: { width: number; height: number } } = {}): Promise<Page> {
    const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const call = <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => connection.send<T>(method, params, sessionId, timeoutMs);
    await call('Page.enable');
    // 响应体要留得住：默认的缓冲很小，页面里的视频、图片一多，早先的接口响应体就读不出来了
    await call('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024 });
    const viewport = options.viewport ?? { width: 1280, height: 860 };
    await call('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });

    const captured: CapturedResponse[] = [];
    let nextSeq = 0;
    const byId = new Map<string, CapturedResponse>();
    const waiters = new Set<() => void>();
    const wake = () => { for (const waiter of [...waiters]) waiter(); };
    const mine = (id: string | undefined) => id === sessionId;
    connection.on('Network.responseReceived', (params, id) => {
        if (!mine(id)) return;
        const response = { seq: nextSeq++, requestId: String(params.requestId), url: String(params.response?.url ?? ''), status: Number(params.response?.status ?? 0), mimeType: String(params.response?.mimeType ?? ''), finished: false, failed: false };
        byId.set(response.requestId, response);
        captured.push(response);
        // 只留最近 400 条的记录，免得滚很久之后内存越攒越多
        if (captured.length > 400) { const dropped = captured.splice(0, captured.length - 400); for (const old of dropped) byId.delete(old.requestId); }
    });
    connection.on('Network.loadingFinished', (params, id) => {
        if (!mine(id)) return;
        const response = byId.get(String(params.requestId));
        if (response) { response.finished = true; wake(); }
    });
    connection.on('Network.loadingFailed', (params, id) => {
        if (!mine(id)) return;
        const response = byId.get(String(params.requestId));
        if (response) { response.failed = true; wake(); }
    });
    let loadWaiter: (() => void) | undefined;
    connection.on('Page.loadEventFired', (_params, id) => { if (mine(id)) loadWaiter?.(); });

    const view = (response: CapturedResponse) => ({
        url: response.url,
        status: response.status,
        async body() {
            // 读不出来的（被浏览器丢了缓冲）要尽快失败，不能拖住整次浏览
            const { body, base64Encoded } = await call<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: response.requestId }, 8_000);
            return base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        },
    });
    const ready = (match: RegExp, since: number) => captured.filter(response => response.seq >= since && response.finished && !response.failed && match.test(response.url));

    return {
        async goto(url, { timeoutMs = 30_000 } = {}) {
            const loaded = new Promise<void>(resolve => { loadWaiter = resolve; });
            const result = await call<{ errorText?: string }>('Page.navigate', { url });
            if (result.errorText) throw new CdpError(`打不开 ${new URL(url).host}：${result.errorText}`);
            await Promise.race([loaded, sleep(timeoutMs)]);
            loadWaiter = undefined;
        },
        async evaluate<T>(expression: string) {
            const result = await call<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (result.exceptionDetails) throw new CdpError(`页面脚本出错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知'}`);
            return result.result?.value as T;
        },
        mark: () => nextSeq,
        async waitForResponse(match, { since = 0, timeoutMs = 15_000 } = {}) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const found = ready(match, since)[0];
                if (found) return view(found);
                const left = deadline - Date.now();
                if (left <= 0) return undefined;
                await new Promise<void>(resolve => { const done = () => { waiters.delete(done); clearTimeout(timer); resolve(); }; const timer = setTimeout(done, Math.min(left, 500)); waiters.add(done); });
            }
        },
        responses: (match, since = 0) => ready(match, since).map(view),
        async wheel(deltaY) {
            await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2), deltaX: 0, deltaY });
        },
        async click(x, y) {
            await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
            await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        },
        async screenshot({ jpegQuality = 70, clipTo } = {}) {
            let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
            if (clipTo) {
                // 只截这个元素（比如正在播的 video）：没有这个元素、或小到看不清，就截整个视口
                const rect = await call<{ result?: { value?: typeof clip | null } }>('Runtime.evaluate', {
                    expression: `(() => { const e = document.querySelector(${JSON.stringify(clipTo)}); if (!e) return null; const b = e.getBoundingClientRect();
                      return b.width > 50 && b.height > 50 ? { x: Math.max(0, b.left), y: Math.max(0, b.top), width: b.width, height: b.height, scale: 1 } : null; })()`,
                    returnByValue: true,
                });
                clip = rect.result?.value ?? undefined;
            }
            const { data } = await call<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: jpegQuality, ...(clip ? { clip } : {}) });
            return Buffer.from(data, 'base64');
        },
        async cookieNames(urls) {
            const { cookies } = await call<{ cookies: Array<{ name: string }> }>('Network.getCookies', { urls });
            return [...new Set(cookies.map(cookie => cookie.name))];
        },
        url: () => call<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).then(result => String(result.result?.value ?? '')),
        async close() { try { await connection.send('Target.closeTarget', { targetId }); } catch { /* 浏览器已经关了 */ } },
    };
}

// ───────── 启动 / 关闭浏览器 ─────────

export interface Browser {
    readonly pid: number | undefined;
    newPage(): Promise<Page>;
    close(): Promise<void>;
}

/** 常见位置里第一个存在的浏览器；环境变量 QQBOT_BROWSER_EXE 优先 */
export function findBrowserExe(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
    const candidates = [env.QQBOT_BROWSER_EXE,
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
    return candidates.find((path): path is string => Boolean(path) && exists(path!));
}

/** DevToolsActivePort 文件：第一行端口，第二行浏览器的 WebSocket 路径 */
export function parseActivePort(text: string): { port: number; path: string } | undefined {
    const [port, path] = text.split(/\r?\n/);
    const number = Number(port);
    return Number.isInteger(number) && number > 0 && path?.startsWith('/devtools/') ? { port: number, path } : undefined;
}

export interface LaunchOptions {
    exe: string;
    /** 专用的用户数据目录（登录态放这里） */
    profileDir: string;
    log?: (message: string) => void;
    /** 窗口放到屏幕外面，不挡虚拟机桌面（不是无头模式：无头会在 UA 里写 HeadlessChrome，被网站当成机器人） */
    offscreen?: boolean;
    /** 用户扫码登录时要看见窗口 */
    visible?: boolean;
    /** 不加载图片（浏览器自己的「不显示图片」设置）：小红书首页开着要 600 MB，空闲内存掉到 227 MB（10-26 实测），虚拟机只有 6 GB；默认关掉，要看图的页面再开 */
    images?: boolean;
    startTimeoutMs?: number;
    /** 测试注入 */
    spawnProcess?: typeof spawn;
    connect?: (url: string) => Promise<CdpTransport>;
}

export function launchArgs(options: Pick<LaunchOptions, 'profileDir' | 'offscreen' | 'visible' | 'images'>): string[] {
    return [
        `--user-data-dir=${options.profileDir}`, '--remote-debugging-port=0', '--remote-allow-origins=*',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--disable-gpu',
        ...(options.images === true ? [] : ['--blink-settings=imagesEnabled=false']),
        ...(options.visible || options.offscreen === false ? [] : ['--window-position=-2400,-2400', '--window-size=1280,900']),
        'about:blank',
    ];
}

export async function launchBrowser(options: LaunchOptions): Promise<Browser> {
    const { exe, profileDir } = options;
    const log = options.log ?? (() => undefined);
    mkdirSync(profileDir, { recursive: true });
    const portFile = join(profileDir, 'DevToolsActivePort');
    rmSync(portFile, { force: true });
    // 参数只管省资源和放哪儿，不碰「网站怎么看待这个浏览器」：不加 --headless（UA 会写 HeadlessChrome）、不改 UA、不关 AutomationControlled、不装隐身脚本。
    // 开着调试端口，网页里 navigator.webdriver 就是 true（10-26 实测）——这是事实，不去改它；被拦了就熔断。
    const args = launchArgs(options);
    const child: ChildProcess = (options.spawnProcess ?? spawn)(exe, args, { stdio: 'ignore', windowsHide: false, detached: false });
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.once('error', error => { exited = true; log(`浏览器启动出错：${error.message}`); });

    const deadline = Date.now() + (options.startTimeoutMs ?? 20_000);
    let active: { port: number; path: string } | undefined;
    while (!active) {
        if (exited) throw new CdpError('浏览器启动后马上退出了');
        if (Date.now() > deadline) { killTree(child.pid); throw new CdpError('等不到浏览器的调试端口'); }
        if (existsSync(portFile)) active = parseActivePort(readFileSync(portFile, 'utf8'));
        if (!active) await sleep(150);
    }
    let connection: CdpConnection;
    try {
        const transport = await (options.connect ?? webSocketTransport)(`ws://127.0.0.1:${active.port}${active.path}`);
        connection = createCdpConnection(transport);
    } catch (error) {
        killTree(child.pid);
        throw error;
    }
    log(`浏览器已开（pid ${child.pid}）`);
    return {
        pid: child.pid,
        newPage: () => openPage(connection),
        async close() {
            try { await connection.send('Browser.close'); } catch { /* 已经关了 */ }
            connection.close();
            const gone = new Promise<void>(resolve => { if (exited) resolve(); else child.once('exit', () => resolve()); });
            await Promise.race([gone, sleep(5_000)]);
            if (!exited) killTree(child.pid);
            log('浏览器已关');
        },
    };
}

/** 只结束我们自己开的这个浏览器（含它的子进程），不碰别的 */
function killTree(pid: number | undefined): void {
    if (!pid) return;
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref(); } catch { /* 没有 taskkill（非 Windows）就算了 */ }
}
