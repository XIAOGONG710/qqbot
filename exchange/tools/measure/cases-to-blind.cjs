// cases-40.json -> 盲评题库（sim/blind.ts 读的格式）
//   node cases-to-blind.cjs <cases.json> <questions 输出.json>
// cases 的字段见 exchange/research/2026-10-real-chat/v2/cases-40.json：
//   { id, relation, scene, context[], stimulus[], human[], humanAt, sourceId, probe }
// 题库字段见 packages/bot/src/sim/blind.ts 的 BlindQuestion；这里只填它要的，human 不进来（它在答案侧比）。
const fs = require('node:fs');

const [casesPath, outPath] = process.argv.slice(2);
if (!casesPath || !outPath) {
    console.error('用法：node cases-to-blind.cjs <cases.json> <questions.json>');
    process.exit(2);
}
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

// 关系 → 档位 + 对方在她手机里的称呼；跟角色卡里的称呼一致（男朋友叫宝宝，其他人按名字）
const tierOf = (relation) => {
    const r = String(relation || '').toLowerCase();
    if (/partner|romantic|couple|boyfriend|girlfriend|情侣|恋人|对象/.test(r)) return { tier: 'boyfriend', user: '宝宝' };
    if (/bestie|闺蜜/.test(r)) return { tier: 'classmate', user: '思思' };
    if (/friend|朋友|同学/.test(r)) return { tier: 'classmate', user: '阿明' };
    return { tier: 'known', user: '阿明' };
};

// 时间：humanAt 往前推，每行隔 1–4 分钟（确定性，不用随机）
const backMinutes = (iso, steps) => new Date(Date.parse(iso) - steps * 60_000).toISOString().replace('Z', '+00:00');

const questions = cases.map((c) => {
    const { tier, user } = tierOf(c.relation);
    const lines = [];
    const ctx = (c.context ?? []).slice(-6);
    const stim = c.stimulus ?? [];
    // 上下文最晚的一条也要早于刺激里的第一条：上下文每 6 分钟一条、整体再往前错开 stimLen 分钟
    ctx.forEach((line, i) => {
        const who = /^女生[：:]/.test(line) ? '她' : '他';
        const text = line.replace(/^(男生|女生)[：:]\s*/, '');
        lines.push({ who, at: backMinutes(c.humanAt, (ctx.length - i) * 6 + stim.length), text });
    });
    // 刺激每 1 分钟一条，最后一条落在 humanAt 前 1 分钟（她随后回的）
    stim.forEach((text, i) => {
        lines.push({ who: '他', at: backMinutes(c.humanAt, (stim.length - i)), text });
    });
    return {
        id: c.id,
        relation: c.relation === 'partner' ? '男朋友' : '朋友',
        tier,
        user,
        scene: Number(c.scene ?? 1),
        lines,
        ...(c.probe ? { probe: c.probe } : {}),
        sourceId: c.sourceId,
    };
});

if (questions.length !== 40) throw new Error(`题数不是 40：${questions.length}`);
for (const q of questions) {
    if (!q.lines.length) throw new Error(`${q.id} 没有台词`);
    if (q.lines.at(-1).who !== '他') throw new Error(`${q.id} 最后一句不是他说的`);
}
fs.writeFileSync(outPath, JSON.stringify({
    version: 'cases-40/v1',
    note: '由 cases-40.json 生成：语料来自 exchange/research/2026-10-real-chat（真人），不含用户与她的私聊。冻结：只用来评，不拿来调参。',
    questions,
}, null, 1));
console.log(`写了 ${questions.length} 题到 ${outPath}`);
