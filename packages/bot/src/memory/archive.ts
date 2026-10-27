// 测试数据归档（ADR 0014 决策 6，照 ADR 0011 第 10 节的手动做法）：只挪不删。
// 1. tiers.json 给每个联系人记一个起点（档位不变），之后提示词、记忆写入、补回只看这之后的消息；旧的另存一份。
// 2. 聊天记录挪进 chats/archive/，记忆写入进度、主动消息记录挪进各自目录下的 archive-<时间>/。
// 3. koishi.yml、config.json 里的 bank 前缀换成新的：新 bank 是空的，旧 bank 留在 Hindsight 里不删、不再读。
// 要求 bot 停着（数据目录的锁没有活着的持有者）：在跑的插件手里有聊天记录和换档记录，改了会被它写回去。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { writeJsonAtomic } from './json-file.ts';
import { isProcessAlive, type IsAlive } from '../platform/lock.ts';

export interface ArchiveOptions {
    /** 数据目录（runtime/bot） */
    dataDir: string;
    /** 要换 bank 前缀的配置：koishi.yml（插件配置）、config.json（独立入口和模拟器）；没有的跳过 */
    configFiles: string[];
    /** 新前缀；不传就用旧前缀去掉末尾的 -数字，再接上月日时分 */
    prefix?: string;
    now?: Date;
    /** 只列出要做的事，不动文件 */
    dryRun?: boolean;
    isAlive?: IsAlive;
}

export interface ArchiveResult {
    stamp: string;
    moves: { from: string; to: string }[];
    /** 记了起点的联系人 */
    since: { qq: string; tier: string }[];
    tiersBackup?: string;
    prefix: { file: string; from?: string; to: string }[];
    /** 没改前缀的配置和原因 */
    skipped: { file: string; reason: string }[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const PREFIX = /^[A-Za-z0-9-]+$/;
const YAML_PREFIX = /^(\s*)bankPrefix:[ \t]*(\S*)[ \t]*$/gm;
const YAML_MEMORY_ON = /^(\s*)memory:[ \t]*\r?\n(\1\s+)enabled:[ \t]*true[ \t]*$/m;

export function archiveTestData(options: ArchiveOptions): ArchiveResult {
    const now = options.now ?? new Date();
    const { dataDir } = options;
    const lock = join(dataDir, 'bot.lock');
    if (existsSync(lock)) {
        const pid = Number.parseInt(readFileSync(lock, 'utf8'), 10);
        if (Number.isInteger(pid) && pid > 0 && (options.isAlive ?? isProcessAlive)(pid)) {
            throw new Error(`bot 还在跑（${lock} 的持有者 PID ${pid}）：先停掉 Koishi（或 main.ts）再归档`);
        }
    }
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const result: ArchiveResult = { stamp, moves: [], since: [], prefix: [], skipped: [] };

    // 换档记录：每人记起点，档位不变
    const tiersPath = join(dataDir, 'tiers.json');
    const tiers: Record<string, { tier: string; since?: string } | string> = existsSync(tiersPath) ? JSON.parse(readFileSync(tiersPath, 'utf8')) : {};
    const tierOf = (qq: string) => { const entry = tiers[qq]; return typeof entry === 'string' ? entry : entry?.tier; };

    const files = (dir: string, ext: string) => (existsSync(dir)
        ? readdirSync(dir).filter(f => f.endsWith(ext) && statSync(join(dir, f)).isFile()).sort()
        : []);
    const plan = (from: string, to: string) => {
        let target = to;
        for (let i = 2; existsSync(target) || result.moves.some(m => m.to === target); i++) target = to.replace(/(\.[^.]+)$/, `-${i}$1`);
        result.moves.push({ from, to: target });
    };
    const chats = join(dataDir, 'chats');
    for (const file of files(chats, '.jsonl')) {
        const qq = basename(file, '.jsonl');
        plan(join(chats, file), join(chats, 'archive', `${qq}-${tierOf(qq) ?? 'unknown'}-${stamp}.jsonl`));
    }
    for (const sub of ['memory', 'proactive']) {
        const dir = join(dataDir, sub);
        for (const file of files(dir, '.json')) plan(join(dir, file), join(dir, `archive-${stamp}`, file));
    }

    // 新前缀
    const configs = options.configFiles.filter(f => existsSync(f));
    for (const f of options.configFiles.filter(f => !existsSync(f))) result.skipped.push({ file: f, reason: '没有这个文件' });
    const current = configs.map(f => currentPrefix(f)).find(Boolean);
    const prefix = options.prefix ?? `${(current ?? 'linmengyao').replace(/(-\d+)+$/, '')}-${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
    if (!PREFIX.test(prefix)) throw new Error(`bank 前缀只能有字母、数字、短横线：${prefix}`);
    if (prefix === current) throw new Error(`新前缀和现在的一样（${prefix}），换一个`);
    const edits: { file: string; text: string }[] = [];
    for (const file of configs) {
        const text = readFileSync(file, 'utf8');
        const edited = file.endsWith('.json') ? editJson(text, prefix) : editYaml(text, prefix);
        if ('reason' in edited) result.skipped.push({ file, reason: edited.reason });
        else {
            result.prefix.push({ file, ...(edited.from ? { from: edited.from } : {}), to: prefix });
            edits.push({ file, text: edited.text });
        }
    }
    for (const qq of Object.keys(tiers)) result.since.push({ qq, tier: tierOf(qq)! });

    if (options.dryRun) return result;

    // 先记起点、挪文件，再改前缀（ADR 0011 第 10 节：顺序反了，插件重启时会把最近的消息从 QQ 补回来）
    if (existsSync(tiersPath)) {
        result.tiersBackup = join(dataDir, `tiers.before-${stamp}.json`);
        copyFileSync(tiersPath, result.tiersBackup);
        writeJsonAtomic(tiersPath, Object.fromEntries(Object.keys(tiers).map(qq => [qq, { tier: tierOf(qq), since: now.toISOString() }])));
    }
    for (const { from, to } of result.moves) {
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
    }
    for (const { file, text } of edits) writeFileSync(file, text);
    return result;
}

function currentPrefix(file: string): string | undefined {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.json')) {
        const prefix = (JSON.parse(text) as { memory?: { bankPrefix?: unknown } }).memory?.bankPrefix;
        return typeof prefix === 'string' && prefix ? prefix : undefined;
    }
    return [...text.matchAll(YAML_PREFIX)][0]?.[2] || undefined;
}

/** koishi.yml：改 bankPrefix 那一行；没有这一行而长期记忆开着，就在 enabled 下面加一行。只改这一处，别的原样 */
function editYaml(text: string, prefix: string): { text: string; from?: string } | { reason: string } {
    const lines = [...text.matchAll(YAML_PREFIX)];
    if (lines.length > 1) return { reason: `有 ${lines.length} 处 bankPrefix，不知道改哪个，请在控制台「长期记忆」里改` };
    if (lines.length === 1) {
        return { text: text.replace(YAML_PREFIX, (_, indent: string) => `${indent}bankPrefix: ${prefix}`), from: lines[0]![2] || undefined };
    }
    const memory = YAML_MEMORY_ON.exec(text);
    if (!memory) return { reason: '长期记忆没开（没有 memory.enabled: true），不用换前缀' };
    const at = memory.index + memory[0].length;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return { text: `${text.slice(0, at)}${eol}${memory[2]}bankPrefix: ${prefix}${text.slice(at)}` };
}

/** config.json：有 memory 一节才改 */
function editJson(text: string, prefix: string): { text: string; from?: string } | { reason: string } {
    const config = JSON.parse(text) as { memory?: Record<string, unknown> };
    if (!config.memory) return { reason: '没有 memory 一节（长期记忆没开），不用换前缀' };
    const from = typeof config.memory.bankPrefix === 'string' ? config.memory.bankPrefix : undefined;
    config.memory.bankPrefix = prefix;
    const indent = /^\{\r?\n( +)/.exec(text)?.[1]?.length ?? 2;
    return { text: JSON.stringify(config, null, indent) + '\n', ...(from ? { from } : {}) };
}
