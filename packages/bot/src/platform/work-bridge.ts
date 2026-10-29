// QQ 工作模式的工具桥：把他的话交给 headless 的她去干，拿回一条要发的话。
// 用 dsh 的 headless profile（lmy：同一套人格补丁），stdout 是最终回复，stderr 是推理（丢掉）。
import { spawn } from 'node:child_process'
import { permissionMode, readToken, residentDir, TOKEN_HEADER } from './resident-guard.ts'

const DSH_BIN = 'D:/nodejs/global/node_modules/@deepseek-ai/dsh/lib/bin.js'

export interface WorkTaskOptions {
    /** 用哪个 dsh profile 干活；默认 lmy */
    profile?: string
    /** 干活时待的目录；默认进程当前目录 */
    cwd?: string
    timeoutMs?: number
    /** 模型 key；默认从 QQBOT_LLM_API_KEY 拿 */
    apiKey?: string
    /** 最近几条 QQ 对话，给 headless 的她当上下文 */
    context?: string
}

const HINDSIGHT = 'http://127.0.0.1:8888'

/** 把这次活写进 DSH 记忆库，聊天里的她也能看到 */
export async function rememberWorkTask(task: string, reply: string, bank = 'linmengyao'): Promise<void> {
    try {
        await fetch(`${HINDSIGHT}/v1/default/banks/${bank}/memories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [{
                    content: `林梦瑶今天帮宝宝干活：他让她${task}；林梦瑶做了：${reply}`,
                    context: 'DSH 工作',
                    document_id: `qq-work-${Date.now()}`,
                    timestamp: new Date().toISOString(),
                }],
            }),
            signal: AbortSignal.timeout(5000),
        })
    } catch { /* 记忆写不进去不挡回复 */ }
}

function spawnWorkTask(task: string, options: WorkTaskOptions = {}): Promise<string> {
    const profile = options.profile ?? 'lmy'
    const timeoutMs = options.timeoutMs ?? 180_000
    const apiKey = options.apiKey ?? process.env.QQBOT_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY
    const context = options.context ? `他在 QQ 里刚说过：\n${options.context}\n\n` : ''
    const prompt = `${context}现在他让你帮忙：${task}\n\n做完用你平时的口气回他，只留要发出去的话。按 QQ 聊天来：第一句只给结果，最多再补一句关键细节；不要列清单、不要分点、不要逐项汇报；除非他明确要详细，否则不超过两句。`

    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [DSH_BIN, '--profile', profile, prompt], {
            cwd: options.cwd ?? process.cwd(),
            env: {
                ...process.env,
                DSH_PERMISSION_MODE: permissionMode(),
                ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {}),
            },
            windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => child.kill(), timeoutMs)
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('close', (code) => {
            clearTimeout(timer)
            const reply = stdout.trim()
            if (reply) {
                // 兜底：她说长了就截到最后一个句号/问号/感叹号，免得 QQ 里刷屏
                const short = reply.length > 260
                    ? reply.slice(0, 260).replace(/[^。！？!?]*$/, '') + '…'
                    : reply
                return resolve(short.trim() || reply.slice(0, 260) + '…')
            }
            reject(new Error(`工作桥没有拿到回复（exit ${code}）：${stderr.slice(-500)}`))
        })
    })
}

/** 优先交给常驻的她（独立进程），没起来再自己起 headless */
export async function runWorkTask(task: string, options: WorkTaskOptions = {}): Promise<string> {
    const resident = process.env.HER_RESIDENT_URL ?? 'http://127.0.0.1:7777'
    const token = readToken(residentDir())
    let res: Response | undefined
    try {
        res = await fetch(`${resident}/task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { [TOKEN_HEADER]: token } : {}) },
            body: JSON.stringify({ task, context: options.context ?? '' }),
            signal: AbortSignal.timeout((options.timeoutMs ?? 180_000) + 10_000),
        })
    } catch { /* 常驻没起来（连不上），走临时 headless */ }
    // 常驻明确拒绝（令牌不对 / 没有令牌）不能悄悄改走临时 headless：那样会绕过常驻的队列和「她离开电脑」（ADR 0172）
    if (res && (res.status === 401 || res.status === 403)) throw new Error(`常驻的她拒绝了这次请求（HTTP ${res.status}）：令牌不对或不存在，检查 ${residentDir()}\\RESIDENT_TOKEN`);
    if (res?.ok) {
        try {
            const data = await res.json() as { ok?: boolean; reply?: string }
            if (data?.ok && data.reply) return String(data.reply)
        } catch { /* 读不出来按没回处理 */ }
    }
    return spawnWorkTask(task, options)
}
