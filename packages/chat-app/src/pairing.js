// @ts-check
// 配对：8 位一次性配对码 + 设备名 → deviceId / token。这里只有校验和报错文字。

import { isCredentials } from './protocol.js';

export const CODE_LENGTH = 8;
export const DEVICE_NAME_MAX = 40;

/** 只留数字（全角数字也算），最多 8 位。 @param {string} input */
export function normalizeCode(input) {
    let digits = '';
    for (const ch of String(input)) {
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x30 && code <= 0x39) digits += ch;
        else if (code >= 0xff10 && code <= 0xff19) digits += String.fromCodePoint(code - 0xff10 + 0x30);
    }
    return digits.slice(0, CODE_LENGTH);
}

/** 输入框里显示成 `1234 5678`。 @param {string} input */
export function displayCode(input) {
    const digits = normalizeCode(input);
    return digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
}

/** @param {string} input */
export function normalizeDeviceName(input) {
    // eslint-disable-next-line no-control-regex
    const cleaned = String(input).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return [...cleaned].slice(0, DEVICE_NAME_MAX).join('');
}

/** 根据 UA 猜一个默认设备名，用户可以改。 @param {string} userAgent */
export function defaultDeviceName(userAgent) {
    const ua = String(userAgent);
    const android = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua);
    if (android && android[1] && android[1].trim() !== 'K') return normalizeDeviceName(android[1]);
    if (/Android/.test(ua)) return '我的手机';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Windows/.test(ua)) return '我的电脑';
    if (/Macintosh/.test(ua)) return 'Mac';
    return '我的设备';
}

/**
 * @param {string} code @param {string} deviceName
 * @returns {{ ok: true, body: { code: string, deviceName: string } } | { ok: false, field: 'code' | 'deviceName', message: string }}
 */
export function buildPairRequest(code, deviceName) {
    const digits = normalizeCode(code);
    if (digits.length !== CODE_LENGTH) return { ok: false, field: 'code', message: '配对码是 8 位数字' };
    const name = normalizeDeviceName(deviceName);
    if (!name) return { ok: false, field: 'deviceName', message: '给这台设备起个名字' };
    return { ok: true, body: { code: digits, deviceName: name } };
}

/**
 * `/api/pair` 的结果 → 凭据或给人看的错误。中继对「不对 / 过期 / 用过 / 作废」一律回 401 和同一个响应体（不泄露是哪一种），
 * 429 是请求太频繁；别的实现如果在 code / error 里写了 expired、locked，也认。
 * @param {number} status @param {unknown} body
 * @returns {{ ok: true, credentials: import('./types.d.ts').Credentials } | { ok: false, reason: 'invalid' | 'expired' | 'locked' | 'rate_limited' | 'server' | 'malformed', message: string }}
 */
export function readPairResponse(status, body) {
    if (status >= 200 && status < 300) {
        if (isCredentials(body)) return { ok: true, credentials: { deviceId: body.deviceId, token: body.token } };
        return { ok: false, reason: 'malformed', message: '中继的回应看不懂，可能版本对不上' };
    }
    const hint = typeof body === 'object' && body !== null
        ? `${/** @type {any} */ (body).code ?? ''} ${/** @type {any} */ (body).error ?? ''}`.toLowerCase() : '';
    if (status === 429 || /rate_limited/.test(hint)) return { ok: false, reason: 'rate_limited', message: '试得太频繁了，等一分钟再试' };
    if (/too_many|locked|attempt/.test(hint)) return { ok: false, reason: 'locked', message: '试错次数太多，这个配对码已作废。在电脑上重新生成一个' };
    if (status === 410 || /expired/.test(hint)) return { ok: false, reason: 'expired', message: '配对码过期了（10 分钟有效）。在电脑上重新生成一个' };
    if (status >= 400 && status < 500) return { ok: false, reason: 'invalid', message: '配对码不对，或者已经用过、过期、作废了。核对一下，不行就在电脑上重新生成一个' };
    return { ok: false, reason: 'server', message: '中继暂时没回应，稍后再试' };
}
