// 媒体仓（media/）：图片和语音。id 是随机的，文件名只由 id 和白名单里的扩展名拼成，不用任何外来路径。
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const IMAGE_MIMES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const AUDIO_MIMES: readonly string[] = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'];

const EXTENSIONS: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
};
const MIME_BY_EXTENSION = new Map(Object.entries(EXTENSIONS).map(([mime, extension]) => [extension, mime]));
const MEDIA_ID = /^[A-Za-z0-9_-]{16,64}$/;

export type MediaErrorCode = 'too_large' | 'unsupported' | 'empty' | 'unreadable';

export class MediaError extends Error {
    code: MediaErrorCode;
    constructor(code: MediaErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

export interface MediaInfo {
    id: string;
    mime: string;
    size: number;
    /** 本机绝对路径 */
    path: string;
}

export interface MediaStore {
    /** 存一份。mime 给了就必须和内容对得上；不给按内容判断。kind 限制是图片还是语音 */
    put(bytes: Uint8Array, options?: { mime?: string; kind?: 'image' | 'audio' }): MediaInfo;
    get(id: unknown): MediaInfo | undefined;
}

/** `audio/webm;codecs=opus` → `audio/webm`；不在白名单里返回 undefined */
export function allowedMime(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const mime = raw.split(';')[0]!.trim().toLowerCase();
    return mime in EXTENSIONS ? mime : undefined;
}

/** 按文件头认类型。webm / mp4 容器不分音视频，这里只在语音的位置用，认成 audio */
export function sniffMime(bytes: Uint8Array): string | undefined {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (start: number, end: number) => b.subarray(start, end).toString('latin1');
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
    if (b.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg';
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
    if (b.length >= 12 && ascii(4, 8) === 'ftyp') return 'audio/mp4';
    if (b.length >= 3 && ascii(0, 3) === 'ID3') return 'audio/mpeg';
    if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) return 'audio/mpeg';
    return undefined;
}

export function createMediaStore(options: { dir: string; randomId?: () => string }): MediaStore {
    const { dir } = options;
    const randomId = options.randomId ?? (() => randomBytes(16).toString('base64url'));
    mkdirSync(dir, { recursive: true });
    const index = new Map<string, MediaInfo>();
    /** 这次运行里存过的内容 → id：同一张表情反复发不重复占盘 */
    const byHash = new Map<string, string>();
    for (const name of readdirSync(dir)) {
        const match = /^([A-Za-z0-9_-]{16,64})\.([a-z0-9]+)$/.exec(name);
        const mime = match ? MIME_BY_EXTENSION.get(match[2]!) : undefined;
        if (!match || !mime) continue;
        const path = join(dir, name);
        try {
            const stat = statSync(path);
            if (stat.isFile()) index.set(match[1]!, { id: match[1]!, mime, size: stat.size, path });
        } catch { /* 读不了的文件当它不存在 */ }
    }

    return {
        put(bytes, putOptions = {}) {
            if (!bytes.byteLength) throw new MediaError('empty', '文件是空的');
            if (bytes.byteLength > MAX_MEDIA_BYTES) throw new MediaError('too_large', '文件超过 10 MiB');
            const sniffed = sniffMime(bytes);
            if (!sniffed) throw new MediaError('unsupported', '认不出的文件类型');
            if (putOptions.mime !== undefined && putOptions.mime !== sniffed) throw new MediaError('unsupported', '文件内容和声明的类型对不上');
            const allowed = putOptions.kind === 'image' ? IMAGE_MIMES : putOptions.kind === 'audio' ? AUDIO_MIMES : [...IMAGE_MIMES, ...AUDIO_MIMES];
            if (!allowed.includes(sniffed)) throw new MediaError('unsupported', '这里不收这种文件');
            const hash = createHash('sha256').update(bytes).digest('hex');
            const known = index.get(byHash.get(hash) ?? '');
            if (known) return known;
            let id = randomId();
            if (!MEDIA_ID.test(id)) throw new Error('media id generator returned an invalid id');
            while (index.has(id)) id = randomBytes(16).toString('base64url');
            const path = join(dir, `${id}.${EXTENSIONS[sniffed]!}`);
            // wx：不覆盖已有文件
            writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
            const info: MediaInfo = { id, mime: sniffed, size: bytes.byteLength, path };
            index.set(id, info);
            byHash.set(hash, id);
            return info;
        },
        get(id) {
            if (typeof id !== 'string' || !MEDIA_ID.test(id)) return undefined;
            return index.get(id);
        },
    };
}

/** 取 http(s) 上的一个文件；实现必须自己限大小和时间 */
export type MediaFetcher = (url: string) => Promise<Uint8Array>;

export const defaultFetcher: MediaFetcher = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    if (!response.ok || !response.body) throw new MediaError('unreadable', `下载返回 ${response.status}`);
    if (Number(response.headers.get('content-length') ?? 0) > MAX_MEDIA_BYTES) {
        void response.body.cancel().catch(() => {});
        throw new MediaError('too_large', '文件超过 10 MiB');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > MAX_MEDIA_BYTES) throw new MediaError('too_large', '文件超过 10 MiB');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
};

/**
 * 她发来的 image / record 段里的 `file`：本机路径、file:// URL、base64:// 数据、http(s) URL（只经 fetcher）。
 * 读进来的字节交给调用方存进媒体仓。
 */
export async function readMediaReference(reference: string, fetcher: MediaFetcher): Promise<Uint8Array> {
    if (reference.startsWith('base64://')) {
        const encoded = reference.slice('base64://'.length);
        if (encoded.length * 3 / 4 > MAX_MEDIA_BYTES + 3) throw new MediaError('too_large', '文件超过 10 MiB');
        return Buffer.from(encoded, 'base64');
    }
    if (/^https?:\/\//i.test(reference)) return fetcher(reference);
    let path: string;
    if (/^file:\/\//i.test(reference)) {
        try { path = fileURLToPath(reference); } catch { throw new MediaError('unreadable', '看不懂的 file:// 地址'); }
    } else if (isAbsolute(reference)) {
        path = reference;
    } else {
        throw new MediaError('unreadable', '不是本机绝对路径、file://、base64:// 或 http(s) 地址');
    }
    try {
        const stat = statSync(path);
        if (!stat.isFile()) throw new MediaError('unreadable', '不是普通文件');
        if (stat.size > MAX_MEDIA_BYTES) throw new MediaError('too_large', '文件超过 10 MiB');
        return readFileSync(path);
    } catch (error) {
        if (error instanceof MediaError) throw error;
        throw new MediaError('unreadable', '本机文件读不了');
    }
}

/** 段里能当来源用的那个字段：先看 file，再看 url、path */
export function mediaReferenceOf(data: Record<string, unknown>): string | undefined {
    for (const key of ['file', 'url', 'path'] as const) {
        const value = data[key];
        if (typeof value !== 'string' || !value) continue;
        if (/^(base64|file|https?):\/\//i.test(value) || isAbsolute(value)) return value;
    }
    return undefined;
}
