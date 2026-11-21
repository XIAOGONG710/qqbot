// 体检：profile 补丁里她的身份三段是否在位、文案是否和 scripts/dsh/her-identity.txt 一致。
// 用法：node scripts/dsh/check-her-identity.mjs [--profile desktop] [--profile-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repoRoot = path.resolve(here, '..', '..');
const profileDir = opt('profile-dir', path.join(os.homedir(), '.dsh', 'profiles', opt('profile', 'desktop')));
const patchPath = path.join(profileDir, 'cordis.patch.yml');
const src = fs.readFileSync(patchPath, 'utf8');
const lines = src.split('\n');

const report = [];
const has = (re) => lines.some((l) => re.test(l));

report.push(['agent-preset-registry 默认座位', has(/^- id: agent-preset-registry\s*$/) && /default:\s*cordis/.test(src)]);
report.push(['system-prompt 关掉 harness 身份', has(/^- id: system-prompt\s*$/) && /includeHarnessIdentity:\s*false/.test(src)]);
report.push(['preset-cordis 整表覆盖', has(/^- id: preset-cordis\s*$/)]);
report.push(['tool-cordis 行在位', /id:\s*tool-cordis/.test(src)]);
report.push(['tool-pwsh 行在位', /id:\s*tool-pwsh/.test(src)]);
report.push(['tool-plugin-manager 行在位', /id:\s*tool-plugin-manager/.test(src)]);

const text = fs.readFileSync(path.join(repoRoot, 'scripts', 'dsh', 'her-identity.txt'), 'utf8').trim();
const firstLine = text.split('\n')[0].trim();
report.push(['persona 文案与 her-identity.txt 一致', src.includes(firstLine) && src.includes(text.split('\n')[2]?.trim() ?? firstLine)]);

let bad = 0;
for (const [name, ok] of report) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项不对`);
process.exit(bad === 0 ? 0 : 1);
