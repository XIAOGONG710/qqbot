// 用免费网关跑一批活（2026-10-31 用户：「到点直接多开子代理，用这个免费的疯狂蹬」）
//
// 思路：子代理本身走不了 ginka（它们继承主线），但**它们的 shell 能**。
// 所以这里把「批量」做成一个驱动：读一个清单，把每个文件切段，并发扔给 ginka，结果按任务落盘。
// 主线只花很小的额度（谁跑、跑什么），大头都在免费的 ginka 上。
//
// 清单（JSON）：
// [
//   { "name": "exemplars", "files": ["runtime/bot-shadow/exemplars/corpus.jsonl"], "system": "…", "prompt": "…", "chunk": 4000 },
//   { "name": "code-review", "files": ["packages/bot/src/language/reply.ts"], "prompt": "找 bug 和可简化的地方", "chunk": 6000 }
// ]
//
// 用法：node scripts/ginka-batch.mjs --manifest scripts/ginka-tasks.json [--model deepseek-v4-pro] [--concurrency 4]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

/** 清单里给目录时，展开成目录里的文本文件（一层，按名字排序） */
function expand(path) {
    try {
        if (!statSync(path).isDirectory()) return [path];
        return readdirSync(path)
            .filter(name => /\.(md|txt|jsonl|json|ts|mjs)$/.test(name))
            .sort()
            .slice(0, 20)
            .map(name => join(path, name));
    } catch { return [path]; }
}

const SECRET = join(process.env.USERPROFILE ?? '', 'Desktop', 'qqbot-dsh-control', 'runtime', 'bot-shadow', 'secrets', 'ginka.json');
const secret = JSON.parse(readFileSync(SECRET, 'utf8'));
const base = secret.baseUrl.replace(/\/+$/, '');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const manifestPath = arg('--manifest');
const model = arg('--model', 'deepseek-v4-flash');
const concurrency = Number(arg('--concurrency', '4'));
const outDir = arg('--out', join(process.env.USERPROFILE ?? '', 'Desktop', 'qqbot-dsh-control', 'runtime', 'ginka-batch'));
if (!manifestPath || !existsSync(manifestPath)) { console.error('用法：--manifest <清单.json>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const tasks = JSON.parse(readFileSync(manifestPath, 'utf8'));

/** 按字符切段，尽量在换行处断 */
function chunks(text, size) {
    const pieces = [];
    let rest = text;
    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = size;
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest.trim()) pieces.push(rest);
    return pieces;
}

async function ask(system, prompt) {
    const started = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.apiKey}` },
                body: JSON.stringify({
                    model, temperature: 0.3, max_tokens: 2000,
                    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
                }),
                signal: AbortSignal.timeout(120_000),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (response.status === 429) { await new Promise(r => setTimeout(r, 3000 * attempt)); continue; }
                return { ok: false, ms: Date.now() - started, error: `${response.status} ${JSON.stringify(body).slice(0, 160)}` };
            }
            const text = body.choices?.[0]?.message?.content ?? '';
            // 2026-10-31：有几段返回 200 但正文是空的（模型只在 thinking 里想完就被截断）——重试一次，明确要求直接输出
            if (!text.trim() && attempt < 3) {
                const retry = await fetch(`${base}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.apiKey}` },
                    body: JSON.stringify({
                        model, temperature: 0.2, max_tokens: 2000,
                        messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: `${prompt}

（不要描述思考过程，直接给结论。）` }],
                    }),
                    signal: AbortSignal.timeout(120_000),
                });
                const again = await retry.json().catch(() => ({}));
                const retried = again.choices?.[0]?.message?.content ?? '';
                if (retried.trim()) return { ok: true, ms: Date.now() - started, text: retried, tokens: again.usage?.total_tokens ?? null };
                continue;
            }
            return { ok: true, ms: Date.now() - started, text, tokens: body.usage?.total_tokens ?? null };
        } catch (error) {
            if (attempt === 3) return { ok: false, ms: Date.now() - started, error: String(error).slice(0, 160) };
            await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
    return { ok: false, ms: Date.now() - started, error: '重试完没成' };
}

const jobs = [];
for (const task of tasks) {
    const files = task.files ?? [];
    if (!files.length) {
        jobs.push({ task: task.name, part: 0, prompt: task.prompt, system: task.system });
        continue;
    }
    for (const file of files.flatMap(expand)) {
        if (!existsSync(file)) { console.error(`跳过（没这个文件）：${file}`); continue; }
        const parts = chunks(readFileSync(file, 'utf8'), task.chunk ?? 5000);
        parts.forEach((part, index) => {
            jobs.push({
                task: task.name, part: index + 1, of: parts.length, file: basename(file), system: task.system,
                prompt: `${task.prompt ?? ''}\n\n=== ${basename(file)} 第 ${index + 1}/${parts.length} 段 ===\n${part}`,
            });
        });
    }
}

console.log(`清单 ${tasks.length} 个任务 → ${jobs.length} 段；模型 ${model}，并发 ${concurrency}`);

let next = 0;
const results = [];
async function worker(id) {
    while (next < jobs.length) {
        const index = next++;
        const job = jobs[index];
        const result = await ask(job.system, job.prompt);
        const name = `${job.task}-${String(job.part).padStart(2, '0')}${job.of ? `of${job.of}` : ''}.md`;
        if (result.ok) {
            writeFileSync(join(outDir, name), `# ${job.task} ${job.file ?? ''} 第 ${job.part} 段\n\n${result.text}\n`);
            console.log(`✓ [w${id}] ${name} ${result.ms}ms ${result.tokens ?? '?'} tok`);
        } else {
            writeFileSync(join(outDir, name.replace(/\.md$/, '.error.txt')), `${result.error}\n`);
            console.log(`✗ [w${id}] ${name} ${result.error}`);
        }
        results.push({ ...job, ...result, prompt: undefined });
    }
}
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(jobs.length, 1)) }, (_, i) => worker(i)));
writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), model, jobs: results.length, ok: results.filter(r => r.ok).length }, null, 1));
console.log(`\n完成 ${results.filter(r => r.ok).length}/${results.length}，结果在 ${outDir}`);
