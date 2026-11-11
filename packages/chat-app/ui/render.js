// 把 timeline 的一行画成 DOM。消息内容只用 textContent；链接只有 https 的才变成 <a>。

import { faceDisplay, formatClock, formatDuration, reactionDisplay } from '../src/format.js';
import { safeHttpsUrl } from '../src/protocol.js';
import { statusText } from '../src/timeline.js';
import { h, icon, ring, setRing } from './dom.js';

const LINK = /https:\/\/[^\s<>"'，。！？；、（）【】《》]+/g;
const JUMBO = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*){1,3}$/u;

/**
 * @param {{
 *   media: ReturnType<typeof import('./media.js').createMedia>,
 *   scroller: HTMLElement,
 *   selfName: () => string,
 *   onOpenImage: (key: string, alt: string) => void,
 *   onJump: (id: number) => void,
 *   onRetry: (clientId: string) => void,
 *   onMediaLoaded: () => void,
 *   toast: (text: string) => void,
 * }} ctx
 */
export function createRenderer(ctx) {
    /** 图片比例记下来，重画 / 滚回来时先把位置占好 @type {Map<string, number>} */
    const ratios = new Map();
    /** 已经取了 URL 的媒体元素 @type {WeakMap<Element, string>} */
    const held = new WeakMap();

    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (entry.isIntersecting) loadImage(/** @type {HTMLElement} */ (entry.target));
            else unloadImage(/** @type {HTMLElement} */ (entry.target));
        }
    }, { root: ctx.scroller, rootMargin: '150% 0px' });

    /** @param {HTMLElement} box */
    function loadImage(box) {
        const key = box.dataset.mediaKey;
        if (!key || held.has(box)) return;
        held.set(box, key);
        box.classList.remove('failed');
        ctx.media.acquire(key).then(url => {
            if (held.get(box) !== key) return;
            const img = /** @type {HTMLImageElement} */ (box.querySelector('img'));
            img.onload = () => {
                if (img.naturalWidth && img.naturalHeight) {
                    const ratio = img.naturalWidth / img.naturalHeight;
                    ratios.set(key, ratio);
                    box.style.aspectRatio = String(ratio);
                }
                box.classList.add('loaded');
                ctx.onMediaLoaded();
            };
            img.onerror = () => box.classList.add('failed');
            img.src = url;
        }).catch(() => {
            if (held.get(box) !== key) return;
            // 取不到：放开引用，点一下可以再试
            held.delete(box);
            ctx.media.release(key);
            box.classList.add('failed');
        });
    }

    /** 离屏幕远了：收回 object URL，占位留着 @param {HTMLElement} box */
    function unloadImage(box) {
        const key = held.get(box);
        if (!key) return;
        held.delete(box);
        const img = /** @type {HTMLImageElement} */ (box.querySelector('img'));
        img.onload = img.onerror = null;
        img.removeAttribute('src');
        box.classList.remove('loaded');
        ctx.media.release(key);
    }

    // ---- 语音：同一时间只放一条 ----
    /** @type {{ audio: HTMLAudioElement, key: string, el: HTMLElement } | undefined} */
    let playing;
    function stopVoice() {
        if (!playing) return;
        const { audio, key, el } = playing;
        playing = undefined;
        audio.pause();
        audio.removeAttribute('src');
        ctx.media.release(key);
        setVoiceUi(el, false, 0);
    }
    /** @param {HTMLElement} el @param {boolean} on @param {number} fraction */
    function setVoiceUi(el, on, fraction) {
        el.classList.toggle('playing', on);
        const button = /** @type {HTMLElement} */ (el.querySelector('.voice-btn'));
        button.replaceChildren(icon(on ? 'pause' : 'play', 20));
        button.setAttribute('aria-label', on ? '暂停' : '播放语音');
        /** @type {HTMLElement} */ (el.querySelector('.voice-fill')).style.transform = `scaleX(${fraction})`;
    }
    /** @param {HTMLElement} el */
    async function toggleVoice(el) {
        const key = el.dataset.mediaKey;
        if (!key) return;
        if (playing && playing.el === el) {
            if (playing.audio.paused) { await playing.audio.play().catch(() => {}); setVoiceUi(el, true, playing.audio.currentTime / (playing.audio.duration || 1)); } else { playing.audio.pause(); el.classList.remove('playing'); setVoiceUi(el, false, playing.audio.currentTime / (playing.audio.duration || 1)); }
            return;
        }
        stopVoice();
        const audio = new Audio();
        playing = { audio, key, el };
        el.classList.add('loading');
        try {
            const url = await ctx.media.acquire(key);
            if (playing?.audio !== audio) { ctx.media.release(key); return; }
            audio.src = url;
            audio.ontimeupdate = () => { if (playing?.audio === audio && Number.isFinite(audio.duration)) setVoiceUi(el, !audio.paused, audio.currentTime / audio.duration); };
            audio.onended = () => { if (playing?.audio === audio) stopVoice(); };
            audio.onerror = () => { if (playing?.audio === audio) { stopVoice(); ctx.toast('这条语音放不了'); } };
            await audio.play();
            setVoiceUi(el, true, 0);
        } catch {
            if (playing?.audio === audio) {
                playing = undefined;
                ctx.media.release(key);
                ctx.toast('这条语音放不了');
            }
        } finally {
            el.classList.remove('loading');
        }
    }

    /** @param {string} text */
    function textNodes(text) {
        /** @type {(Node | string)[]} */
        const out = [];
        let last = 0;
        for (const match of text.matchAll(LINK)) {
            const url = safeHttpsUrl(match[0]);
            if (!url) continue;
            if (match.index > last) out.push(text.slice(last, match.index));
            out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: match[0] }));
            last = match.index + match[0].length;
        }
        if (last < text.length) out.push(text.slice(last));
        return out;
    }

    /** @param {import('../src/types.d.ts').Part} part @param {import('../src/timeline.d.ts').BubbleRow} row */
    function partNode(part, row) {
        switch (part.kind) {
            case 'text':
                return h('span', { class: 'text' }, ...textNodes(part.text));
            case 'face': {
                const face = faceDisplay(part.id, part.name);
                return h('span', { class: face.emoji ? 'face emoji' : 'face', role: 'img', 'aria-label': face.label, title: face.label, text: face.text });
            }
            case 'image': {
                const key = part.mediaId || (row.localId ? `local:${row.localId}` : '');
                const alt = part.summary || '图片';
                const box = h('button', { class: 'image', type: 'button', dataset: { mediaKey: key }, 'aria-label': `${alt}，点开看大图` },
                    h('img', { alt: '', decoding: 'async', draggable: 'false' }),
                    h('span', { class: 'image-fallback' }, icon('image', 28), h('span', { text: '图片没取到，点一下重试' })));
                const ratio = ratios.get(key);
                if (ratio) box.style.aspectRatio = String(ratio);
                box.addEventListener('click', () => {
                    if (box.classList.contains('failed')) { unloadImage(box); loadImage(box); } else if (key) ctx.onOpenImage(key, alt);
                });
                if (key) observer.observe(box);
                return box;
            }
            case 'voice': {
                const key = part.mediaId || (row.localId ? `local:${row.localId}` : '');
                const seconds = Math.max(1, Math.round((part.durationMs ?? 0) / 1000));
                const el = h('div', { class: 'voice', dataset: { mediaKey: key } },
                    h('button', { class: 'voice-btn', type: 'button', 'aria-label': '播放语音' }, icon('play', 20)),
                    h('span', { class: 'voice-track', 'aria-hidden': 'true' }, h('span', { class: 'voice-fill' })),
                    h('span', { class: 'voice-time', text: formatDuration(part.durationMs) || '语音' }));
                // 越长的语音条越宽，像个长度
                el.style.setProperty('--voice-w', `${Math.min(220, 96 + seconds * 4)}px`);
                /** @type {HTMLElement} */ (el.querySelector('.voice-btn')).addEventListener('click', () => void toggleVoice(el));
                return el;
            }
            case 'card': {
                const url = safeHttpsUrl(part.url);
                const inner = [h('span', { class: 'card-title', text: part.title || '卡片' }), url ? h('span', { class: 'card-host' }, icon('link', 14), h('span', { text: new URL(url).hostname })) : part.url ? h('span', { class: 'card-host', text: '链接不是 https，打不开' }) : null];
                return url ? h('a', { class: 'card', href: url, target: '_blank', rel: 'noopener noreferrer' }, ...inner) : h('div', { class: 'card' }, ...inner);
            }
            case 'poke':
                return h('span', { class: 'text', text: '[戳一戳]' });
            default:
                return h('span', { class: 'text', text: '[暂不支持的消息]' });
        }
    }

    /** @param {import('../src/timeline.d.ts').BubbleRow} row */
    function bubble(row) {
        const parts = row.parts;
        const onlyMedia = parts.length === 1 && parts[0]?.kind === 'image';
        const plain = parts.map(part => (part.kind === 'text' ? part.text : part.kind === 'face' && faceDisplay(part.id).emoji ? '😀' : 'x')).join('').trim();
        const jumbo = !row.reply && parts.every(part => part.kind === 'text' || part.kind === 'face') && JUMBO.test(plain);
        const content = h('div', { class: 'content' }, ...parts.map(part => partNode(part, row)));
        const quote = row.reply
            ? h('button', { class: 'quote', type: 'button', 'aria-label': `引用：${row.reply.text}`, onclick: () => ctx.onJump(/** @type {NonNullable<typeof row.reply>} */ (row.reply).id) },
                h('span', { class: 'quote-who', text: row.reply.found ? (row.reply.mine ? '我' : ctx.selfName() || '对方') : '' }),
                h('span', { class: 'quote-text', text: row.reply.text }))
            : null;
        const li = h('li', { class: `row msg ${row.mine ? 'mine' : 'theirs'}`, dataset: { key: row.key } },
            h('span', { class: 'sr-only', text: `${row.mine ? '我' : ctx.selfName() || '对方'}，${formatClock(row.at)}：` }),
            h('div', { class: `bubble${onlyMedia ? ' media-only' : ''}${jumbo ? ' jumbo' : ''}`, tabindex: '0' },
                quote, content,
                row.viaQq ? h('span', { class: 'via', title: '这条是在 QQ 上发的', text: 'QQ' }) : null,
                h('span', { class: 'upload-veil', hidden: true }, ring(40))),
            h('div', { class: 'reactions', hidden: true }),
            h('div', { class: 'meta', hidden: true }));
        if (row.id !== undefined) li.dataset.id = String(row.id);
        if (row.clientId) li.dataset.clientId = row.clientId;
        return li;
    }

    /** 这一行要不要整个重画（内容变了），还是只改状态。 @param {import('../src/timeline.d.ts').Row} row */
    function structure(row) {
        if (row.type !== 'bubble') return JSON.stringify(row);
        return JSON.stringify([row.mine, row.parts, row.reply, row.localId, row.viaQq, row.id, formatClock(row.at)]);
    }

    /** @param {import('../src/timeline.d.ts').Row} row @returns {HTMLElement} */
    function create(row) {
        if (row.type === 'stamp') return h('li', { class: 'row stamp', dataset: { key: row.key } }, h('time', { datetime: new Date(row.at).toISOString(), text: row.label }));
        if (row.type === 'unread') return h('li', { class: 'row unread', dataset: { key: row.key } }, h('span', { text: '以下是新消息' }));
        if (row.type === 'notice') {
            const li = h('li', { class: 'row notice', dataset: { key: row.key } }, h('span', { text: row.text }));
            if (row.id !== undefined) li.dataset.id = String(row.id);
            return li;
        }
        return bubble(row);
    }

    /** 分组、状态、进度、表情回应：不重画气泡，只改这些。 @param {HTMLElement} el @param {import('../src/timeline.d.ts').Row} row */
    function patch(el, row) {
        if (row.type !== 'bubble') return;
        el.classList.toggle('first', row.first);
        el.classList.toggle('last', row.last);
        el.classList.toggle('failed', row.status === 'failed');
        el.classList.toggle('pending', row.status === 'sending' || row.status === 'uploading');

        const veil = /** @type {HTMLElement} */ (el.querySelector('.upload-veil'));
        veil.hidden = row.status !== 'uploading';
        if (!veil.hidden) setRing(veil, row.progress ?? 0);

        const reactions = /** @type {HTMLElement} */ (el.querySelector('.reactions'));
        reactions.hidden = row.reactions.length === 0;
        if (reactions.dataset.sig !== row.reactions.join(',')) {
            reactions.dataset.sig = row.reactions.join(',');
            reactions.replaceChildren(...row.reactions.map(id => {
                const face = reactionDisplay(id);
                return h('span', { class: 'reaction', role: 'img', 'aria-label': `对方回应了「${face.label}」`, text: face.text });
            }));
        }

        const meta = /** @type {HTMLElement} */ (el.querySelector('.meta'));
        const label = row.showStatus ? statusText(row) : '';
        meta.hidden = !label;
        if (meta.dataset.sig !== `${row.status}|${label}`) {
            meta.dataset.sig = `${row.status}|${label}`;
            if (row.status === 'failed' && row.clientId) {
                const clientId = row.clientId;
                meta.replaceChildren(h('button', { class: 'retry', type: 'button', onclick: () => ctx.onRetry(clientId) }, icon('alert', 16), h('span', { text: label })));
            } else {
                meta.replaceChildren(h('span', { class: `status ${row.status}`, text: label }));
            }
        }
    }

    /** 这一行不要了：放开它占着的媒体。 @param {HTMLElement} el */
    function dispose(el) {
        for (const box of el.querySelectorAll('.image')) {
            observer.unobserve(box);
            unloadImage(/** @type {HTMLElement} */ (box));
        }
        if (playing && el.contains(playing.el)) stopVoice();
    }

    return { create, patch, dispose, structure, stopVoice };
}
