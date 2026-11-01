// 浏览器里看她的后台（2026-10-31 用户：「我还是看不见」——终端窗口靠不住，改成网页）
//   node scripts/live-view.mjs [端口]
// 打开 http://127.0.0.1:7799/ 就是实时日志 + 这一轮的完整提示词，每 2 秒自己刷新。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd();
const port = Number(process.argv[2] ?? 7799);
const logFile = join(repo, 'runtime', 'bot-shadow', 'logs', `${new Date().toISOString().slice(0, 10)}.log`);
const promptFile = join(repo, 'runtime', 'bot-shadow', 'last-prompt.json');

const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const page = `<!doctype html><meta charset="utf-8"><title>她的后台</title>
<style>
body{margin:0;background:#0f1115;color:#e6e6e6;font:13px/1.5 Consolas,Menlo,monospace}
header{padding:8px 12px;background:#171a21;border-bottom:1px solid #262b36;display:flex;gap:16px;align-items:center}
header b{color:#8fd6ff}header span{color:#7d8595}
main{display:grid;grid-template-columns:1fr 1fr;height:calc(100vh - 36px)}
section{overflow:auto;padding:8px 12px;border-right:1px solid #262b36}
h2{font-size:12px;color:#8fd6ff;margin:4px 0 8px;position:sticky;top:0;background:#0f1115;padding:4px 0}
pre{white-space:pre-wrap;word-break:break-word;margin:0}
.log{color:#b9c2d0}.warn{color:#ffd479}.err{color:#ff7a7a}
.msg{border-left:2px solid #2d3442;margin:6px 0;padding-left:8px}
.role{color:#8fd6ff}.user{color:#ffd479}.assistant{color:#7ee787}.system{color:#9aa4b2}
#prompt{white-space:pre-wrap}
</style>
<header><b>她的后台</b><span id="stamp">加载中…</span><span>日志每 2 秒刷新 · 完整提示词同步</span></header>
<main>
<section><h2>日志（生成回复 / 心境 / 形状 / 命令）</h2><pre class="log" id="log"></pre></section>
<section><h2>这一轮的完整提示词（她真正看到的）</h2><div id="prompt"></div></section>
</main>
<script>
async function tick() {
  try {
    const log = await (await fetch('/log')).text();
    document.getElementById('log').innerHTML = log.split('\\n').map(l => {
      const cls = /失败|出错|错误|没成/.test(l) ? 'err' : /慎重|警告|冷却/.test(l) ? 'warn' : 'log';
      return '<span class="' + cls + '">' + l + '</span>';
    }).join('\\n');
  } catch {}
  try {
    const prompt = await (await fetch('/prompt')).json();
    const el = document.getElementById('prompt');
    if (!prompt.messages) { el.textContent = prompt.note ?? '还没有生成过回复。'; }
    else {
      el.innerHTML = '<div class="msg"><b class="system">共 ' + prompt.messages.length + ' 条消息</b> ' +
        (prompt.note ? '<span style="color:#7d8595">' + prompt.note + '</span>' : '') + '</div>' +
        prompt.messages.map((m, i) => '<div class="msg"><b class="' + m.role + '">#' + (i + 1) + ' ' + m.role + '</b> <span style="color:#7d8595">(' + [...(m.content || '')].length + ' 字)</span><pre>' + (m.content || '') + '</pre></div>').join('');
    }
  } catch {}
  document.getElementById('stamp').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
tick(); setInterval(tick, 2000);
</script>`;

createServer((req, res) => {
    if (req.url === '/log') {
        const lines = read(logFile).split('\n').slice(-120).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(esc(lines));
        return;
    }
    if (req.url === '/prompt') {
        const raw = read(promptFile);
        let body;
        try { body = raw ? JSON.parse(raw) : { note: '还没有 last-prompt.json（说一句话让她生成一轮）' }; }
        catch { body = { note: 'last-prompt.json 读不出来' }; }
        // 消息正文里可能有 HTML：前端用 pre 输出，这里预转义
        if (Array.isArray(body.messages)) body.messages = body.messages.map(m => ({ ...m, content: esc(String(m.content ?? '')) }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
}).listen(port, '127.0.0.1', () => console.log(`她的后台：http://127.0.0.1:${port}/`));
