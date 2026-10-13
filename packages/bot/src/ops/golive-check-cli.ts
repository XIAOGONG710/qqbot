// node src/ops/golive-check-cli.ts [--live <线上目录>] [--target origin/main] [--fetch] [--cards-ok]
// 只读：不切分支、不改文件、不重启。把「快进线上目录之前该看的」一次列出来。退出码 1 = 有挡路的。
import { execFileSync, spawnSync } from 'node:child_process';
import { classifyChanges, goLiveReport } from './golive-check.ts';
import { exposedListeners, LISTENERS_POWERSHELL, parseListeners } from './listeners.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const at = args.indexOf(name); return at >= 0 && args[at + 1] ? args[at + 1]! : fallback; };
const live = option('--live', process.cwd());
const target = option('--target', 'origin/main');
const git = (...rest: string[]) => execFileSync('git', ['-C', live, ...rest], { encoding: 'utf8' }).trim();

if (args.includes('--fetch')) git('fetch', 'origin');
const liveHead = git('rev-parse', '--short', 'HEAD');
const targetHead = git('rev-parse', '--short', target);
const files = git('diff', '--name-only', 'HEAD', target).split('\n').filter(Boolean);
const commits = git('log', '--oneline', `HEAD..${target}`).split('\n').filter(Boolean);
const dirty = git('status', '--porcelain').length > 0;
const shell = spawnSync('powershell', ['-NoProfile', '-Command', LISTENERS_POWERSHELL], { encoding: 'utf8' });
const exposed = shell.status === 0 ? exposedListeners(parseListeners(shell.stdout)) : [];
const report = goLiveReport({ liveHead, targetHead, dirty, commits, changes: classifyChanges(files), exposed }, { cardsApproved: args.includes('--cards-ok') });

console.log(`线上目录 ${live}`);
for (const commit of commits.slice(0, 30)) console.log(`  ${commit}`);
if (commits.length > 30) console.log(`  ……还有 ${commits.length - 30} 个`);
for (const note of report.notes) console.log(`· ${note}`);
if (shell.status !== 0) console.log('· 监听检查没跑成（不是 Windows 或没有 PowerShell）');
for (const blocker of report.blockers) console.log(`✖ ${blocker}`);
console.log('上线前要答的：');
for (const ask of report.asks) console.log(`  □ ${ask}`);
console.log(report.blockers.length ? '结论：有挡路的，先处理' : '结论：没有机器能查出来的挡路项（上面三个问题仍要人答）');
process.exit(report.blockers.length ? 1 : 0);
