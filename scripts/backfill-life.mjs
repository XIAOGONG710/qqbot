// 补她过去几天的日子（2026-10-30，用户：「让她加速跑一段时间」「再让她频繁上网学习」）。
// 不动物理时钟：按日期回放，给每一天补 2-3 件她自己的小事 + 一篇日记。
// 只写她自己的东西（不写"宝宝跟我说"），素材来自她已有的世界里的事（书、猫、课、拍照、B 站），不编大事件。
// 用法：node scripts/backfill-life.mjs --days 7 [--dry]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const DAYS = Number(flag('--days', 7));
const DRY = args.includes('--dry');

const SOUL = process.env.QQBOT_SOUL_DIR ?? path.join(process.env.USERPROFILE, '.dsh', 'linmengyao');
const JOURNAL = path.join(SOUL, 'JOURNAL.md');
const LIFE = path.join(SOUL, 'LIFE.json');
const PERSONA = path.join(SOUL, 'PERSONA.md');
const KEY = process.env.QQBOT_LLM_API_KEY;
if (!KEY) { console.error('缺少 QQBOT_LLM_API_KEY'); process.exit(2); }

const journal = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, 'utf8') : '';
const life = JSON.parse(fs.readFileSync(LIFE, 'utf8'));
const persona = fs.existsSync(PERSONA) ? fs.readFileSync(PERSONA, 'utf8').slice(0, 1500) : '';

const taken = new Set([...journal.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})/gm)].map(m => m[1]));
const recentOwn = life.events.map(e => String(e.text ?? '')).filter(t => t && !t.includes('跟我说')).slice(-6);

// 找最近 N 个「还没写过」的日子（从昨天往前数）
const days = [];
const cursor = new Date();
cursor.setDate(cursor.getDate() - 1);
while (days.length < DAYS) {
    const key = cursor.toISOString().slice(0, 10);
    if (!taken.has(key)) days.push({ date: key, weekday: '日一二三四五六'[cursor.getDay()] });
    cursor.setDate(cursor.getDate() - 1);
}
days.reverse();

console.log(`要补：${days.map(d => d.date).join('、')}`);
if (DRY) process.exit(0);

async function ask(day) {
    const prompt = `你是林梦瑶（设定见下），正在补记 ${day.date}（周${day.weekday}）那一天。

已知你最近自己在做的事：${recentOwn.join('；') || '（没有记录）'}

写那一天的：
1. 两条「我在做的事」，每条不超过 20 字，写成一两句口语，像自己随手记的（例如：「在宿舍看《药屋》第 11 卷。」「下楼喂了土豆。」）；
2. 一篇日记，100–150 字，口语，第一人称，写那天吃了什么、看了什么、猫怎么样、课上发生了什么（从素材里推，不编大奖、不编旅行、不编恋爱大事）。

只输出 JSON：{"events":["…","…"],"diary":"…"}
素材里没有的日子，就写平淡的一天（上课、吃饭、刷手机、睡觉），不要造大事件。

设定（节选）：
${persona}`;
    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: 'deepseek-flash', temperature: 0.7, max_tokens: 900, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
    });
    const body = await response.json();
    const text = body.choices?.[0]?.message?.content ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`模型没给 JSON：${text.slice(0, 100)}`);
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.events) || !parsed.events.length || !parsed.diary) throw new Error('JSON 缺字段');
    return { events: parsed.events.map(String).slice(0, 3), diary: String(parsed.diary) };
}

let added = 0;
const newEvents = [];
for (const day of days) {
    try {
        const result = await ask(day);
        // 事件：放在那天的 10:00–21:00 之间
        result.events.forEach((text, index) => {
            const at = new Date(`${day.date}T${String(10 + index * 4).padStart(2, '0')}:30:00+08:00`).getTime();
            newEvents.push({ at, text });
        });
        // 日记：按日期顺序追加到文件末尾（旧的在上面）
        fs.appendFileSync(JOURNAL, `\n## ${day.date}\n${result.diary.trim()}\n`);
        added++;
        console.log(`✓ ${day.date}：${result.events.length} 件小事 + 日记 ${result.diary.length} 字`);
    } catch (error) {
        console.log(`✗ ${day.date}：${error instanceof Error ? error.message : String(error)}`);
    }
}

// 事件并进 LIFE.json，按时间排序（原来的不动）
life.events = [...life.events, ...newEvents].sort((a, b) => a.at - b.at);
fs.writeFileSync(LIFE, JSON.stringify(life));
console.log(`补了 ${added}/${days.length} 天，LIFE 事件 +${newEvents.length}，日记在 ${JOURNAL}`);
