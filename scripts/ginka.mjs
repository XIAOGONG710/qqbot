// 用 ginka 网关跑一次模型（2026-10-31 用户：「让子代理用他，或者你自己开新会话使用，反正是免费的，使劲用」）
//
// 用途：把不需要我本人思考质量的活（长文摘要、批量分类、抽取要点、生成变体）扔给它，省主线路的额度。
// 密钥在 runtime/bot-shadow/secrets/ginka.json（不入库）。
//
// 用法：
//   node scripts/ginka.mjs --model deepseek-v4-flash --prompt "你好"
//   echo "要总结的长文" | node scripts/ginka.mjs --model deepseek-v4-flash --stdin
//   node scripts/ginka.mjs --list
//
// 注意：免费组只在 10:00–12:00 / 14:00–23:30（北京时间）开放，关着会返回 403，脚本会把原因打出来。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SECRET = join(process.env.USERPROFILE ?? '', '.dsh', '..', 'Desktop', 'qqbot-dsh-control', 'runtime', 'bot-shadow', 'secrets', 'ginka.json');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(name);

let secret;
try { secret = JSON.parse(readFileSync(SECRET, 'utf8')); } catch {
    console.error(`读不到密钥：${SECRET}`);
    process.exit(2);
}
const base = (arg('--base', secret.baseUrl) ?? '').replace(/\/+$/, '');
const key = secret.apiKey;
const model = arg('--model', 'deepseek-v4-flash');

if (has('--list')) {
    const response = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    console.log(response.status, JSON.stringify(await response.json()).slice(0, 500));
    process.exit(0);
}

const prompt = has('--stdin')
    ? readFileSync(0, 'utf8')
    : arg('--prompt', args.filter(a => !a.startsWith('--') && a !== model)[0] ?? '');
if (!prompt.trim()) { console.error('没有 prompt：用 --prompt 或 --stdin'); process.exit(2); }

const started = Date.now();
const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
        model,
        temperature: Number(arg('--temperature', '0.3')),
        max_tokens: Number(arg('--max-tokens', '1500')),
        messages: [
            ...(arg('--system') ? [{ role: 'system', content: arg('--system') }] : []),
            { role: 'user', content: prompt },
        ],
    }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
    console.error(`失败 ${response.status}：${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
}
const text = body.choices?.[0]?.message?.content ?? '';
const usage = body.usage ?? {};
console.error(`[ginka] ${model} ${Date.now() - started}ms, tokens=${usage.total_tokens ?? '?'}`);
console.log(text);
