// 实时看她这一轮真正发给模型的完整提示词（2026-10-31 用户：「要最详细的后台」）
// 数据来源：runtime/bot-shadow/last-prompt.json（只在 QQBOT_SENSITIVE_LOGS 开着时写）。
//   node scripts/watch-prompt.mjs
// 每秒看一次文件，变了就整屏重画；q 退出。
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd();
const file = join(repo, 'runtime', 'bot-shadow', 'last-prompt.json');
let last = 0;
let seen = 0;

const clear = () => process.stdout.write('\x1b[2J\x1b[H');
const dim = (text) => `\x1b[90m${text}\x1b[0m`;
const bold = (text) => `\x1b[1m${text}\x1b[0m`;
const roleColor = { system: '\x1b[36m', user: '\x1b[33m', assistant: '\x1b[32m' };

function draw() {
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch {
        clear();
        console.log('还没有 last-prompt.json。');
        console.log(dim('要先开着敏感调试：QQBOT_SENSITIVE_LOGS=30m 重启，提示词才会落盘。'));
        return;
    }
    const prompt = JSON.parse(raw);
    clear();
    console.log(bold(`她的完整提示词 · ${new Date().toISOString().slice(11, 19)} · 共 ${prompt.messages?.length ?? 0} 条消息`));
    if (prompt.note) console.log(dim(prompt.note));
    console.log(dim('─'.repeat(100)));
    (prompt.messages ?? []).forEach((message, index) => {
        const color = roleColor[message.role] ?? '';
        console.log(`${color}${bold(`#${index + 1} ${message.role}`)}\x1b[0m ${dim(`(${[...(message.content ?? '')].length} 字)`)}`);
        console.log(message.content);
        console.log(dim('·'.repeat(60)));
    });
}

setInterval(() => {
    try {
        const mtime = statSync(file).mtimeMs;
        if (mtime === last) return;
        last = mtime;
        draw();
    } catch { /* 文件还没出现 */ }
}, 1000);

draw();
process.stdin.setRawMode?.(true);
process.stdin.on('data', (key) => { if (String(key) === 'q') process.exit(0); });
console.log(dim('\n（按 q 退出）'));
