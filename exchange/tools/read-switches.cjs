// Read-only: print the qqbot plugin switches from the LIVE koishi.yml. Secret-looking keys are masked; long strings/arrays/objects are summarized.
const fs = require('fs');
const path = require('path');
const live = 'C:/Users/XG/Desktop/Project/qqbot';
const yaml = require(path.join(live, 'node_modules', 'js-yaml'));
const file = path.join(live, 'runtime/koishi/koishi.yml');
const doc = yaml.load(fs.readFileSync(file, 'utf8'));
const SECRET = /key|token|secret|password|cookie|passwd|auth|qq$|uin|account$/i;
const plugins = doc.plugins || {};
const name = Object.keys(plugins).find(k => k.includes('qqbot'));
console.log('plugin block:', name, '| modified:', fs.statSync(file).mtime.toISOString());
const cfg = plugins[name] || {};
const rows = [];
for (const [k, v] of Object.entries(cfg)) {
    let shown;
    if (SECRET.test(k)) shown = '〈已打码〉';
    else if (typeof v === 'boolean' || typeof v === 'number') shown = String(v);
    else if (typeof v === 'string') shown = v.length <= 24 ? v : `〈字符串 ${v.length} 字〉`;
    else if (Array.isArray(v)) shown = `〈数组 ${v.length} 项〉`;
    else if (v && typeof v === 'object') shown = `〈对象，键：${Object.keys(v).join(',').slice(0, 60)}〉`;
    else shown = String(v);
    rows.push(`${k}: ${shown}`);
}
console.log(rows.join('\n'));
console.log('--- other top-level plugins:', Object.keys(plugins).filter(k => k !== name).map(k => k.split(':')[0]).join(', '));
