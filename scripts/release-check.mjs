import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const manifest = JSON.parse(read('release/manifest.json'));
const problems = [];
if (manifest.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.version)) problems.push('发布清单版本不合法');
if (manifest.protocol !== 1) problems.push('手机协议版本与当前实现不一致');
if (manifest.minimumNode !== 24) problems.push('Node 最低版本与 package.json 不一致');
const android = read('packages/mobile-companion-android/app/build.gradle.kts');
if (!android.includes(`versionName = "${manifest.version}"`)) problems.push('Android versionName 与发布清单不一致');
if (!android.includes(`versionCode = ${manifest.androidVersionCode}`)) problems.push('Android versionCode 与发布清单不一致');
for (const required of ['docs/operations/first-start.md', 'docs/operations/upgrade.md', 'docs/operations/rollback.md', `docs/release/${manifest.version}.md`]) {
    try { read(required); } catch { problems.push(`缺少发布文档：${required}`); }
}
const diff = spawnSync('git', ['diff', '--check'], { cwd: root, encoding: 'utf8' });
if (diff.status !== 0) problems.push('git diff --check 未通过');
const report = { passed: problems.length === 0, version: manifest.version, protocol: manifest.protocol, backupRequired: manifest.requiresBackup, problems };
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
