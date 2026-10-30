// 变异检验：ADR 0194（她翻日记写对自己的认识）+ 单独一行的内部标记。每处撤掉，对应的测试必须变红；每次都还原。
// 用法：node mutate-insights.mjs <仓库根>
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const MOD = 'packages/bot/src/life/diary-insights.ts';
const UNIT = 'packages/bot/test/diary-insights.test.ts';
const APP = 'packages/bot/test/app.test.ts';
const RUN = 'packages/bot/test/runtime.test.ts';
const RESP = 'packages/bot/src/social/responder.ts';
const CONTACT = 'packages/bot/src/platform/contact.ts';
const APPSRC = 'packages/bot/src/platform/app.ts';

const mutations = [
    // ── 模块：依据、防线、上限 ──
    ['依据的日期不查真有没有', MOD, 'const unknown = dates.find(date => !guard.dates.has(date));', 'const unknown = undefined as string | undefined;', UNIT],
    ['一个日子也算发现', MOD, 'if (new Set(dates).size < EVIDENCE_DATES) return', 'if (false) return', UNIT],
    ['底线绊线失效', MOD, 'for (const floor of [...FLOORS, ...EXTRA_FLOORS]) if (floor.pattern.test(flat)) return floor.reason;', '', UNIT],
    ['自我认识特有的两条底线失效', MOD, '[...FLOORS, ...EXTRA_FLOORS]', 'FLOORS', UNIT],
    ['不查他的话（连续 6 字）', MOD, 'if (sharedRun(flat, guard.his) || quotedSpan(flat, guard.his)) return', 'if (quotedSpan(flat, guard.his)) return', UNIT],
    ['不查他的话（引号里）', MOD, 'if (sharedRun(flat, guard.his) || quotedSpan(flat, guard.his)) return', 'if (sharedRun(flat, guard.his)) return', UNIT],
    ['不查名单里别人', MOD, 'const other = guard.others.find(name => len(name) >= 2 && flat.includes(name));', 'const other = undefined as string | undefined;', UNIT],
    ['一个字的称呼也查', MOD, 'len(name) >= 2 && flat.includes(name)', 'flat.includes(name)', UNIT],
    ['不查抄日记', MOD, 'if (sharedRun(flat, guard.diaryTexts, DIARY_COPY_RUN)) return', 'if (false) return', UNIT],
    ['不查太像', MOD, 'if (clash) return', 'if (false) return', UNIT],
    ['不限条数', MOD, 'if (state.notes.length >= MAX_ACTIVE) return', 'if (false) return', UNIT],
    ['放下不要理由', MOD, 'if (len(item.why) < 2) {', 'if (false) {', UNIT],
    ['一晚不限放下', MOD, 'if (retired >= MAX_RETIRE) {', 'if (false) {', UNIT],
    ['一晚不限加', MOD, 'if (added >= MAX_ADD) {', 'if (false) {', UNIT],
    ['不先放下', MOD, '    let retired = 0;\n    for (const item of decision.retire) {', '    let retired = 0;\n    for (const item of []) {', UNIT],
    // ── 模块：什么时候想、日记从哪来 ──
    ['成功不记时间', MOD, '        fresh.lastReflectionAt = now;\n', '', UNIT],
    ['没有新日记也想', MOD, 'if (state.lastWindow?.newest === newestKey(entries)) return { ran: false };', '', UNIT],
    ['日记太少也想', MOD, 'if (entries.length < MIN_ENTRIES || dates.size < MIN_DATES) return { ran: false };', '', UNIT],
    ['不按 14 天窗口过滤', MOD, 'entry => entry.date >= from && entry.date <= to', 'entry => true', UNIT],
    ['日记原文不截', MOD, "const clipped = entries.map(entry => ({ ...entry, text: clip(entry.text, ENTRY_CHARS) }));", 'const clipped = entries.map(entry => ({ ...entry }));', UNIT],
    ['总量不收', MOD, 'while (clipped.length > 1 && total > MATERIAL_CHARS)', 'while (false)', UNIT],
    ['自己写的日记不限 60 篇', MOD, 'writeJsonAtomic(selfDiaryPath(dataDir), { entries: [...loadSelfDiary(dataDir), { at: now, text: flat }].slice(-SELF_DIARY_KEEP) });', 'writeJsonAtomic(selfDiaryPath(dataDir), { entries: [...loadSelfDiary(dataDir), { at: now, text: flat }] });', UNIT],
    // ── 模块：放进提示词 ──
    ['没聊到也放', MOD, '.filter(item => item.score > 0)\n', '\n', UNIT],
    ['没有相关也放一行', MOD, "    if (!picked.length) return undefined;\n    return `[你对自己的了解", "    return `[你对自己的了解", UNIT],
    ['太常见的词也算相关', MOD, '!COMMON_GRAMS.has(gram)', 'true', UNIT],
    ['提示词那一行提日记', MOD, '[你对自己的了解（是你自己慢慢发现的', '[你翻自己日记时发现的自己（是你自己慢慢发现的', UNIT],
    ['提示词不说他看得到', MOD, '你写的这些，他用 /自我认识 都能看到（他只能看，不能改）。', '', UNIT],
    ['提示词不说别写别人', MOD, '不写别人的事和名字，不写他说过的话；', '', UNIT],
    ['提示词不说要两个日子', MOD, '要在 ${EVIDENCE_DATES} 个以上不同的日子的日记里都看得出来才算发现，一次的事不算，', '', UNIT],
    // ── 接线 ──
    ['命令不看开关', APPSRC, "if (config.diaryInsights && plain === '/自我认识')", "if (plain === '/自我认识')", APP],
    ['危机回合也放', CONTACT, "const insightNow = options.diaryInsights && contact.tier === 'boyfriend' && !thinking && !crisisNow && !grievance", "const insightNow = options.diaryInsights && contact.tier === 'boyfriend' && !thinking && !grievance", APP],
    ['日志记内容', CONTACT, "log('自我认识：这一轮放了几条她翻日记时发现的自己（日志不记内容）')", "log(`自我认识：这一轮放了几条她翻日记时发现的自己（${insightNow}）`)", APP],
    ['同学档的日记也在本地留', APPSRC, "if (note.kind === '日记' && config.diaryInsights && contact.tier === 'boyfriend') {", "if (note.kind === '日记' && config.diaryInsights) {", APP],
    ['关着也在本地留日记', APPSRC, "if (note.kind === '日记' && config.diaryInsights && contact.tier === 'boyfriend') {", "if (note.kind === '日记' && contact.tier === 'boyfriend') {", APP],
    // ── 单独一行的内部标记（responder / 接线） ──
    ['回复路径不处理只有标记的气泡', RESP, "deps.beforeSend?.();\n        absorbMarkerOnly(parts);\n        setPhase({ phase: 'sending' });", "deps.beforeSend?.();\n        setPhase({ phase: 'sending' });", RUN],
    ['主动路径不处理只有标记的气泡', RESP, "deps.beforeSend?.();\n        absorbMarkerOnly(parts);\n\n        const { timing } = deps;", "deps.beforeSend?.();\n\n        const { timing } = deps;", RUN],
    ['回复路径还把标记气泡当消息发（打字、空行）', RESP, "            // 只有内部标记的不发、不「打字」、不进记录（标记上面已经处理了）\n            if (markerOnly(part)) continue;\n", '', RUN],
    ['主动路径不跳过只有标记的气泡', RESP, "            if (markerOnly(part)) continue;\n            if (i > 0) {\n                await (timing ? sleepTyping(timing.typingMs(part)) : sleep(PART_GAP_MS));\n                if (deps.history.load(deps.userId).slice(input).some(m => m.role === 'user')) {\n                    deps.log(`发送中途对方插话，剩下 ${parts.length - i} 条不发`);\n                    break;\n                }\n            }\n            if (stopped) {\n                deps.log(`已停止，剩下 ${parts.length - i} 条不发`);\n                break;\n            }\n            let bubble", "            if (i > 0) {\n                await (timing ? sleepTyping(timing.typingMs(part)) : sleep(PART_GAP_MS));\n                if (deps.history.load(deps.userId).slice(input).some(m => m.role === 'user')) {\n                    deps.log(`发送中途对方插话，剩下 ${parts.length - i} 条不发`);\n                    break;\n                }\n            }\n            if (stopped) {\n                deps.log(`已停止，剩下 ${parts.length - i} 条不发`);\n                break;\n            }\n            let bubble", RUN],
    ['absorb 抛错会拖垮这一轮', RESP, "catch (error) { deps.log(`内部标记没处理成：${error instanceof Error ? error.message : String(error)}`); }", 'catch (error) { throw error; }', RUN],
    ['contact 没把 absorb 交给回复器', CONTACT, '...(options.absorb ? { absorb: (part: string) => options.absorb!(contact.qq, part) } : {}),', '', APP],
    ['app 的 absorb 什么都不做', APPSRC, 'absorb: (userId, part) => { absorbMarkers(userId, part); },', 'absorb: () => {},', APP],
];

let bad = 0;
for (const [name, file, from, to, test] of mutations) {
    const path = join(root, file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(from)) { console.log(`?? 找不到：${name}`); bad++; continue; }
    if (original.split(from).length > 2) { console.log(`?? 不唯一：${name}`); bad++; continue; }
    writeFileSync(path, original.replace(from, to));
    let out;
    try { out = spawnSync(process.execPath, ['--test', join(root, test)], { encoding: 'utf8', cwd: join(root, 'packages/bot'), timeout: 280_000 }); } finally { writeFileSync(path, original); }
    const failed = /ℹ fail (\d+)/.exec(out.stdout ?? '')?.[1];
    const red = failed !== undefined && Number(failed) > 0;
    console.log(`${red ? '红 ✓' : '没红 ✗'}  ${name}（fail ${failed}）`);
    if (!red) bad++;
}
console.log(bad ? `有 ${bad} 处没被抓到` : '全部变红');
