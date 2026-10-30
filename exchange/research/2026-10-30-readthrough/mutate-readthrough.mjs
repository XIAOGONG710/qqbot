// 变异检验：ADR 0198（通读发现的毛病：质感的“先嗯一声”判法、他的低落往后接着算）。每处撤掉，对应测试必须变红；每次都还原。
// 用法：node mutate-readthrough.mjs <仓库根> [名字片段]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const only = process.argv[3];
const TEX = 'packages/bot/src/language/texture.ts';
const INT = 'packages/bot/src/language/intent.ts';
const TTEX = 'packages/bot/test/texture.test.ts';
const TINT = 'packages/bot/test/intent.test.ts';

const mutations = [
    // ── 质感：先嗯一声 ──
    ['问句判法退回旧的', TEX, '!SAID_ASKING.test(said) && !SAID_NO_ACK.test(said)', '!/[？?吗呢吧么]|什么|怎么|为什么/.test(said) && !SAID_NO_ACK.test(said)', TTEX],
    ['道谢 / 示爱 / 问候也先应一声', TEX, '!SAID_ASKING.test(said) && !SAID_NO_ACK.test(said)', '!SAID_ASKING.test(said)', TTEX],
    ['陈述也接好 / 行', TEX, "(SAID_PROPOSAL.test(said) ? ['好', '行'] : ['嗯嗯', '嗯'])", "(SAID_PROPOSAL.test(said) ? ['好', '行'] : ['嗯嗯', '嗯', '好', '对'])", TTEX],
    ['提议也只接嗯', TEX, "(SAID_PROPOSAL.test(said) ? ['好', '行'] : ['嗯嗯', '嗯'])", "['嗯嗯', '嗯']", TTEX],
    ['句尾的没 / 不不算问', TEX, '|(?:没|不)[！!。.~～啊呀]*$`);', '`);', TTEX],
    ['啥 / 哪 / 谁 / 是不是不算问', TEX, '${ASKING.source}|', '', TTEX],
    ['嘛不算问', TEX, '[吗呢吧嘛]|', '[吗呢吧]|', TTEX],
    // ── 意图：他的低落往后接着算 ──
    ['低落不往后接着算', INT, 'return needsCareText(latestUserText(history)) || distressCarried(history);', 'return needsCareText(latestUserText(history));', TINT],
    ['半小时的窗口不看', INT, 'if (Number.isFinite(lastAt) && Number.isFinite(at) && lastAt - at > DISTRESS_CARRY_MS) break;', '', TINT],
    ['窗口 30 分钟变 24 小时', INT, 'export const DISTRESS_CARRY_MS = 30 * 60_000;', 'export const DISTRESS_CARRY_MS = 24 * 3_600_000;', TINT],
    ['只看最近 1 条', INT, 'export const DISTRESS_CARRY_MESSAGES = 8;', 'export const DISTRESS_CARRY_MESSAGES = 1;', TINT],
    ['看全部历史', INT, '.filter(message => message.role === \'user\').slice(-DISTRESS_CARRY_MESSAGES);', '.filter(message => message.role === \'user\');', TINT],
    ['他说缓过来了也不算过去', INT, 'return hit >= 0 && !mine.slice(hit + 1).some(message => RECOVERED.test(message.content));', 'return hit >= 0;', TINT],
    ['他笑了不算过去', INT, '|不烦了|想开了|缓过来了|哈哈|嘿嘿|hhh/i;', '|不烦了|想开了|缓过来了/i;', TINT],
    ['她的话也算他的低落', INT, "const mine = history.filter(message => message.role === 'user')", 'const mine = history', TINT],
    // ── 意图：多认几类难受 ──
    ['新说法不认', INT, '        || DISTRESS_EXTRA.test(text);', '        ;', TINT],
    ['没用过也算难受', INT, '没用|废物|差劲|失败)(?![过到上着完])|想辞职', '没用|废物|差劲|失败)|想辞职', TINT],
    ['心情不好不认', INT, '心情(?:很|真的|特别|太)?(?:不好|差|糟)|不开心|低落|', '不开心|低落|', TINT],
    ['被说垃圾不认', INT, '(?:说|骂|嫌)我.{0,10}(?:垃圾|没用|废物|不行|差劲|太差)|', '', TINT],
    ['想辞职不认', INT, '想辞职|想离职|不想干了|干不下去|', '', TINT],
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
