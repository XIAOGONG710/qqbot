// 把她的桌面身份写进 profile 补丁里 preset-cordis 的 persona.prefix。
// 文字来源（ADR 0353）：角色卡上的 voice.desktopIdentity（persona.yml voice.desktop_identity）；卡上没写就用 scripts/dsh/her-identity.txt（改造前的来源）。
// 只改这一处文本；插件表、system-prompt 行、默认座位都不动（见 docs/adr/0346）。
// 用法：node scripts/dsh/apply-her-prefix.mjs [--profile <profileId>] [--profile-dir <dir>] [--card <卡>]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const { cardDesktopIdentity } = createRequire(import.meta.url)('../../dsh-plugins/dsh-linmengyao-preset/her-prefix.cjs');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repoRoot = path.resolve(here, '..', '..');
const profileId = opt('profile', 'desktop');
const profileDir = opt('profile-dir', path.join(os.homedir(), '.dsh', 'profiles', profileId));
const patchPath = path.join(profileDir, 'cordis.patch.yml');
const textPath = path.join(repoRoot, 'scripts', 'dsh', 'her-identity.txt');

const fromCard = cardDesktopIdentity(opt('card', undefined));
const text = (fromCard ?? fs.readFileSync(textPath, 'utf8')).replace(/\r\n/g, '\n').replace(/\s+$/, '');
const src = fs.readFileSync(patchPath, 'utf8');
const lines = src.split('\n');

// 找到 preset-cordis 段，再找它里面的 persona.prefix 块。
const start = lines.findIndex((l) => /^- id: preset-cordis\s*$/.test(l));
if (start < 0) throw new Error('preset-cordis 段不存在，先按 docs/adr/0346 从 asar 抄一份整表覆盖');
const prefixAt = lines.findIndex((l, i) => i > start && /^\s*prefix: \|-?\s*$/.test(l));
if (prefixAt < 0) throw new Error('preset-cordis 里没有 persona.prefix 块');

const indent = (lines[prefixAt].match(/^\s*/) || [''])[0] + '  ';
let end = prefixAt + 1;
while (end < lines.length) {
  const l = lines[end];
  if (l.trim() === '') { end += 1; continue; }
  if (l.startsWith(indent)) { end += 1; continue; }
  break;
}

const block = text.split('\n').map((l) => (l === '' ? '' : indent + l));
const next = [...lines.slice(0, prefixAt + 1), ...block, ...lines.slice(end)];

const backup = `${patchPath}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
fs.copyFileSync(patchPath, backup);
fs.writeFileSync(`${patchPath}.tmp`, next.join('\n'), 'utf8');
fs.renameSync(`${patchPath}.tmp`, patchPath);

console.log(`已写入 ${patchPath}`);
console.log(`备份 ${backup}`);
console.log(`来源 ${fromCard === undefined ? textPath : '角色卡 voice.desktopIdentity'}`);
console.log(`prefix 行数 ${text.split('\n').length}，字数 ${[...text].length}`);
