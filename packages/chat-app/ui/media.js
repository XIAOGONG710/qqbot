// 图片和语音：带 Authorization 头取成 blob，再变成 object URL；没人用了就 revoke。
// 凭据只进请求头，不进 URL。取回来的文件存进本机 IndexedDB，离线也能看。

import { authorization, mediaPath, uploadMime, MAX_MEDIA_BYTES } from '../src/protocol.js';

const REVOKE_DELAY_MS = 4000;
const IMAGE_MAX_EDGE = 2560;
const IMAGE_KEEP_BYTES = 3 * 1024 * 1024;

export class HttpError extends Error {
    /** @param {number} status @param {string} message */
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/**
 * @param {{ db: any, credentials: () => import('../src/types.d.ts').Credentials | undefined, onUnauthorized: () => void }} options
 */
export function createMedia(options) {
    /** key（mediaId 或 `local:<id>`）→ 引用计数和 URL @type {Map<string, { refs: number, url?: string, promise?: Promise<string>, timer?: number }>} */
    const entries = new Map();
    /** 上传完的本地文件：mediaId → local key，省一次下载 @type {Map<string, string>} */
    const aliases = new Map();
    /** 没落盘时（或落盘失败）本地文件留在内存里 @type {Map<string, Blob>} */
    const locals = new Map();

    const headers = () => {
        const credentials = options.credentials();
        if (!credentials) throw new HttpError(401, '未配对');
        return { Authorization: authorization(credentials) };
    };

    /** @param {string} key @returns {Promise<Blob>} */
    async function loadBlob(key) {
        const local = locals.get(key) ?? locals.get(aliases.get(key) ?? '');
        if (local) return local;
        const cached = await options.db.getBlob(key).catch(() => undefined) ?? (aliases.has(key) ? await options.db.getBlob(aliases.get(key)).catch(() => undefined) : undefined);
        if (cached) return cached;
        if (key.startsWith('local:')) throw new Error('本地文件不在了');
        const response = await fetch(mediaPath(key), { headers: headers(), cache: 'no-store', credentials: 'omit' });
        if (response.status === 401) { options.onUnauthorized(); throw new HttpError(401, '配对已失效'); }
        if (!response.ok) throw new HttpError(response.status, response.status === 404 ? '文件已经不在了' : '取不到文件');
        const blob = await response.blob();
        void options.db.putBlob(key, blob).catch(() => {});
        return blob;
    }

    return {
        /** 要用这个文件：返回 object URL。用完必须 release。 @param {string} key @returns {Promise<string>} */
        acquire(key) {
            let entry = entries.get(key);
            if (!entry) {
                entry = { refs: 0 };
                entries.set(key, entry);
            }
            entry.refs++;
            if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
            if (!entry.promise) {
                const current = entry;
                current.promise = loadBlob(key).then(blob => {
                    current.url = URL.createObjectURL(blob);
                    return current.url;
                });
                current.promise.catch(() => { if (entries.get(key) === current) current.promise = undefined; });
            }
            return entry.promise;
        },
        /** @param {string} key */
        release(key) {
            const entry = entries.get(key);
            if (!entry) return;
            entry.refs = Math.max(0, entry.refs - 1);
            if (entry.refs > 0 || entry.timer) return;
            // 稍等一下再收：滚动来回、气泡重画时不用反复取
            entry.timer = window.setTimeout(() => {
                entry.timer = undefined;
                if (entry.refs > 0) return;
                if (entry.url) URL.revokeObjectURL(entry.url);
                entries.delete(key);
            }, REVOKE_DELAY_MS);
        },
        /** @param {string} key */
        blob: key => loadBlob(key),
        /** 刚选的图片 / 刚录的语音。 @param {string} localId @param {Blob} blob */
        async putLocal(localId, blob) {
            locals.set(`local:${localId}`, blob);
            await options.db.putBlob(`local:${localId}`, blob).catch(() => {});
        },
        /** 上传成功：同一份文件以后按 mediaId 找。 @param {string} localId @param {string} mediaId */
        async adopt(localId, mediaId) {
            const key = `local:${localId}`;
            aliases.set(mediaId, key);
            const blob = locals.get(key) ?? await options.db.getBlob(key).catch(() => undefined);
            if (blob) {
                locals.set(key, blob);
                await options.db.putBlob(mediaId, blob).catch(() => {});
                await options.db.deleteBlob(key).catch(() => {});
            }
        },
        /** @param {string} localId */
        async dropLocal(localId) {
            locals.delete(`local:${localId}`);
            await options.db.deleteBlob(`local:${localId}`).catch(() => {});
        },
        /**
         * 上传到 `/api/media`，带进度。用 XHR 是因为 fetch 拿不到上传进度。
         * @param {Blob} blob @param {string} mime @param {(fraction: number) => void} onProgress
         * @returns {{ promise: Promise<string>, abort: () => void }}
         */
        upload(blob, mime, onProgress) {
            const xhr = new XMLHttpRequest();
            const promise = new Promise((resolve, reject) => {
                const type = uploadMime(mime);
                if (!type) return reject(new Error('这种文件发不了'));
                if (blob.size > MAX_MEDIA_BYTES) return reject(new Error('文件超过 10 MB'));
                let auth;
                try { auth = headers().Authorization; } catch (error) { return reject(error); }
                xhr.open('POST', '/api/media');
                xhr.setRequestHeader('Authorization', auth);
                xhr.setRequestHeader('Content-Type', type);
                xhr.responseType = 'json';
                xhr.timeout = 120_000;
                xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
                xhr.onload = () => {
                    if (xhr.status === 401) { options.onUnauthorized(); return reject(new HttpError(401, '配对已失效')); }
                    if (xhr.status === 413) return reject(new HttpError(413, '文件超过 10 MB'));
                    if (xhr.status === 429) return reject(new HttpError(429, '发得太快了，等一下再试'));
                    const mediaId = xhr.response && typeof xhr.response === 'object' ? xhr.response.mediaId : undefined;
                    if (xhr.status < 200 || xhr.status >= 300 || typeof mediaId !== 'string' || !mediaId) return reject(new HttpError(xhr.status, '上传失败'));
                    resolve(mediaId);
                };
                xhr.onerror = () => reject(new Error('网络断了，上传失败'));
                xhr.ontimeout = () => reject(new Error('上传超时'));
                xhr.onabort = () => reject(new Error('已取消'));
                xhr.send(blob);
            });
            return { promise, abort: () => xhr.abort() };
        },
        /** 退出配对 / 清缓存：把还活着的 URL 都收掉 */
        reset() {
            for (const entry of entries.values()) {
                if (entry.timer) clearTimeout(entry.timer);
                if (entry.url) URL.revokeObjectURL(entry.url);
            }
            entries.clear();
            aliases.clear();
            locals.clear();
        },
    };
}

/**
 * 发图前的整理：协议只收 jpeg / png / webp / gif、≤ 10 MiB。太大的照片或别的格式（比如 HEIC）转成 JPEG 并缩到长边 2560。
 * @param {Blob} file @returns {Promise<{ blob: Blob, mime: string }>}
 */
export async function prepareImage(file) {
    const mime = uploadMime(file.type);
    if (mime && (mime === 'image/gif' || file.size <= IMAGE_KEEP_BYTES)) {
        if (file.size > MAX_MEDIA_BYTES) throw new Error('这张图超过 10 MB');
        return { blob: file, mime };
    }
    let bitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
        if (mime && file.size <= MAX_MEDIA_BYTES) return { blob: file, mime };
        throw new Error('这张图打不开');
    }
    for (const [edge, quality] of [[IMAGE_MAX_EDGE, 0.86], [1600, 0.75]]) {
        const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        if (!context) break;
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= MAX_MEDIA_BYTES) {
            bitmap.close?.();
            return { blob, mime: 'image/jpeg' };
        }
    }
    bitmap.close?.();
    throw new Error('这张图太大了');
}
