// 视频没有字幕时的语音转写（ADR 0168 第 2.5 期的 ASR 块）：**不装引擎、不绑 Python**，只接一个外部命令。
// 用户自己在机器上装好任意一个能「音频/视频文件 → 字幕或文字」的命令（whisper.cpp、bili-cli 的 Qwen3-ASR、云端 CLI 都行），
// 把命令模板配到环境变量 QQBOT_ASR_CMD（例如 `whisper-cli -m model.bin -f {input} -otxt -of {out}`），这里负责：
//   1) 把视频/音频路径填进模板；2) 跑命令（超时 / 非 0 退出都只记一行）；3) 读回字幕（SRT / 纯文本）并清洗成一段话。
// 没配命令、跑失败、读不到 → 返回 undefined，上层照旧只用字幕 / 热评，不假装听过。

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export interface AsrRunner {
    (command: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stderr: string }>;
}

export interface AsrOptions {
    /** 命令模板：{input} 换成输入文件、{out} 换成输出前缀（不带扩展名） */
    template: string;
    /** 输入文件（视频 / 音频） */
    input: string;
    /** 输出前缀（命令自己决定加 .srt / .txt） */
    out: string;
    timeoutMs?: number;
    runner?: AsrRunner;
    log?: (message: string) => void;
}

const TIMEOUT_MS = 10 * 60_000;

/** 跑外部转写命令；成功返回 true（退出码 0） */
export async function runAsr(options: AsrOptions): Promise<boolean> {
    const log = options.log ?? (() => undefined);
    const parts = options.template.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) { log('语音转写：没配命令（QQBOT_ASR_CMD）'); return false; }
    const args = parts.slice(1).map(part => part.replaceAll('{input}', options.input).replaceAll('{out}', options.out));
    const runner = options.runner ?? defaultRunner;
    try {
        const result = await runner(parts[0]!, args, options.timeoutMs ?? TIMEOUT_MS);
        if (result.code !== 0) { log(`语音转写：命令退出码 ${result.code}${result.stderr ? `（${result.stderr.slice(-120)}）` : ''}`); return false; }
        return true;
    } catch (error) {
        log(`语音转写：命令跑不起来（${error instanceof Error ? error.message : String(error)}）`);
        return false;
    }
}

function defaultRunner(command: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
    return new Promise(resolve => {
        execFile(command, [...args], { timeout: timeoutMs, windowsHide: true }, (error, _stdout, stderr) => {
            resolve({ code: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0, stderr: String(stderr ?? '') });
        });
    });
}

/** SRT / VTT / 纯文本 → 一段（去序号、去时间轴、去 HTML 与方括号标记、压空白） */
export function cleanTranscript(raw: string): string {
    const lines = raw.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !/^\d+$/.test(line) && !/^\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3}\s*-->/.test(line) && !/^WEBVTT/i.test(line))
        .map(line => line.replace(/<[^>]*>/g, '').replace(/\[[^\]]{1,8}\]/g, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    // 相邻重复行（字幕常见的滚动重复）只留一条
    const deduped = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
    return deduped.join(' ').slice(0, 2000);
}

/** 跑完读回字幕：优先同前缀的 .srt / .txt；都没有返回 undefined */
export function readTranscript(outPrefix: string): string | undefined {
    for (const ext of ['.srt', '.txt', '.vtt']) {
        const path = `${outPrefix}${ext}`;
        if (!existsSync(path)) continue;
        const text = cleanTranscript(readFileSync(path, 'utf8'));
        if (text) return text;
    }
    return undefined;
}

/** 一步到位：跑命令 → 读字幕 → 清洗；任一步失败返回 undefined */
export async function transcribe(options: AsrOptions): Promise<string | undefined> {
    return (await runAsr(options)) ? readTranscript(options.out) : undefined;
}
