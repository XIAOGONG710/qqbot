import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const host = process.env.COMPANION_HOST ?? '127.0.0.1';
const port = Number(process.env.COMPANION_PORT ?? 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8' };

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('COMPANION_PORT 不合法');

const server = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method ?? '')) return finish(response, 405, 'method_not_allowed');
    const raw = (request.url ?? '/').split('?', 1)[0] ?? '/';
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch { return finish(response, 400, 'bad_path'); }
    const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const filename = resolve(root, normalize(relativePath));
    const outside = relative(root, filename);
    if (isAbsolute(outside) || outside === '..' || outside.startsWith(`..${normalize('/')}`) || outside.split(/[\\/]/u).includes('..')) return finish(response, 403, 'forbidden');
    try {
        const stat = await fs.stat(filename);
        if (!stat.isFile()) return finish(response, 404, 'not_found');
        response.statusCode = 200;
        response.setHeader('Content-Type', types[extname(filename)] ?? 'application/octet-stream');
        response.setHeader('Cache-Control', filename.endsWith('index.html') ? 'no-store' : 'public, max-age=300');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.method === 'HEAD') return response.end();
        return createReadStream(filename).pipe(response);
    } catch { return finish(response, 404, 'not_found'); }
});

server.listen(port, host, () => console.log(`手机伴侣 PWA：http://${host}:${port}/`));

function finish(response, status, body) {
    response.statusCode = status;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(body);
}
