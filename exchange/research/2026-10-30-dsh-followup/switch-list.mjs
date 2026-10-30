// 只读：把 koishi.yml 里所有「开关」列出来（键名 + 值），**只输出值是 true/false/on/off/dryRun/log/fix/explicit 这类的行**，
// 字符串、数字、密钥、路径、QQ 号一概不会被打出来。用法：node switch-list.mjs <koishi.yml>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('用法：node switch-list.mjs <koishi.yml>'); process.exit(1); }
const SAFE = /^\s*([A-Za-z][A-Za-z0-9_]*):\s*(true|false|on|off|dryRun|log|fix|explicit|auto|always|never)\s*(?:#.*)?$/;
const found = new Map();
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = SAFE.exec(line);
    if (m) found.set(m[1], m[2]);
}
const keys = [...found.keys()].sort();
console.log(`开关 ${keys.length} 个：`);
for (const key of keys) console.log(`${key}: ${found.get(key)}`);
