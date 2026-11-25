import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createController } from '../dsh-plugins/dsh-qqbot-services/controller.js';
import { allowedRequest, createHandler, summarizeWatchdog } from '../dsh-plugins/dsh-qqbot-services/index.js';

const health = { napcat: false, hindsight: false, koishi: false, koishiListening: false, maintenance: false, watchdog: true };

async function settled(controller) {
    for (let n = 0; n < 30; n++) {
        const state = await controller.state();
        if (!state.operation?.running) return state.operation;
        await sleep(0);
    }
    throw new Error('Operation did not finish');
}

test('batch skips ready services and waits for each missing dependency in order', async () => {
    const current = { ...health, napcat: true };
    const calls = [];
    const controller = createController({
        probe: async () => ({ ...current }),
        launch: async service => { calls.push(service); current[service] = true; if (service === 'koishi') current.koishiListening = true; },
        sleep: async () => {},
    });
    assert.equal(controller.start('all'), 'accepted');
    assert.equal(controller.start('koishi'), 'busy');
    assert.deepEqual((await settled(controller)).steps, { napcat: 'skipped', hindsight: 'ready', koishi: 'ready' });
    assert.deepEqual(calls, ['hindsight', 'koishi']);
});

test('a missing dependency times out without launching the downstream service', async () => {
    let clock = 0;
    const calls = [];
    const controller = createController({
        probe: async () => ({ ...health, launchers: { napcat: true } }),
        launch: async service => { calls.push(service); },
        sleep: async () => { clock += 60_000; },
        now: () => clock,
    });
    assert.equal(controller.start('all'), 'accepted');
    assert.deepEqual((await settled(controller)).steps, { napcat: 'timeout' });
    assert.deepEqual(calls, []);
});

test('individual start does not launch other services; maintenance and disposal suppress launch', async () => {
    const current = { ...health, maintenance: true };
    const calls = [];
    const controller = createController({
        probe: async () => ({ ...current }),
        launch: async service => { calls.push(service); current[service] = true; },
        sleep: async () => {},
    });
    assert.equal(controller.start('hindsight'), 'accepted');
    assert.deepEqual((await settled(controller)).steps, { hindsight: 'maintenance' });
    current.maintenance = false;
    assert.equal(controller.start('hindsight'), 'accepted');
    assert.deepEqual((await settled(controller)).steps, { hindsight: 'ready' });
    assert.deepEqual(calls, ['hindsight']);
    controller.dispose();
    assert.equal(controller.start('all'), 'unavailable');
});

test('routes accept only local panel operations and event texts never leave the host', async () => {
    const request = { method: 'POST', url: '/api/qqbot-services/start/napcat', socket: { remoteAddress: '::ffff:127.0.0.1' },
        headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'x-qqbot-service-panel': '1' } };
    assert.equal(allowedRequest(request), true);
    assert.equal(allowedRequest({ ...request, headers: { ...request.headers, origin: 'https://example.test' } }), false);
    assert.equal(allowedRequest({ ...request, headers: { ...request.headers, 'x-forwarded-for': '192.168.1.1' } }), false);
    assert.equal(allowedRequest({ ...request, socket: { remoteAddress: '192.168.1.1' } }), false);
    const controller = createController({ probe: async () => health, launch: async () => assert.fail(), sleep: async () => {} });
    const handler = createHandler(controller, () => [], undefined, { authorizeIndex: () => true });
    let status;
    await handler({ ...request, url: '/api/qqbot-services/start/other-script.ps1' }, {
        writeHead(value) { status = value; }, end() {},
    });
    assert.equal(status, 400);
    assert.deepEqual(summarizeWatchdog(['2026/11/24 18:00:00 hindsight：启动失败 token=SECRET']), [
        { at: '2026/11/24 18:00:00', service: 'hindsight', event: 'failed' },
    ]);
});

test('desktop proxy uses the DSH host session without returning a panel token', async () => {
    const current = { ...health, napcat: true, hindsight: true, koishi: true, koishiListening: true,
        ports: { napcat: 3001, hindsight: 8899, koishi: 5140 }, lastConnection: { state: 'connected', detail: 'PRIVATE' } };
    const controller = createController({ probe: async () => current, launch: async () => assert.fail(), sleep: async () => {} });
    const connection = { authorizeIndex(req) {
        assert.equal(req.url, '/api/qqbot-services');
        return req.headers.cookie === 'test-session=owner';
    } };
    const handler = createHandler(controller, () => [], undefined, connection);
    const call = async (method, path, headers = {}) => {
        let status, body;
        await handler({ method, url: '/api/qqbot-services/' + path, socket: { remoteAddress: '127.0.0.1' },
            headers: { host: '127.0.0.1:3000', ...headers } }, {
            writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); },
        });
        return { status, body };
    };
    assert.equal((await call('GET', 'state')).status, 403);
    const { body } = await call('GET', 'state', { cookie: 'test-session=owner' });
    assert.match(body.diagnostic, /Hindsight（端口 8899） 正常/);
    assert.match(body.diagnostic, /Koishi → NapCat 最近记录为已连接/);
    assert.doesNotMatch(body.diagnostic, /PRIVATE|panelToken/);
    assert.equal(body.panelToken, undefined);
    const marker = { 'x-qqbot-service-panel': '1' };
    const authorized = { ...marker, cookie: 'test-session=owner' };
    assert.equal((await call('POST', 'start/all', marker)).status, 403);
    assert.equal((await call('POST', 'start/all', { ...marker, origin: 'http://127.0.0.1:3000' })).status, 403);
    assert.equal((await call('GET', 'state?token=attacker')).status, 403);
    assert.equal((await call('GET', 'state', { origin: 'https://example.test' })).status, 403);
    assert.equal((await call('POST', 'start/all', { ...authorized, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await call('POST', 'start/all', { ...authorized, origin: 'null' })).status, 403);
    assert.equal((await call('POST', 'start/all', authorized)).status, 202);
    assert.deepEqual((await settled(controller)).steps, { napcat: 'skipped', hindsight: 'skipped', koishi: 'skipped' });
});

test('client registers the same bridge console in DSH settings and the sidebar', () => {
    const entries = [];
    const ctx = { slots: {
        inject(_name, callback) { callback(); },
        register(entry, render) { entries.push({ ...entry, render }); },
    } };
    let plugin;
    const source = readFileSync(new URL('../dsh-plugins/dsh-qqbot-services/client.js', import.meta.url), 'utf8');
    runInNewContext(source, {
        window: { __ModuleLoader__: { load(bundle) {
            assert.equal(bundle.id, 'dsh-qqbot-services');
            plugin = bundle.factory(name => {
                assert.equal(name, 'react');
                return { createElement() {} };
            });
        } } },
    });
    plugin.apply(ctx);
    plugin.apply(ctx);
    assert.deepEqual(entries.map(({ name, key, id }) => [name, key ?? id]), [
        ['main', 'dsh-qqbot-services'], ['sidebar.panellist', 'dsh-qqbot-services'],
        ['settings.section', 'linmengyao-qq-bridge'],
    ]);
    assert.equal(entries[0].render, entries[2].render);
});

test('the DSH chat form commits only after the operator accepts the server preview', async () => {
    let panel, plugin, accepted = false;
    let theme;
    const requests = [], previews = [];
    const account = { id: '100', name: '测试账号' };
    const recipient = { key: 'private:200', target: '200', kind: 'private', name: '测试收件人' };
    const draft = '合成消息';
    const text = '【本人手动代发】' + draft;
    const source = readFileSync(new URL('../dsh-plugins/dsh-qqbot-services/client.js', import.meta.url), 'utf8');
    let states;
    const React = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: () => [states.shift(), () => {}],
        useRef: current => ({ current }),
        useEffect() {},
        useId: () => 'test',
    };
    runInNewContext(source, {
        document: { getElementById: () => theme ?? null, createElement: () => ({}), head: { appendChild: style => { theme = style; } } },
        window: {
            __ModuleLoader__: { load(bundle) { plugin = bundle.factory(() => React); } },
            confirm(message) { previews.push(message); return accepted; },
        },
        fetch: async (url, options) => {
            requests.push([url.split('/').at(-1), JSON.parse(options.body)]);
            return { ok: true, json: async () => ({ confirmation: 'synthetic', preview: { account, recipient, text } }) };
        },
    });
    plugin.apply({ slots: {
        inject(_name, callback) { callback(); },
        register(slot, render) { if (slot.name === 'main') panel = render; },
    } });
    const find = (node, predicate) => node && typeof node === 'object' &&
        (predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean));
    states = [{ health: {} }, '', false, false, '', 'chat'];
    const root = panel();
    assert.equal(theme.id, 'qqb-style');
    assert.match(theme.textContent, /\.qqb-hero.*radial-gradient/s);
    assert.match(theme.textContent, /\.qqb-bubble\{/);
    assert.ok(find(root, node => node.props?.className === 'qqb-hero'));
    const chat = find(root, node => node.type?.name === 'Chat');
    states = [{ account, sessions: [recipient], sendKey: recipient.key, sendPrefix: '【本人手动代发】' }, recipient.key, '', 0, false];
    const conversation = find(chat.type(chat.props), node => node.type?.name === 'Conversation');
    states = [30, null, '', draft, false, 0];
    const { props: form } = find(conversation.type(conversation.props), node => node.type === 'form');
    assert.equal(form.className, 'qqb-composer');
    await form.onSubmit({ preventDefault() {} });
    assert.deepEqual(requests.map(([operation]) => operation), ['prepare']);
    accepted = true;
    await form.onSubmit({ preventDefault() {} });
    assert.match(previews.at(-1), /测试账号（100）.*测试收件人（200）/);
    assert.ok(previews.at(-1).endsWith(text));
    assert.deepEqual(requests.at(-1), ['send', { key: recipient.key, accountId: account.id, text: draft, confirmation: 'synthetic' }]);
});

test('PowerShell launchers hold one shared lock for the whole foreground run', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-managed-service-'));
    const scripts = join(root, 'scripts');
    const marker = join(root, 'launches.txt');
    const release = join(root, 'release');
    const quote = value => "'"+value.replaceAll("'", "''")+"'";
    mkdirSync(scripts);
    copyFileSync(new URL('./start-managed-service.ps1', import.meta.url), join(scripts, 'start-managed-service.ps1'));
    writeFileSync(join(scripts, 'start-napcat.ps1'),
        `Add-Content -LiteralPath ${quote(marker)} -Value launch\nwhile (!(Test-Path -LiteralPath ${quote(release)})) { Start-Sleep -Milliseconds 100 }\n`);
    const invoke = () => {
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            `function Get-NetTCPConnection { param($State,$LocalPort) }\n& ${quote(join(scripts, 'start-managed-service.ps1'))} -Service napcat`],
        { windowsHide: true, stdio: 'pipe' });
        let output = '';
        child.stdout.on('data', bytes => { output += bytes; });
        child.stderr.on('data', bytes => { output += bytes; });
        const result = new Promise((done, reject) => {
            child.once('error', reject);
            child.once('close', code => done({ code, output }));
        });
        return { child, result };
    };
    const first = invoke();
    const children = [first];
    try {
        const end = Date.now() + 6500;
        while (!existsSync(marker) && Date.now() < end) await sleep(50);
        assert.ok(existsSync(marker), 'fake launcher did not start');
        const second = invoke();
        children.push(second);
        const result = await second.result;
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /Already managed: napcat/);
        assert.equal(readFileSync(marker, 'utf8').trim(), 'launch');
        writeFileSync(release, '');
        assert.equal((await first.result).code, 0);
        const third = invoke();
        children.push(third);
        assert.equal((await third.result).code, 0);
        assert.equal(readFileSync(marker, 'utf8').trim().split(/\r?\n/).length, 2);
    } finally {
        writeFileSync(release, '');
        for (const { child, result } of children) {
            if (child.exitCode === null) child.kill();
            await result.catch(() => {});
        }
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(basename(root).startsWith('qqbot-managed-service-'));
        rmSync(root, { recursive: true, force: true });
    }
});
