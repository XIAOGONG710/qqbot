// QQ 工作模式的工具桥：把他的话交给 headless 的她去干，拿回一条要发的话。
// 用 dsh 的 headless profile（lmy：同一套人格补丁），stdout 是最终回复，stderr 是推理（丢掉）。
import { spawn } from 'node:child_process'

const DSH_BIN = 'D:/nodejs/global/node_modules/@deepseek-ai/dsh/lib/bin.js'

export interface WorkTaskOptions {
    /** 用哪个 dsh profile 干活；默认 lmy */
    profile?: string
    /** 干活时待的目录；默认进程当前目录 */
    cwd?: string
    timeoutMs?: number
    /** 模型 key；默认从 QQBOT_LLM_API_KEY 拿 */
    apiKey?: string
}

export function runWorkTask(task: string, options: WorkTaskOptions = {}): Promise<string> {
    const profile = options.profile ?? 'lmy'
    const timeoutMs = options.timeoutMs ?? 180_000
    const apiKey = options.apiKey ?? process.env.QQBOT_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY
    const prompt = `他在 QQ 里让你帮忙：${task}\n\n做完用你平时的口气回他，只留要发出去的话。`

    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [DSH_BIN, '--profile', profile, prompt], {
            cwd: options.cwd ?? process.cwd(),
            env: {
                ...process.env,
                DSH_PERMISSION_MODE: 'danger-full-access',
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
            if (reply) return resolve(reply)
            reject(new Error(`工作桥没有拿到回复（exit ${code}）：${stderr.slice(-500)}`))
        })
    })
}
