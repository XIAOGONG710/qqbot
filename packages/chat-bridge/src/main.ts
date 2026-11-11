// 她自己的聊天软件的服务端（ADR 0337）：一个 OneBot 中继，站在 Koishi 和 NapCat 中间，同时接手机 App。
//
//   npm start --workspace @qqbot/chat-bridge              起中继
//   npm start --workspace @qqbot/chat-bridge -- --pair    起中继，同时打印一个配对码
//
// 配置见 docs/chat-app.md。日志只有「连上 / 断开 / 收到一条 / 发出一条」，没有凭据、配对码和聊天内容。
import { loadConfig } from './config.ts';
import { startRelay } from './relay.ts';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

let config;
try { config = loadConfig(); }
catch (error) {
    console.error(`中继没有启动：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

const token = process.env.QQBOT_ONEBOT_TOKEN?.trim() || undefined;
const relay = await startRelay({ config, log, ...(token ? { token } : {}) });

log(`中继起来了：Koishi 连 ws://127.0.0.1:${relay.onebotPort}，手机连 http://${config.host}:${relay.appPort}`);
log(`上游：${config.upstreamUrl ? '已配置，连不上会一直重试' : '没有配置（她的话都发到 App）'}；投递规则 ${config.delivery}；${token ? '已启用 token' : '没有设 QQBOT_ONEBOT_TOKEN'}`);
if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    log(`注意：手机端口监听在 ${config.host}，不只是本机。确认这个地址只在私有网络（Tailscale / WireGuard）里可达`);
}

if (process.argv.includes('--pair')) {
    // 配对码只在这里打印一次，不走日志函数
    console.log(`\n配对码：${relay.devices.startPairing()}（10 分钟内有效，只能用一次）\n`);
}

let stopping = false;
const stop = () => {
    if (stopping) return;
    stopping = true;
    log('正在停下');
    relay.stop().then(() => process.exit(0), () => process.exit(1));
    // 收尾卡住也要退
    setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
