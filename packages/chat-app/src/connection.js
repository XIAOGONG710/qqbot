// @ts-check
// 连接状态机：第一帧 hello（凭据不进 URL）、since 续传、指数退避加抖动重连、ping/pong 心跳和假死检测。
// socket、定时器、时钟、随机数都从外面传进来，Node 里能用假的测。

import { encodeFrame, helloFrame, parseServerFrame, pingFrame } from './protocol.js';

export const DEFAULTS = Object.freeze({
    /** 第一次重连等多久 */
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    /** 多久没动静就 ping 一次 */
    pingIntervalMs: 25_000,
    /** ping 之后多久没任何回音算假死 */
    pongTimeoutMs: 10_000,
    /** 连上之后多久没等到任何一帧算失败 */
    helloTimeoutMs: 15_000,
});

/**
 * 第 attempt 次重连（从 0 数）前等多久：指数增长封顶，再乘 0.5–1 的抖动。
 * @param {number} attempt @param {number} random 0..1
 * @param {{ baseDelayMs?: number, maxDelayMs?: number }} [config]
 */
export function backoffDelay(attempt, random, config = {}) {
    const base = config.baseDelayMs ?? DEFAULTS.baseDelayMs;
    const max = config.maxDelayMs ?? DEFAULTS.maxDelayMs;
    const ceiling = Math.min(max, base * 2 ** Math.min(Math.max(0, attempt), 20));
    return Math.round(ceiling * (0.5 + 0.5 * Math.min(1, Math.max(0, random))));
}

export class Connection {
    /** @param {import('./connection.d.ts').ConnectionOptions} options */
    constructor(options) {
        this.options = options;
        this.config = { ...DEFAULTS, ...(options.config ?? {}) };
        this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = options.clearTimer ?? (handle => clearTimeout(/** @type {any} */ (handle)));
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
        /** @type {import('./connection.d.ts').ConnectionStatus} */
        this.status = 'idle';
        /** 每开一条新 socket 加一；旧 socket 迟到的回调靠它丢掉 */
        this.generation = 0;
        this.attempt = 0;
        this.retryAt = 0;
        /** @type {import('./connection.d.ts').SocketLike | undefined} */
        this.socket = undefined;
        this.running = false;
        this.lastInboundAt = 0;
        /** @type {unknown} */ this.retryTimer = undefined;
        /** @type {unknown} */ this.pingTimer = undefined;
        /** @type {unknown} */ this.staleTimer = undefined;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.attempt = 0;
        this.connect();
    }

    /** 停下来，不再重连（退出配对、页面卸载）。 */
    stop() {
        this.running = false;
        this.clearTimers();
        this.closeSocket();
        this.setStatus('idle');
    }

    /** 网络恢复 / 页面回到前台：正在等重连就立刻连；连着就马上探一次活。 */
    kick() {
        if (!this.running) return;
        if (this.status === 'waiting') {
            this.clear('retryTimer');
            this.attempt = 0;
            this.connect();
        } else if (this.status === 'ready') {
            this.probe();
        }
    }

    /** 只有补齐之后（ready）才能发；发不出去返回 false，由发件箱留着下次再发。 @param {import('./types.d.ts').ClientFrame} frame */
    send(frame) {
        if (this.status !== 'ready' || !this.socket) return false;
        try {
            this.socket.send(encodeFrame(frame));
            return true;
        } catch (error) {
            if (error instanceof RangeError) throw error;
            this.drop();
            return false;
        }
    }

    connect() {
        if (!this.running) return;
        this.clearTimers();
        this.closeSocket();
        const generation = ++this.generation;
        this.setStatus('connecting');
        /** @type {import('./connection.d.ts').SocketLike} */
        let socket;
        try {
            socket = this.options.open();
        } catch {
            this.scheduleRetry();
            return;
        }
        this.socket = socket;
        socket.onopen = () => {
            if (generation !== this.generation) return;
            const hello = this.options.hello();
            try {
                socket.send(encodeFrame(helloFrame(hello.credentials, hello.since)));
            } catch {
                this.drop();
                return;
            }
            this.lastInboundAt = this.now();
            this.setStatus('syncing');
            this.armStale(this.config.helloTimeoutMs);
        };
        socket.onmessage = event => {
            if (generation !== this.generation) return;
            this.lastInboundAt = this.now();
            // 任何一帧都算活着
            if (this.status === 'syncing') this.armStale(this.config.helloTimeoutMs);
            else this.clear('staleTimer');
            const frame = parseServerFrame(event.data);
            if (!frame) return;
            if (frame.type === 'error' && frame.code === 'unauthorized') {
                this.running = false;
                this.clearTimers();
                this.closeSocket();
                this.setStatus('unauthorized');
                this.options.onFrame(frame, generation);
                return;
            }
            if (frame.type === 'ready') {
                this.attempt = 0;
                this.clear('staleTimer');
                this.setStatus('ready');
                this.armPing();
            }
            if (frame.type !== 'pong') this.options.onFrame(frame, generation);
        };
        socket.onclose = () => { if (generation === this.generation) this.drop(); };
        socket.onerror = () => { if (generation === this.generation) this.drop(); };
    }

    /** 这条连接不要了，按退避再连。 */
    drop() {
        if (!this.running) return;
        this.clearTimers();
        this.closeSocket();
        this.generation++;
        this.scheduleRetry();
    }

    scheduleRetry() {
        const delay = backoffDelay(this.attempt, this.random(), this.config);
        this.attempt++;
        this.retryAt = this.now() + delay;
        this.setStatus('waiting');
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = undefined;
            this.connect();
        }, delay);
    }

    armPing() {
        this.clear('pingTimer');
        this.pingTimer = this.setTimer(() => {
            this.pingTimer = undefined;
            this.probe();
        }, this.config.pingIntervalMs);
    }

    /** 发一个 ping，限时等任何回音。 */
    probe() {
        if (this.status !== 'ready' || !this.socket) return;
        try {
            this.socket.send(encodeFrame(pingFrame()));
        } catch {
            this.drop();
            return;
        }
        if (this.staleTimer === undefined) this.armStale(this.config.pongTimeoutMs);
        this.armPing();
    }

    /** @param {number} ms */
    armStale(ms) {
        this.clear('staleTimer');
        this.staleTimer = this.setTimer(() => {
            this.staleTimer = undefined;
            this.drop();
        }, ms);
    }

    /** @param {'retryTimer' | 'pingTimer' | 'staleTimer'} name */
    clear(name) {
        if (this[name] !== undefined) {
            this.clearTimer(this[name]);
            this[name] = undefined;
        }
    }

    clearTimers() {
        this.clear('retryTimer');
        this.clear('pingTimer');
        this.clear('staleTimer');
    }

    closeSocket() {
        const socket = this.socket;
        if (!socket) return;
        this.socket = undefined;
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        try { socket.close(); } catch { /* 已经关了 */ }
    }

    /** @param {import('./connection.d.ts').ConnectionStatus} status */
    setStatus(status) {
        if (this.status === status && status !== 'waiting') return;
        this.status = status;
        this.options.onStatus?.({ status, attempt: this.attempt, retryAt: status === 'waiting' ? this.retryAt : 0, generation: this.generation });
    }
}
