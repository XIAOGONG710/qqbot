// 让她唱一首（2026-11-14）：他说「唱 BVxxxx」就把歌接下来，
// 后台跑 scripts/sing.py（下载→分离→分块 RVC→混音），出结果后发 60 秒片段 + 整首的路径。
//
// 为什么走进程而不是她跑 <<执行：>>：一首歌要 5 分钟，命令工具 60 秒就掐。
// 这里 detached 起进程、轮询产物，不占她的回复流程。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 一轮最多等多久（毫秒）：稻香那条整首 5 分钟，留足余量 */
export const SING_TIMEOUT_MS = 20 * 60_000;
/** 发出去的片段多长（秒）：QQ 语音条吃不下整首 */
export const SING_CLIP_SECONDS = 60;

/** 他说「唱 BVxxxx」/「唱 https://www.bilibili.com/video/BVxxxx」时取出 BV；不是这个意思就 undefined */
export function matchSingRequest(text: string): string | undefined {
    const m = /(?:唱|翻唱)[^\n]{0,12}?(BV[0-9A-Za-z]{10})/i.exec(text.trim());
    if (m?.[1]) return m[1];
    const url = /bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/i.exec(text);
    return url?.[1];
}

export interface SingOptions {
    /** 仓库根目录 */
    root: string;
    /** python 解释器（带 torch 那个 venv） */
    python: string;
    /** ffmpeg 可执行文件 */
    ffmpeg: string;
    log: (message: string) => void;
}

export interface SingResult {
    /** 整首 mp3 */
    mp3?: string;
    /** 60 秒片段（发给他的那条） */
    clip?: string;
    error?: string;
}

/** 把整首切成开头 60 秒之外的副歌部分：避开前奏，从第 45 秒起取 60 秒 */
async function cutClip(ffmpeg: string, mp3: string, out: string, log: SingOptions['log']): Promise<string | undefined> {
    if (existsSync(out)) return out;
    const started = Date.now();
    const child = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', '45', '-t', String(SING_CLIP_SECONDS), '-i', mp3, out], { windowsHide: true });
    const code: number = await new Promise(resolve => child.on('exit', c => resolve(c ?? 1)));
    log(`唱歌：片段裁剪退出码 ${code}（${Date.now() - started} ms）`);
    return code === 0 && existsSync(out) ? out : undefined;
}

/** 跑一首；返回整首和片段，失败给 error。不抛错，让调用方一句文字兜住 */
export async function singSong(bv: string, options: SingOptions): Promise<SingResult> {
    const outDir = join(options.root, 'out', 'sing');
    mkdirSync(outDir, { recursive: true });
    const mp3 = join(outDir, `${bv}-她唱的.mp3`);
    if (!existsSync(mp3)) {
        const script = join(options.root, 'scripts', 'sing.py');
        options.log(`唱歌：开始 ${bv}`);
        const child = spawn(options.python, [script, '--song', bv], {
            cwd: options.root,
            windowsHide: true,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, PYTHONUTF8: '1' },
        });
        child.unref();
        const deadline = Date.now() + SING_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (existsSync(mp3)) break;
            // 进程早退了又没有产物：下一轮循环会等满，但大多时候是还在跑
            await new Promise(resolve => setTimeout(resolve, 15_000));
        }
        if (!existsSync(mp3)) return { error: '没唱完（等超时了）' };
    }
    options.log(`唱歌：${bv} 出结果了`);
    const clip = await cutClip(options.ffmpeg, mp3, join(outDir, `${bv}-片段.wav`), options.log);
    return { mp3, ...(clip ? { clip } : {}) };
}
