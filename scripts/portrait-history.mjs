// 看她的「我现在的样子」现在写着什么、以前每一版是什么、每次为什么改（ADR 0340）。只读，不改任何东西。
// 她说「写歪了你得跟我说」：这个工具让人看得到她每一版的变化，看到写歪了在聊天里跟她说（不加指令）。
//
// 用法：node scripts/portrait-history.mjs <数据目录> [--last N]
//   数据目录是 Koishi 配置里的 dataDir（线上是 runtime/bot-shadow）；--last 只看最近 N 版（默认全部）。

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const day = at => { const d = new Date(at); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '?'; };

/** 读现在这份和历史；文件不在就当没有 */
export function readPortrait(dataDir) {
    let current;
    try { current = JSON.parse(readFileSync(join(dataDir, 'self-portrait.json'), 'utf8')); } catch { current = undefined; }
    let history = [];
    try {
        history = readFileSync(join(dataDir, 'self-portrait.history.jsonl'), 'utf8').split('\n').filter(line => line.trim()).flatMap(line => {
            try { return [JSON.parse(line)]; } catch { return []; }
        });
    } catch { /* 还没有 */ }
    return { current, history };
}

/** 按句子比两版：哪些句子是新的、哪些不见了（粗略，够人看） */
export function sentenceDiff(before, after) {
    const split = text => String(text ?? '').split(/(?<=[。！？!?；;\n])/).map(part => part.trim()).filter(Boolean);
    const a = split(before);
    const b = split(after);
    return { added: b.filter(line => !a.includes(line)), removed: a.filter(line => !b.includes(line)) };
}

/** 整份说明：从第一版到现在，每一版的日期、为什么改、加了什么、去掉了什么 */
export function describe({ current, history }, last = Infinity) {
    if (!current?.text) return '她还没写过「我现在的样子」（开关 selfPortrait 开着、名单里有男朋友档，夜里 22 点以后才会想）。';
    const versions = [...history.map(item => ({ text: item.text, at: item.at, version: item.version })), { text: current.text, at: current.at, version: current.version }];
    // history 里每一行的 why 是「换掉这一行那一版」的原因，也就是下一版为什么改；最新一版的原因也在 current.why
    const reasonOf = index => (index === 0 ? '' : history[index - 1]?.why || (index === versions.length - 1 ? current.why ?? '' : ''));
    const lines = [];
    const from = Math.max(0, versions.length - last);
    for (let i = from; i < versions.length; i++) {
        const v = versions[i];
        const reason = reasonOf(i);
        lines.push(`── 第 ${v.version} 版（${day(v.at)}）${reason ? `：${reason}` : ''}`);
        if (i === 0 || i === from) lines.push(v.text);
        else {
            const diff = sentenceDiff(versions[i - 1].text, v.text);
            for (const line of diff.removed) lines.push(`  - ${line}`);
            for (const line of diff.added) lines.push(`  + ${line}`);
            if (!diff.added.length && !diff.removed.length) lines.push('  （只改了标点或换行）');
        }
    }
    if (current.rejected?.reason) lines.push(`\n上次想改、没成（${day(current.rejected.at)}）：${current.rejected.reason}`);
    lines.push(`\n现在这份（第 ${current.version} 版）：\n${current.text}`);
    return lines.join('\n');
}

function main() {
    const args = process.argv.slice(2);
    const i = args.indexOf('--last');
    const last = i >= 0 ? Number(args.splice(i, 2)[1]) : Infinity;
    if (args.length !== 1 || !(last > 0)) {
        console.error('用法：node scripts/portrait-history.mjs <数据目录> [--last N]');
        process.exit(2);
    }
    console.log(describe(readPortrait(resolve(args[0])), last));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
