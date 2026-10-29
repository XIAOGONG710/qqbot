// 变异检验：把每处改动撤掉，对应的测试必须变红；每次都还原。用法：node mutate.mjs <bot 包目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const SRC = 'src/language/speech-notes.ts';
const UNIT = 'test/speech-notes.test.ts';
const APP = 'test/app.test.ts';
const mutations = [
    ['夜里窗口：22 点前也想', SRC, 'if (hour < REFLECT_FROM_HOUR && hour >= REFLECT_UNTIL_HOUR) return false;', 'if (false) return false;', UNIT],
    ['夜里窗口：凌晨不想', SRC, 'if (hour < REFLECT_FROM_HOUR && hour >= REFLECT_UNTIL_HOUR) return false;', 'if (hour < REFLECT_FROM_HOUR) return false;', UNIT],
    ['不查他的话（连续 6 字）', SRC, 'if (sharedRun(flat, guard.his) || quotedSpan(flat, guard.his)) return', 'if (quotedSpan(flat, guard.his)) return', UNIT],
    ['不查他的话（引号里）', SRC, 'if (sharedRun(flat, guard.his) || quotedSpan(flat, guard.his)) return', 'if (sharedRun(flat, guard.his)) return', UNIT],
    ['不查语料原话（连续 6 字）', SRC, 'if (sharedRun(flat, corpusLines) || quotedSpan(flat, corpusLines)) return', 'if (quotedSpan(flat, corpusLines)) return', UNIT],
    ['不查语料原话（引号里）', SRC, 'if (sharedRun(flat, corpusLines) || quotedSpan(flat, corpusLines)) return', 'if (sharedRun(flat, corpusLines)) return', UNIT],
    ['底线绊线失效', SRC, 'for (const floor of FLOORS) if (floor.pattern.test(flat)) return floor.reason;', '', UNIT],
    ['不查太像', SRC, 'if (clash) return', 'if (false) return', UNIT],
    ['不限条数', SRC, "if (state.notes.length >= MAX_ACTIVE) return", "if (false) return", UNIT],
    ['一晚不限放下', SRC, 'if (retired >= MAX_RETIRE) {', 'if (false) {', UNIT],
    ['一晚不限加', SRC, 'if (added >= MAX_ADD) {', 'if (false) {', UNIT],
    ['放下不要理由', SRC, 'if (len(item.why) < 2) {', 'if (false) {', UNIT],
    ['先加再放下（顺序反了）', SRC, '    let retired = 0;\n    for (const item of decision.retire) {', '    let retired = 0;\n    for (const item of []) {', UNIT],
    ['运维行算她说话', SRC, 'if (NOT_SPEECH.test(message.content)) continue;\n        if (!current)', 'if (!current)', UNIT],
    ['成功不记时间', SRC, '        fresh.lastReflectionAt = now;\n', '', UNIT],
    ['失败也记成功', SRC, "        deps.log(`说话习惯：今晚没想成", "        { const s = loadNotesState(deps.dataDir); s.lastReflectionAt = now; saveNotesState(deps.dataDir, s); }\n        deps.log(`说话习惯：今晚没想成", UNIT],
    ['说话太少也想', SRC, 'if (!mine || mine.bubbles < MIN_BUBBLES) return { ran: false };', 'if (!mine) return { ran: false };', UNIT],
    ['排序不看重叠', SRC, '.sort((a, b) => b.score - a.score || b.note.at - a.note.at)', '.sort((a, b) => b.note.at - a.note.at)', UNIT],
    ['提示词不写「不是目标线」', SRC, '不是目标线，也不是上限', '是目标线', UNIT],
    ['提示词不说他看得到', SRC, '你写的这些，他用 /说话习惯 都能看到（他只能看，不能改）。', '', UNIT],
    ['不收住读进来的条数', SRC, '.slice(-MAX_ACTIVE) : [];', ' : [];', UNIT],
    ['命令不看开关', 'src/platform/app.ts', "if (config.speechNotes && plain === '/说话习惯')", "if (plain === '/说话习惯')", APP],
    ['同学档也放', 'src/platform/app.ts', "...(speechNotesNow && contact.tier === 'boyfriend' ? { speechNotes: speechNotesNow } : {}),", '...(speechNotesNow ? { speechNotes: speechNotesNow } : {}),', APP],
    ['危机回合也放', 'src/platform/contact.ts', 'const speechNoteNow = options.speechNotes && contact.tier === \'boyfriend\' && !thinking && !crisisNow && !grievance', 'const speechNoteNow = options.speechNotes && contact.tier === \'boyfriend\' && !thinking && !grievance', APP],
    ['日志记内容', 'src/platform/contact.ts', "log('说话习惯：这一轮放了几条她自己总结的（日志不记内容）')", "log(`说话习惯：这一轮放了几条她自己总结的（${speechNoteNow}）`)", APP],
];

let bad = 0;
for (const [name, file, from, to, test] of mutations) {
    const path = join(root, file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(from)) { console.log(`?? 找不到：${name}`); bad++; continue; }
    if (original.split(from).length > 2) { console.log(`?? 不唯一：${name}`); bad++; continue; }
    writeFileSync(path, original.replace(from, to));
    let out;
    try { out = spawnSync(process.execPath, ['--test', join(root, test)], { encoding: 'utf8', cwd: root, timeout: 280_000 }); } finally { writeFileSync(path, original); }
    const failed = /ℹ fail (\d+)/.exec(out.stdout ?? '')?.[1];
    const red = failed !== undefined && Number(failed) > 0;
    console.log(`${red ? '红 ✓' : '没红 ✗'}  ${name}（fail ${failed}）`);
    if (!red) bad++;
}
console.log(bad ? `有 ${bad} 处没被抓到` : '全部变红');
