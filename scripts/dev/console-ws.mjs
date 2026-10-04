// 通过 Koishi 控制台的 WebSocket 读、存 qqbot 插件的配置：和表单保存发的是同一个请求（manager/reload）。
// 浏览器截不了图、或者要脚本化地改配置时用（docs/koishi.md「临时实例」）。只给临时实例用，不要拿它改真实例。
//
//   node scripts/dev/console-ws.mjs <端口> show               打印 qqbot 的配置和实例状态（2 = 运行中，3 = 失败）
//   node scripts/dev/console-ws.mjs <端口> save <配置.json>   用文件里的对象替换 qqbot 的配置并保存
//
// 管理员密码从环境变量 QQBOT_TEST_CONSOLE_PASSWORD 读（临时实例 koishi.yml 里 auth 一节写的那个）。

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, command, file] = process.argv.slice(2);
const password = process.env.QQBOT_TEST_CONSOLE_PASSWORD;
if (!port || !['show', 'save'].includes(command) || (command === 'save' && !file)) throw new Error('用法见文件开头');
if (!password) throw new Error('缺少环境变量 QQBOT_TEST_CONSOLE_PASSWORD');

const WebSocket = createRequire(new URL('../../package.json', import.meta.url))('ws');
const ws = new WebSocket(`ws://127.0.0.1:${port}/status`);
const data = {};
let nextId = 0;
const pending = new Map();
const call = (type, args) => new Promise((resolve, reject) => {
    const id = String(++nextId);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type, args, id }));
});
const sleep = ms => new Promise(done => setTimeout(done, ms));

ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'data') data[message.body.key] = message.body.value;
    else if (message.type === 'patch') data[message.body.key] = { ...data[message.body.key], ...message.body.value };
    else if (message.type === 'response') {
        const waiting = pending.get(message.body.id);
        if (!waiting) return;
        pending.delete(message.body.id);
        if (message.body.error) waiting.reject(new Error(JSON.stringify(message.body.error)));
        else waiting.resolve(message.body.value);
    }
});

ws.on('open', async () => {
    try {
        await call('login/password', ['admin', password]);
        // 登录后控制台推送 config（koishi.yml 的原文）和 packages（含各实例的状态）
        await sleep(1500);
        const key = Object.keys(data.config?.plugins ?? {}).find(k => k.startsWith('qqbot:'));
        if (!key) throw new Error('koishi.yml 里没有 qqbot 插件');
        if (command === 'show') {
            console.log(key, JSON.stringify(data.config.plugins[key], null, 2));
        } else {
            await call('manager/reload', ['', key, JSON.parse(readFileSync(file, 'utf8'))]);
            console.log('已保存', key);
            await sleep(2500);
        }
        const pkg = Object.values(data.packages ?? {}).find(p => p.name === 'koishi-plugin-qqbot');
        console.log('实例状态', JSON.stringify(pkg?.runtime?.forks ?? pkg?.forks));
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    } finally {
        ws.close();
    }
});
