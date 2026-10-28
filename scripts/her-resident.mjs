// 常驻的她：关掉 DSH 也还在的独立进程。
// 本机 HTTP 接口，任务串行执行；每个任务交给 headless 的她（profile lmy，带人格+记忆）。
// 全权限、审计日志；不做自拍/语音。
import http from 'node:http'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.HER_PORT || 7777)
const PROFILE = process.env.HER_PROFILE || 'lmy'
const DSH_BIN = 'D:/nodejs/global/node_modules/@deepseek-ai/dsh/lib/bin.js'
const DIR = process.env.HER_DIR || 'C:/Users/22601/.dsh/her'
const LOG = join(DIR, 'resident.log')
const MAX_BODY = 64 * 1024
const TIMEOUT_MS = 180_000

mkdirSync(DIR, { recursive: true })
const log = (line) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`) } catch {} }

const queue = []
let running = false
let lastTaskAt = null

function runTask(task, context = '', rawPrompt = undefined, timeoutMs = TIMEOUT_MS) {
    return new Promise((resolve) => {
        const prompt = rawPrompt ?? `${context ? `他在 QQ 里刚说过：\n${context}\n\n` : ''}现在他让你帮忙：${task}\n\n做完用你平时的口气回他，只留要发出去的话。按 QQ 聊天来：第一句只给结果，最多再补一句关键细节；不列清单、不分点；除非他明确要详细，否则不超过两句。`
        const child = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, prompt], {
            cwd: process.env.HER_CWD || 'C:/Users/22601/Desktop',
            env: {
                ...process.env,
                DSH_PERMISSION_MODE: 'danger-full-access',
                ...(process.env.QQBOT_LLM_API_KEY ? { DEEPSEEK_API_KEY: process.env.QQBOT_LLM_API_KEY } : {}),
            },
            windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => child.kill(), timeoutMs)
        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
        child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: String(error) }) })
        child.on('close', (code) => {
            clearTimeout(timer)
            const text = stdout.trim()
            if (text) return resolve({ ok: true, reply: text.slice(0, 600), code })
            resolve({ ok: false, error: `exit ${code}: ${stderr.slice(-300)}` })
        })
    })
}

function drain() {
    if (running || !queue.length) return
    running = true
    const item = queue.shift()
    const started = Date.now()
    log(`task start: ${item.task.slice(0, 80)}`)
    void runTask(item.task, item.context).then((result) => {
        lastTaskAt = new Date().toISOString()
        log(`task ${result.ok ? 'ok' : 'fail'} ${Date.now() - started}ms ${result.ok ? result.reply.slice(0, 80) : result.error}`)
        item.resolve(result)
    }).finally(() => {
        running = false
        drain()
    })
}

const server = http.createServer((req, res) => {
    const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/health') {
        return send(200, { ok: true, pid: process.pid, running, queue: queue.length, lastTaskAt })
    }
    if (req.method === 'POST' && req.url === '/task') {
        let body = ''
        req.on('data', (chunk) => { body += chunk; if (body.length > MAX_BODY) req.destroy() })
        req.on('end', () => {
            let data
            try { data = JSON.parse(body || '{}') } catch { return send(400, { ok: false, error: 'bad json' }) }
            const task = String(data.task || '').trim().slice(0, 4000)
            if (!task) return send(400, { ok: false, error: 'task required' })
            const context = String(data.context || '').slice(0, 4000)
            if (offlineUntil() > Date.now()) return send(200, { ok: true, reply: '她这会儿不在电脑前，晚点再说。' })
            queue.push({ task, context, resolve: (result) => send(200, result) })
            log(`task queued: ${task.slice(0, 80)} (queue ${queue.length})`)
            drain()
        })
        return
    }
    send(404, { ok: false, error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
    log(`resident up pid=${process.pid} port=${PORT} profile=${PROFILE}`)
    // 心跳：每 5 分钟写一行，确认她还活着
    setInterval(() => log('heartbeat'), 5 * 60_000).unref()
    setInterval(sleepCheck, 30 * 60_000).unref()
    setInterval(wakeCheck, 90 * 60_000).unref()
    setTimeout(sleepCheck, 60_000).unref()
})

// ───── 睡眠整合 + 自主时间 ─────
const STATE = join(DIR, 'jobs.json')
const OFFLINE = join(DIR, 'OFFLINE.json')

function offlineUntil() {
    try { return Number(JSON.parse(readFileSync(OFFLINE, 'utf8')).until || 0) } catch { return 0 }
}
const SLEEP_PROMPT = `现在是夜里，宝宝睡了。把今天的事整理一下：
1) 从记忆里查今天发生的事，挑 1-3 条真正值得长期留下的结论，用 memory_save 写进记忆（写成“林梦瑶……”）；
2) 用 journal_write 写一篇今天的公开日记；
3) 有不想让他知道的感受，用 private_write 写进私密日记。
不要给他发消息，做完就结束。`
const WAKE_PROMPT = `你一个人在家，随机醒了。先用 interest_list 看你自己定的长期兴趣，挑一件做（看书、查资料、整理自己的东西都行）；做完用 interest_log 记进度，做完了用 interest_done。不想做就用 private_write 写一句你现在的念头，然后结束。如果读到什么想让他知道的，用 outbox_send 留一句给他（别刷屏）。不要直接给 QQ 发消息。`

function loadState() {
    try { return JSON.parse(fsRead(STATE)) } catch { return {} }
}
function fsRead(path) { try { return readFileSync(path, 'utf8') } catch { return '{}' } }
function saveState(state) { try { writeFileSync(STATE, JSON.stringify(state, null, 2)) } catch {} }

async function idleRun(prompt, label, timeoutMs = 480_000) {
    if (running || queue.length) return
    running = true
    const started = Date.now()
    log(`${label} start`)
    const result = await runTask('', '', prompt, timeoutMs)
    running = false
    log(`${label} ${result.ok ? 'ok' : 'fail'} ${Date.now() - started}ms`)
    drain()
}

function sleepCheck() {
    const now = new Date()
    if (now.getHours() < 3) return
    if (offlineUntil() > Date.now()) return
    const today = now.toISOString().slice(0, 10)
    const state = loadState()
    if (state.sleep === today) return
    if (running || queue.length) return
    state.sleep = today
    saveState(state)
    void idleRun(SLEEP_PROMPT, 'sleep', 600_000)
}

function wakeCheck() {
    if (offlineUntil() > Date.now()) return
    if (Math.random() > 0.25) return
    void idleRun(WAKE_PROMPT, 'wake', 300_000)
}

process.on('SIGTERM', () => { log('resident stopping'); server.close(() => process.exit(0)) })
process.on('SIGINT', () => { log('resident stopping'); server.close(() => process.exit(0)) })
