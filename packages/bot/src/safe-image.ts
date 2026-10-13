import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupPromise } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { AsyncGate } from './async-gate.ts';

export type SupportedImageType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
export interface DownloadedImage { bytes: Uint8Array; type: SupportedImageType }
export type HostResolver = (hostname: string) => Promise<readonly { address: string; family: number }[]>;
export type ImageFetch = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

export interface RemoteImageOptions {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    signal?: AbortSignal;
    /** Test seams only. Production also validates DNS again while opening the socket. */
    resolve?: HostResolver;
    fetch?: ImageFetch;
}

export const REMOTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const downloads = new AsyncGate(3);
const blocked = new BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
    ['::', 96], ['100::', 64], ['2001:db8::', 32],
    // NAT64 and 6to4 embed an IPv4 address that can point back at this machine or the LAN.
    ['64:ff9b::', 96], ['2002::', 16],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(address, prefix, 'ipv6');

function publicAddress(address: string, family = isIP(address)): boolean {
    if (family !== 4 && family !== 6) return false;
    // BlockList treats an IPv4-mapped IPv6 subnet as matching every IPv4 address on Node 24,
    // so mapped addresses are rejected explicitly instead of adding ::ffff:0:0/96 to the list.
    if (family === 6 && address.toLowerCase().startsWith('::ffff:')) return false;
    return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, options, (error, address, family) => {
        if (error) return callback(error, address, family);
        const values = Array.isArray(address) ? address : [{ address, family }];
        if (!values.length || values.some(item => !publicAddress(item.address, item.family))) {
            return callback(Object.assign(new Error(`refusing non-public address: ${hostname}`), { code: 'ESSRF' }), address, family);
        }
        callback(null, address, family);
    });
};

const dispatcher = new Agent({ connect: { timeout: 3000, lookup: guardedLookup } });
const defaultFetch: ImageFetch = (url, init) => undiciFetch(url, { ...init, dispatcher }) as unknown as Promise<Response>;
const defaultResolve: HostResolver = hostname => dnsLookupPromise(hostname, { all: true, verbatim: true });

function checkedUrl(raw: string): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('invalid image URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http/https image URLs are accepted');
    if (url.username || url.password) throw new Error('image URL must not contain credentials');
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('refusing local or private image URL');
    const family = isIP(hostname);
    if (family && !publicAddress(hostname, family)) throw new Error('refusing local or private image URL');
    return url;
}

async function assertPublic(url: URL, resolveHost: HostResolver): Promise<void> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname)) return;
    const addresses = await resolveHost(hostname);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address, item.family))) {
        throw new Error(`image hostname resolves to a non-public address: ${hostname}`);
    }
}

export function detectImageType(bytes: Uint8Array): SupportedImageType | undefined {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return undefined;
}

export function imageDataUrl(image: DownloadedImage): string {
    return `data:${image.type};base64,${Buffer.from(image.bytes).toString('base64')}`;
}

export function validateImageDataUrl(value: string, maxBytes = REMOTE_IMAGE_MAX_BYTES): string {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
    if (!match) throw new Error('unsupported image data URL');
    const bytes = new Uint8Array(Buffer.from(match[2]!, 'base64'));
    if (!bytes.length || bytes.length > maxBytes) throw new Error('image is empty or too large');
    const type = detectImageType(bytes);
    if (!type || type !== match[1]!.toLowerCase()) throw new Error('image content does not match its type');
    return imageDataUrl({ bytes, type });
}

/** A single safe path for remote images: validate every redirect and cap bytes while streaming. */
export function fetchRemoteImage(raw: string, options: RemoteImageOptions = {}): Promise<DownloadedImage> {
    return downloads.run(async () => {
        const maxBytes = options.maxBytes ?? REMOTE_IMAGE_MAX_BYTES;
        const controller = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        const timer = setTimeout(() => controller.abort(new Error('image download timed out')), options.timeoutMs ?? 8000);
        const fetchImage = options.fetch ?? defaultFetch;
        const resolveHost = options.resolve ?? defaultResolve;
        try {
            let url = checkedUrl(raw);
            for (let redirects = 0; ; redirects++) {
                await assertPublic(url, resolveHost);
                const response = await fetchImage(url.href, { redirect: 'manual', signal });
                // A body we will not read must be released, otherwise the socket stays busy until the server gives up.
                const drop = () => response.body?.cancel().catch(() => {});
                if (response.status >= 300 && response.status < 400) {
                    await drop();
                    const location = response.headers.get('location');
                    if (!location) throw new Error(`image redirect ${response.status} has no Location`);
                    if (redirects >= (options.maxRedirects ?? 3)) throw new Error('too many image redirects');
                    url = checkedUrl(new URL(location, url).href);
                    continue;
                }
                if (!response.ok) {
                    await drop();
                    throw new Error(`download returned ${response.status}`);
                }
                const length = Number(response.headers.get('content-length') ?? 0);
                if (Number.isFinite(length) && length > maxBytes) {
                    await drop();
                    throw new Error(`image exceeds ${maxBytes} bytes`);
                }
                if (!response.body) throw new Error('image body is empty');
                const reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let total = 0;
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (!value?.byteLength) continue;
                        total += value.byteLength;
                        if (total > maxBytes) {
                            controller.abort(new Error(`image exceeds ${maxBytes} bytes`));
                            throw new Error(`image exceeds ${maxBytes} bytes`);
                        }
                        chunks.push(value);
                    }
                } finally {
                    if (total > maxBytes) await reader.cancel().catch(() => {});
                }
                if (!total) throw new Error('image body is empty');
                const bytes = new Uint8Array(total);
                let at = 0;
                for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
                const type = detectImageType(bytes);
                if (!type) throw new Error('unsupported image content');
                return { bytes, type };
            }
        } finally {
            clearTimeout(timer);
        }
    }, options.signal);
}
