// 她的声音（ADR 0140）：把一句话念成一个音频文件。
// - 本机引擎（localSpeech）：起 scripts/voice-synth.mjs 这个子进程，用 sherpa-onnx 在本机离线合成（Melo / Kokoro），念完就退出；
//   不联网、不要 key，聊天内容不会发给第三方。一次只念一条（排队），超时就杀掉子进程。
// - 唱歌的引擎（SongEngine）只定接口：本机念话的模型不会唱，唱歌要接外面的服务（见 ADR 0140 “唱歌”一节），没配就没有。
// 音频文件放在数据目录下的 voice/，发完就删，启动时清掉超过一小时的残留（里面是私聊内容念出来的声音）。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Log } from './log.ts';

export interface SpeechClip {
    /** 本机的音频文件（wav） */
    file: string;
    seconds: number;
}

export interface SpeechEngine {
    readonly name: string;
    synthesize(text: string): Promise<SpeechClip>;
}

export interface SongEngine {
    readonly name: string;
    /** 唱这几行词；返回一个音频文件（最多约 30 秒） */
    sing(lines: readonly string[]): Promise<SpeechClip>;
}

export const LOCAL_MODELS = ['melo', 'kokoro'] as const;
export type LocalModel = (typeof LOCAL_MODELS)[number];

/** 模型在引擎目录 models/ 下的文件夹名 */
export const MODEL_DIRS: Record<LocalModel, string> = { melo: 'vits-melo-tts-zh_en', kokoro: 'kokoro-int8-multi-lang-v1_1' };

export interface SynthRequest { engineDir: string; model: LocalModel; speaker: number; speed: number; text: string; out: string }
export type SynthResult = { ok: true; seconds: number; sampleRate: number } | { ok: false; error: string };
/** 跑一次合成（默认起子进程；测试换成假的） */
export type SynthRunner = (request: SynthRequest, timeoutMs: number) => Promise<SynthResult>;

const SCRIPT = fileURLToPath(new URL('../../../scripts/voice-synth.mjs', import.meta.url));

/**
 * 起一个子进程，请求（JSON）从 stdin 进，stdout 最后一行 JSON 是结果 { ok: true, ... } 或 { ok: false, error }；超时杀掉。
 * 本机念话（scripts/voice-synth.mjs）和外接的唱歌引擎（songEngine.command）用同一个协议
 */
export function runJsonProcess<R extends { ok: boolean }>(command: string, args: readonly string[], request: unknown, timeoutMs: number, label: string): Promise<R | { ok: false; error: string }> {
    return new Promise(resolve => {
        const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        let done = false;
        const finish = (result: R | { ok: false; error: string }) => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
        const timer = setTimeout(() => { child.kill(); finish({ ok: false, error: `${label}超时（${Math.round(timeoutMs / 1000)} 秒）` }); }, timeoutMs);
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 2000); });
        child.on('error', error => finish({ ok: false, error: `起不了${label}进程：${error.message}` }));
        child.on('close', code => {
            const last = stdout.trim().split('\n').at(-1) ?? '';
            try {
                const parsed = JSON.parse(last) as R;
                if (parsed.ok === true || parsed.ok === false) return finish(parsed);
            } catch { /* 下面报错 */ }
            finish({ ok: false, error: `${label}进程退出 ${code}，没有结果${stderr ? `：${stderr.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` });
        });
        child.stdin.on('error', () => { /* 进程已退出 */ });
        child.stdin.end(JSON.stringify(request));
    });
}

/** 默认的跑法：node scripts/voice-synth.mjs */
export const runSynthProcess: SynthRunner = (request, timeoutMs) => runJsonProcess<SynthResult>(process.execPath, [SCRIPT], request, timeoutMs, '合成');

export interface LocalSpeechOptions {
    /** 装 sherpa-onnx-node 和 models/ 的目录（默认 <仓库>/runtime/voice） */
    engineDir: string;
    /** 合成出来的 wav 放这里（数据目录下的 voice/） */
    outDir: string;
    model: LocalModel;
    speaker: number;
    speed: number;
    timeoutMs?: number;
    log: Log;
    run?: SynthRunner;
    now?: () => number;
    /** 此刻还能用多少字节内存（默认 process.availableMemory）；测试换成假的 */
    available?: () => number;
}

/** 合成子进程要占 400 多 MB：可用内存不到这么多就不起（6 GB 的虚拟机上还有 Hindsight 和 NapCat，挤爆了线上就收不到消息） */
export const MIN_FREE_BYTES = 800 * 1024 * 1024;

/** 引擎装好了没有：没装 / 缺模型时给出原因（启动时写日志，配置开着但装不起来就不工作） */
export function localSpeechProblem(engineDir: string, model: LocalModel): string | undefined {
    if (!existsSync(join(engineDir, 'node_modules', 'sherpa-onnx-node'))) return `${engineDir} 里没有 sherpa-onnx-node（先照 ADR 0140 的“安装”装一遍）`;
    if (!existsSync(join(engineDir, 'models', MODEL_DIRS[model]))) return `${engineDir}\\models 里没有 ${MODEL_DIRS[model]}（先照 ADR 0140 的“安装”下载）`;
    return undefined;
}

/** 删掉一个音频文件（发完、失败都要删）；删不掉不报错 */
export function discardClip(clip: SpeechClip | undefined): void {
    if (!clip) return;
    try { unlinkSync(clip.file); } catch { /* 已经没了 */ }
}

/** 启动时清掉 outDir 里超过 maxAgeMs 的残留音频 */
export function sweepClips(outDir: string, maxAgeMs: number, nowMs = Date.now()): number {
    let removed = 0;
    try {
        for (const name of readdirSync(outDir)) {
            if (!name.endsWith('.wav')) continue;
            const path = join(outDir, name);
            try {
                if (nowMs - statSync(path).mtimeMs > maxAgeMs) { unlinkSync(path); removed++; }
            } catch { /* 别的进程刚删了 */ }
        }
    } catch { /* 目录还不存在 */ }
    return removed;
}

export function localSpeech(options: LocalSpeechOptions): SpeechEngine {
    const run = options.run ?? runSynthProcess;
    const timeoutMs = options.timeoutMs ?? 90_000;
    const now = options.now ?? Date.now;
    const available = options.available ?? (() => process.availableMemory());
    let counter = 0;
    /** 排队：同一时间只跑一个合成（每个要占 400 多 MB） */
    let tail: Promise<unknown> = Promise.resolve();
    return {
        name: `本机 ${options.model}`,
        synthesize(text) {
            const job = tail.then(async () => {
                const free = available();
                if (free < MIN_FREE_BYTES) throw new Error(`可用内存只有 ${Math.round(free / 1048576)} MB，不起合成进程（至少要 ${Math.round(MIN_FREE_BYTES / 1048576)} MB）`);
                mkdirSync(options.outDir, { recursive: true });
                const out = join(options.outDir, `${now()}-${counter++}.wav`);
                const started = Date.now();
                const result = await run({ engineDir: options.engineDir, model: options.model, speaker: options.speaker, speed: options.speed, text, out }, timeoutMs);
                if (!result.ok) throw new Error(result.error);
                options.log(`语音合成：${[...text].length} 字 → ${result.seconds.toFixed(1)} 秒（用了 ${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
                return { file: out, seconds: result.seconds };
            });
            tail = job.catch(() => undefined);
            return job;
        },
    };
}

/** 唱一首的请求（外接引擎从 stdin 读）：lines 是要唱的词，style 是曲风提示，out 是要写的 wav 路径，maxSeconds 是最长要几秒 */
export interface SongRequest { lines: readonly string[]; style: string; out: string; maxSeconds: number }
export type SongResult = { ok: true; seconds: number } | { ok: false; error: string };
export type SongRunner = (command: readonly string[], request: SongRequest, timeoutMs: number) => Promise<SongResult>;

/** 她唱歌的样子：像个不专业的女生对着手机清唱——没有伴奏、轻轻的、有点害羞（给生成歌曲的服务的曲风提示） */
export const SING_STYLE = 'a cappella, no instruments, solo young female Mandarin vocal, soft and shy, intimate phone-recorded feel, slow simple melody';
/** 最长唱多久：QQ 语音上限 60 秒，真人清唱一小段也就十几二十秒 */
export const SING_MAX_SECONDS = 25;

export interface CommandSongOptions {
    /** 外接的命令（第一个是可执行文件，后面是参数），例如 ["node", "scripts/sing-xxx.mjs"]；协议见 SongRequest / SongResult */
    command: readonly string[];
    outDir: string;
    timeoutMs?: number;
    log: Log;
    run?: SongRunner;
    now?: () => number;
}

/** 唱歌引擎：把词交给一个外接命令，它去调某家生成歌曲的服务、把 wav 写到 out（本机不会唱，见 ADR 0140）。一次只唱一首 */
export function commandSong(options: CommandSongOptions): SongEngine {
    const run: SongRunner = options.run ?? ((command, request, timeoutMs) => runJsonProcess<SongResult>(command[0]!, command.slice(1), request, timeoutMs, '唱歌'));
    const timeoutMs = options.timeoutMs ?? 180_000;
    const now = options.now ?? Date.now;
    let counter = 0;
    let tail: Promise<unknown> = Promise.resolve();
    return {
        name: `外接命令 ${options.command[0]}`,
        sing(lines) {
            const job = tail.then(async () => {
                mkdirSync(options.outDir, { recursive: true });
                const out = join(options.outDir, `${now()}-sing-${counter++}.wav`);
                const started = Date.now();
                const result = await run(options.command, { lines, style: SING_STYLE, out, maxSeconds: SING_MAX_SECONDS }, timeoutMs);
                if (!result.ok) throw new Error(result.error);
                if (!existsSync(out)) throw new Error('唱歌命令说成功了，但没有写出音频文件');
                options.log(`唱歌：${lines.length} 行 → ${result.seconds.toFixed(1)} 秒（用了 ${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
                return { file: out, seconds: result.seconds };
            });
            tail = job.catch(() => undefined);
            return job;
        },
    };
}
