// ginka 网关的对比测试（2026-10-31）：同一组任务，换模型跑，记延迟 / token / 输出
// 免费组 10:00–12:00 / 14:00–23:30 开放；关着会 403，脚本直接说清楚。
// 用法：node scripts/ginka-bench.mjs [--out 结果.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SECRET = join(process.env.USERPROFILE ?? '', 'Desktop', 'qqbot-dsh-control', 'runtime', 'bot-shadow', 'secrets', 'ginka.json');
const secret = JSON.parse(readFileSync(SECRET, 'utf8'));
const base = secret.baseUrl.replace(/\/+$/, '');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const out = arg('--out', join(process.env.USERPROFILE ?? '', 'Desktop', 'qqbot-dsh-control', 'runtime', 'bot-shadow', 'ginka-bench.json'));

const MODELS = ['deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro'];
const TASKS = [
    {
        name: '摘要（结构化）',
        prompt: '把下面这段压成三行要点，每行不超过 20 字，不要客套：\n她晚上写日记的时候会先把白天的事排一遍，挑一两件说清楚，剩下的写成一句带过；写完会翻前一晚的，看自己昨天在琢磨什么；如果那天跟他聊得多，日记里就会多一段他的事，但不会原样引他的话。',
    },
    {
        name: '抽取（JSON）',
        prompt: '从下面这句话里抽出 JSON，键只有 kind 和 reason：\n"她今天没去上课，因为前一晚整理资料到三点，早上实在起不来。"',
    },
    {
        name: '口气（像她）',
        prompt: '用 20 字以内回一句：他说"我今天有点累"。你要像林梦瑶（嘴硬心软、讨厌太长）那样回，只说这一句。',
    },
    {
        name: '算术（简单）',
        prompt: '只输出数字：一箱 24 瓶，喝了 5 瓶，又买了两箱，现在一共多少瓶？',
    },
];

async function run(model, task) {
    const started = Date.now();
    let response;
    try {
        response = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.apiKey}` },
            body: JSON.stringify({ model, temperature: 0.3, max_tokens: 500, messages: [{ role: 'user', content: task.prompt }] }),
            signal: AbortSignal.timeout(60_000),
        });
    } catch (error) {
        return { ok: false, error: String(error).slice(0, 120), ms: Date.now() - started };
    }
    const ms = Date.now() - started;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, error: JSON.stringify(body).slice(0, 200), ms };
    const text = body.choices?.[0]?.message?.content ?? '';
    return { ok: true, ms, tokens: body.usage?.total_tokens ?? null, chars: [...text].length, text: text.trim().slice(0, 200) };
}

const results = [];
for (const model of MODELS) {
    for (const task of TASKS) {
        const result = await run(model, task);
        results.push({ model, task: task.name, ...result });
        console.log(`${result.ok ? '✓' : '✗'} ${model} / ${task.name} ${result.ms}ms ${result.ok ? `${result.tokens} tok` : result.error?.slice(0, 80)}`);
    }
}

const ok = results.filter(item => item.ok);
const byModel = MODELS.map(model => {
    const mine = ok.filter(item => item.model === model);
    const avg = mine.length ? Math.round(mine.reduce((sum, item) => sum + item.ms, 0) / mine.length) : null;
    return { model, 成功: `${mine.length}/${TASKS.length}`, 平均毫秒: avg, 总token: mine.reduce((sum, item) => sum + (item.tokens ?? 0), 0) };
});
console.log('\n模型         成功   平均毫秒  总token');
for (const row of byModel) console.log(`${row.model.padEnd(20)} ${String(row.成功).padEnd(6)} ${String(row.平均毫秒).padEnd(9)} ${row.总token}`);
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), byModel, results }, null, 1));
console.log(`\n结果写到 ${out}`);
