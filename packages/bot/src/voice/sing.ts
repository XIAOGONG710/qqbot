// 让她唱一首（2026-11-14）：他说「唱 BVxxxx」或「唱 稻香《…》」就把歌接下来，
// 后台跑 scripts/sing.py（搜女声源→下载→分离→分块 RVC→混音），出结果后发 60 秒片段 + 整首路径。
//
// 为什么不让她跑 <<执行：>>：一首歌要 5 分钟，命令工具 60 秒就掐。
// 这里 detached 起进程、轮询结果文件，不占她的回复流程。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 一轮最多等多久（毫秒）：含搜索/下载/分离，留足余量 */
export const SING_TIMEOUT_MS = 30 * 60_000;
/** 发出去的片段多长（秒）：整首发不出去时的退路（2026-11-14 实测 QQ 能收整首 3:46） */
export const SING_CLIP_SECONDS = 60;

/** 从他的话里取「唱什么」：BV 或歌名；不是这个意思就 undefined */
export function matchSingRequest(text: string): string | undefined {
    const request = text.trim().replace(/^(?:宝宝|瑶瑶|梦瑶)[，,\s]+/u, '');
    const content = /^(?:(?:我)?想听|来一?首|(?:可以|能不能|能)?(?:给我|帮我|你|再|在)*(?:翻唱|唱)(?:一?首|一下|个)?)[\s:：]*(.+)$/u.exec(request)?.[1]?.trim();
    if (!content) return undefined;
    const quoted = /^《([^《》\n]{1,30})》\s*[呗吧啊嘛呀哦啦呢吗]*[。！？!?]?$/.exec(content)?.[1]?.trim();
    if (quoted) return quoted;
    const reference = singVideoReference(content.replace(/\s+[呗吧啊嘛呀哦啦呢吗]+[。！？!?]?$/, ''));
    if (reference) return reference;
    const title = content.replace(/[呗吧啊嘛呀哦啦呢吗。！？!?]+$/u, '').trim();
    if (/^(?:一下|一听|你|歌|听|这首|那首)|意见|建议|想法|说话|怎么想|故事|解释/u.test(title)) return undefined;
    return /^[\p{L}\p{N}·]{2,15}$/u.test(title) ? title : undefined;
}

export function singVideoReference(text: string): string | undefined {
    return /^(?:https?:\/\/(?:www\.)?bilibili\.com\/video\/)?(BV[0-9A-Za-z]{10})(?:[/?#]\S*)?$/i.exec(text.trim())?.[1];
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

/** 把整首切一段副歌：避开前奏，从第 45 秒起取 60 秒 */
async function cutClip(ffmpeg: string, mp3: string, out: string, log: SingOptions['log']): Promise<string | undefined> {
    if (existsSync(out)) return out;
    const child = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', '45', '-t', String(SING_CLIP_SECONDS), '-i', mp3, out], { windowsHide: true });
    const code: number = await new Promise(resolve => child.on('exit', c => resolve(c ?? 1)));
    log(`唱歌：片段裁剪退出码 ${code}`);
    return code === 0 && existsSync(out) ? out : undefined;
}

/** 跑一首；返回整首和片段，失败给 error。不抛错，让调用方一句文字兜住 */
export async function singSong(song: string, options: SingOptions): Promise<SingResult> {
    const outDir = join(options.root, 'out', 'sing');
    mkdirSync(outDir, { recursive: true });
    // 歌名进去出来的 BV 是脚本自己定的，用结果文件回传，别猜文件名
    const resultPath = join(outDir, `result-${Date.now()}.json`);
    options.log(`唱歌：开始「${song}」`);
    const child = spawn(options.python, [join(options.root, 'scripts', 'sing.py'), '--song', song, '--out', outDir, '--result', resultPath], {
        cwd: options.root,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PYTHONUTF8: '1' },
    });
    child.unref();

    const deadline = Date.now() + SING_TIMEOUT_MS;
    let mp3: string | undefined;
    while (Date.now() < deadline) {
        if (existsSync(resultPath)) {
            try {
                const parsed = JSON.parse(readFileSync(resultPath, 'utf8')) as { mp3?: string; busy?: boolean; error?: string };
                if (parsed.busy) return { error: 'busy' };
                if (parsed.error) return { error: parsed.error };
                if (parsed.mp3 && existsSync(parsed.mp3)) { mp3 = parsed.mp3; break; }
            } catch { /* 还没写完，下一轮再读 */ }
        }
        await new Promise(resolve => setTimeout(resolve, 15_000));
    }
    if (!mp3) return { error: '没唱完（等超时了）' };
    options.log(`唱歌：「${song}」出结果了`);
    // 2026-11-14 实测：NapCat/QQ 收得下整首（3:46 也发成功），所以默认整首发；
    // 片段只留作退路——发整首失败时再发这段。
    const clip = await cutClip(options.ffmpeg, mp3, mp3.replace(/\.mp3$/, '-片段.wav'), options.log);
    return { mp3, ...(clip ? { clip } : {}) };
}
