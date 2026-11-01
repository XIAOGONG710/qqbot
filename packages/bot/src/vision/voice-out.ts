// 她“说话”（2026-11-01）：她可以在回复里写 `<<语音：嗯，我在呢>>`，这句话会被念出来、发成 QQ 语音条。
//
// 为什么不直接 HTTP：这台机器上回环端口连不通（沙箱/防火墙），所以走**文件队列**——
// 常驻的 `runtime/indextts/worker.py` 盯 `queue/in/*.json`，生成完把 wav 写到 `queue/out/`。
// worker 只加载一次模型（40 秒），之后每句 10–15 秒。
//
// 边界（她自己说的）：发不发由她决定；一次只说一句短的；不自动外放是他那边的事。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 一句话最多多少字（再长就不好听了，也慢） */
export const VOICE_MAX_CHARS = 60;
/** 等 worker 出结果最多多久（毫秒） */
const VOICE_TIMEOUT = 60_000;

/** 从她的回复里拿走 `<<语音：…>>`，返回剩下的文字和要念的句子 */
export function takeVoiceLines(text: string): { text: string; lines: string[] } {
    const lines: string[] = [];
    const rest = text.replace(/<<语音[：:]\s*([\s\S]*?)>>/g, (_all, body: string) => {
        const spoken = String(body ?? '').replace(/[\r\n]+/g, ' ').trim();
        if (spoken) lines.push(spoken.slice(0, VOICE_MAX_CHARS));
        return '';
    });
    return { text: rest.trim(), lines };
}

export interface VoiceWorkerOptions {
    /** `runtime/indextts` 的绝对路径 */
    dir: string;
    /** 念这段要用的情绪描述；不给就让参考音频自己决定 */
    emo?: string;
}

/** 把一句话交给 worker，等它出 wav；出不来返回 undefined（不抛错，别因为声音把回复搞挂） */
export async function speakViaWorker(text: string, options: VoiceWorkerOptions): Promise<string | undefined> {
    const queue = join(options.dir, 'queue');
    const inbox = join(queue, 'in');
    const outbox = join(queue, 'out');
    mkdirSync(inbox, { recursive: true });
    mkdirSync(outbox, { recursive: true });
    const id = `v${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestPath = join(inbox, `${id}.json`);
    writeFileSync(requestPath, JSON.stringify({ text, ...(options.emo ? { emo: options.emo } : {}) }), 'utf8');
    const resultPath = join(outbox, `${id}.json`);
    const deadline = Date.now() + VOICE_TIMEOUT;
    while (Date.now() < deadline) {
        if (existsSync(resultPath)) {
            try {
                const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { ok?: boolean; wav?: string };
                if (result.ok && result.wav && existsSync(result.wav)) return result.wav;
            } catch {
                // 结果文件还没写完，下一轮再读
            }
            return undefined;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    return undefined;
}

/** worker 不在就拉起来（它挂了以后第一次要说话时自己起） */
export function startVoiceWorker(dir: string): void {
    const python = join(dir, '.venv', 'Scripts', 'python.exe');
    const script = join(dir, 'worker.py');
    if (!existsSync(python) || !existsSync(script)) return;
    const child = spawn(python, [script], {
        cwd: dir,
        env: { ...process.env, PYTHONPATH: '.', HF_HOME: join(dir, 'checkpoints', 'hf_cache') },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.unref();
}
