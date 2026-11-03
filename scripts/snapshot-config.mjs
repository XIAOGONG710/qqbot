// 生成一份脱敏的 koishi.yml 快照（开关状态要给 Claude 看，密钥不能进仓库）
const fs = require('node:fs');

const source = 'runtime/koishi/koishi.yml';
const target = 'exchange/live/koishi-2026-11-02-1955.yaml';

let text = fs.readFileSync(source, 'utf8');
text = text.replace(/(apiKey|token|password|accessToken|api_key|secret)\s*:\s*\S+/gi, (all, key) => `${key}: <已脱敏>`);
fs.mkdirSync('exchange/live', { recursive: true });
fs.writeFileSync(target, text);
const left = /(sk-[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9]{10,})/.test(text);
console.log(`写好 ${target}；还有没脱敏的密钥吗：${left ? '有！' : '没有'}`);
