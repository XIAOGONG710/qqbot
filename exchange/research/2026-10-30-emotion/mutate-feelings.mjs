// 变异检验：ADR 0197（桌面读同一份心境 + 聊完回想）。每处撤掉，对应测试必须变红；每次都还原。
// 用法：node mutate-feelings.mjs <仓库根> [名字片段]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const only = process.argv[3];
const EXP = 'packages/bot/src/emotion/feeling-export.ts';
const REV = 'packages/bot/src/emotion/feeling-review.ts';
const CONTACT = 'packages/bot/src/platform/contact.ts';
const APPSRC = 'packages/bot/src/platform/app.ts';
const PLUGIN = 'dsh-plugins/dsh-linmengyao-memory/index.js';
const TEXP = 'packages/bot/test/feeling-export.test.ts';
const TREV = 'packages/bot/test/feeling-review.test.ts';
const TPLG = 'packages/bot/test/soul-plugin.test.ts';
const TAPP = 'packages/bot/test/app.test.ts';

const mutations = [
    // ── QQ 写 FEELINGS.json ──
    ['隐约的也带出去', EXP, ".filter(item => item.level !== 'faint').slice(0, 4)", '.slice(0, 4)', TEXP],
    ['不限 4 条', EXP, ".filter(item => item.level !== 'faint').slice(0, 4)", ".filter(item => item.level !== 'faint')", TEXP],
    ['没有感受写空串不写 null', EXP, 'line: report.line ?? null,', "line: report.line ?? '',", TEXP],
    ['每次都重写', EXP, 'if (same && Number.isFinite(written)', 'if (false && same && Number.isFinite(written)', TEXP],
    ['时间戳不刷新', EXP, 'report.at - written < FEELINGS_REFRESH_MS && written <= report.at', 'written <= report.at', TEXP],
    ['时间在未来也不重写', EXP, 'report.at - written < FEELINGS_REFRESH_MS && written <= report.at', 'report.at - written < FEELINGS_REFRESH_MS', TEXP],
    ['同学档也写', APPSRC, "...(config.herFeelings && contact.tier === 'boyfriend' ? { onFeelings:", '...(config.herFeelings ? { onFeelings:', TAPP],
    ['危机回合也写', CONTACT, "if (options.onFeelings && options.herFeelings && contact.tier === 'boyfriend' && !crisisNow) {", "if (options.onFeelings && options.herFeelings && contact.tier === 'boyfriend') {", TAPP],
    ['导出的那一行带 melt', CONTACT, 'describeFeelings(feltNow, contact.name, { melt: false, voiced:', 'describeFeelings(feltNow, contact.name, { melt: asksAfterHer(hisWords), voiced:', TAPP],
    ['关着也写', APPSRC, "...(config.herFeelings && contact.tier === 'boyfriend' ? { onFeelings:", "...(contact.tier === 'boyfriend' ? { onFeelings:", TAPP],
    // ── 桌面读 ──
    ['不看是不是桌面上的回合', PLUGIN, "export function feelingsBlock(cfg, now = Date.now()) {\n  if (channel() !== 'desktop') return ''\n", 'export function feelingsBlock(cfg, now = Date.now()) {\n', TPLG],
    ['过期也用', PLUGIN, 'now - at > cfg.feelingsStaleMs', 'false', TPLG],
    ['不认标记', PLUGIN, "!data || data.kind !== 'qq-feelings' || typeof data.line !== 'string'", "!data || typeof data.line !== 'string'", TPLG],
    ['未来的时间也信', PLUGIN, "|| at > now + 60_000) return ''\n    const line", ") return ''\n    const line", TPLG],
    ['绊线失效', PLUGIN, 'return line && !soulTripwire(line) ? line : \'\'', "return line ? line : ''", TPLG],
    ['没放进提示词', PLUGIN, "              feelings,\n              insights,", "              insights,", TPLG],
    // ── 聊完回想：材料 ──
    ['聊天窗口不是 36 小时', REV, 'at >= now - REVIEW_WINDOW_MS && at <= now && !NOT_SPEECH', 'at <= now && !NOT_SPEECH', TREV],
    ['运维行也算', REV, ' && !NOT_SPEECH.test(message.content) && message.content.trim(); })', ' && message.content.trim(); })', TREV],
    ['不限 60 条', REV, '.slice(-MAX_MESSAGES)\n', '\n', TREV],
    ['消息不截 60 字', REV, 'text: clip(message.content, MESSAGE_CHARS) }', 'text: message.content }', TREV],
    // ── 什么时候想 ──
    ['聊得太少也想', REV, 'if (chat.length < MIN_MESSAGES) return false;', '', TREV],
    ['没聊完半小时也想', REV, 'if (now - lastAt < SETTLE_MS || now - lastAt > FRESH_MS) return false;', 'if (now - lastAt > FRESH_MS) return false;', TREV],
    ['很久以前的也想', REV, 'if (now - lastAt < SETTLE_MS || now - lastAt > FRESH_MS) return false;', 'if (now - lastAt < SETTLE_MS) return false;', TREV],
    ['没有新聊天也想', REV, 'length < MIN_NEW) return false;', 'length < 0) return false;', TREV],
    ['刚想过又想', REV, 'if (state.lastAttemptAt && now - state.lastAttemptAt < MIN_GAP_MS) return false;', '', TREV],
    ['一天不限次数', REV, 'return state.attempts.day !== dayKey(now) || state.attempts.n < MAX_ATTEMPTS_PER_DAY;', 'return true;', TREV],
    // ── 一条感受能不能收 ──
    ['来由太短也收', REV, 'if (len(cause) < CAUSE_MIN) return', 'if (false) return', TREV],
    ['来由太长也收', REV, 'if (len(cause) > CAUSE_MAX) return', 'if (false) return', TREV],
    ['大事也收（轻重不限）', REV, 'if (item.strength !== 1 && item.strength !== 2) return', 'if (false) return', TREV],
    ['没有依据也收', REV, 'if (!item.evidence.length) return', 'if (false) return', TREV],
    ['编号不对也收', REV, 'if (missing) return', 'if (false) return', TREV],
    ['明显一条依据就够', REV, 'if (item.strength === 2 && new Set(item.evidence).size < 2) return', 'if (false) return', TREV],
    ['依据太旧也收', REV, 'if (at > guard.now || guard.now - at > REVIEW_WINDOW_MS) return', 'if (false) return', TREV],
    ['因他但依据里没有他的话也收', REV, "if (item.aboutHim && !cited.some(e => e!.role === 'him')) return", 'if (false) return', TREV],
    ['因他难过不限一晚一条', REV, "negativeAboutHimSoFar >= MAX_NEGATIVE_ABOUT_HIM) return", "negativeAboutHimSoFar >= 99) return", TREV],
    ['危机 / 程序 / 骗人的不拦', REV, 'for (const floor of FLOORS) if (floor.pattern.test(cause)) return floor.reason;', '', TREV],
    ['医书词不拦', REV, 'if (odd) return', 'if (false) return', TREV],
    ['引他的话不拦（连续 6 字）', REV, 'if (sharedRun(cause, guard.his) || quotedSpan(cause, guard.his)) return', 'if (quotedSpan(cause, guard.his)) return', TREV],
    ['引他的话不拦（引号里）', REV, 'if (sharedRun(cause, guard.his) || quotedSpan(cause, guard.his)) return', 'if (sharedRun(cause, guard.his)) return', TREV],
    ['写别人名字不拦', REV, 'if (other) return', 'if (false) return', TREV],
    ['和之前记的太像也收', REV, 'if (clash) return', 'if (false) return', TREV],
    ['心里已经有的也收', REV, 'if (known) return', 'if (false) return', TREV],
    ['不限 8 条', REV, 'if (state.items.length >= MAX_ACTIVE) return', 'if (false) return', TREV],
    // ── 落地 ──
    ['放下不要理由', REV, 'if (len(item.why) < 2) {', 'if (false) {', TREV],
    ['一晚不限放下', REV, 'if (retired >= MAX_RETIRE) {', 'if (false) {', TREV],
    ['一晚不限记', REV, 'if (added >= MAX_ADD) {', 'if (false) {', TREV],
    ['感受的时刻用现在而不是依据', REV, 'const at = Math.max(...cited.map(e => e.at));', 'const at = now;', TREV],
    ['记依据只记第一条', REV, 'evidence: item.evidence, addedAt: now', 'evidence: item.evidence.slice(0, 1), addedAt: now', TREV],
    ['因他难过的不计数', REV, "if (item.aboutHim && (item.kind === 'sad' || item.kind === 'annoyed')) negativeAboutHim++;", '', TREV],
    ['散光了的也留', REV, 'state.items = state.items.filter(old => now - old.at <= KEEP_MS);', '', TREV],
    ['成功不记时刻', REV, '        fresh.lastReflectionAt = now;\n', '', TREV],
    ['成功不记看到哪', REV, 'fresh.lastWindow = { messages: messages.length, until: messages.at(-1)!.at };', '', TREV],
    ['来源不是 self', REV, "source: 'self' as const,", "source: 'world' as const,", TREV],
    // ── 提示词 ──
    ['提示词不要求依据', REV, '每一条都要在 evidence 里指出是哪几条消息或日记让你有的这个感受，编号必须是上面真有的，没有依据的不要记；', '', TREV],
    ['提示词不说大事不由你记', REV, '，没有更重的——大事不由你记', '', TREV],
    ['提示词不说别因为没回编难过', REV, '别因为他没回你就编出难过（那种另有地方算）；', '', TREV],
    ['提示词不说他看得到', REV, '用 /心境 都能看到', '都能看到', TREV],
    // ── 给他看 / 接线 ──
    ['/心境 关着也认', APPSRC, "if (config.herFeelings && plain === '/心境')", "if (plain === '/心境')", TAPP],
    ['回想的结果没进心境', CONTACT, '...(options.feelingReview?.() ?? [])', '', TAPP],
    ['同学档也读回想的结果', APPSRC, "...(feelingReviewNow && contact.tier === 'boyfriend' ? { feelingReview: feelingReviewNow } : {}),", '...(feelingReviewNow ? { feelingReview: feelingReviewNow } : {}),', TAPP],
    ['定时器没有交出已有的感受', APPSRC, "existing: () => (lastFeelings && clockNow().getTime() - lastFeelings.at <= 6 * 3_600_000", "existing: () => (false && lastFeelings && clockNow().getTime() - lastFeelings.at <= 6 * 3_600_000", TAPP],
];

let bad = 0;
for (const [name, file, from, to, test] of mutations) {
    if (only && !name.includes(only)) continue;
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
