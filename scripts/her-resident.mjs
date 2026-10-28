// 常驻的她：关掉 DSH 也还在的独立进程。
// 本机 HTTP 接口，任务串行执行；每个任务交给 headless 的她（profile lmy，带人格+记忆）。
// 全权限、审计日志；不做自拍/语音。
import http from 'node:http'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
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

function runTask(task, context = '') {
    return new Promise((resolve) => {
        const prompt = `${context ? `他在 QQ 里刚说过：\n${context}\n\n` : ''}现在他让你帮忙：${task}\n\n做完用你平时的口气回他，只留要发出去的话。按 QQ 聊天来：第一句只给结果，最多再补一句关键细节；不列清单、不分点；除非他明确要详细，否则不超过两句。`
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
        const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
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
})

process.on('SIGTERM', () => { log('resident stopping'); server.close(() => process.exit(0)) })
process.on('SIGINT', () => { log('resident stopping'); server.close(() => process.exit(0)) })
