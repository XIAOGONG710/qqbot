// 对浏览器那几份文件做的静态检查：安全边界不靠人记。
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (file: string) => readFile(join(root, file), 'utf8');
const browserScripts = async () => [
    'app.js', 'sw.js',
    ...(await readdir(join(root, 'src'))).filter(name => name.endsWith('.js')).map(name => `src/${name}`),
    ...(await readdir(join(root, 'ui'))).filter(name => name.endsWith('.js')).map(name => `ui/${name}`),
];

test('首页有严格的 CSP：只许同源脚本和样式，媒体只许 blob:', async () => {
    const html = await read('index.html');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /style-src 'self'(;|$)/);
    assert.match(csp, /connect-src 'self'(;|$)/);
    assert.match(csp, /img-src 'self' blob:(;|$)/);
    assert.match(csp, /media-src blob:(;|$)/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
});

test('首页不引用任何外部地址，没有内联脚本、内联样式和内联事件', async () => {
    const html = await read('index.html');
    assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<style|\sstyle="|\son[a-z]+="/);
    const css = await read('style.css');
    assert.doesNotMatch(css, /url\(|@import/);
});

test('浏览器脚本不用 innerHTML / eval 之类，不往别处发请求', async () => {
    for (const file of await browserScripts()) {
        const source = await read(file);
        assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, file);
        assert.doesNotMatch(source, /["'`]https?:\/\/(?!www\.w3\.org\/2000\/svg)/, file);
        assert.doesNotMatch(source, /sendBeacon|EventSource|importScripts/, file);
    }
});

test('凭据只进 hello 帧和 Authorization 头：没有任何地方把 token 拼进 URL', async () => {
    for (const file of await browserScripts()) {
        const source = await read(file);
        assert.doesNotMatch(source, /[?&](token|deviceId|access_token)=/, file);
        assert.doesNotMatch(source, /new WebSocket\([^)]*(token|credentials)/, file);
    }
    const app = await read('app.js');
    assert.match(app, /new WebSocket\(`\$\{location\.protocol === 'https:' \? 'wss:' : 'ws:'\}\/\/\$\{location\.host\}\/ws`\)/);
    assert.match(app, /fetch\('\/api\/pair'/);
});

test('Service Worker 只缓存列出来的静态文件，/api 和 /ws 不碰；列表和实际文件对得上', async () => {
    const sw = await read('sw.js');
    assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\) \|\| url\.pathname === '\/ws'\) return/);
    assert.match(sw, /if \(!STATIC_URLS\.has\(key\)\) return/);
    const listed = [...(/const ASSETS = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '').matchAll(/'\.\/([^']*)'/g)].map(match => match[1] as string).filter(Boolean).sort();
    const expected = [
        'index.html', 'style.css', 'manifest.webmanifest',
        ...(await browserScripts()).filter(file => file !== 'sw.js'),
        ...(await readdir(join(root, 'icons'))).map(name => `icons/${name}`),
    ].sort();
    assert.deepEqual(listed, expected);
    for (const file of expected) await read(file);
});

test('manifest 指向的图标都在', async () => {
    const manifest = JSON.parse(await read('manifest.webmanifest')) as { icons: { src: string }[]; display: string; start_url: string };
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) assert.ok((await readFile(join(root, icon.src))).length > 0, icon.src);
});

test('界面里不写死她的名字', async () => {
    for (const file of ['index.html', 'manifest.webmanifest', ...(await browserScripts())]) {
        assert.doesNotMatch(await read(file), /林梦瑶/, file);
    }
});
