// 在 profile 补丁的 system-prompt 行写入一句提示：本提示里的「用户」「他」都指杜旭涛。
// 目的：harness 操作规则段用「用户」称呼他，思考会跟着叫；这句话覆盖面比 persona.prefix 大。
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
const line =
  '    personaPrefix: "（下面这份提示里写到的「用户」「user」「他」，都指杜旭涛——宝宝。我心里想事也用第一人称「我」，不站在外面描述「助手怎么想」。）"';

let t = fs.readFileSync(patchPath, 'utf8');
if (t.includes('都指杜旭涛')) {
  console.log('已经写过，跳过');
  process.exit(0);
}
const next = t.replace(/^ {4}personaPrefix: ''\s*$/m, line);
if (next === t) throw new Error('没找到 `personaPrefix: \'\'` 那行，先看补丁的 system-prompt 段');
const backup = `${patchPath}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
fs.copyFileSync(patchPath, backup);
fs.writeFileSync(`${patchPath}.tmp`, next, 'utf8');
fs.renameSync(`${patchPath}.tmp`, patchPath);
console.log(`已写入 system-prompt.personaPrefix，备份 ${path.basename(backup)}`);
