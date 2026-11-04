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

import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sha256 } from './ledger.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { stateObject, stateTimestamp } from './state-schema.ts';

export type DormancyState =
    | { state: 'awake' }
    | { state: 'proposed'; at: string; token?: string; reason?: string; herNote?: string }
    | { state: 'dormant'; since: string; reason?: string; herNote?: string; archive: string };

export interface ArchiveOptions {
    repoRoot: string;
    dataDir: string;
    archiveRoot: string;
    now: Date;
    reason?: string;
    herNote?: string;
    gitHead?: string;
    /** 确认休眠时写入封存副本；live 状态仍由 confirm 在完整清单完成后发布。 */
    dormantSince?: string;
}

export interface ArchiveResult { dir: string; files: number; bytes: number }

const SKIP = /(?:^|[\\/])(?:secrets|logs)(?:[\\/]|$)/;

function validDormancyState(value: unknown): value is DormancyState {
    if (!stateObject(value) || !['awake', 'proposed', 'dormant'].includes(value.state as string)) return false;
    if (value.state === 'awake') return true;
    if (value.reason !== undefined && typeof value.reason !== 'string' || value.herNote !== undefined && typeof value.herNote !== 'string') return false;
    return value.state === 'proposed'
        ? stateTimestamp(value.at) && (value.token === undefined || typeof value.token === 'string' && /^[0-9a-f-]{36}$/.test(value.token))
        : stateTimestamp(value.since) && typeof value.archive === 'string' && Boolean(value.archive.trim());
}

const stamp = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

function walk(root: string, dir = root): string[] {
    if (lstatSync(dir).isSymbolicLink()) throw new Error('封存包含链接，不能安全核对');
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error('封存包含链接，不能安全核对');
        if (entry.isDirectory()) out.push(...walk(root, full));
        else if (entry.isFile()) out.push(full);
    }
    return out;
}

export function createArchive(options: ArchiveOptions): ArchiveResult {
    if (!stateTimestamp(options.now.toISOString())) throw new Error('封存时间无效');
    if (options.dormantSince !== undefined && !stateTimestamp(options.dormantSince)) throw new Error('休眠封存时间无效');
    const nested = relative(resolve(options.dataDir), resolve(options.archiveRoot));
    if (!nested || (!nested.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && nested !== '..' && !isAbsolute(nested))) throw new Error('封存目录不能位于源数据目录内');
    // 同一分钟里封存两次也不能互相覆盖：后面的加序号
    let dir = join(options.archiveRoot, `${stamp(options.now)}-dormancy`);
    for (let n = 2; existsSync(dir); n++) dir = join(options.archiveRoot, `${stamp(options.now)}-dormancy-${n}`);
    mkdirSync(dir, { recursive: true });
    const filter = (src: string) => {
        if (SKIP.test(relative(options.dataDir, src))) return false;
        if (lstatSync(src).isSymbolicLink()) throw new Error('封存源包含链接，已停止复制');
        return true;
    };
    cpSync(options.dataDir, join(dir, 'bot'), { recursive: true, filter });
    for (const sub of ['source', 'st']) {
        const from = join(options.repoRoot, 'characters', 'linmengyao', sub);
        if (existsSync(from)) cpSync(from, join(dir, 'characters', 'linmengyao', sub), { recursive: true, filter: src => { if (lstatSync(src).isSymbolicLink()) throw new Error('角色封存源包含链接'); return true; } });
    }
    if (options.dormantSince !== undefined) {
        writeJsonAtomic(join(dir, 'bot', 'dormancy.json'), {
            state: 'dormant', since: options.dormantSince, archive: resolve(dir),
            ...(options.reason ? { reason: options.reason } : {}), ...(options.herNote ? { herNote: options.herNote } : {}),
        } satisfies DormancyState);
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
    const files = walk(dir).filter(file => file !== join(dir, 'manifest.json'));
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
        const raw: unknown = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        if (!stateObject(raw) || !stateObject(raw.files)) throw new Error('schema');
        for (const [name, entry] of Object.entries(raw.files)) {
            if (!name || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')
                || !stateObject(entry) || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('schema');
        }
        // 检查链接在任何文件读取之前，不能由清单引导读取封存外的文件。
        walk(dir);
        manifest = raw as typeof manifest;
    } catch {
        return { ok: false, checked: 0, problems: ['封存的清单（manifest.json）读不了'] };
    }
    const names = Object.keys(manifest.files);
    for (const name of names) {
        const file = join(dir, name);
        if (!existsSync(file)) { problems.push(`少了：${name}`); continue; }
        try {
            if (!lstatSync(file).isFile() || sha256(readFileSync(file)) !== manifest.files[name]!.sha256) problems.push(`被改过：${name}`);
        } catch { problems.push(`读不了：${name}`); }
    }
    const known = new Set(names);
    let actual: string[];
    try { actual = walk(dir); } catch { return { ok: false, checked: names.length, problems: [...problems, '封存文件无法安全核对'] }; }
    for (const file of actual) {
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
        try {
            return readJsonOr<DormancyState>(this.#path, { state: 'awake' }, undefined, { label: '休眠状态', invalid: 'throw', validate: validDormancyState });
        } catch { throw new Error('休眠状态读取或校验失败；已保留原文件，请修复后重试'); }
    }

    #save(value: DormancyState): void {
        if (!validDormancyState(value)) throw new Error('休眠状态无效，未写入');
        try { writeJsonAtomic(this.#path, value); }
        catch {
            try { if (JSON.stringify(this.state()) === JSON.stringify(value)) return; } catch { /* 保留写入失败事实。 */ }
            throw new Error('休眠状态未能保存，请检查后重试');
        }
    }

    isDormant(): boolean { return this.state().state === 'dormant'; }

    #now(): Date { return this.#options.now?.() ?? new Date(); }

    /** 商量：记下提议和她的话（还没休眠） */
    propose(reason: string | undefined, herNote: string | undefined): string {
        if (this.isDormant()) throw new Error('她已经在休眠了，不能重新提议');
        const token = randomUUID();
        this.#save({ state: 'proposed', at: this.#now().toISOString(), token, ...(reason ? { reason } : {}), ...(herNote ? { herNote } : {}) });
        return token;
    }

    updateProposal(token: string, herNote: string | undefined): boolean {
        const current = this.state();
        if (current.state !== 'proposed' || !current.token || current.token !== token) return false;
        this.#save({ ...current, ...(herNote ? { herNote } : {}) });
        return true;
    }

    cancel(): boolean {
        if (this.state().state !== 'proposed') return false;
        this.#save({ state: 'awake' });
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
                dormantSince: now.toISOString(),
                ...(current.reason ? { reason: current.reason } : {}), ...(current.herNote ? { herNote: current.herNote } : {}), ...(gitHead ? { gitHead } : {}),
            });
            this.#save({ state: 'dormant', since: now.toISOString(), ...(current.reason ? { reason: current.reason } : {}), ...(current.herNote ? { herNote: current.herNote } : {}), archive: archive.dir });
            return { ok: true, archive };
        } catch {
            return { ok: false, reason: '封存没做成，请检查存储；没有进入休眠' };
        }
    }

    /** 醒来：核对封存清单，回到醒着；返回休眠了多久和核对结果 */
    wake(): { ok: true; minutes: number; archive: string; check: { ok: boolean; checked: number; problems: string[] } } | { ok: false; reason: string } {
        const current = this.state();
        if (current.state !== 'dormant') return { ok: false, reason: '她没在休眠' };
        const check = verifyArchive(current.archive);
        this.#save({ state: 'awake' });
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
