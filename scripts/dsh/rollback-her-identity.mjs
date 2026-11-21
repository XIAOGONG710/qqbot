// 回滚：把她身份那三段从 profile 补丁里退回到改动前那份备份。
// 用法：node scripts/dsh/rollback-her-identity.mjs [--profile desktop] [--profile-dir <dir>] [--backup <file>]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const profileDir = opt('profile-dir', path.join(os.homedir(), '.dsh', 'profiles', opt('profile', 'desktop')));
const patchPath = path.join(profileDir, 'cordis.patch.yml');
const backups = fs
  .readdirSync(profileDir)
  .filter((n) => n.startsWith('cordis.patch.yml.bak-'))
  .map((n) => ({ name: n, at: fs.statSync(path.join(profileDir, n)).mtimeMs }))
  .sort((a, b) => b.at - a.at);

const wanted = opt('backup', 'cordis.patch.yml.bak-2026-11-21-identity4');
const picked = backups.find((b) => b.name === wanted) ?? backups[0];
if (!picked) throw new Error(`没有找到备份：${path.join(profileDir, 'cordis.patch.yml.bak-*')}`);

const from = path.join(profileDir, picked.name);
const content = fs.readFileSync(from, 'utf8');
fs.writeFileSync(`${patchPath}.tmp`, content, 'utf8');
fs.renameSync(`${patchPath}.tmp`, patchPath);

console.log(`已回滚到 ${picked.name}（${[...content].length} 字）`);
console.log('接着把 DeepSeek Harness 整个退出重开，新会话才会按回滚后的组合创建。');
