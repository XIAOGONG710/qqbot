// 试发一条语音：走 NapCat 的 WS（和机器人同一条路），用来确认「file:// 本地 wav → QQ 语音条」能通。
// 用法：node scripts/test-voice-send.mjs <wav路径> [QQ号]
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const wav = process.argv[2];
const qq = Number(process.argv[3] ?? process.env.QQBOT_OWNER_QQ);
if (!wav || !Number.isSafeInteger(qq) || qq <= 0) {
    console.error('用法：node scripts/test-voice-send.mjs <wav> [QQ号]（不给 QQ 号时读环境变量 QQBOT_OWNER_QQ）');
    process.exit(2);
}
const token = process.env.QQBOT_ONEBOT_TOKEN
    ?? (() => { try { return JSON.parse(readFileSync('runtime/bot-shadow/config.json', 'utf8')).onebotToken; } catch { return ''; } })();
const headers = token ? { Authorization: `Bearer ${token}` } : {};
const ws = new WebSocket('ws://127.0.0.1:3001', { headers });
const echo = `voice-${Date.now()}`;
const timer = setTimeout(() => { console.error('超时：30 秒没有回音'); process.exit(1); }, 30_000);

ws.on('open', () => {
    ws.send(JSON.stringify({
        action: 'send_private_msg',
        params: {
            user_id: qq,
            message: [{ type: 'record', data: { file: `file:///${wav.split('\\').join('/')}` } }],
        },
        echo,
    }));
});
ws.on('message', raw => {
    const data = JSON.parse(String(raw));
    if (data.echo !== echo) return;
    clearTimeout(timer);
    console.log(JSON.stringify(data));
    ws.close();
    process.exit(data.retcode === 0 ? 0 : 1);
});
ws.on('error', error => { console.error('连接失败：', error.message); process.exit(1); });
