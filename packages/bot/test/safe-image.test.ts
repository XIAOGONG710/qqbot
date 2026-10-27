import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fetchRemoteImage, imageDataUrl, validateImageDataUrl, type HostResolver, type ImageFetch } from '../src/vision/safe-image.ts';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const publicDns: HostResolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('远程图片安全入口', () => {
    test('拒绝环回、内网以及解析结果里混入内网的域名', async () => {
        let fetched = false;
        const fetch: ImageFetch = async () => { fetched = true; return new Response(png); };
        await assert.rejects(() => fetchRemoteImage('http://127.0.0.1/a.png', { fetch, resolve: publicDns }), /local|private/);
        await assert.rejects(() => fetchRemoteImage('http://[::1]/a.png', { fetch, resolve: publicDns }), /local|private/);
        await assert.rejects(() => fetchRemoteImage('https://images.example/a.png', {
            fetch,
            resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }],
        }), /non-public/);
        assert.equal(fetched, false);
    });

    test('各种写法的本机、内网、元数据地址都挡住，公网地址放行', async () => {
        const fetch: ImageFetch = async () => new Response(png);
        const blocked = [
            'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://0.0.0.0/', 'http://169.254.169.254/latest/meta-data',
            'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://100.64.0.1/',
            'http://localhost/', 'http://a.localhost/', 'http://printer.local/',
            'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/',
            'http://[2002:7f00:1::]/', 'http://[fe80::1]/', 'http://[fc00::1]/',
        ];
        for (const url of blocked) await assert.rejects(() => fetchRemoteImage(url, { fetch, resolve: publicDns }), /local|private/, url);
        await assert.rejects(() => fetchRemoteImage('http://user:pw@images.example/a.png', { fetch, resolve: publicDns }), /credentials/);
        await assert.rejects(() => fetchRemoteImage('ftp://images.example/a.png', { fetch, resolve: publicDns }), /http/);
        for (const url of ['https://images.example/a.png', 'http://93.184.216.34/a.png', 'http://[2606:2800:220:1:248:1893:25c8:1946]/a.png']) {
            assert.equal((await fetchRemoteImage(url, { fetch, resolve: publicDns })).type, 'image/png', url);
        }
    });

    test('重定向次数有上限，不读正文的响应会被释放', async () => {
        let released = 0;
        const fetch: ImageFetch = async () => {
            const body = new ReadableStream<Uint8Array>({ cancel() { released++; } });
            return new Response(body, { status: 302, headers: { location: 'https://images.example/next.png' } });
        };
        await assert.rejects(() => fetchRemoteImage('https://images.example/a.png', { fetch, resolve: publicDns, maxRedirects: 2 }), /too many/);
        assert.equal(released, 3);
        let notFoundReleased = false;
        const gone: ImageFetch = async () => new Response(new ReadableStream<Uint8Array>({ cancel() { notFoundReleased = true; } }), { status: 404 });
        await assert.rejects(() => fetchRemoteImage('https://images.example/a.png', { fetch: gone, resolve: publicDns }), /404/);
        assert.equal(notFoundReleased, true);
    });

    test('手动处理重定向，每一跳重新校验，不能跳进本机', async () => {
        const seen: string[] = [];
        const fetch: ImageFetch = async url => {
            seen.push(url);
            return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
        };
        await assert.rejects(() => fetchRemoteImage('https://images.example/a.png', { fetch, resolve: publicDns }), /local|private/);
        assert.deepEqual(seen, ['https://images.example/a.png']);
    });

    test('不信 Content-Length，边读边限长并取消超额正文', async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(png.subarray(0, 8));
                controller.enqueue(Uint8Array.from([1, 2, 3, 4]));
            },
            cancel() { cancelled = true; },
        });
        const fetch: ImageFetch = async () => new Response(body, { headers: { 'content-length': '1' } });
        await assert.rejects(() => fetchRemoteImage('https://images.example/a.png', { fetch, resolve: publicDns, maxBytes: 9 }), /exceeds/);
        assert.equal(cancelled, true);
    });

    test('只按文件签名接收支持的图片，并生成经过复验的 data URL', async () => {
        const fetch: ImageFetch = async () => new Response(png, { headers: { 'content-type': 'text/html' } });
        const image = await fetchRemoteImage('https://images.example/a.png', { fetch, resolve: publicDns });
        assert.equal(image.type, 'image/png');
        const dataUrl = imageDataUrl(image);
        assert.equal(validateImageDataUrl(dataUrl), dataUrl);
        await assert.rejects(() => fetchRemoteImage('https://images.example/a.png', {
            fetch: async () => new Response('not an image'), resolve: publicDns,
        }), /unsupported/);
        assert.throws(() => validateImageDataUrl('data:image/png;base64,AAAA'), /content does not match/);
    });
});
