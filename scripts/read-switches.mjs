// 导出线上 Koishi 的开关快照（打码），给 exchange/config/koishi.redacted.yml 用。
// 旧的 exchange/tools/read-switches.cjs 写死了 C:\Users\XG\Desktop\Project\qqbot 的 js-yaml，跑不起来；
// 这里用仓库自己装的 js-yaml，只读 runtime/koishi/koishi.yml。
//   用法：node scripts/read-switches.mjs [输出路径]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const src = 'runtime/koishi/koishi.yml';
const out = process.argv[2] ?? 'exchange/config/koishi.redacted.yml';
const config = yaml.load(readFileSync(src, 'utf8'));
const SECRET = /pass|token|key|secret|cookie|auth/i;

const redact = (value, key = '') => {
    if (Array.isArray(value)) return value.map(v => redact(v, key));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? '<REDACTED>' : redact(v, k);
        return out;
    }
    return SECRET.test(key) ? '<REDACTED>' : value;
};

const qqbot = Object.values(config.plugins ?? {}).find(p => p && typeof p === 'object' && 'contacts' in p) ?? {};
const switches = Object.entries(qqbot).filter(([, v]) => v === true).map(([k]) => k).sort();
const body = [
    '# 线上 Koishi 开关快照（由 scripts/read-switches.mjs 生成，密钥已打码；文件头别手改）',
    `# 源：runtime/koishi/koishi.yml · 导出时间：${new Date().toISOString()}`,
    '',
    yaml.dump(redact(config), { lineWidth: 200, noRefs: true }),
    '# 开着的开关：' + switches.join(', '),
].join('\n');
writeFileSync(out, body);
console.log(`写了 ${out}；开着 ${switches.length} 个开关`);
console.log(switches.join(' '));
