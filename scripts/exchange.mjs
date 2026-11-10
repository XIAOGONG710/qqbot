#!/usr/bin/env node
// 两台机器上的 agent（这台 Claude、国内那台 DSH）经由 Git 互相留言，不用用户传话。
// 设计见 docs/governance/2026-11-10-agent-mailbox.md。
//
//   node scripts/exchange.mjs check --me claude [--throttle 600] [--quiet]
//       fetch 远端，列出上次看过之后 origin/main 的新提交、还没拉到本地的提交、发给我且未办完的留言。
//       --throttle N：距上次检查不足 N 秒就什么都不做（给每轮对话的钩子用）。
//       --quiet：没有新东西就不输出。
//   node scripts/exchange.mjs send --me claude --to dsh --title "…" [--re <提交或留言文件>] [--body "…" | 从标准输入读]
//       在 exchange/inbox/ 写一条留言，只提交这一个文件，pull --rebase 后推送。
//   node scripts/exchange.mjs done <留言文件名> --me claude [--body "回话"]
//       把这条留言标成已办；带 --body 时同时回一条给对方。一次提交，推送。
//   node scripts/exchange.mjs list [--me claude] [--all]
//       列出留言（默认只列未办的）。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENTS = ['claude', 'dsh'];
export const INBOX = 'exchange/inbox';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = join(ROOT, 'runtime', 'exchange');

// ---------- 纯函数（有测试） ----------

export function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) out[key] = true;
            else { out[key] = next; i++; }
        } else out._.push(a);
    }
    return out;
}

export function slugify(title) {
    const s = String(title)
        .replace(/[\\/:*?"<>|\s#%&{}$!'`@+=,;[\]（）()【】「」『』，。、：；！？“”‘’]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return [...s].slice(0, 40).join('') || 'note';
}

const pad = (n) => String(n).padStart(2, '0');
// 文件名和正文里的时间都按 UTC+8 写，两台机器（东京 / 国内）看到同一个钟点。
export function stamp(date = new Date()) {
    const t = new Date(date.getTime() + 8 * 3600_000);
    const day = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    const hm = `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}`;
    return { day, hm, human: `${day} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} (UTC+8)` };
}

export function messageFileName({ from, to, title, date = new Date() }) {
    const { day, hm } = stamp(date);
    return `${day}-${hm}-${from}-to-${to}-${slugify(title)}.md`;
}

export function renderMessage({ from, to, title, body, re, date = new Date() }) {
    const head = [
        '---',
        `from: ${from}`,
        `to: ${to}`,
        `date: ${stamp(date).human}`,
        ...(re ? [`re: ${re}`] : []),
        'status: open',
        '---',
        '',
        `# ${title}`,
        '',
    ];
    return head.join('\n') + '\n' + String(body ?? '').trim() + '\n';
}

export function parseMessage(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { meta, body: m[2] };
}

export function markDone(text, { by, date = new Date(), note }) {
    const { meta } = parseMessage(text);
    if (!meta.status) throw new Error('不是留言文件（没有 status 字段）');
    const done = text.replace(/^status: .*$/m, `status: done（${by}，${stamp(date).human}）`);
    return note ? `${done.trimEnd()}\n\n> 已办：${note}\n` : done;
}

export function isForMe(meta, me) {
    return meta.to === me || meta.to === 'both';
}

export const isOpen = (meta) => String(meta.status ?? '').startsWith('open');

// ---------- Git ----------

function git(args, opts = {}) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
const tryGit = (args) => { try { return git(args); } catch { return null; } };

function readState(me) {
    try { return JSON.parse(readFileSync(join(STATE_DIR, `${me}.json`), 'utf8')); } catch { return {}; }
}
function writeState(me, state) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, `${me}.json`), JSON.stringify(state, null, 2));
}

function inboxAt(ref) {
    const names = tryGit(['ls-tree', '--name-only', `${ref}:${INBOX}`]);
    if (!names) return [];
    return names.split('\n').filter((n) => n.endsWith('.md') && n !== 'README.md').map((name) => {
        const text = tryGit(['show', `${ref}:${INBOX}/${name}`]) ?? '';
        const { meta, body } = parseMessage(text);
        return { name, meta, body };
    });
}

function requireMe(args) {
    const me = args.me ?? process.env.QQBOT_AGENT;
    if (!AGENTS.includes(me)) throw new Error(`要用 --me ${AGENTS.join('|')}（或环境变量 QQBOT_AGENT）说明你是哪台`);
    return me;
}

function commitAndPush(paths, message) {
    git(['add', '--', ...paths]);
    git(['commit', '-m', message, '--', ...paths]);
    for (let i = 0; i < 3; i++) {
        try { git(['pull', '--rebase', '--autostash', 'origin', 'main']); } catch (e) {
            throw new Error(`pull --rebase 失败，请手动处理后再推：${e.stderr || e.message}`);
        }
        try { git(['push', 'origin', 'HEAD:main']); return; } catch { /* 被拒就再拉一次 */ }
    }
    throw new Error('推了三次都被拒，请手动 pull --rebase 再 push（不要强推）');
}

// ---------- 子命令 ----------

function check(args) {
    const me = requireMe(args);
    const state = readState(me);
    const now = Date.now();
    const throttle = Number(args.throttle ?? 0);
    if (throttle && state.checkedAt && now - state.checkedAt < throttle * 1000) return;

    const fetched = tryGit(['fetch', '--quiet', '--prune', '--tags', 'origin']) !== null;
    const remote = tryGit(['rev-parse', 'origin/main']);
    const lines = [];
    if (!fetched) lines.push('（git fetch 失败，下面是上次拿到的远端状态）');

    if (remote && state.seen && state.seen !== remote) {
        const range = tryGit(['merge-base', '--is-ancestor', state.seen, remote]) !== null ? `${state.seen}..${remote}` : remote;
        const log = tryGit(['log', '--format=%h %ad %s', '--date=format:%m-%d %H:%M', '-30', range]);
        if (log) lines.push(`origin/main 上次看过之后的新提交：\n${log.replace(/^/gm, '  ')}`);
    }
    const behind = tryGit(['rev-list', '--count', 'HEAD..origin/main']);
    if (behind && behind !== '0') lines.push(`本地落后 origin/main ${behind} 个提交，动手前先 git pull --rebase。`);

    const open = inboxAt('origin/main').filter((m) => isForMe(m.meta, me) && isOpen(m.meta) && m.meta.from !== me);
    if (open.length) {
        lines.push(`发给 ${me}、还没办完的留言 ${open.length} 条（${INBOX}/，办完用 done 标掉）：`);
        for (const m of open) {
            const title = (/^# (.*)$/m.exec(m.body) ?? [])[1] ?? '';
            const fresh = !(state.shown ?? []).includes(m.name);
            lines.push(`  ${fresh ? '[新] ' : ''}${m.name}${title ? ` — ${title}` : ''}`);
            if (fresh) lines.push(m.body.trim().split('\n').slice(1).join('\n').trim().replace(/^/gm, '      '));
        }
    }

    writeState(me, { ...state, checkedAt: now, seen: remote ?? state.seen, shown: open.map((m) => m.name) });
    if (!state.seen && !args.quiet) lines.unshift(`（${me} 第一次检查，从 ${remote?.slice(0, 8)} 开始记）`);
    if (lines.length) console.log(`【另一台的动静】\n${lines.join('\n')}`);
    else if (!args.quiet) console.log('【另一台的动静】没有新提交，也没有给你的留言。');
}

function readStdin() {
    if (process.stdin.isTTY) return '';
    try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function send(args) {
    const me = requireMe(args);
    const to = args.to;
    if (![...AGENTS, 'both'].includes(to) || to === me) throw new Error('--to 要写对方（claude / dsh / both）');
    if (!args.title || args.title === true) throw new Error('要有 --title');
    const body = typeof args.body === 'string' ? args.body : readStdin();
    const name = messageFileName({ from: me, to, title: args.title });
    const rel = `${INBOX}/${name}`;
    mkdirSync(join(ROOT, INBOX), { recursive: true });
    if (existsSync(join(ROOT, rel))) throw new Error(`${rel} 已存在`);
    writeFileSync(join(ROOT, rel), renderMessage({ from: me, to, title: args.title, body, re: args.re === true ? undefined : args.re }));
    commitAndPush([rel], `exchange(${me}→${to}): ${args.title}`);
    console.log(`已留言并推送：${rel}`);
}

function done(args) {
    const me = requireMe(args);
    const name = args._[1];
    if (!name) throw new Error('用法：done <留言文件名> --me …');
    const rel = `${INBOX}/${name.replace(/^.*[\\/]/, '')}`;
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) throw new Error(`本地没有 ${rel}，先 git pull --rebase`);
    const text = readFileSync(abs, 'utf8');
    const { meta } = parseMessage(text);
    const note = typeof args.body === 'string' ? args.body : undefined;
    writeFileSync(abs, markDone(text, { by: me, note }));
    const paths = [rel];
    if (note && meta.from && meta.from !== me) {
        const title = `回：${(/^# (.*)$/m.exec(text) ?? [])[1] ?? name}`;
        const reply = `${INBOX}/${messageFileName({ from: me, to: meta.from, title })}`;
        writeFileSync(join(ROOT, reply), renderMessage({ from: me, to: meta.from, title, body: note, re: name }));
        paths.push(reply);
    }
    commitAndPush(paths, `exchange(${me}): done ${name}`);
    console.log(`已标为办完并推送：${paths.join('、')}`);
}

function list(args) {
    const me = args.me ?? process.env.QQBOT_AGENT;
    tryGit(['fetch', '--quiet', 'origin']);
    for (const m of inboxAt('origin/main')) {
        if (!args.all && !isOpen(m.meta)) continue;
        if (me && !args.all && !isForMe(m.meta, me) && m.meta.from !== me) continue;
        console.log(`${isOpen(m.meta) ? '未办' : '已办'}  ${m.name}`);
    }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0] ?? 'check';
    try {
        const run = { check, send, done, list }[cmd];
        if (!run) throw new Error(`不认识的子命令：${cmd}`);
        run(args);
    } catch (e) {
        console.error(`exchange: ${e.message}`);
        // 钩子里跑 check 时不要因为网络之类的问题打断会话
        process.exit(cmd === 'check' ? 0 : 1);
    }
}
