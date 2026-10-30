// 把旧机器（VM）上的素材并进新机器的数据目录（ADR 0199）。一次性的工具，不是常驻功能。
// 搬什么：
//   ① 聊天记录：并进新机器已有的那份（「谁说的 + 内容 + 时间差几秒以内」算同一条，去重；不覆盖、不删）；
//   ② 她自己写的日记 / 周记 / 阶段总结：原样（document_id、事件时间、标签、元数据都照旧）写进新机器的公共记忆库，并把 diary.json 里「写过了」的记录并进去
//      （不并的话，补写日记的流程会把这些日子当成没写过，用模型重写一遍，覆盖她当时写的原文）；
//   ③ 其余状态（身份账本、世界事件、承诺、主动记录、成语、观看记录……）：只存档到 vm-archive-<日期>/，不启用——它们是有时效的运行状态，搬过来会让她重提早就过去的事。
// 不搬：记忆库本身（Hindsight 里的事实 / 观察 / 关系概况——聊天并进去之后，机器人按平常的写入路径会自己重新写：片段的 document_id 是 ep-<首条时间戳>，聊天不变就不变）、
//   配置和密钥、照片和贴纸。
// 三步：export（旧机器上，只读）→ plan（新机器上，只看不写）→ apply（新机器上，Koishi 停着；先备份再写；没带 --yes 就只是 plan）。

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { EPISODE_GAP_MS } from '../memory/episodes.ts';
import type { MemoryItem } from '../memory/hindsight.ts';
import { acquireLock, isProcessAlive } from '../platform/lock.ts';
import { isPrivateFile } from '../platform/private-space.ts';

export const BUNDLE_VERSION = 1;
/** 同一个人说的同一句话，两边记的时间差在这以内算同一条 */
export const DEDUP_TOLERANCE_MS = 3000;
/** 她自己写的东西在公共库里的 document_id 前缀（long-term.ts：diary: / week: / phase: / diary-self: / self:） */
export const WRITTEN_ID = /^(?:diary|week|phase|diary-self|self):/;
/** 存档时不带走的：名字像密钥的、太大的 */
const SENSITIVE_NAME = /cookie|secret|token|password|\.key$|\.pem$/i;
const MAX_ARCHIVE_FILE_BYTES = 2 * 1024 * 1024;
/** 旧数据目录（runtime/bot）里要存档的（相对路径）；聊天、diary.json 单独处理，配置 / 密钥 / 日志 / 照片 / 贴纸不带 */
export const ARCHIVE_ENTRIES = ['identity', 'idioms', 'jokes', 'promises', 'proactive', 'presence', 'reports', 'watching', 'world', 'memory', 'tiers.json'];

// ───────────────────────── 聊天记录 ─────────────────────────

export interface ChatRow {
    time: string;
    role: 'user' | 'assistant';
    content: string;
    [key: string]: unknown;
}

/** 读一份 jsonl：读不了的行（坏 JSON、没有时间 / 角色 / 内容）跳过并计数，能读的原样保留 */
export function parseChatJsonl(text: string): { rows: ChatRow[]; bad: number } {
    const rows: ChatRow[] = [];
    let bad = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line) as ChatRow;
            if ((row.role !== 'user' && row.role !== 'assistant') || typeof row.content !== 'string' || !Number.isFinite(Date.parse(row.time))) { bad++; continue; }
            rows.push(row);
        } catch { bad++; }
    }
    return { rows, bad };
}

export const serializeChatRows = (rows: ChatRow[]): string => rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');

/**
 * 把 incoming 并进 existing。已有的一条只能对上一条 incoming（两边各有两条一模一样的「嗯」就是两条，不会被合成一条）。
 * 返回按时间排好的全部（同一时刻 existing 在前），不改 existing 里任何一行的内容。
 */
export function mergeChatRows(existing: ChatRow[], incoming: ChatRow[], toleranceMs = DEDUP_TOLERANCE_MS): { rows: ChatRow[]; added: number; skipped: number } {
    const slots = new Map<string, { at: number; used: boolean }[]>();
    const keyOf = (row: ChatRow) => `${row.role}\u0000${row.content}`;
    for (const row of existing) {
        const key = keyOf(row);
        const list = slots.get(key) ?? [];
        list.push({ at: Date.parse(row.time), used: false });
        slots.set(key, list);
    }
    const fresh: ChatRow[] = [];
    let skipped = 0;
    for (const row of incoming) {
        const at = Date.parse(row.time);
        const hit = slots.get(keyOf(row))?.find(slot => !slot.used && Math.abs(slot.at - at) <= toleranceMs);
        if (hit) { hit.used = true; skipped++; continue; }
        fresh.push(row);
    }
    const all = [...existing, ...fresh].map((row, index) => ({ row, index, at: Date.parse(row.time) }));
    all.sort((a, b) => (a.at - b.at) || (a.index - b.index));
    return { rows: all.map(entry => entry.row), added: fresh.length, skipped };
}

// ───────────────────────── diary.json ─────────────────────────

/** memory/diary.json（life/diary.ts）：写过的日记（日期 → 字数）、日记原文、写过的周记和阶段总结（id → 字数） */
export interface DiaryState {
    written: Record<string, number>;
    texts: Record<string, string>;
    weeks: Record<string, number>;
    phases: Record<string, number>;
}

/** 并进去：同一个键新机器已有的优先（那是新机器上她自己写的，不被旧的盖掉） */
export function mergeDiaryState(existing: Partial<DiaryState>, incoming: Partial<DiaryState>): { state: DiaryState; added: Record<keyof DiaryState, number> } {
    const added = { written: 0, texts: 0, weeks: 0, phases: 0 };
    const union = <T>(key: keyof DiaryState): Record<string, T> => {
        const base = { ...((existing[key] ?? {}) as Record<string, T>) };
        for (const [id, value] of Object.entries((incoming[key] ?? {}) as Record<string, T>)) {
            if (id in base) continue;
            base[id] = value;
            added[key]++;
        }
        return base;
    };
    const state: DiaryState = { written: union<number>('written'), texts: union<string>('texts'), weeks: union<number>('weeks'), phases: union<number>('phases') };
    return { state: { ...existing, ...state }, added };
}

// ───────────────────────── 她自己写的文档 ─────────────────────────

export interface BundleDoc {
    id: string;
    /** Hindsight 里存的原文（标题行 + 正文） */
    text: string;
    tags: string[];
    metadata: Record<string, string>;
    context: string;
    /** 当时写进去时的事件时间（日记是那天晚上 22:00） */
    eventDate: string;
    entities: { text: string; type?: string }[];
}

/** 原样再写一次：和 long-term.ts 的 #retainWritten 发出的一样（content、timestamp、context、document_id、tags、metadata、entities） */
export function memoryItemOf(doc: BundleDoc): MemoryItem {
    return {
        content: doc.text,
        timestamp: doc.eventDate,
        context: doc.context,
        document_id: doc.id,
        tags: doc.tags,
        metadata: doc.metadata,
        ...(doc.entities.length ? { entities: doc.entities } : {}),
    };
}

interface ApiDocument {
    id: string;
    original_text?: string | null;
    tags?: string[] | null;
    document_metadata?: Record<string, string> | null;
    created_at?: string;
    retain_params?: { context?: string; entities?: { text: string; type?: string }[]; event_date?: string; metadata?: Record<string, string> } | null;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function getJson<T>(fetchImpl: FetchLike, url: string): Promise<T> {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`GET ${url.replace(/^https?:\/\/[^/]+/, '')} → ${response.status}`);
    return await response.json() as T;
}

const documentsRoot = (baseUrl: string, bankId: string) => `${baseUrl.replace(/\/+$/, '')}/v1/default/banks/${encodeURIComponent(bankId)}/documents`;

/** 一个 bank 里所有文档的 id（分页读，只用 GET） */
export async function listDocumentIds(baseUrl: string, bankId: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 100) {
        const page = await getJson<{ items?: { id: string }[]; total?: number }>(fetchImpl, `${documentsRoot(baseUrl, bankId)}?limit=100&offset=${offset}`);
        const items = page.items ?? [];
        ids.push(...items.map(item => item.id));
        if (!items.length || ids.length >= (page.total ?? 0)) break;
    }
    return ids;
}

/** 从旧机器的 Hindsight 公共库里读出她自己写的文档（只用 GET） */
export async function fetchWrittenDocs(baseUrl: string, bankId: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<BundleDoc[]> {
    const root = documentsRoot(baseUrl, bankId);
    const ids = await listDocumentIds(baseUrl, bankId, fetchImpl);
    const docs: BundleDoc[] = [];
    for (const id of ids.filter(id => WRITTEN_ID.test(id)).sort()) {
        const doc = await getJson<ApiDocument>(fetchImpl, `${root}/${encodeURIComponent(id)}`);
        if (!doc.original_text) throw new Error(`${id} 没有原文，不能搬`);
        const params = doc.retain_params ?? {};
        docs.push({
            id,
            text: doc.original_text,
            tags: doc.tags ?? [],
            metadata: params.metadata ?? doc.document_metadata ?? {},
            context: params.context ?? '',
            eventDate: params.event_date ?? doc.created_at ?? '',
            entities: params.entities ?? [],
        });
    }
    return docs;
}

// ───────────────────────── 素材包 ─────────────────────────

export interface Manifest {
    version: number;
    createdAt: string;
    /** 来源：旧数据目录的目录名（不带路径）、公共库 bank */
    source: { dir: string; commonBank: string };
    counts: { chats: Record<string, number>; docs: Record<string, number>; archiveFiles: number; diary: boolean };
    files: Record<string, { bytes: number; sha256: string }>;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) out.push(...walk(path));
        else out.push(path);
    }
    return out;
}

export interface ExportOptions {
    /** 旧数据目录（runtime/bot） */
    liveDir: string;
    outDir: string;
    hindsightUrl: string;
    commonBank: string;
    /** 只带这几个联系人的聊天（QQ 号，不带 .jsonl）；不给就全带。别人的聊天要不要进素材包由用户定，默认该只带他自己的 */
    chats?: string[];
    fetchImpl?: FetchLike;
    now?: () => Date;
    log?: (message: string) => void;
}

/** 旧机器上跑：只读旧数据目录和 Hindsight（GET），写到 outDir（必须是新目录） */
export async function exportBundle(options: ExportOptions): Promise<Manifest> {
    const { liveDir, outDir } = options;
    const log = options.log ?? (() => undefined);
    if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`${outDir} 不是空目录，换一个新的`);
    mkdirSync(outDir, { recursive: true });
    const files: Manifest['files'] = {};
    const put = (rel: string, data: Buffer | string) => {
        const target = join(outDir, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
        files[rel.split(sep).join('/')] = { bytes: Buffer.byteLength(data), sha256: sha256(data) };
    };

    const chats: Record<string, number> = {};
    const chatDir = join(liveDir, 'chats');
    for (const name of existsSync(chatDir) ? readdirSync(chatDir).filter(n => n.endsWith('.jsonl')).sort() : []) {
        if (options.chats && !options.chats.includes(name.replace(/\.jsonl$/, ''))) { log(`聊天记录 ${name}：不在 --chats 里，没带`); continue; }
        const text = readFileSync(join(chatDir, name), 'utf8');
        const { rows, bad } = parseChatJsonl(text);
        chats[name] = rows.length;
        put(join('chats', name), serializeChatRows(rows));
        log(`聊天记录 ${name}：${rows.length} 条${bad ? `（${bad} 行读不了，没带）` : ''}`);
    }

    const docs = await fetchWrittenDocs(options.hindsightUrl, options.commonBank, options.fetchImpl);
    const docKinds: Record<string, number> = {};
    for (const doc of docs) docKinds[doc.id.split(':')[0]!] = (docKinds[doc.id.split(':')[0]!] ?? 0) + 1;
    put('docs.jsonl', docs.map(doc => JSON.stringify(doc)).join('\n') + (docs.length ? '\n' : ''));
    log(`她自己写的文档：${docs.length} 篇（${Object.entries(docKinds).map(([k, v]) => `${k} ${v}`).join('、') || '没有'}）`);

    const diaryPath = join(liveDir, 'memory', 'diary.json');
    const hasDiary = existsSync(diaryPath);
    if (hasDiary) put('diary.json', readFileSync(diaryPath));

    let archiveFiles = 0;
    for (const entry of ARCHIVE_ENTRIES) {
        const base = join(liveDir, entry);
        if (!existsSync(base)) continue;
        for (const path of statSync(base).isDirectory() ? walk(base) : [base]) {
            const rel = relative(liveDir, path);
            const name = basename(path);
            if (SENSITIVE_NAME.test(name) || SENSITIVE_NAME.test(rel)) { log(`存档跳过（名字像密钥）：${rel}`); continue; }
            if (isPrivateFile(name)) { log(`存档跳过（她的私人空间，ADR 0200）：${rel}`); continue; }
            const owner = /^(\d{3,})(?:[-.]|$)/.exec(name)?.[1];
            if (options.chats && owner && !options.chats.includes(owner)) { log(`存档跳过（别的联系人的，不在 --chats 里）：${rel}`); continue; }
            if (statSync(path).size > MAX_ARCHIVE_FILE_BYTES) { log(`存档跳过（超过 2 MB）：${rel}`); continue; }
            put(join('archive', rel), readFileSync(path));
            archiveFiles++;
        }
    }
    log(`存档：${archiveFiles} 个文件`);

    const manifest: Manifest = {
        version: BUNDLE_VERSION,
        createdAt: (options.now?.() ?? new Date()).toISOString(),
        source: { dir: basename(liveDir), commonBank: options.commonBank },
        counts: { chats, docs: docKinds, archiveFiles, diary: hasDiary },
        files,
    };
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}

export interface Bundle {
    manifest: Manifest;
    dir: string;
    chats: Map<string, ChatRow[]>;
    docs: BundleDoc[];
    diary?: Partial<DiaryState>;
}

/** 读素材包并核对 manifest 里每个文件的哈希；对不上就抛错（拷贝时坏了 / 被改过） */
export function readBundle(dir: string): Bundle {
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`${dir} 里没有 manifest.json，不是素材包`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    if (manifest.version !== BUNDLE_VERSION) throw new Error(`素材包版本 ${manifest.version}，这个工具只认 ${BUNDLE_VERSION}`);
    const problems: string[] = [];
    for (const [rel, expected] of Object.entries(manifest.files)) {
        const path = join(dir, ...rel.split('/'));
        if (!existsSync(path)) { problems.push(`缺文件 ${rel}`); continue; }
        if (sha256(readFileSync(path)) !== expected.sha256) problems.push(`哈希对不上 ${rel}`);
    }
    if (problems.length) throw new Error(`素材包有问题：${problems.slice(0, 5).join('；')}${problems.length > 5 ? `……共 ${problems.length} 处` : ''}`);
    const chats = new Map<string, ChatRow[]>();
    for (const rel of Object.keys(manifest.files).filter(rel => rel.startsWith('chats/'))) {
        chats.set(basename(rel), parseChatJsonl(readFileSync(join(dir, ...rel.split('/')), 'utf8')).rows);
    }
    const docsPath = join(dir, 'docs.jsonl');
    const docs = existsSync(docsPath)
        ? readFileSync(docsPath, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as BundleDoc)
        : [];
    const diaryPath = join(dir, 'diary.json');
    const diary = existsSync(diaryPath) ? JSON.parse(readFileSync(diaryPath, 'utf8')) as Partial<DiaryState> : undefined;
    return { manifest, dir, chats, docs, ...(diary ? { diary } : {}) };
}

// ───────────────────────── 迁完之后：记忆补齐了没有 ─────────────────────────

/**
 * 聊天并进去之后，机器人按平常的写入路径把「已经结束的片段」（安静 45 分钟以上）写进 Hindsight，一个片段一个 document_id（ep-<首条时间戳>）。
 * 这里算出该有哪些，给 verify 对：和 Hindsight 里实际有的比，缺的就是还没写完（或写失败了，下次同步会补）。
 */
export function expectedEpisodeIds(rows: ChatRow[], nowMs: number): string[] {
    const ids: string[] = [];
    let start: number | undefined;
    let end = 0;
    const flush = () => { if (start !== undefined && nowMs - end >= EPISODE_GAP_MS) ids.push(`ep-${start}`); };
    for (const row of [...rows].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
        const at = Date.parse(row.time);
        if (start !== undefined && at - end < EPISODE_GAP_MS) { if (at > end) end = at; continue; }
        flush();
        start = at;
        end = at;
    }
    flush();
    return ids;
}

export function memoryGap(expected: string[], present: Iterable<string>, idPrefix = ''): { expected: number; present: number; missing: string[] } {
    const have = new Set(present);
    const missing = expected.filter(id => !have.has(`${idPrefix}${id}`));
    return { expected: expected.length, present: expected.length - missing.length, missing };
}

// ───────────────────────── 新机器：plan / apply ─────────────────────────

export interface ChatPlan {
    file: string;
    status: 'merge' | 'skip-not-present' | 'skip-excluded';
    existing: number;
    incoming: number;
    added: number;
    duplicates: number;
    range?: { from: string; to: string };
}

export interface ImportPlan {
    chats: ChatPlan[];
    diary: { present: boolean; added: Record<keyof DiaryState, number> };
    docs: { total: number; byKind: Record<string, number> };
    archiveTo: string;
    problems: string[];
}

export interface PlanOptions {
    /** 新机器的数据目录（runtime/bot-shadow 或 runtime/bot） */
    dataDir: string;
    bundle: Bundle;
    /** 只处理这几个聊天文件（QQ 号，不带 .jsonl）；不给就处理新机器上已经有的每一份 */
    only?: string[];
    /** 新机器上没有的聊天文件也建（默认不建：那个联系人不在新机器的名单里，建了也没人用） */
    createMissing?: boolean;
    now?: () => Date;
}

const two = (n: number) => String(n).padStart(2, '0');
export const stampOf = (date: Date) => `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
export const archiveDirName = (bundle: Bundle) => `vm-archive-${bundle.manifest.createdAt.slice(0, 10).replaceAll('-', '')}`;

function readExistingRows(path: string): ChatRow[] {
    return existsSync(path) ? parseChatJsonl(readFileSync(path, 'utf8')).rows : [];
}

/** 只看不写：每份聊天并进去会多几条、diary.json 多几个、要写几篇文档、有什么挡路 */
export function planImport(options: PlanOptions): ImportPlan {
    const { dataDir, bundle } = options;
    const problems: string[] = [];
    const lockPath = join(dataDir, 'bot.lock');
    if (existsSync(lockPath)) {
        const pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
        if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) problems.push(`${lockPath} 里的 PID ${pid} 还活着：先把 Koishi 停掉（它在追加聊天记录，同时改会被它写回去）`);
    }
    const chats: ChatPlan[] = [];
    for (const [file, incoming] of bundle.chats) {
        const qq = file.replace(/\.jsonl$/, '');
        const path = join(dataDir, 'chats', file);
        const excluded = options.only && !options.only.includes(qq);
        if (excluded) { chats.push({ file, status: 'skip-excluded', existing: 0, incoming: incoming.length, added: 0, duplicates: 0 }); continue; }
        if (!existsSync(path) && !options.createMissing) { chats.push({ file, status: 'skip-not-present', existing: 0, incoming: incoming.length, added: 0, duplicates: 0 }); continue; }
        const existing = readExistingRows(path);
        const merged = mergeChatRows(existing, incoming);
        const times = merged.rows.map(row => row.time).sort();
        chats.push({
            file, status: 'merge', existing: existing.length, incoming: incoming.length, added: merged.added, duplicates: merged.skipped,
            ...(times.length ? { range: { from: times[0]!, to: times.at(-1)! } } : {}),
        });
    }
    const diaryPath = join(dataDir, 'memory', 'diary.json');
    const existingDiary = existsSync(diaryPath) ? JSON.parse(readFileSync(diaryPath, 'utf8')) as Partial<DiaryState> : {};
    const diary = bundle.diary ? mergeDiaryState(existingDiary, bundle.diary).added : { written: 0, texts: 0, weeks: 0, phases: 0 };
    const byKind: Record<string, number> = {};
    for (const doc of bundle.docs) byKind[doc.id.split(':')[0]!] = (byKind[doc.id.split(':')[0]!] ?? 0) + 1;
    return { chats, diary: { present: !!bundle.diary, added: diary }, docs: { total: bundle.docs.length, byKind }, archiveTo: join(dataDir, archiveDirName(bundle)), problems };
}

export function describePlan(plan: ImportPlan): string {
    const lines: string[] = [];
    for (const chat of plan.chats) {
        lines.push(chat.status === 'merge'
            ? `聊天 ${chat.file}：新机器已有 ${chat.existing} 条，素材 ${chat.incoming} 条 → 并进 ${chat.added} 条（${chat.duplicates} 条重复不动），并完 ${chat.existing + chat.added} 条${chat.range ? `，${chat.range.from.slice(0, 10)} → ${chat.range.to.slice(0, 10)}` : ''}`
            : `聊天 ${chat.file}：${chat.status === 'skip-not-present' ? '新机器上没有这个联系人的记录，跳过（要建加 --create-missing）' : '不在 --only 里，跳过'}（素材 ${chat.incoming} 条）`);
    }
    lines.push(plan.diary.present
        ? `diary.json：并进 写过的日记 ${plan.diary.added.written}、日记原文 ${plan.diary.added.texts}、周记 ${plan.diary.added.weeks}、阶段总结 ${plan.diary.added.phases}`
        : 'diary.json：素材里没有');
    lines.push(`她自己写的文档：${plan.docs.total} 篇（${Object.entries(plan.docs.byKind).map(([k, v]) => `${k} ${v}`).join('、') || '没有'}）→ 写进公共记忆库（已经有同样的就不动，有但内容不一样的不覆盖，列出来）`);
    lines.push(`存档（不启用）→ ${plan.archiveTo}`);
    for (const problem of plan.problems) lines.push(`✖ ${problem}`);
    return lines.join('\n');
}

export interface MigrationApi {
    retain(bankId: string, item: MemoryItem): Promise<void>;
    getDocument?(bankId: string, documentId: string): Promise<{ original_text?: string | null } | undefined>;
    activeOperations?(bankId: string): Promise<string[]>;
}

export interface ApplyOptions extends PlanOptions {
    api: MigrationApi;
    commonBank: string;
    /** 写完文档后等 Hindsight 的后台任务做完（毫秒；0 不等） */
    waitMs?: number;
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
}

export interface ApplyResult {
    plan: ImportPlan;
    backupDir: string;
    docs: { retained: string[]; same: string[]; conflicts: string[] };
    waited: 'done' | 'timeout' | 'not-waited';
}

function atomicWrite(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.migrating`;
    writeFileSync(temp, text);
    renameSync(temp, path);
}

/**
 * 真写。顺序：拿数据目录的锁（Koishi 在跑就拿不到，直接停）→ 备份要改的两类文件 → 并聊天 → 并 diary.json → 写文档 → 存档 → 留 migration-done.json。
 * 什么都不覆盖：已有的聊天一行不改，diary.json 里已有的键不动，Hindsight 里已有的文档不动。再跑一遍结果一样（聊天按去重、文档按 document_id）。
 */
export async function applyImport(options: ApplyOptions): Promise<ApplyResult> {
    const { dataDir, bundle, api, commonBank } = options;
    const log = options.log ?? (() => undefined);
    const now = options.now?.() ?? new Date();
    const plan = planImport(options);
    if (plan.problems.length) throw new Error(plan.problems.join('；'));
    mkdirSync(dataDir, { recursive: true });
    const release = acquireLock(join(dataDir, 'bot.lock'), process.pid, undefined, { path: join(dataDir, 'bot.lock.hb') });
    try {
        const backupDir = join(dataDir, `migration-backup-${stampOf(now)}`);
        const backup = (path: string) => {
            if (!existsSync(path)) return;
            const target = join(backupDir, relative(dataDir, path));
            mkdirSync(dirname(target), { recursive: true });
            copyFileSync(path, target);
        };
        const diaryPath = join(dataDir, 'memory', 'diary.json');
        for (const chat of plan.chats.filter(c => c.status === 'merge')) backup(join(dataDir, 'chats', chat.file));
        backup(diaryPath);
        mkdirSync(backupDir, { recursive: true });
        log(`备份在 ${backupDir}`);

        for (const chat of plan.chats.filter(c => c.status === 'merge')) {
            const path = join(dataDir, 'chats', chat.file);
            const merged = mergeChatRows(readExistingRows(path), bundle.chats.get(chat.file) ?? []);
            if (merged.added === 0 && existsSync(path)) { log(`聊天 ${chat.file}：没有要并的`); continue; }
            atomicWrite(path, serializeChatRows(merged.rows));
            log(`聊天 ${chat.file}：并进 ${merged.added} 条，现在 ${merged.rows.length} 条`);
        }

        if (bundle.diary) {
            const existing = existsSync(diaryPath) ? JSON.parse(readFileSync(diaryPath, 'utf8')) as Partial<DiaryState> : {};
            const merged = mergeDiaryState(existing, bundle.diary);
            atomicWrite(diaryPath, JSON.stringify(merged.state, null, 2));
            log(`diary.json：并进 ${merged.added.written} 篇日记记录、${merged.added.weeks} 周记、${merged.added.phases} 阶段总结`);
        }

        const docs: ApplyResult['docs'] = { retained: [], same: [], conflicts: [] };
        for (const doc of bundle.docs) {
            const found = await api.getDocument?.(commonBank, doc.id);
            if (found?.original_text) {
                (found.original_text === doc.text ? docs.same : docs.conflicts).push(doc.id);
                continue;
            }
            await api.retain(commonBank, memoryItemOf(doc));
            docs.retained.push(doc.id);
        }
        log(`文档：写进 ${docs.retained.length} 篇，已经有同样的 ${docs.same.length} 篇，内容不一样没动 ${docs.conflicts.length} 篇${docs.conflicts.length ? `（${docs.conflicts.join('、')}）` : ''}`);

        let waited: ApplyResult['waited'] = 'not-waited';
        if (options.waitMs && api.activeOperations) {
            const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
            const started = Date.now();
            waited = 'timeout';
            while (Date.now() - started < options.waitMs) {
                if (!(await api.activeOperations(commonBank)).length) { waited = 'done'; break; }
                await sleep(2000);
            }
            log(waited === 'done' ? 'Hindsight 的后台任务做完了' : 'Hindsight 的后台任务还没做完（超时），它们会自己继续');
        }

        const archiveRoot = join(bundle.dir, 'archive');
        for (const path of walk(archiveRoot)) {
            const target = join(plan.archiveTo, relative(archiveRoot, path));
            mkdirSync(dirname(target), { recursive: true });
            copyFileSync(path, target);
        }
        writeFileSync(join(dataDir, 'migration-done.json'), JSON.stringify({
            at: now.toISOString(), bundleCreatedAt: bundle.manifest.createdAt, chats: plan.chats.map(({ file, status, added }) => ({ file, status, added })),
            docs: { retained: docs.retained.length, same: docs.same.length, conflicts: docs.conflicts },
        }, null, 2) + '\n');
        log(`存档 → ${plan.archiveTo}`);
        return { plan, backupDir, docs, waited };
    } finally {
        release();
    }
}
