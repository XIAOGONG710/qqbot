// 小工具：造元素、造图标。消息内容一律走 textContent，不拼 HTML 字符串。

export const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @param {string} tag
 * @param {Record<string, unknown> | null} [props] class / text / dataset / aria-* / on* / 其余当属性
 * @param {...(Node | string | null | undefined | false)} children
 */
export function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === 'class') el.className = String(value);
            else if (key === 'text') el.textContent = String(value);
            else if (key === 'dataset') Object.assign(el.dataset, value);
            else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), /** @type {EventListener} */ (value));
            else if (value === true) el.setAttribute(key, '');
            else el.setAttribute(key, String(value));
        }
    }
    for (const child of children) if (child) el.append(child);
    return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
    play: [['path', { d: 'M8 5.500v13l11-6.500z', fill: 'currentColor' }]],
    pause: [['path', { d: 'M7.500 5.500h3v13h-3zM13.500 5.500h3v13h-3z', fill: 'currentColor' }]],
    alert: [['circle', { cx: 12, cy: 12, r: 9, fill: 'currentColor' }], ['path', { d: 'M12 7.500v5.500M12 16.200v.3', stroke: 'var(--surface)', 'stroke-width': 2, 'stroke-linecap': 'round', fill: 'none' }]],
    link: [['path', { d: 'M10 14a4 4 0 005.700 0l3-3a4 4 0 00-5.700-5.700l-1 1M14 10a4 4 0 00-5.700 0l-3 3a4 4 0 005.700 5.700l1-1', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', fill: 'none' }]],
    close: [['path', { d: 'M7 7l10 10M17 7L7 17', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', fill: 'none' }]],
    image: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 }], ['path', { d: 'M4.500 17l4.500-4.500 3.500 3.500 2.500-2.500 4.500 4.500', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linejoin': 'round' }]],
};

/** @param {keyof typeof ICONS} name @param {number} [size] */
export function icon(name, size = 20) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of ICONS[name]) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
        svg.append(node);
    }
    return svg;
}

/** 语音条上的进度环 / 上传进度环 */
export function ring(size = 36) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('class', 'ring');
    svg.setAttribute('aria-hidden', 'true');
    for (const cls of ['ring-track', 'ring-value']) {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', '18'); circle.setAttribute('cy', '18'); circle.setAttribute('r', '15');
        circle.setAttribute('class', cls);
        circle.setAttribute('pathLength', '100');
        svg.append(circle);
    }
    return svg;
}

/** @param {Element} svg @param {number} fraction 0..1 */
export function setRing(svg, fraction) {
    const value = /** @type {SVGCircleElement | null} */ (svg.querySelector('.ring-value'));
    if (value) value.style.strokeDashoffset = String(100 - Math.round(Math.min(1, Math.max(0, fraction)) * 100));
}

export const storage = {
    /** @param {string} key */
    get(key) {
        try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; }
    },
    /** @param {string} key @param {unknown} value */
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
    /** @param {string} key */
    remove(key) {
        try { localStorage.removeItem(key); } catch { /* 存储不可用 */ }
    },
};

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map((b, i) => (i === 6 ? (b & 0x0f) | 0x40 : i === 8 ? (b & 0x3f) | 0x80 : b).toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'));
