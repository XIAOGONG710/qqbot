import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceHub, type DeviceHub } from '../src/platform/device-hub.ts';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');
const hubs: DeviceHub[] = [];
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.stop(); });

async function start(extra: Partial<Parameters<typeof createDeviceHub>[0]> = {}) {
    const tamper: number[] = [];
    const hub = createDeviceHub({ host: '127.0.0.1', port: 0, token: TOKEN, log: () => undefined, pollWaitMaxMs: 300, onTamper: n => tamper.push(n), ...extra });
    await hub.start();
    hubs.push(hub);
    const base = `http://127.0.0.1:${hub.port()}`;
    const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
        fetch(`${base}${path}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    return { hub, call, tamper };
}

describe('设备取件中心（ADR 0148）', () => {
    test('没有取件者：提交马上失败，不排队', async () => {
        const { hub } = await start();
        assert.equal(hub.online(), false);
        assert.deepEqual(await hub.submit({ action: 'notify', params: { text: 'x' } }), { ok: false, error: '电脑那头没上线' });
    });

    test('取件者先来挂着：提交一个任务，取件者马上领到，交回结果后提交方拿到结果', async () => {
        const { hub, call } = await start();
        const polling = call('/poll?wait=5');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(hub.online(), true);
        const submitted = hub.submit({ action: 'notify', params: { text: '喝水' } });
        const response = await polling;
        assert.equal(response.status, 200);
        const job = await response.json() as { id: string; action: string; params: unknown };
        assert.deepEqual([job.action, job.params], ['notify', { text: '喝水' }]);
        const posted = await call('/result', { method: 'POST', body: JSON.stringify({ id: job.id, ok: true }) });
        assert.equal(posted.status, 200);
        assert.deepEqual(await submitted, { ok: true });
    });

    test('取件者晚到：任务先排着，下一次来取就拿到', async () => {
        const { hub, call } = await start();
        assert.equal((await call('/poll')).status, 204, '先来一次表示上线');
        const submitted = hub.submit({ action: 'media', params: { op: 'next' } });
        const job = await (await call('/poll')).json() as { id: string; action: string };
        assert.equal(job.action, 'media');
        await call('/result', { method: 'POST', body: JSON.stringify({ id: job.id, ok: false, error: '播放器没开' }) });
        assert.deepEqual(await submitted, { ok: false, error: '播放器没开' });
    });

    test('取件者上线了但一直不来领：20 秒内没领就失败（这里把时钟拨快）', async () => {
        let clock = 1_000_000;
        const { hub, call } = await start({ now: () => clock });
        await call('/poll');
        const result = await hub.submit({ action: 'notify', params: { text: 'x' } }, 80);
        assert.deepEqual(result, { ok: false, error: '电脑那头没来领' });
        clock += 61_000;
        assert.equal(hub.online(), false, '60 秒没来就算下线');
    });

    test('截图：只收 PNG / JPEG，检查文件头；合格的变成 data URL', async () => {
        const { hub, call } = await start();
        await call('/poll');
        const good = hub.submit({ action: 'capture_screen', params: {} });
        const job = await (await call('/poll')).json() as { id: string };
        const posted = await call('/result', { method: 'POST', body: JSON.stringify({ id: job.id, ok: true, mime: 'image/png', imageBase64: PNG_B64 }) });
        assert.equal(posted.status, 200);
        const result = await good;
        assert.equal(result.ok, true);
        assert.equal(result.dataUrl, `data:image/png;base64,${PNG_B64}`);

        for (const bad of [
            { mime: 'image/png', imageBase64: Buffer.from('<html>not an image</html>').toString('base64') },
            { mime: 'image/svg+xml', imageBase64: PNG_B64 },
            { mime: 'image/png', imageBase64: '###' },
        ]) {
            const pending = hub.submit({ action: 'capture_screen', params: {} });
            const next = await (await call('/poll')).json() as { id: string };
            const answer = await call('/result', { method: 'POST', body: JSON.stringify({ id: next.id, ok: true, ...bad }) });
            assert.equal(answer.status, 422);
            const failed = await pending;
            assert.equal(failed.ok, false);
            assert.equal(failed.dataUrl, undefined);
        }
    });

    test('图片太大被拒', async () => {
        const { hub, call } = await start({ maxImageBytes: 8 });
        await call('/poll');
        const pending = hub.submit({ action: 'capture_screen', params: {} });
        const job = await (await call('/poll')).json() as { id: string };
        await call('/result', { method: 'POST', body: JSON.stringify({ id: job.id, ok: true, mime: 'image/png', imageBase64: PNG_B64 }) });
        assert.equal((await pending).ok, false);
    });

    test('认证：没有令牌 / 令牌不对 → 401；5 次失败报一次警；别的路径和方法 404 / 405', async () => {
        const { call, tamper } = await start();
        assert.equal((await call('/poll', {}, null)).status, 401);
        assert.equal((await call('/poll', {}, 'wrong')).status, 401);
        assert.equal((await call('/poll', {}, TOKEN + 'x')).status, 401);
        assert.equal((await call('/result', { method: 'POST', body: '{}' }, 'nope')).status, 401);
        assert.deepEqual(tamper, []);
        assert.equal((await call('/poll', {}, '')).status, 401);
        assert.deepEqual(tamper, [5]);
        assert.equal((await call('/poll', {}, 'again')).status, 401);
        assert.deepEqual(tamper, [5], '只报一次');
        assert.equal((await call('/etc/passwd')).status, 404);
        assert.equal((await call('/poll', { method: 'POST', body: '{}' })).status, 405);
    });

    test('交结果：不是 JSON → 400；不存在的任务 → 404；交了就不能再交', async () => {
        const { hub, call } = await start();
        assert.equal((await call('/result', { method: 'POST', body: 'not json' })).status, 400);
        assert.equal((await call('/result', { method: 'POST', body: JSON.stringify({ id: 'nope', ok: true }) })).status, 404);
        await call('/poll');
        const pending = hub.submit({ action: 'ring', params: {} });
        const job = await (await call('/poll')).json() as { id: string };
        assert.equal((await call('/result', { method: 'POST', body: JSON.stringify({ id: job.id, ok: true }) })).status, 200);
        assert.equal((await call('/result', { method: 'POST', body: JSON.stringify({ id: job.id, ok: true }) })).status, 404);
        assert.equal((await pending).ok, true);
    });

    test('停掉的时候还在等的任务都失败，不挂着', async () => {
        const { hub, call } = await start();
        await call('/poll');
        const pending = hub.submit({ action: 'notify', params: { text: 'x' } });
        await hub.stop();
        assert.deepEqual(await pending, { ok: false, error: '取件中心关了' });
    });
});

// 2026-10-30：手机端伴侣 app 把屏幕帧推上来，她以后能"看手机"
describe('手机屏幕帧（伴侣 app 推上来）', () => {
    test('收一帧 JPEG / PNG：存成 latest + latest.json，不带令牌推不进来', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-frames-'));
        const { call } = await start({ phoneFramesDir: dir });
        const ok = await call('/frame', { method: 'POST', body: JSON.stringify({ mime: 'image/png', imageBase64: PNG_B64, at: 1793355000000 }) });
        assert.equal(ok.status, 200);
        assert.ok(existsSync(join(dir, 'latest.png')));
        const meta = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')) as { mime: string; at: number };
        assert.equal(meta.mime, 'image/png');
        assert.equal(meta.at, 1793355000000);
        const denied = await call('/frame', { method: 'POST', body: JSON.stringify({ mime: 'image/png', imageBase64: PNG_B64 }) }, null);
        assert.equal(denied.status, 401);
    });

    test('不是图片的文件头不收；没开这个入口就是 404', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-frames-'));
        const { call } = await start({ phoneFramesDir: dir });
        const bad = await call('/frame', { method: 'POST', body: JSON.stringify({ mime: 'image/png', imageBase64: Buffer.from('not an image').toString('base64') }) });
        assert.equal(bad.status, 422);
        const closed = await start();
        const notFound = await closed.call('/frame', { method: 'POST', body: JSON.stringify({ mime: 'image/png', imageBase64: PNG_B64 }) });
        assert.equal(notFound.status, 404);
    });
});
