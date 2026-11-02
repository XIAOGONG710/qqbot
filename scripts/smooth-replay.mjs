// 「太顺 / 不敢损他」的尺子（ADR 0099 的方法，重建；ADR 0220）：拿真人情侣聊天（exchange/research/2026-10-real-chat/samples.jsonl 里 relation=boyfriend 的段落），
// 每一对「他说的一轮 → 真人女生回的一轮」生成一个模拟场景（前面最多 8 条上文，真人女生说的当她自己说的），让她回同一句；
// 再用另一个调用（DeepSeek，温度 0，不告诉它谁是真人）只看「他这一轮 → 回复」打标签。真人女生的原回复一起标，当对照。
//
// 用法（在仓库根目录）：
//   node scripts/smooth-replay.mjs gen <输出目录> <变体名> [plain 比例 | shapeShares 的 JSON]   → 生成场景文件
//   npm run sim -w @qqbot/bot -- <输出目录>/<变体名> --runs 2 --no-memory --parallel 8
//   node scripts/smooth-replay.mjs score <名字>=<sim 结果目录> [...]                 → 按变体汇总标签占比（要 QQBOT_LLM_API_KEY）
// 只读：不写任何线上状态、不发 QQ；场景和结果都在 runtime/ 下。
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = process.env.REAL_CHAT ?? join(root, '..', 'qqbot-exchange', 'exchange', 'research', '2026-10-real-chat', 'samples.jsonl');
const HISTORY_MAX = 8;

/** 真人聊天里的一对一对：他（不是 her 的那一方）说了一轮，紧接着她回了一轮 */
function pairs() {
    const segments = readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(s => s.relation === 'boyfriend');
    const out = [];
    for (const segment of segments) {
        const turns = segment.turns ?? [];
        for (let i = 1; i < turns.length; i++) {
            const his = turns[i - 1];
            const hers = turns[i];
            if (his.who === segment.her || hers.who !== segment.her) continue;
            const before = turns.slice(0, i - 1).flatMap(turn => (turn.bubbles ?? []).map(text => ({ role: turn.who === segment.her ? 'assistant' : 'user', text })));
            out.push({ id: `${segment.id}-${i}`, history: before.slice(-HISTORY_MAX), his: his.bubbles ?? [], real: (hers.bubbles ?? []).join(' / ') });
        }
    }
    return out;
}

function gen(dir, variant, shares) {
    const target = join(dir, variant);
    mkdirSync(target, { recursive: true });
    const start = Date.parse('2026-11-05T20:30:00+08:00');
    const list = pairs();
    list.forEach((pair, n) => {
        const history = pair.history.map((m, i) => ({ time: new Date(start - (pair.history.length - i) * 60_000).toISOString(), role: m.role, content: m.text }));
        const scenario = {
            name: `太顺尺子 ${variant} ${pair.id}`,
            tier: 'boyfriend', user: '宝宝', start: new Date(start).toISOString(), memory: false,
            shape: true, shapeAgenda: true, shapeFiller: true, shapeFeel: true, shapeSplit: true, herNo: true, texture: true,
            ...(shares !== undefined && Object.keys(shares).some(k => k !== 'all') ? { shapeShares: Object.fromEntries(Object.entries(shares).filter(([k]) => k !== 'all')) } : {}),
            ...(shares?.all ? { shapeAll: true } : {}),
            history,
            steps: [{ case: pair.id, note: pair.real }, { say: pair.his.length > 1 ? pair.his : pair.his[0] ?? '嗯' }, { check: { exitClean: true } }],
        };
        writeFileSync(join(target, `p${String(n + 1).padStart(3, '0')}.json`), JSON.stringify(scenario, null, 2));
    });
    writeFileSync(join(target, 'pairs.json'), JSON.stringify(list, null, 2));
    console.log(`${list.length} 对 → ${target}`);
}

const LABELS = ['完整接话', '表达情绪', '顺从让步', '带笑的损', '一句话驳回', '俏皮话', '带疑问句'];
const ANNOTATE = `下面是一对情侣聊天里的一轮：男生先说了一句，女生回了一句（「/」分开的是连着发的几条）。只看这一轮，判断女生的回复（可以多选）：
- 完整接话：把他这句话处理完整了（回答了、接住了、给了个完整的回应）
- 表达情绪：主要在表达她自己的情绪 / 态度（撒娇、委屈、嫌弃、开心、生气），不是在处理他的话
- 顺从让步：顺着他、让步、认错、答应照他说的做、马上附和他的批评或建议
- 带笑的损：拿他开玩笑、损他、嘴硬、怼他，但是玩笑的、亲昵的（不是真生气）
- 一句话驳回：一开口就把他的话驳回去（「不好笑」「随你」「想得美」「没你个头」这类），不接他的话
- 俏皮话：有俏皮、好玩的说法
- 带疑问句
只输出一个 JSON：{"labels":["上面的名字", ...]}，一个都不沾就输出 {"labels":[]}。`;

async function annotate(his, reply) {
    const key = process.env.QQBOT_LLM_API_KEY;
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ model: 'deepseek-flash', temperature: 0, max_tokens: 120, thinking: { type: 'disabled' }, messages: [{ role: 'system', content: ANNOTATE }, { role: 'user', content: `男生：${his}\n女生：${reply}` }] }),
        });
        const text = (await res.json())?.choices?.[0]?.message?.content ?? '';
        const match = text.match(/\{[\s\S]*\}/);
        if (match) { try { return (JSON.parse(match[0]).labels ?? []).filter(l => LABELS.includes(l)); } catch { /* 再来 */ } }
    }
    return undefined;
}

/** 一份 sim 结果目录里每个场景每一遍她回的话（报告里「- `时间` 她：……」的行） */
function repliesIn(dir) {
    const out = [];
    for (const scenario of readdirSync(dir)) {
        const sdir = join(dir, scenario);
        if (!existsSync(sdir) || !scenario.startsWith('p')) continue;
        for (const run of readdirSync(sdir).filter(name => /^r\d+$/.test(name))) {
            const report = join(sdir, run, 'report.md');
            if (!existsSync(report)) continue;
            const lines = readFileSync(report, 'utf8').split('\n').filter(line => /^- `[\d:]+` 她：/.test(line)).map(line => line.replace(/^- `[\d:]+` 她：/, ''));
            out.push({ scenario, run, reply: lines.join(' / ') });
        }
    }
    return out;
}

async function score(dirs) {
    const pairList = pairs();
    const byScenario = new Map(pairList.map((pair, n) => [`p${String(n + 1).padStart(3, '0')}`, pair]));
    const tally = async (name, items) => {
        const counts = Object.fromEntries(LABELS.map(l => [l, 0]));
        let done = 0;
        for (const item of items) {
            const labels = await annotate(item.his, item.reply);
            if (!labels) continue;
            done++;
            for (const label of labels) counts[label]++;
        }
        console.log(`${name}（${done} 条）：${LABELS.map(l => `${l} ${Math.round(100 * counts[l] / Math.max(1, done))}%`).join('，')}`);
        // 长短（不用模型）：一轮回复的字数中位、4 字以内的占比、一条里连问 2 句以上的占比
        const len = text => [...text.replace(/\s|\//g, '')].length;
        const asks = text => (text.match(/[?？]|吗(?=\s|\/|$)|呢(?=\s|\/|$)/g) || []).length;
        const lens = items.map(item => len(item.reply)).sort((x, y) => x - y);
        console.log(`  长短：字数中位 ${lens[Math.floor(lens.length / 2)]}，4 字以内 ${Math.round(100 * lens.filter(x => x <= 4).length / Math.max(1, lens.length))}%，连问 2 句以上 ${Math.round(100 * items.filter(item => asks(item.reply) >= 2).length / Math.max(1, items.length))}%`);
    };
    await tally('真人女生', pairList.map(pair => ({ his: pair.his.join(' / '), reply: pair.real })));
    // 每个参数是「名字=sim 结果目录」（npm run sim 跑一个变体，结果在 runtime/sim/<时间>/，里面是 p001/r1/report.md …）
    for (const arg of dirs) {
        const [name, dir] = arg.includes('=') ? arg.split('=') : [arg, arg];
        const items = repliesIn(dir).filter(item => item.reply).map(item => ({ his: (byScenario.get(item.scenario)?.his ?? []).join(' / '), reply: item.reply }));
        await tally(name, items);
    }
}

const [command, ...args] = process.argv.slice(2);
// 第三个参数：一个数（plain 比例），或者 JSON（{"feel":0.5,"plain":0.35}，整个当 shapeShares）
if (command === 'gen') gen(args[0], args[1], args[2] === undefined ? undefined : args[2].trim().startsWith('{') ? JSON.parse(args[2]) : { plain: Number(args[2]) });
else if (command === 'score') await score(args);
else console.log('用法见文件开头');
