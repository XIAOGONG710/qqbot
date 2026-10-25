import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { dispatchNetworkAlert, networkDownHelperText, networkDownText, networkUpHelperText, networkUpText, readAlertConfig, sendAlert, type AlertConfig, type AlertResult, type SocketLike } from '../src/ops/alert-qq.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const file = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-alert-'));
    dirs.push(dir);
    const path = join(dir, 'alert.json');
    writeFileSync(path, content);
    return path;
};

/** 假的 NapCat：连上就开，记下发的东西，按脚本回 */
function fakeSocket(script: (sent: string, socket: FakeSocket) => void) {
    return class FakeSocket implements SocketLike {
        sent: string[] = [];
        url: string;
        headers: Record<string, string>;
        closed = false;
        #listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
        constructor(url: string, headers: Record<string, string>) {
            this.url = url;
            this.headers = headers;
            queueMicrotask(() => this.emit('open'));
        }
        addEventListener(type: string, listener: (event: { data?: unknown }) => void) { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]); }
        emit(type: string, data?: unknown) { for (const l of this.#listeners.get(type) ?? []) l({ data }); }
        send(data: string) { this.sent.push(data); script(data, this); }
        close() { this.closed = true; }
    };
}
type FakeSocket = InstanceType<ReturnType<typeof fakeSocket>>;

describe('告警发到 QQ（alert-qq）', () => {
    test('配置：没有、坏了、没开、qq 不对都当没有；开了默认外网也发', () => {
        assert.equal(readAlertConfig('Z:/没有这个文件.json'), undefined);
        assert.equal(readAlertConfig(file('不是 json')), undefined);
        assert.equal(readAlertConfig(file('{"qq": 12345}')), undefined);
        assert.equal(readAlertConfig(file('{"enabled": false, "qq": 12345}')), undefined);
        assert.equal(readAlertConfig(file('{"enabled": true, "qq": "12345"}')), undefined);
        assert.equal(readAlertConfig(file('{"enabled": true, "qq": -1}')), undefined);
        assert.deepEqual(readAlertConfig(file('{"enabled": true, "qq": 12345}')), { qq: 12345, network: true, helpers: [] });
        assert.deepEqual(readAlertConfig(file('{"enabled": true, "qq": 12345, "network": false}')), { qq: 12345, network: false, helpers: [] });
    });

    test('配置：helpers 是断网时也要通知的人——去重、去掉自己和不是正整数的、最多 3 个；不是数组当没有', () => {
        assert.deepEqual(readAlertConfig(file('{"enabled": true, "qq": 12345, "helpers": [777, 777, 12345, "888", -1, 1.5, 999]}'))?.helpers, [777, 999]);
        assert.deepEqual(readAlertConfig(file('{"enabled": true, "qq": 12345, "helpers": [1, 2, 3, 4, 5]}'))?.helpers, [1, 2, 3]);
        assert.deepEqual(readAlertConfig(file('{"enabled": true, "qq": 12345, "helpers": 777}'))?.helpers, []);
    });

    test('断网发给谁：先用户，再 helpers；各自独立，一个失败不影响另一个；helpers 的文字更短、不带她的聊天细节', async () => {
        const config: AlertConfig = { qq: 1, network: true, helpers: [2, 3] };
        const sent: { qq: number; text: string }[] = [];
        const send = async (qq: number, text: string): Promise<AlertResult> => {
            sent.push({ qq, text });
            if (qq === 2) return { ok: false, reason: '不是好友' };
            if (qq === 3 && text.includes('恢复')) throw new Error('炸了');
            return { ok: true, messageId: 1 };
        };
        const down = await dispatchNetworkAlert(config, 'down', 12, 'api.deepseek.com', send);
        assert.deepEqual(down, [{ to: 'user', ok: true }, { to: 'helper', ok: false, reason: '不是好友' }, { to: 'helper', ok: true }]);
        assert.deepEqual(sent.map(m => m.qq), [1, 2, 3]);
        assert.equal(sent[0]!.text, networkDownText(12, 'api.deepseek.com'));
        assert.equal(sent[1]!.text, networkDownHelperText(12, 'api.deepseek.com'));
        sent.length = 0;
        const up = await dispatchNetworkAlert(config, 'up', 40, 'api.deepseek.com', send);
        assert.deepEqual(up.map(d => [d.to, d.ok]), [['user', true], ['helper', false], ['helper', false]]);
        assert.equal(up[2]!.reason, '炸了');
        assert.equal(sent[2]!.text, networkUpHelperText(40));
        assert.deepEqual(await dispatchNetworkAlert({ ...config, network: false }, 'down', 12, 'h', send), [], '没开外网提醒什么都不发');
        assert.equal(sent.length, 3);
    });

    test('给 helpers 的文字：简短、一眼看得出是运维提醒、说清楚该看什么；不夸大、不写她的聊天', () => {
        const down = networkDownHelperText(12, 'api.deepseek.com');
        const up = networkUpHelperText(40);
        for (const text of [down, up]) { assert.match(text, /^【运维提醒】/); assert.ok([...text].length <= 80, text); }
        assert.match(down, /12 分钟连不上外网（解析不了 api\.deepseek\.com）/);
        assert.match(down, /宿主机或虚拟机网络/);
        assert.match(up, /不用再看了/);
        assert.doesNotMatch(down + up, /主动消息|男朋友|聊天/);
    });

    test('发一条：连上就发 send_private_msg，只发文字、带 token、等回执、发完断开', async () => {
        let socket: FakeSocket | undefined;
        const Fake = fakeSocket((sent, s) => {
            const call = JSON.parse(sent);
            s.emit('message', JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' })); // 别的事件：忽略
            s.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 4242 }, echo: call.echo }));
        });
        const result = await sendAlert({ url: 'ws://127.0.0.1:3001/', token: 'T', qq: 12345, text: '【运维提醒】测试', open: (url, headers) => (socket = new Fake(url, headers)) });
        assert.deepEqual(result, { ok: true, messageId: 4242 });
        assert.equal(socket!.headers.Authorization, 'Bearer T');
        const call = JSON.parse(socket!.sent[0]!);
        assert.equal(call.action, 'send_private_msg');
        assert.deepEqual(call.params, { user_id: 12345, message: [{ type: 'text', data: { text: '【运维提醒】测试' } }] });
        assert.equal(socket!.closed, true);
    });

    test('NapCat 报错、连接断了、没回应、连不上：都返回原因，不抛', async () => {
        const reject = fakeSocket((sent, s) => s.emit('message', JSON.stringify({ status: 'failed', retcode: 1200, wording: '不是好友', echo: JSON.parse(sent).echo })));
        const r1 = await sendAlert({ url: 'ws://x', qq: 1, text: 'a', open: (u, h) => new reject(u, h) });
        assert.equal(r1.ok, false);
        assert.match((r1 as { reason: string }).reason, /1200.*不是好友/);

        const drop = fakeSocket((_sent, s) => s.emit('close'));
        const r2 = await sendAlert({ url: 'ws://x', qq: 1, text: 'a', open: (u, h) => new drop(u, h) });
        assert.match((r2 as { reason: string }).reason, /断了/);

        const silent = fakeSocket(() => undefined);
        const r3 = await sendAlert({ url: 'ws://x', qq: 1, text: 'a', timeoutMs: 30, open: (u, h) => new silent(u, h) });
        assert.match((r3 as { reason: string }).reason, /时限/);

        const r4 = await sendAlert({ url: 'ws://x', qq: 1, text: 'a', open: () => { throw new Error('ECONNREFUSED'); } });
        assert.match((r4 as { reason: string }).reason, /ECONNREFUSED/);
    });

    test('文字：一眼看得出不是她在说话，只写事实，不夸大', () => {
        const down = networkDownText(10, 'api.deepseek.com');
        const up = networkUpText(37);
        for (const text of [down, up]) assert.match(text, /^【运维提醒】/);
        assert.match(down, /10 分钟解析不了 api\.deepseek\.com/);
        assert.match(up, /37 分钟/);
    });
});
