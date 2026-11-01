// 扫码页：把 NapCat 的登录二维码挂到 http://127.0.0.1:7801/ ，手机上扫码登录。
// 二维码文件会被 NapCat 覆盖刷新，页面每 3 秒重新拉一次。
// 用法：node scripts/qr-page.mjs [png路径] [端口]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const png = process.argv[2] ?? 'C:\\napcat-ascii\\napcat\\cache\\qrcode.png';
const port = Number(process.argv[3] ?? 7801);

createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0];
    if (url === '/qrcode.png' || url === '/' || url === '') {
        try {
            const image = readFileSync(png);
            if (url === '/' || url === '') {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                response.end(`<!doctype html><meta charset="utf-8"><title>扫码登录</title>
<body style="background:#111;color:#eee;font-family:sans-serif;text-align:center;padding:24px">
<h2>用手机 QQ 扫这个码登录机器人</h2>
<img id="q" src="/qrcode.png?t=${Date.now()}" style="width:320px;image-rendering:pixelated;background:#fff;padding:12px;border-radius:8px">
<p style="opacity:.6">页面每 3 秒自动刷新二维码</p>
<script>setInterval(() => { document.getElementById('q').src = '/qrcode.png?t=' + Date.now(); }, 3000);</script>
</body>`);
                return;
            }
            response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            response.end(image);
        } catch (error) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end(`还没有二维码：${error instanceof Error ? error.message : String(error)}`);
        }
        return;
    }
    response.writeHead(404);
    response.end();
}).listen(port, '127.0.0.1', () => console.log(`扫码页：http://127.0.0.1:${port}/`));
