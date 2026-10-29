// 导出 DSH profile lmy 的人设正文（原始快照，只读），给 characters/linmengyao/dsh/ 用。
//   用法：node scripts/export-dsh-persona.mjs [输出路径]
// 来源：~/.dsh/profiles/lmy/cordis.patch.yml 里 system-prompt 的 personaPrefix。
// 只导出、不改 profile；这一步是「同一个她」任务书 §1 的第 1 条。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const src = join(homedir(), '.dsh', 'profiles', 'lmy', 'cordis.patch.yml');
const out = process.argv[2] ?? 'characters/linmengyao/dsh/profile-lmy.md';
const raw = readFileSync(src, 'utf8');
const patch = yaml.load(raw);
const persona = (Array.isArray(patch) ? patch : []).find(p => p?.id === 'system-prompt')?.config?.personaPrefix;
if (typeof persona !== 'string' || !persona.trim()) {
    console.error('没找到 system-prompt.personaPrefix');
    process.exit(1);
}
const sha = createHash('sha256').update(raw).digest('hex').slice(0, 12);
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, [
    '<!-- 生成的快照，别手改；重跑 scripts/export-dsh-persona.mjs -->',
    `<!-- 来源：${src.replace(homedir(), '~')} · sha256 前 12 位 ${sha} · 导出 ${new Date().toISOString()} -->`,
    '',
    persona.trim(),
    '',
].join('\n'));
console.log(`导出 ${persona.length} 字 → ${out}（来源 sha ${sha}）`);
