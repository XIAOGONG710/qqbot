// 语音录制（MediaRecorder）。麦克风只在录的时候开，录完 / 取消立刻关。

import { uploadMime } from '../src/protocol.js';

const CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];
export const MAX_RECORD_MS = 60_000;
export const MIN_RECORD_MS = 700;

export function recordingSupported() {
    return typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

/** @param {{ onLimit: () => void }} options 录满上限时回调 */
export function createRecorder(options) {
    /** @type {MediaRecorder | undefined} */ let recorder;
    /** @type {MediaStream | undefined} */ let stream;
    /** @type {Blob[]} */ let chunks = [];
    let startedAt = 0;
    let limitTimer = 0;
    /** start 还在等权限时就被取消了 */
    let generation = 0;

    const release = () => {
        clearTimeout(limitTimer);
        stream?.getTracks().forEach(track => track.stop());
        stream = undefined;
        recorder = undefined;
    };

    return {
        get active() { return Boolean(recorder); },
        get elapsed() { return recorder ? Date.now() - startedAt : 0; },
        /** 开始录。拿不到麦克风时抛带中文说明的 Error。 */
        async start() {
            if (recorder) return;
            if (!recordingSupported()) throw new Error(window.isSecureContext ? '这台设备录不了音' : '录音需要 HTTPS 连接');
            const mine = ++generation;
            let media;
            try {
                media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
            } catch (error) {
                const name = error instanceof DOMException ? error.name : '';
                throw new Error(name === 'NotAllowedError' || name === 'SecurityError' ? '没有麦克风权限，在系统设置里允许后再试' : name === 'NotFoundError' ? '没找到麦克风' : '麦克风打不开');
            }
            if (mine !== generation) {
                media.getTracks().forEach(track => track.stop());
                return;
            }
            const type = CANDIDATES.find(candidate => MediaRecorder.isTypeSupported(candidate) && uploadMime(candidate));
            stream = media;
            chunks = [];
            try {
                recorder = new MediaRecorder(media, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : undefined);
            } catch {
                release();
                throw new Error('这台设备录不了音');
            }
            recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
            recorder.start(250);
            startedAt = Date.now();
            limitTimer = window.setTimeout(options.onLimit, MAX_RECORD_MS);
        },
        /** 停下并拿到录音；太短或格式发不了返回 undefined。 @returns {Promise<{ blob: Blob, mime: string, durationMs: number } | undefined>} */
        stop() {
            generation++;
            const current = recorder;
            if (!current) return Promise.resolve(undefined);
            const durationMs = Date.now() - startedAt;
            return new Promise(resolve => {
                current.onstop = () => {
                    const mime = uploadMime(current.mimeType || chunks[0]?.type || '');
                    const blob = mime ? new Blob(chunks, { type: mime }) : undefined;
                    chunks = [];
                    release();
                    resolve(blob && mime && blob.size > 0 && durationMs >= MIN_RECORD_MS ? { blob, mime, durationMs } : undefined);
                };
                try { current.stop(); } catch { release(); resolve(undefined); }
            });
        },
        cancel() {
            generation++;
            const current = recorder;
            chunks = [];
            if (current) {
                current.onstop = null;
                try { current.stop(); } catch { /* 已经停了 */ }
            }
            release();
        },
    };
}
