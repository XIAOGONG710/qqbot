import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { createDeviceControl, type DeviceControl } from '../src/platform/device-actions.ts';
import { devicesSecretsPath, linksOf, loadDeviceSecrets, newDeviceSecrets, startDeviceService, validSecrets, type DeviceSecrets, type DeviceService } from '../src/platform/device-service.ts';
import { createBreaker } from '../src/bilibili/platform-breaker.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

const dirs: string[] = [];
const services: DeviceService[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-devices-')); dirs.push(d); return d; };
afterEach(async () => { for (const s of services.splice(0)) await s.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]).toString('base64');
const secrets: DeviceSecrets = { hub: { host: '127.0.0.1', port: 0 }, token: 'a'.repeat(64), phone: { baseUrl: 'https://ntfy.example', topic: 'mengyao-0123456789abcdef' } };

/** 假的电脑端小程序：一直来取任务，按 answer 回结果，记下收到的任务 */
function fakeAgent(base: string, answer: (job: { action: string; params: unknown }) => { ok: boolean; error?: string; mime?: string; imageBase64?: string }, beforeResult?: () => Promise<void>) {
    const seen: { action: string; params: unknown }[] = [];
    let stopped = false;
    const headers = { Authorization: `Bearer ${secrets.token}` };
    void (async () => {
        while (!stopped) {
            try {
                const response = await fetch(`${base}/poll?wait=1`, { headers });
                if (response.status !== 200) continue;
                const job = await response.json() as { id: string; action: string; params: unknown };
                seen.push({ action: job.action, params: job.params });
                if (beforeResult) await beforeResult();
                await fetch(`${base}/result`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, ...answer(job) }) });
            } catch { /* 取件中心关了 */ }
        }
    })();
    return { seen, stop: () => { stopped = true; } };
}
const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); };

async function start(extra: Partial<Parameters<typeof startDeviceService>[0]> = {}) {
    const dataDir = tmp();
    const logs: string[] = [];
    const said: string[] = [];
    const phoneCalls: { url: string; body: Record<string, unknown> }[] = [];
    const service = await startDeviceService({
        dataDir, mode: 'on', links: ['音乐=https://music.example/'], apps: ['记事本'], log: m => logs.push(m), say: t => said.push(t), secrets,
        phoneRequest: async (url, init) => { phoneCalls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '{}' }; },
        ...extra,
    });
    assert.ok(service);
    services.push(service);
    return { service, dataDir, logs, said, phoneCalls, base: `http://127.0.0.1:${service.hub.port()}` };
}

describe('设备控制的密钥和装配（ADR 0148）', () => {
    test('密钥：令牌 ≥ 32 位、hub.host 不能是 0.0.0.0、ntfy 要 https 且话题 ≥ 16 位', () => {
        const real: DeviceSecrets = { ...secrets, hub: { host: '192.168.139.138', port: 7789 } };
        assert.equal(validSecrets(real), true);
        assert.equal(validSecrets({ ...real, token: 'short' }), false);
        assert.equal(validSecrets({ ...real, hub: { host: '0.0.0.0', port: 7789 } }), false);
        assert.equal(validSecrets({ ...real, hub: { host: '192.168.1.5', port: 80 } }), false);
        assert.equal(validSecrets({ ...real, phone: { baseUrl: 'http://ntfy.example', topic: 'mengyao-0123456789abcdef' } }), false);
        assert.equal(validSecrets({ ...real, phone: { baseUrl: 'https://ntfy.example', topic: 'short' } }), false);
        const fresh = newDeviceSecrets('192.168.139.138', true);
        assert.equal(validSecrets(fresh), true);
        assert.match(fresh.token, /^[0-9a-f]{64}$/);
        assert.match(fresh.phone!.topic, /^mengyao-[0-9a-f]{24}$/);
        assert.notEqual(newDeviceSecrets('x', false).token, fresh.token);
    });

    test('密钥文件：写出来能读回；没有返回 undefined；格式不对抛错', () => {
        const dir = tmp();
        const path = devicesSecretsPath(dir);
        assert.equal(loadDeviceSecrets(path), undefined);
        mkdirSync(join(dir, 'secrets'));
        writeFileSync(path, JSON.stringify(newDeviceSecrets('192.168.139.138', false)));
        assert.equal(loadDeviceSecrets(path)?.hub.host, '192.168.139.138');
        writeFileSync(path, '{"token":"x"}');
        assert.throws(() => loadDeviceSecrets(path), /格式不对/);
    });

    test('登记的网页：「名字=地址」→ Map', () => {
        assert.deepEqual([...linksOf(['音乐=https://music.example/a?b=c'])], [['音乐', 'https://music.example/a?b=c']]);
    });

    test('没有密钥文件：不启动，日志里说清怎么办', async () => {
        const logs: string[] = [];
        const service = await startDeviceService({ dataDir: tmp(), mode: 'on', links: [], apps: [], log: m => logs.push(m), say: () => undefined });
        assert.equal(service, undefined);
        assert.match(logs[0]!, /npm run devices -w @qqbot\/bot -- init/);
    });
});

describe('设备控制服务：电脑、手机、他的命令（ADR 0148）', () => {
    test('她回复里的通知令牌 → 取件中心 → 电脑端小程序拿到任务；审计只有动作和结果，没有文字', async () => {
        const t = await start();
        const resultGate = Promise.withResolvers<void>();
        const agent = fakeAgent(t.base, () => ({ ok: true }), () => resultGate.promise);
        const auditPath = join(t.dataDir, 'devices', 'audit.jsonl');
        try {
            await until(() => t.service.hub.online());
            t.service.control.take('我提醒你一下\n<device:notify|电脑|该喝水了>');
            await until(() => agent.seen.length === 1);
            assert.deepEqual(agent.seen, [{ action: 'notify', params: { text: '该喝水了' } }]);
            // 已取件不等于已执行：确定性暂停结果提交，证明 seen 不能作为审计完成条件。
            assert.equal(existsSync(auditPath) && readFileSync(auditPath, 'utf8').includes('"decision":"executed"'), false);
            resultGate.resolve();
            await until(() => existsSync(auditPath) && readFileSync(auditPath, 'utf8').includes('"decision":"executed"'));
            const audit = readFileSync(auditPath, 'utf8');
            assert.match(audit, /"action":"notify".*"decision":"executed"/);
            assert.equal(audit.includes('喝水'), false);
        } finally {
            resultGate.resolve();
            agent.stop();
        }
    });

    test('手机走 ntfy：通知、定时（延时）；电脑没上线时「都」只走手机，电脑那份在审计里记失败', async () => {
        const t = await start();
        t.service.control.take('<device:notify|手机|喝水>');
        t.service.control.take('<device:timer|手机|600|泡面>');
        await until(() => t.phoneCalls.length === 2);
        assert.deepEqual(t.phoneCalls.map(c => [c.url, c.body.message, c.body.delay]), [['https://ntfy.example', '喝水', undefined], ['https://ntfy.example', '泡面（定时提醒）', '600s']]);
        assert.equal(t.phoneCalls[0]!.body.topic, secrets.phone!.topic);
        t.service.control.take('<device:notify|都|一起>');
        await until(() => t.phoneCalls.length === 3);
        await until(() => readFileSync(join(t.dataDir, 'devices', 'audit.jsonl'), 'utf8').includes('电脑这一头还没配好'));
    });

    test('菜单：电脑没上线、手机配了就只列手机能做的；都没有就是空的', async () => {
        const t = await start();
        assert.match(t.service.control.menu(), /<device:ring>/);
        assert.doesNotMatch(t.service.control.menu(), /<device:(?:media|volume|lock|sleep|open_url|open_app)/, '电脑没上线：不列电脑上的动作');
        const none = await start({ secrets: { ...secrets, phone: undefined } });
        assert.equal(none.service.control.menu(), '');
        const agent = fakeAgent(none.base, () => ({ ok: true }));
        await until(() => none.service.hub.online());
        assert.match(none.service.control.menu(), /<device:media\|play_pause>/);
        agent.stop();
    });

    test('他发 /屏幕：截图 → 看图 → 变成他这一条消息交给她；图本身不留，描述里没有图', async () => {
        const described: string[] = [];
        const t = await start({ describe: { screen: { describe: async image => { described.push(`${image.url}|${image.dataUrl!.slice(0, 22)}`); return '他在写一份报告，屏幕上是文档软件'; } }, camera: { describe: async () => '' } } });
        const agent = fakeAgent(t.base, job => (job.action === 'capture_screen' ? { ok: true, mime: 'image/png', imageBase64: PNG } : { ok: false, error: '不会' }));
        await until(() => t.service.hub.online());
        const outcome = t.service.owner('/屏幕 你看这个报错');
        assert.equal(outcome.kind, 'capture');
        const handled = await (outcome as Extract<typeof outcome, { kind: 'capture' }>).run();
        assert.deepEqual(handled, { kind: 'message', text: '[他让你看了一眼他的电脑屏幕：他在写一份报告，屏幕上是文档软件] 你看这个报错' });
        assert.deepEqual(described, ['|data:image/png;base64,']);
        agent.stop();
    });

    test('看屏幕失败的几种：看图没开 → 说清楚且不留图；电脑没上线；隔得太近', async () => {
        const t = await start();
        const agent = fakeAgent(t.base, () => ({ ok: true, mime: 'image/png', imageBase64: PNG }));
        await until(() => t.service.hub.online());
        const noVision = await (t.service.owner('/屏幕') as Extract<ReturnType<DeviceService['owner']>, { kind: 'capture' }>).run();
        assert.deepEqual(noVision, { kind: 'reply', text: '（截到了，但看图没开，她看不了——图我也没留）' });
        const tooSoon = await (t.service.owner('/屏幕') as Extract<ReturnType<DeviceService['owner']>, { kind: 'capture' }>).run();
        assert.deepEqual(tooSoon, { kind: 'reply', text: '（隔得太近，稍等几秒）' });
        agent.stop();
        const offline = await start();
        assert.deepEqual(await (offline.service.owner('/摄像头') as Extract<ReturnType<DeviceService['owner']>, { kind: 'capture' }>).run(), { kind: 'reply', text: '（电脑这一头还没连上）' });
    });

    test('认证失败 5 次 → 设备控制熔断：之后所有动作都不发，直到人恢复', async () => {
        const t = await start();
        for (let i = 0; i < 5; i++) await fetch(`${t.base}/poll`, { headers: { Authorization: 'Bearer wrong' } });
        await until(() => Boolean(createBreaker({ dataDir: t.dataDir, platform: 'devices' }).state()));
        t.service.control.take('<device:notify|手机|x>');
        await new Promise(r => setTimeout(r, 100));
        assert.equal(t.phoneCalls.length, 0, '熔断后连手机也不发');
        assert.match(readFileSync(join(t.dataDir, 'devices', 'audit.jsonl'), 'utf8'), /设备控制熔断中/);
        createBreaker({ dataDir: t.dataDir, platform: 'devices' }).resume();
        t.service.control.take('<device:notify|手机|y>');
        await until(() => t.phoneCalls.length === 1);
    });

    test('端口被占：取件中心起不来，电脑先不用，手机照常，日志说清怎么办', async () => {
        const first = await start();
        const clash = await start({ secrets: { ...secrets, hub: { host: '127.0.0.1', port: first.service.hub.port() } } });
        assert.ok(clash.logs.some(l => l.includes('取件中心起不来')));
        clash.service.control.take('<device:notify|手机|z>');
        await until(() => clash.phoneCalls.length === 1);
    });
});

describe('回复路径：令牌不会发给他，而且只在真发送时登记（ADR 0148）', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend');
    const llm: BotConfig['llm'] = { baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {} };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };

    function setup() {
        const jobs: { action: string; params: unknown }[] = [];
        const control: DeviceControl = createDeviceControl({
            mode: 'on', context: { links: new Map(), apps: [], maxVolume: 60 },
            dispatch: async job => { jobs.push({ action: job.action, params: job.params }); return { ok: true }; },
            available: () => ['computer', 'phone'], say: () => undefined, log: () => undefined,
        });
        return { jobs, control };
    }

    test('开着：令牌从气泡里消失，动作被登记；菜单进了提示词', async () => {
        const { jobs, control } = setup();
        const dir = tmp();
        const prompts: string[] = [];
        const result = await runScenario(parseScenario({ name: 'devices', tier: 'boyfriend', user: '宝宝', start: '2026-10-25T20:00:00+08:00', memory: false, schedule: false, steps: [{ say: '我在加班' }] }), {
            runId: 'devices', dataDir: dir, card, llm, prompt, settle: { quietMs: 10, maxMs: 50 }, devices: control,
            generate: async messages => { prompts.push(messages.map(m => String(m.content)).join('\n')); return '辛苦啦\n<device:notify|电脑|记得喝水>'; },
        });
        await new Promise(r => setImmediate(r));
        assert.deepEqual(result.steps[0]!.bubbles.map(b => b.text), ['辛苦啦']);
        assert.deepEqual(jobs, [{ action: 'notify', target: undefined, params: { text: '记得喝水' } }].map(({ action, params }) => ({ action, params })));
        assert.ok(prompts[0]!.includes('你可以替他操作他的'), '菜单在提示词里');
    });

    test('没开设备控制：令牌照样摘掉，不会发给他，也不登记任何东西', async () => {
        const { jobs } = setup();
        const dir = tmp();
        const result = await runScenario(parseScenario({ name: 'devices off', tier: 'boyfriend', user: '宝宝', start: '2026-10-25T20:00:00+08:00', memory: false, schedule: false, steps: [{ say: '我在加班' }] }), {
            runId: 'devices-off', dataDir: dir, card, llm, prompt, settle: { quietMs: 10, maxMs: 50 },
            generate: async () => '辛苦啦\n<device:lock>',
        });
        await new Promise(r => setImmediate(r));
        assert.deepEqual(result.steps[0]!.bubbles.map(b => b.text), ['辛苦啦']);
        assert.equal(jobs.length, 0);
    });

    test('审计文件夹建在数据目录下（jsonl）', async () => {
        const t = await start();
        t.service.control.take('<device:notify|手机|x>');
        await until(() => existsSync(join(t.dataDir, 'devices', 'audit.jsonl')));
        assert.ok(existsSync(join(t.dataDir, 'devices', 'audit.jsonl')));
    });
});
