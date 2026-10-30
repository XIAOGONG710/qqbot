// 变异检验：ADR 0195（他标「这句像 AI」/「像真人」→ 每晚想说话习惯）。每处撤掉，对应测试必须变红；每次都还原。
// 用法：node mutate-feedback.mjs <仓库根>
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const FB = 'packages/bot/src/language/speech-feedback.ts';
const NOTES = 'packages/bot/src/language/speech-notes.ts';
const APPSRC = 'packages/bot/src/platform/app.ts';
const UNIT = 'packages/bot/test/speech-feedback.test.ts';
const NTEST = 'packages/bot/test/speech-notes.test.ts';
const APP = 'packages/bot/test/app.test.ts';

const mutations = [
    // ── 命令 ──
    ['小写 ai 不认', FB, '(AI|ai|Ai|真人)', '(AI|真人)', UNIT],
    ['命令后面直接接字也算', FB, '(?:[\\s：:，,]+(.{1,200}))?$/s', '(?:[\\s：:，,]+(.{1,200}))?/s', UNIT],
    ['理由不截', FB, 'const why = clip(match[2], WHY_CHARS);', "const why = String(match[2] ?? '');", UNIT],
    // ── 他指的是哪一句 ──
    ['他后面还没回的也算', FB, "while (end >= 0 && (messages[end]!.role === 'user' || NOT_SPEECH.test(messages[end]!.content))) end--;", "while (end >= 0 && NOT_SPEECH.test(messages[end]!.content)) end--;", UNIT],
    ['运维行也算她说话', FB, "while (end >= 0 && (messages[end]!.role === 'user' || NOT_SPEECH.test(messages[end]!.content))) end--;", "while (end >= 0 && messages[end]!.role === 'user') end--;", UNIT],
    ['12 小时前的也算', FB, 'now - at > TURN_MAX_AGE_MS', 'false', UNIT],
    ['未来的也算', FB, ' || at > now + 60_000) return undefined;', ') return undefined;', UNIT],
    ['他的话不限 3 条', FB, '.filter(Boolean).slice(-HIS_MAX);', '.filter(Boolean);', UNIT],
    ['她的话不限 6 条', FB, 'hers: hers.slice(-HERS_MAX).map(text => clip(text, LINE_CHARS)), at }', 'hers: hers.map(text => clip(text, LINE_CHARS)), at }', UNIT],
    ['不带他前面的话', FB, "while (from - 1 >= 0 && messages[from - 1]!.role === 'user') from--;", '', UNIT],
    // ── 存 / 读 ──
    ['同一次说的话再标不覆盖', FB, '.filter(old => !sameTurn(old.hers, entry.hers));', '.filter(() => true);', UNIT],
    ['存的时候不限 60 条', FB, 'const next = [...kept, entry].slice(-FEEDBACK_KEEP);', 'const next = [...kept, entry];', UNIT],
    ['读的时候不限 60 条', FB, "}).slice(-FEEDBACK_KEEP);\n}\n\nconst sameTurn", "});\n}\n\nconst sameTurn", UNIT],
    ['标签不对也收', FB, "(item.label !== 'human' && item.label !== 'ai')", 'false', UNIT],
    ['不看 14 天窗口', FB, 'entry.at >= now - FEEDBACK_WINDOW_MS && entry.at <= now + 60_000);\n    const take', 'entry.at <= now + 60_000);\n    const take', UNIT],
    ['未来的也要', FB, 'entry.at >= now - FEEDBACK_WINDOW_MS && entry.at <= now + 60_000);\n    const take', 'entry.at >= now - FEEDBACK_WINDOW_MS);\n    const take', UNIT],
    ['每类不限 5 条', FB, '.slice(-FEEDBACK_SHOW);', ';', UNIT],
    // ── 提示词 ──
    ['不写「不是规定」', FB, '这是他的感受，不是规定；你想不想变、怎么变你自己定；', '', UNIT],
    ['不带他的理由', FB, "${entry.why ? `\\n（${user}说：${entry.why}）` : ''}", '', UNIT],
    ['反馈没放进提示词', NOTES, '${exchanges}${feedback}', '${exchanges}', NTEST],
    ['反馈没交给提示词', NOTES, '...(feedback && feedbackCount(feedback) ? { feedback } : {}),', '', NTEST],
    ['理由里他的话不拦', NOTES, '...(feedback ? feedbackWhys(feedback) : [])', '', NTEST],
    ['他看不到标过几次', NOTES, '...(feedbackLine ? [feedbackLine] : []),', '', NTEST],
    // ── 接线 ──
    ['每晚想的时候没带反馈', APPSRC, 'feedback: () => recentFeedback(loadFeedback(config.dataDir), clockNow().getTime()),', '', APP],
    ['关着也认命令', APPSRC, 'const feedbackCommand = config.speechNotes ? parseFeedbackCommand(plain) : undefined;', 'const feedbackCommand = parseFeedbackCommand(plain);', APP],
    ['理由没存', APPSRC, '...(feedbackCommand.why ? { why: feedbackCommand.why } : {}) }', '}', APP],
    ['没有可标的也记', APPSRC, 'if (!turn) { tellOwner(FEEDBACK_NO_TURN); return; }', 'if (!turn) { tellOwner(FEEDBACK_NO_TURN); }', APP],
    ['日志记内容', APPSRC, "标成「${feedbackCommand.label === 'human' ? '像真人' : '这句像 AI'}」（日志不记内容）", "标成「${feedbackCommand.label === 'human' ? '像真人' : '这句像 AI'}」（${turn.hers.join('')}）", APP],
    ['/说话习惯 不带标过几次', APPSRC, 'describeNotesForOwner(loadNotesState(config.dataDir), now, describeFeedbackForOwner(loadFeedback(config.dataDir), now))', 'describeNotesForOwner(loadNotesState(config.dataDir), now)', APP],
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
