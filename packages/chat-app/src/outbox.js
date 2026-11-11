// @ts-check
// 发件箱：没确认的那几条在每条新连接上用同一个 clientId 再发一遍，等不到 ack 就超时。

import { sendFrame } from './protocol.js';

export const ACK_TIMEOUT_MS = 20_000;

export class Outbox {
    /** @param {import('./outbox.d.ts').OutboxOptions} options */
    constructor(options) {
        this.options = options;
        this.ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
        /** 当前这条连接上已经发过的 clientId → 发出时间 @type {Map<string, number>} */
        this.sent = new Map();
        this.generation = -1;
    }

    /**
     * 把还没在这条连接上发过的待发消息发出去。
     * @param {import('./types.d.ts').PendingMessage[]} sendable
     * @param {number} generation 连接代次；变了就全部重发
     * @param {number} now
     * @returns {{ sent: string[], tooLarge: string[] }}
     */
    flush(sendable, generation, now) {
        if (generation !== this.generation) {
            this.generation = generation;
            this.sent.clear();
        }
        /** @type {string[]} */ const sent = [];
        /** @type {string[]} */ const tooLarge = [];
        const live = new Set(sendable.map(item => item.clientId));
        for (const clientId of this.sent.keys()) if (!live.has(clientId)) this.sent.delete(clientId);
        for (const item of sendable) {
            if (this.sent.has(item.clientId)) continue;
            let ok = false;
            try {
                ok = this.options.send(sendFrame(item.clientId, item.parts, item.replyTo));
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                tooLarge.push(item.clientId);
                continue;
            }
            // 连接不在：后面的也发不出去，等下一次 ready
            if (!ok) break;
            this.sent.set(item.clientId, now);
            sent.push(item.clientId);
        }
        return { sent, tooLarge };
    }

    /** 发出去太久没等到 ack 的。 @param {number} now */
    expired(now) {
        /** @type {string[]} */ const out = [];
        for (const [clientId, at] of this.sent) if (now - at >= this.ackTimeoutMs) out.push(clientId);
        return out;
    }

    /** ack 到了、标了失败或被删掉。 @param {string} clientId */
    forget(clientId) {
        this.sent.delete(clientId);
    }

    /** 连接断了：下一条连接上全部重发。 */
    reset() {
        this.sent.clear();
        this.generation = -1;
    }
}
