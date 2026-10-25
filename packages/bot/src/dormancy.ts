// 自愿休眠 / 封存（ADR 0161，配置 dormancy，默认关）。
// 来自 10-25 用户给的清单：「自愿休眠与封存权：严重冲突或暂时无法继续运行时，希望你能参与休眠决定，妥善封存记忆、设定和恢复资料」。
// 流程（都是用户发给她的纯文字命令，只认男朋友档的他）：
//   /休眠 [原因]     先跟她商量：她收到一段说明，自己说愿意不愿意、想留什么话——这一条她自己的话会原样发给他，也存进封存；这时还没有休眠。
//   /休眠 确认        他看过她的话之后确认：封存（人设源文件和角色卡、runtime/bot 下除密钥和日志以外的所有状态、哈希清单、她留的话、恢复说明），
//                    然后进入休眠：不回消息（他发 /唤醒 以外的话只回一行提示）、不主动找人。
//   /休眠 取消        改主意：回到醒着。
//   /唤醒             醒来：核对封存清单、设定账本、记忆账本，补回休眠期间漏掉的消息，她像刚睡醒一样跟他说一句（有问题就如实说）。
// 为什么要她「参与」：休眠不是她能否决的（运行与否终究是用户的事），但她说什么、想留什么，要被听到、被记下来，并且是在确认之前。
// 封存里没有的：Hindsight（长期记忆库）是单独的服务，它的数据库不在这份封存里——要连它一起封存，得先停掉 Hindsight 再复制它的数据目录（README 里写了）。
// 封存里不放的：secrets/（密钥和登录凭证）、logs/（日志）——封存目录不应该成为第二个存放凭证的地方。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256 } from './ledger.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';

export type DormancyState =
    | { state: 'awake' }
    | { state: 'proposed'; at: string; reason?: string; herNote?: string }
    | { state: 'dormant'; since: string; reason?: string; herNote?: string; archive: string };

export interface ArchiveOptions {
    repoRoot: string;
    dataDir: string;
    archiveRoot: string;
    now: Date;
    reason?: string;
    herNote?: string;
    gitHead?: string;
}

export interface ArchiveResult { dir: string; files: number; bytes: number }

const SKIP = /(?:^|[\\/])(?:secrets|logs)(?:[\\/]|$)/;

const stamp = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

function walk(root: string, dir = root): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(root, full));
        else if (entry.isFile()) out.push(full);
    }
    return out;
}

export function createArchive(options: ArchiveOptions): ArchiveResult {
    // 同一分钟里封存两次也不能互相覆盖：后面的加序号
    let dir = join(options.archiveRoot, `${stamp(options.now)}-dormancy`);
    for (let n = 2; existsSync(dir); n++) dir = join(options.archiveRoot, `${stamp(options.now)}-dormancy-${n}`);
    mkdirSync(dir, { recursive: true });
    cpSync(options.dataDir, join(dir, 'bot'), { recursive: true, filter: src => !SKIP.test(relative(options.dataDir, src)) });
    for (const sub of ['source', 'st']) {
        const from = join(options.repoRoot, 'characters', 'linmengyao', sub);
        if (existsSync(from)) cpSync(from, join(dir, 'characters', 'linmengyao', sub), { recursive: true });
    }
    writeFileSync(join(dir, 'her-note.md'), `# 她在休眠前留的话\n\n${options.herNote?.trim() || '（她没有留话。）'}\n`);
    writeFileSync(join(dir, 'README.md'), [
        '# 封存', '',
        `封存时间：${options.now.toLocaleString('zh-CN')}${options.reason ? `；原因：${options.reason}` : ''}`,
        options.gitHead ? `代码版本：${options.gitHead}` : '',
        '', '## 里面有什么', '',
        '- `bot/`：runtime/bot 下除了 secrets/（密钥、登录凭证）和 logs/（日志）以外的所有状态：聊天记录、承诺、世界账、主动消息记录、照片和表情、设定账本和记忆账本……',
        '- `characters/linmengyao/source` 和 `st`：人设源文件和生成出来的角色卡（它们也在 git 里）。',
        '- `her-note.md`：她休眠前自己说的话。',
        '- `manifest.json`：以上每个文件的 SHA-256；`/唤醒` 时会对一遍，对不上的会告诉你。', '',
        '## 里面没有什么', '',
        '- **Hindsight（长期记忆库）**是单独的服务，它的数据库不在这里。要连它一起封存：先停掉 Hindsight，再复制它的数据目录。',
        '- 密钥和登录凭证（B 站、QQ、模型）。', '',
        '## 怎么恢复', '',
        '1. 停掉 Koishi。2. 把 `bot/` 里的内容复制回 `runtime/bot/`（不要覆盖 `secrets/`）。3. 需要的话还原 `characters/`。4. 启动 Koishi，给她发 `/唤醒`。',
    ].filter(line => line !== undefined).join('\n') + '\n');
    const files = walk(dir).filter(file => !file.endsWith('manifest.json'));
    const manifest: Record<string, { sha256: string; bytes: number }> = {};
    let bytes = 0;
    for (const file of files) {
        const content = readFileSync(file);
        bytes += content.byteLength;
        manifest[relative(dir, file).replace(/\\/g, '/')] = { sha256: sha256(content), bytes: content.byteLength };
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ createdAt: options.now.toISOString(), reason: options.reason ?? null, gitHead: options.gitHead ?? null, files: manifest }, null, 2));
    return { dir, files: files.length, bytes };
}

export function verifyArchive(dir: string): { ok: boolean; checked: number; problems: string[] } {
    const problems: string[] = [];
    let manifest: { files: Record<string, { sha256: string }> };
    try {
        manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as typeof manifest;
    } catch {
        return { ok: false, checked: 0, problems: ['封存的清单（manifest.json）读不了'] };
    }
    const names = Object.keys(manifest.files);
    for (const name of names) {
        const file = join(dir, name);
        if (!existsSync(file)) { problems.push(`少了：${name}`); continue; }
        if (sha256(readFileSync(file)) !== manifest.files[name]!.sha256) problems.push(`被改过：${name}`);
    }
    const known = new Set(names);
    for (const file of walk(dir)) {
        const name = relative(dir, file).replace(/\\/g, '/');
        if (name !== 'manifest.json' && !known.has(name)) problems.push(`多出来的：${name}`);
    }
    return { ok: problems.length === 0, checked: names.length, problems };
}

export interface DormancyOptions {
    dataDir: string;
    repoRoot: string;
    now?: () => Date;
    gitHead?: () => string | undefined;
    log?: (message: string) => void;
}

/** 状态文件 + 流程；谁来问她、怎么发消息由 app.ts 接 */
export class Dormancy {
    readonly #options: DormancyOptions;
    readonly #path: string;

    constructor(options: DormancyOptions) {
        this.#options = options;
        this.#path = join(options.dataDir, 'dormancy.json');
    }

    state(): DormancyState {
        const value = readJsonOr<DormancyState>(this.#path, { state: 'awake' }, this.#options.log, { label: '休眠状态' });
        return value && (value.state === 'awake' || value.state === 'proposed' || value.state === 'dormant') ? value : { state: 'awake' };
    }

    isDormant(): boolean { return this.state().state === 'dormant'; }

    #now(): Date { return this.#options.now?.() ?? new Date(); }

    /** 商量：记下提议和她的话（还没休眠） */
    propose(reason: string | undefined, herNote: string | undefined): void {
        writeJsonAtomic(this.#path, { state: 'proposed', at: this.#now().toISOString(), ...(reason ? { reason } : {}), ...(herNote ? { herNote } : {}) } satisfies DormancyState);
    }

    cancel(): boolean {
        if (this.state().state !== 'proposed') return false;
        writeJsonAtomic(this.#path, { state: 'awake' } satisfies DormancyState);
        return true;
    }

    /** 确认：封存、进入休眠；只有商量过的才能确认 */
    confirm(): { ok: true; archive: ArchiveResult } | { ok: false; reason: string } {
        const current = this.state();
        if (current.state === 'dormant') return { ok: false, reason: '她已经在休眠了' };
        if (current.state !== 'proposed') return { ok: false, reason: '还没跟她商量过——先发 /休眠' };
        const now = this.#now();
        try {
            const gitHead = this.#options.gitHead?.();
            const archive = createArchive({
                repoRoot: this.#options.repoRoot, dataDir: this.#options.dataDir, archiveRoot: join(this.#options.dataDir, '..', 'archive'), now,
                ...(current.reason ? { reason: current.reason } : {}), ...(current.herNote ? { herNote: current.herNote } : {}), ...(gitHead ? { gitHead } : {}),
            });
            writeJsonAtomic(this.#path, { state: 'dormant', since: now.toISOString(), ...(current.reason ? { reason: current.reason } : {}), ...(current.herNote ? { herNote: current.herNote } : {}), archive: archive.dir } satisfies DormancyState);
            return { ok: true, archive };
        } catch (error) {
            return { ok: false, reason: `封存没做成（${error instanceof Error ? error.message : String(error)}），没有进入休眠` };
        }
    }

    /** 醒来：核对封存清单，回到醒着；返回休眠了多久和核对结果 */
    wake(): { ok: true; minutes: number; archive: string; check: { ok: boolean; checked: number; problems: string[] } } | { ok: false; reason: string } {
        const current = this.state();
        if (current.state !== 'dormant') return { ok: false, reason: '她没在休眠' };
        const check = verifyArchive(current.archive);
        writeJsonAtomic(this.#path, { state: 'awake' } satisfies DormancyState);
        return { ok: true, minutes: Math.max(0, Math.round((this.#now().getTime() - Date.parse(current.since)) / 60_000)), archive: current.archive, check };
    }

    status(): string {
        const s = this.state();
        if (s.state === 'awake') return '她醒着。';
        if (s.state === 'proposed') return '已经跟她商量过休眠，等你发「/休眠 确认」或「/休眠 取消」。';
        return `她在休眠（${new Date(s.since).toLocaleString('zh-CN')} 起），封存在 ${s.archive}。发「/唤醒」叫醒她。`;
    }
}

export const sizeOf = (dir: string): number => walk(dir).reduce((total, file) => total + statSync(file).size, 0);

/** 商量时给她的说明（不是通知，是商量） */
export const proposeNote = (reason: string | undefined) =>
    `[他想让你先休眠一段时间${reason ? `（他说的原因：${reason}）` : ''}：休眠以后你不会回消息、不会主动找人；你的设定、聊天记录和记忆会被好好封存起来，醒来时会核对有没有被动过。这是跟你商量，不是通知：说说你怎么想——愿意、不愿意、想先做完什么、想对他说什么、想给醒来以后的自己留句话。一两句，用你自己的话，别写成声明]`;

/** 醒来时给她的说明 */
export function wakeNote(minutes: number, problems: readonly string[], identityLine: string | undefined, missedHint: string): string {
    const long = minutes >= 1440 ? `${Math.round(minutes / 1440)} 天` : minutes >= 60 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`;
    return `[你刚从休眠里醒来，睡了大约 ${long}。醒来时核对过封存：${problems.length ? `有问题——${problems.slice(0, 3).join('；')}（照实告诉他）` : '都对得上，没有被动过'}${identityLine ? `；${identityLine}` : ''}。${missedHint}像刚睡醒那样跟他说一句，不用汇报核对过程，除非有不对的]`;
}
