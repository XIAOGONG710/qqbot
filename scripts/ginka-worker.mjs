// 让免费线路不闲下来（2026-10-31 用户：「不要让免费模型闲下来，不停地给它安排工作」）
//
// 一个常驻工人：队列里有活就干，没活就等下一个开放时段；窗口关着就睡到下一个窗口。
// 队列是磁盘上的 JSON，工人自己会从源码树里补活（--rebuild），永远有下一段。
//
//   node scripts/ginka-worker.mjs --rebuild     # 扫一遍仓库补活（源码审阅、ADR 摘要、语料分析…）
//   node scripts/ginka-worker.mjs               # 常驻：一直干到队列空，然后等窗口
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(process.env.USERPROFILE ?? '', 'Desktop', 'qqbot-dsh-control');
const SECRET = join(REPO, 'runtime', 'bot-shadow', 'secrets', 'ginka.json');
const QUEUE = join(REPO, 'runtime', 'ginka-queue.json');
const OUT = join(REPO, 'runtime', 'ginka-batch-live');
const LOG = join(REPO, 'runtime', 'ginka-worker.log');
const MODEL = process.env.GINKA_MODEL ?? 'deepseek-v4-flash';
const CONCURRENCY = Number(process.env.GINKA_CONCURRENCY ?? '3');
const secret = JSON.parse(readFileSync(SECRET, 'utf8'));
const base = secret.baseUrl.replace(/\/+$/, '');
mkdirSync(OUT, { recursive: true });

import { renameSync } from 'node:fs';
let writing = Promise.resolve();
/** 原子写队列：先写临时文件再改名，避免写一半被杀导致 JSON 坏掉 */
function saveQueue(queue) {
    writing = writing.then(() => {
        const tmp = `${QUEUE}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(queue));
        renameSync(tmp, QUEUE);
    }).catch(() => undefined);
    return writing;
}
function loadQueue() {
    try { return JSON.parse(readFileSync(QUEUE, 'utf8')); } catch { return undefined; }
}

const log = (line) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch { /* 日志写不进去不影响干活 */ } };
const say = (line) => { console.log(line); log(line); };

/** 免费组：10:00–12:00、14:00–23:30（北京时间） */
function windowOpen(now = new Date()) {
    const hour = now.getHours() + now.getMinutes() / 60;
    return (hour >= 10 && hour < 12) || (hour >= 14 && hour < 23.5);
}
function msToNextWindow(now = new Date()) {
    const next = new Date(now);
    const hour = now.getHours() + now.getMinutes() / 60;
    if (hour >= 23.5) { next.setDate(next.getDate() + 1); next.setHours(10, 0, 30, 0); }
    else if (hour >= 12 && hour < 14) next.setHours(14, 0, 30, 0);
    else next.setHours(10, 0, 30, 0);
    return Math.max(60_000, next.getTime() - now.getTime());
}

// ───────── 补活：把仓库里能审的东西排成队 ─────────
/** 每一轮换一个角度问同一份代码（用户：「没有要做的就做新的」）：不做完同一遍就重复同一遍 */
const PRESETS = [
    { name: '代码审阅', system: '你是严谨的 TypeScript 审阅者，只报真实风险。', prompt: '审阅这段代码：只报真实的 bug、边界情况（空/NaN/时区/并发/路径）和能删掉的复杂度。每条写清函数名和触发条件，不要风格意见。不超过 250 字。' },
    { name: '可简化点', system: '你是重构审阅者。', prompt: '这份代码里有哪些可以删掉/合并的东西？（重复逻辑、过度抽象、一次性包装、没人用的参数）每条给函数名和「删掉之后少什么」。不超过 250 字。' },
    { name: '缺什么测试', system: '你是测试设计者。', prompt: '这份代码最该补的 3 个测试是什么？每条写：测什么、怎么构造输入、会抓到什么 bug。不超过 250 字。' },
    { name: '名字与注释', system: '你是代码可读性审阅者。', prompt: '这份代码里有哪些命名/注释是不准确或会误导后来人的？每条给原文 + 建议改法。不超过 250 字。' },
    { name: '性能与 IO', system: '你是性能审阅者。', prompt: '这份代码有没有每轮重复读文件、大数组遍历、同步 IO 阻塞、没必要的网络请求？每条给函数名和后果。不超过 250 字。' },
];
const ADR_PROMPT = '把这份 ADR 压成三行：① 它决定了什么 ② 为什么 ③ 现在还有效吗（有没有被后来的改动推翻）。不超过 200 字。';
const CORPUS_PROMPT = '这段是她的真实语料或聊天记录。只找「不像真人」的具体表现（太长、像作文、客服腔、空附和），引原文 + 一句话怎么改。不超过 250 字。';

function walk(dir, filter, out = []) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const full = join(dir, name);
        const info = statSync(full);
        if (info.isDirectory()) walk(full, filter, out);
        else if (filter(name)) out.push(full);
    }
    return out;
}

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

let round = 0;
function rebuild() {
    const previous = loadQueue();
    const tasks = [];
    const add = (name, system, prompt, file, part, of, body) => tasks.push({ id: `${name}|${relative(REPO, file)}|${part}`, name, system, prompt: `${prompt}\n\n=== ${relative(REPO, file)} ${part}/${of} ===\n${body}`, status: 'pending' });

    // 每次补活用下一轮预设：同一份代码换角度问，才不会一遍遍重复同样的结论
    let nextRound = 0;
    try { if (previous) nextRound = (previous.round ?? 0) + 1; } catch { nextRound = 0; }
    const preset = PRESETS[nextRound % PRESETS.length];
    for (const file of walk(join(REPO, 'packages'), n => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
        const parts = chunks(readFileSync(file, 'utf8'), 3500);
        parts.forEach((body, index) => add(preset.name, preset.system, preset.prompt, file, index + 1, parts.length, body));
    }
    for (const file of walk(join(REPO, 'docs', 'adr'), n => n.endsWith('.md'))) {
        const body = readFileSync(file, 'utf8');
        if (body.length < 400) continue;
        add('ADR 摘要', '你是技术文档编辑。', ADR_PROMPT, file, 1, 1, body.slice(0, 9000));
    }
    for (const file of [join(REPO, 'runtime', 'bot-shadow', 'exemplars', 'corpus.jsonl'), join(REPO, 'runtime', 'bot-shadow', 'chats', '2260168937.jsonl')]) {
        if (!existsSync(file)) continue;
        const parts = chunks(readFileSync(file, 'utf8'), 12000);
        parts.forEach((body, index) => add('语料诊断', '你是中文对话风格分析者。', CORPUS_PROMPT, file, index + 1, parts.length, body));
    }
    void saveQueue({ at: new Date().toISOString(), round: nextRound, tasks });
    round = nextRound;
    say(`补活：${tasks.length} 段（本轮角度：${preset.name}；ADR 摘要 / 语料诊断随附）`);
    return nextRound;
}

// ───────── 干活 ─────────
async function ask(task) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.apiKey}` },
                body: JSON.stringify({ model: MODEL, temperature: 0.3, max_tokens: 2400, thinking: { type: 'disabled' }, messages: [{ role: 'system', content: task.system }, { role: 'user', content: task.prompt }] }),
                signal: AbortSignal.timeout(180_000),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (response.status === 403) return { closed: true };
                if (response.status === 429) { await new Promise(r => setTimeout(r, 5000 * attempt)); continue; }
                return { error: `${response.status} ${JSON.stringify(body).slice(0, 120)}` };
            }
            const text = body.choices?.[0]?.message?.content ?? '';
            if (text.trim()) return { text, tokens: body.usage?.total_tokens ?? null };
            await new Promise(r => setTimeout(r, 1500 * attempt));
        } catch (error) {
            if (attempt === 3) return { error: String(error).slice(0, 120) };
            await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
    return { error: '重试完没成' };
}

const state = { done: 0, failed: 0 };
async function runOnce() {
    const queue = loadQueue();
    if (!queue?.tasks) return 0;
    const pending = queue.tasks.filter(task => task.status === 'pending');
    if (!pending.length) return 0;
    let next = 0;
    async function worker() {
        while (next < pending.length) {
            if (!windowOpen()) return;
            const task = pending[next++];
            const result = await ask(task);
            if (result.closed) { say('窗口关了，先睡'); return; }
            const file = join(OUT, `${task.id.replace(/[\\/:|]/g, '_')}.md`);
            if (result.text) {
                writeFileSync(file, `# ${task.name} · ${task.id.split('|')[1]} 第 ${task.id.split('|')[2]} 段\n\n${result.text}\n`);
                task.status = 'done';
                state.done++;
                say(`✓ ${task.name} ${task.id.split('|')[1]}#${task.id.split('|')[2]}（${result.tokens ?? '?'} tok，累计 ${state.done}）`);
            } else {
                task.status = 'failed';
                task.error = result.error;
                state.failed++;
                say(`✗ ${task.id} ${result.error}`);
            }
            // 每完成一段就落盘，进程被杀也不丢进度
            queue.tasks = queue.tasks.map(item => (item.id === task.id ? task : item));
            await saveQueue(queue);
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    return pending.length;
}

if (process.argv.includes('--rebuild') || !existsSync(QUEUE)) rebuild();

say(`工人上线：模型 ${MODEL}，并发 ${CONCURRENCY}，队列 ${loadQueue()?.tasks.length ?? 0} 段`);
for (;;) {
    if (!windowOpen()) {
        const wait = msToNextWindow();
        say(`现在不在免费时段，${Math.round(wait / 60000)} 分钟后再来`);
        await new Promise(r => setTimeout(r, Math.min(wait, 30 * 60_000)));
        continue;
    }
    const pending = await runOnce();
    if (!pending) {
        const fresh = rebuild();
        say(`队列空了，补下一种活（第 ${fresh} 轮）`);
        continue;
    }
    // 有活但这一轮窗口关了：等下一次窗口
    await new Promise(r => setTimeout(r, 60_000));
}
