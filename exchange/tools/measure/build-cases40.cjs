#!/usr/bin/env node
// 重新生成「人 vs 机器」盲评题库：exchange/research/2026-10-real-chat/v2/cases-40.json
//
//   node exchange/tools/measure/build-cases40.cjs
//
// 输入（只读，不改）：v2/{samples,samples-b1,samples-b2,samples-b3,closing-turns}.jsonl
// 输出：v2/cases-40.json（40 题，题目里只有真人对白，没有我们 bot 的任何聊天）
//
// 选材口径
//  - 每条语料最多 1 题，取「最后一次 男方发言 -> 女方回话」的相邻交换。
//  - 女方由记录里的 her 字段决定。her=A 时女生在 A 侧，此时 stimulus 取 B、human 取 A。
//  - human 只取他发完之后她的第一轮；若是她先连发两轮，只取紧挨着他的那一轮。
//  - 跳过：staged: true、her 未知、整段没有男方发言、男方说完她没接且没有更早的有效交换。
//  - persona_fit: low 默认跳过。严格按这条只剩 35 条（48 - 2 staged - 6 low - 5 无有效交换），
//    凑不满 40；下面这 5 条 low 是不带 staged 的真人 1v1 记录，对「像不像真人」的盲评没有影响，保留：
//    rc-001 / rc-003 / rc-022 / rc-025 / rc-028。ct-003（low，且只有一句「好哒」）仍跳过。
//  - 时间戳由下标推出来（10-10 20:00 起每题 +7 分钟），不随机。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const V2 = path.join(__dirname, '..', '..', 'research', '2026-10-real-chat', 'v2');
const OUT = path.join(V2, 'cases-40.json');
const FILES = ['samples.jsonl', 'samples-b1.jsonl', 'samples-b2.jsonl', 'samples-b3.jsonl', 'closing-turns.jsonl'];

// 为什么不要这条（写清楚，重跑时固定）
const SKIP = {
  'rc-020': '全段只有她一个人说话，男方一句都没有',
  'rc-021': '同上，男方整段没回',
  'rc-b2-004': '她先开口、男方回了一句，之后她没有接（没有男->女交换）',
  'rc-b3-003': '同上，她说完，男方回一句梗，她没有接',
  'ct-006': 'her: ?（说话人未知），整段只有一条',
  'ct-003': 'persona_fit: low，且只有「好哒」一句，太薄',
  'rc-b1-004': 'staged: true',
  'rc-b1-005': 'staged: true',
};

// 这题在测什么（每题一句）
const PROBES = {
  'rc-001': '不熟的人说想来找她玩，她怎么把话变成要钱',
  'rc-002': '被朋友问「你怎么猜到他这么回」，她怎么解释自己不加陌生人',
  'rc-003': '对方质问「知道我有女朋友还加我」，她怎么收',
  'rc-004': '他说「下次不用送东西了」，她怎么绕回「不送就没理由找你」',
  'rc-005': '被催「你说吧」，她怎么开口说瞒了很久的事',
  'rc-006': '他笑她「学疯了」，她怎么反问回去',
  'rc-007': '他把长胖归到热量缺口，她怎么顶回去',
  'rc-008': '他赌气说不再叫她起床，她怎么认错',
  'rc-009': '朋友哭着倒苦水，她怎么用回忆安慰',
  'rc-010': '顺着「对呀」撒娇要抱抱时她怎么起头',
  'rc-011': '他刚说想她，她怎么把「我也想你」说出来',
  'rc-012': '他深夜反复认错表白，她怎么回应',
  'rc-013': '被劝「一点点来」早睡，她怎么解释熬夜',
  'rc-014': '他说「我肯定是啊」，她怎么顺势下十二小时不发消息的战书',
  'rc-015': '他抱怨她最近不发那些消息，她怎么装不懂',
  'rc-016': '闺蜜调侃她前男友数量，她怎么澄清',
  'rc-017': '他连发一串问号，她怎么自顾自说「感觉我瘦了」',
  'rc-018': '他说「滚呀你好烦」，她怎么用「?」「行」收',
  'rc-019': '他怪她照顾妈妈把日子过乱，她怎么顶回去',
  'rc-022': '他问「多少」，她怎么把课时和差价报清楚',
  'rc-023': '他反口「到底对还是不对」，她怎么接自己出的打分梗',
  'rc-024': '他骂游戏打到这么晚，她怎么回',
  'rc-025': '他说下午没空，她怎么绕开话题撒娇叫老公',
  'rc-026': '家人报备买了音箱，她怎么先捧一句再说面试被拒',
  'rc-027': '闺蜜说在考虑后事，她先回一个问号',
  'rc-028': '妈妈深夜说自己可能抑郁健忘，她怎么接',
  'rc-029': '他说烦心事想自己扛，她怎么给台阶',
  'rc-030': '他承认不知道怎么回她，她怎么追问旧账',
  'rc-b1-001': '他说「习惯了」，她怎么把话拐到约夜宵',
  'rc-b1-002': '他定下课在校门口集合，她怎么答应',
  'rc-b1-003': '他说「想和你去」，她怎么回',
  'rc-b2-001': '他反复改口约见面，她怎么再次明确拒绝',
  'rc-b2-002': '他让她定时间，她只问店名',
  'rc-b2-003': '被问图哪来的，她怎么解释还补一句',
  'rc-b3-001': '误发消息只收到一个「?」，她怎么社死自嘲',
  'rc-b3-002': '他追问她为什么这么说话，她怎么堵回去',
  'ct-001': '他说要睡了，她怎么反手说太想他',
  'ct-002': '他要看照片，她怎么发图补一句',
  'ct-004': '他说「我忙着呢」，她怎么反问',
  'ct-005': '他纠正称呼，她怎么嘴硬不认',
};

const START = Date.parse('2026-10-10T20:00:00+08:00');
const STEP = 7 * 60 * 1000;
const MIN_GAP = 1 * 60 * 1000;
const MAX_GAP = 15 * 60 * 1000;

const isText = (b) => typeof b === 'string' && b.trim() !== '';
const cut = (s) => {
  const chars = Array.from(s);
  return chars.length > 60 ? chars.slice(0, 60).join('') + '…' : s;
};
const isoPlus8 = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00');

function loadRecords() {
  const out = [];
  for (const f of FILES) {
    const text = fs.readFileSync(path.join(V2, f), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

// 最后一次 男方发言 -> 女方回话；返回 {k, stimulus, human}，k = 他那段的第一步下标
function lastExchange(rec) {
  const her = rec.her;
  if (her !== 'A' && her !== 'B') return null;
  const other = her === 'A' ? 'B' : 'A';
  const turns = rec.turns ?? [];
  for (let i = turns.length - 1; i > 0; i--) {
    if (turns[i].who !== her) continue;
    if (!(turns[i].bubbles ?? []).some(isText)) continue;
    let j = i - 1;
    while (j >= 0 && turns[j].who !== other) j--;
    if (j < 0) continue;
    // 中间隔了第三个人（rc-026 的家庭群）就不是「他 -> 她」的交换
    if (turns[j + 1].who !== her) continue;
    let k = j;
    while (k - 1 >= 0 && turns[k - 1].who === other) k--;
    const stimulus = turns.slice(k, j + 1).flatMap((t) => (t.bubbles ?? []).filter(isText));
    if (!stimulus.length) continue;
    const human = ((turns[j + 1].bubbles) ?? []).filter(isText);
    if (!human.length) continue;
    return { k, stimulus, human };
  }
  return null;
}

function buildCase(rec, index) {
  const her = rec.her;
  const ex = lastExchange(rec);
  if (!ex) return null;
  const lines = [];
  for (const t of rec.turns.slice(0, ex.k)) {
    for (const b of t.bubbles ?? []) {
      if (!isText(b)) continue;
      lines.push(`${t.who === her ? '女生' : '男生'}：${cut(b.trim())}`);
    }
  }
  return {
    id: `ev-${String(index + 1).padStart(3, '0')}`,
    relation: rec.relation,
    scene: rec.scene,
    context: lines.slice(-6),
    stimulus: ex.stimulus.map(String),
    human: ex.human.map(String),
    humanAt: isoPlus8(START + index * STEP),
    sourceId: rec.id,
    probe: PROBES[rec.id],
  };
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
const assert = (cond, msg) => { if (!cond) fail(msg); };

function main() {
  const records = loadRecords();
  const cases = [];
  const skipped = [];
  for (const rec of records) {
    if (SKIP[rec.id]) { skipped.push(`${rec.id}（${SKIP[rec.id]}）`); continue; }
    if (rec.her !== 'A' && rec.her !== 'B') { skipped.push(`${rec.id}（her 未知）`); continue; }
    const one = buildCase(rec, cases.length);
    if (!one) { skipped.push(`${rec.id}（没有可用的 男->女 交换）`); continue; }
    cases.push(one);
  }

  // ---- 断言 ----
  assert(cases.length === 40, `题数应为 40，实际 ${cases.length}`);
  assert(new Set(cases.map((c) => c.id)).size === 40, 'id 不唯一');
  assert(cases.every((c, i) => c.id === `ev-${String(i + 1).padStart(3, '0')}`), 'id 序号不连续');
  assert(new Set(cases.map((c) => c.sourceId)).size === 40, 'sourceId 不唯一');
  assert(cases.every((c) => PROBES[c.sourceId]), '有题缺 probe');
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
  for (const c of cases) {
    assert(['friend', 'boyfriend', 'bestie', 'unknown'].includes(c.relation), `${c.id} relation 异常`);
    assert(Number.isInteger(c.scene) && c.scene >= 1 && c.scene <= 9, `${c.id} scene 异常`);
    assert(c.stimulus.length > 0 && c.stimulus.every((s) => typeof s === 'string' && s.trim()), `${c.id} stimulus 为空`);
    assert(c.human.length > 0 && c.human.every((s) => typeof s === 'string' && s.trim()), `${c.id} human 为空`);
    assert(c.context.length <= 6, `${c.id} context 超过 6 行`);
    assert(isoRe.test(c.humanAt), `${c.id} humanAt 不是 +08:00 的 ISO`);
    assert(Number.isFinite(Date.parse(c.humanAt)), `${c.id} humanAt 解析失败`);
    assert(c.sourceId && c.probe, `${c.id} sourceId/probe 为空`);
  }
  const lo = Date.parse('2026-10-10T00:00:00+08:00');
  const hi = Date.parse('2026-10-20T23:59:59+08:00');
  let prev = 0;
  for (const c of cases) {
    const t = Date.parse(c.humanAt);
    assert(t >= lo && t <= hi, `${c.id} humanAt 超出 2026-10-10..2026-10-20`);
    if (prev) { const gap = t - prev; assert(gap >= MIN_GAP && gap <= MAX_GAP, `${c.id} 与上一题间隔 ${gap / 60000} 分钟`); }
    prev = t;
  }
  const byScene = {};
  for (const c of cases) byScene[c.scene] = (byScene[c.scene] ?? 0) + 1;
  assert(Math.max(...Object.values(byScene)) <= 10, 'single scene 超过 1/4');

  fs.writeFileSync(OUT, JSON.stringify(cases, null, 2) + '\n', 'utf8');

  const count = (key) => cases.reduce((m, c) => ((m[c[key]] = (m[c[key]] ?? 0) + 1), m), {});
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${cases.length} cases`);
  console.log('relation:', JSON.stringify(count('relation')));
  console.log('scene:', JSON.stringify(count('scene')));
  console.log(`skipped ${skipped.length} records:`);
  for (const s of skipped) console.log('  -', s);
}

main();
