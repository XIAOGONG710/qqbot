// 控制台的「林梦瑶」页面（ADR 0010）：前端是 client/index.js（手写的 ES 模块，不构建），这里是它的后端。
// - 入口、数据服务、监听器挂在根上下文上，每个 Koishi 进程只注册一次：qqbot 插件配置有误（红点）或重启时，页面照样能用；
// - 插件每次启动 / 停下 / 启动失败时更新模块里的状态（setConsoleState），数据服务每几秒推一次给页面；
// - 所有监听器和数据服务都要求登录（authority 4，和 plugin-config 一样），页面本身和入口文件不受登录保护；
// - 保存角色资料：先在内存里生成全部档位、做档位隐私检查，不过就不写；过了写 source/ 和 st/，插件按卡文件监听自动重启。

import type { Context } from 'koishi';
import { PHONE_ACTION_CAPABILITIES, type PhoneActionCapability } from '@qqbot/mobile-companion/protocol';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppStatus } from '../../bot/src/platform/app.ts';
import { aiPhotoDraftFreshness, aiPhotoDraftStore, type AiPhotoDraftStatus } from '../../bot/src/vision/ai-photo-drafts.ts';
import { aiPhotoProvidersFromEnv, createAiPhotoProviderPool, type AiPhotoProvider } from '../../bot/src/vision/ai-photo-provider.ts';
import { AI_PHOTO_REFERENCE_KINDS, AI_PHOTO_REFERENCE_MAX_BYTES, aiPhotoReferenceStore, type AiPhotoReferenceKind } from '../../bot/src/vision/ai-photo-references.ts';
import { PHOTO_MAX_BYTES, photoShelf } from '../../bot/src/vision/photos.ts';
import { detectImageType, imageDataUrl } from '../../bot/src/vision/safe-image.ts';
import { createExternalDraftStore, type ExternalDraftStatus } from '../../bot/src/social/external-drafts.ts';
import type { ExternalPlatform } from '../../bot/src/social/external-platforms.ts';
import { buildCharacter, checkPrivacy, writeOutputs, type Problem } from '../../character-tools/src/build.ts';
import { checkSource, readSource, writeSource, type CharacterSource } from '../../character-tools/src/source.ts';

const require = createRequire(import.meta.url);

/** 插件此刻的情况（apply 里更新） */
export interface ConsoleState {
    /** 插件启动成功、正在回复 */
    running: boolean;
    /** 启动失败的原因（配置有误、锁被占……） */
    error?: string;
    /** 正在跑的 app 的状态 */
    status?: () => AppStatus;
    /** 角色资料：source/ 和 st/ 所在的目录、st/ 文件名的前缀（由插件配置的 characterCard 推出） */
    character?: { sourceDir: string; stDir: string; prefix: string };
    /** AI 照片草稿和照片货架所在的数据目录；只留在服务端，不通过 ConsoleData 暴露。 */
    dataDir?: string;
}

export interface ConsoleData {
    running: boolean;
    error?: string;
    napcat?: { online: boolean; selfId?: string };
    status?: AppStatus;
    phoneActions: readonly PhoneActionCapability[];
    updatedAt: number;
}

export interface AiPhotoReviewItem {
    id: string;
    kind: 'cat' | 'food' | 'desk' | 'view';
    caption: string;
    at: string;
    createdAt: string;
    expiresAt: string;
    expired: boolean;
    status: AiPhotoDraftStatus;
    reviewedAt?: string;
}

export type AiPhotoListResult = { ok: true; entries: AiPhotoReviewItem[] } | { ok: false; error: string };
export type AiPhotoPreviewResult = { ok: true; dataUrl: string } | { ok: false; error: string };
export type AiPhotoReviewResult = { ok: true; status: AiPhotoDraftStatus } | { ok: false; error: string };

export interface AiPhotoReferenceItem {
    id: string;
    kind: AiPhotoReferenceKind;
    addedAt: string;
}

export type AiPhotoReferenceListResult = { ok: true; entries: AiPhotoReferenceItem[] } | { ok: false; error: string };
export type AiPhotoReferenceChangeResult = { ok: true; entry?: AiPhotoReferenceItem } | { ok: false; error: string };

export interface AiPhotoRuntimeStatus {
    feature: 'on' | 'off' | 'unknown';
    providers: readonly AiPhotoProvider['id'][];
    usage?: { day: string; attempts: number; generated: number; failed: number; remaining: number };
    drafts?: { total: number; pending: number; approved: number; rejected: number };
    degraded?: string;
}

export interface ExternalDraftItem {
    id: string;
    platform: ExternalPlatform;
    title: string;
    body: string;
    status: ExternalDraftStatus;
    source: string;
    createdAt: string;
    updatedAt: string;
    mediaCount: number;
}
export type ExternalDraftListResult = { ok: true; entries: ExternalDraftItem[] } | { ok: false; error: string };
export type ExternalDraftReviewResult = { ok: true; status: ExternalDraftStatus } | { ok: false; error: string };

/** moods / books（ADR 0015）是后加的文件：资料里没有这两个文件时页面不显示它们的分页 */
export type SourcePart = 'persona' | 'scenes' | 'schedule' | 'tiers' | 'moods' | 'books';

export type SaveResult =
    | { ok: true; written: string[] }
    | { ok: false; error?: string; problems?: Problem[] };

let state: ConsoleState = { running: false };
let registered = false;
let service: { refresh(): Promise<void> } | undefined;
/** NapCat 连接（根上下文的 bots，插件失败时也能看） */
let napcat: (() => { online: boolean; selfId?: string }) | undefined;

/** 插件更新自己的情况；页面马上收到 */
export function setConsoleState(patch: Partial<ConsoleState>): void {
    state = { ...state, ...patch };
    void service?.refresh();
}

/** characterCard（例如 …/characters/linmengyao/st/linmengyao-{tier}.json）→ 资料目录 */
export function characterPaths(characterCard: string): ConsoleState['character'] {
    const stDir = dirname(characterCard);
    return { stDir, sourceDir: join(dirname(stDir), 'source'), prefix: basename(characterCard).replace(/-?\{tier\}\.json$/, '') };
}

/** 页面要看的数据：插件情况 + app 状态（不含聊天内容） */
export function consoleData(): ConsoleData {
    let status: AppStatus | undefined;
    let napcatStatus: ConsoleData['napcat'];
    let statusUnavailable = false;
    try {
        status = state.status?.();
        const aiPhotos = aiPhotoSummary();
        if (status && aiPhotos) status = { ...status, extras: { ...status.extras, aiPhotoDrafts: aiPhotos } };
    } catch {
        status = undefined;
        statusUnavailable = true;
    }
    try {
        napcatStatus = napcat?.();
    } catch {
        napcatStatus = undefined;
    }
    return {
        running: state.running,
        ...(state.error ? { error: publicConsoleError(state.error) }
            : statusUnavailable ? { error: '状态读取失败，请查看运行日志；插件可能仍在运行。' } : {}),
        ...(napcatStatus ? { napcat: napcatStatus } : {}),
        ...(status ? { status } : {}),
        phoneActions: PHONE_ACTION_CAPABILITIES,
        updatedAt: Date.now(),
    };
}

const REVIEW_STATUSES = new Set<AiPhotoDraftStatus>(['pending_review', 'approved', 'rejected']);
const REVIEW_ID = /^[a-f0-9]{12}$/;
const publicPhotoReviewError = '照片审核暂时无法完成，请刷新页面后重试；详细原因见运行日志。';
const publicPhotoReferenceError = '视觉参考暂时无法修改，请刷新页面后重试；详细原因见运行日志。';

function photoReviewStores() {
    if (!state.dataDir) throw new Error('照片审核尚未连接到数据目录');
    const dataDir = resolve(state.dataDir);
    return {
        drafts: aiPhotoDraftStore({ dir: join(dataDir, 'ai-photo-drafts') }),
        shelf: photoShelf({ dir: join(dataDir, 'photos'), log: () => {} }),
        filesDir: resolve(dataDir, 'ai-photo-drafts', 'files'),
    };
}

/** 参考资料只能使用 dataDir 下的固定索引；拒绝符号链接、目录替身和非普通文件。 */
function photoReferenceStore() {
    if (!state.dataDir) throw new Error('视觉参考尚未连接到数据目录');
    const dataDir = resolve(state.dataDir);
    const referenceDir = resolve(dataDir, 'ai-photo-references');
    const indexFile = resolve(referenceDir, 'index.json');
    if (dirname(referenceDir) !== dataDir || dirname(indexFile) !== referenceDir) throw new Error('视觉参考目录越界');
    if (existsSync(referenceDir)) {
        const directory = lstatSync(referenceDir);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('视觉参考目录不安全');
    }
    if (existsSync(indexFile)) {
        const file = lstatSync(indexFile);
        if (!file.isFile() || file.isSymbolicLink() || dirname(realpathSync(indexFile)) !== realpathSync(referenceDir)) throw new Error('视觉参考索引不安全');
    }
    return aiPhotoReferenceStore({ file: indexFile });
}

function referenceBytes(value: unknown): Uint8Array | undefined {
    if (typeof value !== 'string' || value.length > Math.ceil(AI_PHOTO_REFERENCE_MAX_BYTES * 4 / 3) + 64) return undefined;
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) return undefined;
    const bytes = new Uint8Array(Buffer.from(match[2]!, 'base64'));
    if (!bytes.length || bytes.length > AI_PHOTO_REFERENCE_MAX_BYTES || detectImageType(bytes) !== match[1]) return undefined;
    return bytes;
}

/** 页面不返回内容哈希、供应商引用编号或磁盘路径。 */
export function listAiPhotoReferences(): AiPhotoReferenceListResult {
    try {
        const entries = photoReferenceStore().list()
            .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
            .map(entry => ({ id: entry.id, kind: entry.kind, addedAt: entry.addedAt }));
        return { ok: true, entries };
    } catch {
        return { ok: false, error: publicPhotoReferenceError };
    }
}

export function addAiPhotoReference(kind: unknown, image: unknown, referenceId: unknown, nonHumanConfirmed: unknown, confirmation: unknown, audit?: (message: string) => void): AiPhotoReferenceChangeResult {
    if (typeof kind !== 'string' || !AI_PHOTO_REFERENCE_KINDS.includes(kind as AiPhotoReferenceKind)
        || typeof referenceId !== 'string' || nonHumanConfirmed !== true || confirmation !== 'confirmed') {
        return { ok: false, error: '请选择参考类型、确认画面不含人物，并重新确认本次登记。' };
    }
    const bytes = referenceBytes(image);
    if (!bytes) return { ok: false, error: '请选择 5 MB 以内的 JPEG、PNG 或 WebP 图片。' };
    try {
        const entry = photoReferenceStore().add({ kind: kind as AiPhotoReferenceKind, bytes, referenceId, nonHumanSubject: true });
        audit?.(`控制台登记了非人物 AI 照片参考（${entry.kind}；${entry.id}）`);
        return { ok: true, entry: { id: entry.id, kind: entry.kind, addedAt: entry.addedAt } };
    } catch {
        return { ok: false, error: publicPhotoReferenceError };
    }
}

export function removeAiPhotoReference(id: unknown, confirmation: unknown, audit?: (message: string) => void): AiPhotoReferenceChangeResult {
    if (typeof id !== 'string' || !REVIEW_ID.test(id) || confirmation !== 'confirmed') return { ok: false, error: '删除请求无效，请重新确认后再试。' };
    try {
        const store = photoReferenceStore();
        const entry = store.list().find(item => item.id === id);
        if (!entry || !store.remove(id)) return { ok: false, error: '找不到这项视觉参考。' };
        audit?.(`控制台删除了 AI 照片参考（${entry.kind}；${entry.id}）`);
        return { ok: true };
    } catch {
        return { ok: false, error: publicPhotoReferenceError };
    }
}

function aiPhotoSummary(): { total: number; pending: number; approved: number; rejected: number } | undefined {
    if (!state.dataDir) return undefined;
    try { return photoReviewStores().drafts.status(); } catch { return undefined; }
}

const EXTERNAL_PLATFORMS = new Set<ExternalPlatform>(['tieba', 'douyin', 'xiaohongshu']);
const EXTERNAL_STATUSES = new Set<ExternalDraftStatus>(['pending', 'approved', 'rejected', 'publishing', 'published', 'failed']);
const EXTERNAL_ID = /^[a-z0-9-]{8,80}$/;
const publicExternalDraftError = '外部平台草稿暂时无法处理，请刷新页面后重试；详细原因见运行日志。';

function externalDrafts() {
    if (!state.dataDir) throw new Error('外部平台草稿尚未连接到数据目录');
    const dir = resolve(state.dataDir, 'external-drafts');
    if (dirname(dir) !== resolve(state.dataDir)) throw new Error('外部平台草稿目录越界');
    return createExternalDraftStore({
        dir,
        canDraft: platform => {
            try {
                const mode = state.status?.().externalPlatforms?.[platform];
                return mode === 'draft' || mode === 'authorized';
            } catch { return false; }
        },
    });
}

export function listExternalDrafts(platform: unknown, status: unknown, limit: unknown = 50): ExternalDraftListResult {
    if (platform !== undefined && (typeof platform !== 'string' || !EXTERNAL_PLATFORMS.has(platform as ExternalPlatform))) return { ok: false, error: '请选择有效的平台。' };
    if (status !== undefined && (typeof status !== 'string' || !EXTERNAL_STATUSES.has(status as ExternalDraftStatus))) return { ok: false, error: '请选择有效的草稿状态。' };
    const safeLimit = Number.isInteger(limit) ? Math.min(100, Math.max(1, Number(limit))) : 50;
    try {
        const entries = externalDrafts().list({ ...(platform ? { platform: platform as ExternalPlatform } : {}), ...(status ? { status: status as ExternalDraftStatus } : {}), limit: safeLimit })
            .map(item => ({ id: item.id, platform: item.platform, title: item.title, body: item.body, status: item.status, source: item.source, createdAt: item.createdAt, updatedAt: item.updatedAt, mediaCount: item.media.length }));
        return { ok: true, entries };
    } catch { return { ok: false, error: publicExternalDraftError }; }
}

/** 这里只能批准/拒绝，批准后仍需官方适配器另行发布，控制台不会产生外部副作用。 */
export function reviewExternalDraft(action: unknown, id: unknown, confirmation: unknown, audit?: (message: string) => void): ExternalDraftReviewResult {
    if ((action !== 'approve' && action !== 'reject') || typeof id !== 'string' || !EXTERNAL_ID.test(id) || confirmation !== 'confirmed') return { ok: false, error: '草稿审核请求无效，请重新确认。' };
    try {
        const status: ExternalDraftStatus = action === 'approve' ? 'approved' : 'rejected';
        const item = externalDrafts().updateStatus(id, status, action === 'approve' ? '控制台人工批准' : '控制台人工拒绝');
        if (!item) return { ok: false, error: '找不到这条草稿。' };
        audit?.(`控制台${action === 'approve' ? '批准' : '拒绝'}了外部平台草稿（${item.platform}；${item.id}）`);
        void service?.refresh();
        return { ok: true, status: item.status };
    } catch { return { ok: false, error: publicExternalDraftError }; }
}

/** 只读运行摘要：不返回模型名、URL、密钥、磁盘路径或供应商错误原文。 */
export function aiPhotoRuntimeStatus(env: NodeJS.ProcessEnv = process.env): AiPhotoRuntimeStatus {
    let feature: AiPhotoRuntimeStatus['feature'] = 'unknown';
    try {
        const item = state.status?.().features.find(candidate => candidate.key === 'aiPhotos');
        if (item) feature = item.on ? 'on' : 'off';
    } catch { /* 状态服务失败不阻断照片页 */ }

    let providers: readonly AiPhotoProvider['id'][] = [];
    try { providers = aiPhotoProvidersFromEnv(env).map(provider => provider.id); } catch { /* 环境配置不向页面暴露 */ }
    const drafts = aiPhotoSummary();
    if (!state.dataDir) return { feature, providers, ...(drafts ? { drafts } : {}), degraded: '用量统计尚未连接。' };

    try {
        const dataDir = resolve(state.dataDir);
        const usageDir = resolve(dataDir, 'ai-photo-usage');
        const usageFile = resolve(usageDir, 'usage.json');
        if (dirname(usageDir) !== dataDir || dirname(usageFile) !== usageDir) throw new Error('用量目录越界');
        if (existsSync(usageDir)) {
            const directory = lstatSync(usageDir);
            if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('用量目录不安全');
        }
        if (existsSync(usageFile)) {
            const file = lstatSync(usageFile);
            if (!file.isFile() || file.isSymbolicLink() || dirname(realpathSync(usageFile)) !== realpathSync(usageDir)) throw new Error('用量索引不安全');
        }
        const status = createAiPhotoProviderPool({
            dir: usageDir,
            providers: aiPhotoProvidersFromEnv(env),
            dailyLimit: Number(env.QQBOT_IMAGE_DAILY_LIMIT ?? 4),
        }).status();
        return {
            feature, providers: status.providers,
            usage: { day: status.day, attempts: status.attempts, generated: status.generated, failed: status.failed, remaining: status.remaining },
            ...(drafts ? { drafts } : {}),
        };
    } catch {
        return { feature, providers, ...(drafts ? { drafts } : {}), degraded: '今日用量暂时无法读取。' };
    }
}

/** 控制台只拿展示需要的字段，不返回磁盘路径、事件键、模型名或提示词哈希。 */
export function listAiPhotoDrafts(status: unknown = 'pending_review', limit: unknown = 24, now: Date = new Date()): AiPhotoListResult {
    if (typeof status !== 'string' || !REVIEW_STATUSES.has(status as AiPhotoDraftStatus)) return { ok: false, error: '请选择有效的审核状态。' };
    const safeLimit = Number.isInteger(limit) ? Math.min(30, Math.max(1, Number(limit))) : 24;
    try {
        const entries = photoReviewStores().drafts.list(status as AiPhotoDraftStatus)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .slice(0, safeLimit)
            .map(entry => {
                const freshness = aiPhotoDraftFreshness(entry, now);
                return {
                    id: entry.id,
                    kind: entry.kind,
                    caption: entry.caption,
                    at: entry.at,
                    createdAt: entry.createdAt,
                    expiresAt: freshness.expiresAt,
                    expired: !freshness.fresh,
                    status: entry.status,
                    ...(entry.reviewedAt ? { reviewedAt: entry.reviewedAt } : {}),
                };
            });
        return { ok: true, entries };
    } catch {
        return { ok: false, error: publicPhotoReviewError };
    }
}

/** 缩略图按编号单独取；编号和索引文件名都校验，不能借这个入口读任意本地文件。 */
export function aiPhotoPreview(id: unknown): AiPhotoPreviewResult {
    if (typeof id !== 'string' || !REVIEW_ID.test(id)) return { ok: false, error: '找不到这张照片草稿。' };
    try {
        const { drafts, filesDir } = photoReviewStores();
        const entry = drafts.list().find(item => item.id === id);
        if (!entry) return { ok: false, error: '找不到这张照片草稿。' };
        if (!entry.file.startsWith(`${entry.id}.`)) return { ok: false, error: '找不到这张照片草稿。' };
        const target = resolve(filesDir, entry.file);
        if (dirname(target) !== filesDir) return { ok: false, error: '找不到这张照片草稿。' };
        if (lstatSync(target).isSymbolicLink() || dirname(realpathSync(target)) !== realpathSync(filesDir)) return { ok: false, error: '找不到这张照片草稿。' };
        const bytes = new Uint8Array(readFileSync(target));
        if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) return { ok: false, error: '这张图片无法预览。' };
        const type = detectImageType(bytes);
        if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'image/webp') return { ok: false, error: '这张图片无法预览。' };
        return { ok: true, dataUrl: imageDataUrl({ bytes, type }) };
    } catch {
        return { ok: false, error: '这张图片暂时无法预览。' };
    }
}

/** 通过后只进入照片货架；这里没有发送 QQ 的能力。 */
export function reviewAiPhoto(action: unknown, id: unknown, confirmation: unknown, audit?: (message: string) => void): AiPhotoReviewResult {
    if ((action !== 'approve' && action !== 'reject') || typeof id !== 'string' || !REVIEW_ID.test(id) || confirmation !== 'confirmed') return { ok: false, error: '审核请求无效，请重新确认后再试。' };
    try {
        const { drafts, shelf } = photoReviewStores();
        const entry = action === 'approve' ? drafts.approve(id, shelf) : drafts.reject(id);
        audit?.(`控制台${action === 'approve' ? '通过' : '拒绝'}了 AI 照片草稿（${id}；${entry.kind}）`);
        void service?.refresh();
        return { ok: true, status: entry.status };
    } catch {
        return { ok: false, error: publicPhotoReviewError };
    }
}

/** 编辑页只返回用户能据此修改的中文提示，不把 YAML 路径、字段名或输入值当成错误串展示。 */
export function publicCharacterError(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    if (/HH:MM|(?:schedule\.yml\.)?(?:sleep|wake)|时间格式/i.test(text)) {
        return '时间格式不正确，请按“时:分”填写，例如 08:30。';
    }
    if (/persona\.yml|tiers\.yml|引用|不存在|没有/.test(text)) {
        return '资料中有一项引用不存在，请重新选择相关的说话方式、场景档或条目。';
    }
    return '资料格式不正确，请检查当前页面的必填项和选择项。';
}

/** 控制台只给处理方向；原始异常可能带路径、配置值或技术字段，完整内容留在受控运行日志。 */
function publicConsoleError(error: string): string {
    return error.includes('配置有误')
        ? '配置有误，插件没有启动。请检查插件设置；详细原因见运行日志。'
        : '插件没有启动。请查看运行日志中的详细原因。';
}

function character() {
    if (!state.character) throw new Error('还不知道角色资料在哪：qqbot 插件没启动过');
    return state.character;
}

/** 用页面改过的一部分替换现有资料，校验结构、引用和档位隐私；dryRun 时不写 */
export function saveCharacter(part: SourcePart, value: unknown, dryRun = false): SaveResult {
    const paths = character();
    let source: CharacterSource;
    try {
        const current = readSource(paths.sourceDir);
        source = checkSource({ ...current, [part]: value });
    } catch (error) {
        return { ok: false, error: publicCharacterError(error) };
    }
    let built: ReturnType<typeof buildCharacter>;
    try {
        built = buildCharacter(source, paths.prefix);
    } catch (error) {
        return { ok: false, error: publicCharacterError(error) };
    }
    const problems = checkPrivacy(built, source);
    if (problems.length) return { ok: false, problems };
    if (dryRun) return { ok: true, written: [] };
    writeSource(paths.sourceDir, source);
    const { written } = writeOutputs(paths.stDir, built);
    return { ok: true, written };
}

/** 每个 Koishi 进程注册一次，挂在根上下文上 */
export function registerConsole(ctx: Context, repoRoot: string): void {
    if (registered) return;
    registered = true;
    const root = ctx.root;
    napcat = () => {
        const bot = root.bots.find(b => b.platform === 'onebot');
        return { online: bot?.status === 1, ...(bot?.selfId ? { selfId: bot.selfId } : {}) };
    };
    root.inject(['console'], (c) => {
        const api = (c as Context & { console: ConsoleApi }).console;
        // 入口文件的路径里要有 node_modules，否则控制台返回 403（plugin-console 的 @plugin- 路由）：走工作区的链接
        const clientDir = resolve(repoRoot, 'node_modules/koishi-plugin-qqbot/client');
        api.addEntry({ dev: join(clientDir, 'index.js'), prod: clientDir });

        const { DataService } = require('@koishijs/console') as { DataService: new (ctx: Context, key: string, options: object) => { refresh(): Promise<void> } };
        class QqbotService extends DataService {
            constructor(ctx: Context) {
                super(ctx, 'qqbot', { authority: 4 });
                service = this;
            }

            async get(): Promise<ConsoleData> {
                return consoleData();
            }
        }
        c.plugin(QqbotService as never);
        // 「几点看到」「她此刻在干什么」会随时间变：定时推
        const timer = setInterval(() => void service?.refresh(), 5000);
        c.on('dispose', () => {
            clearInterval(timer);
            service = undefined;
        });

        const authority = { authority: 4 };
        api.addListener('qqbot/character/load', () => {
            const paths = character();
            return { source: readSource(paths.sourceDir) };
        }, authority);
        api.addListener('qqbot/character/check', (part: SourcePart, value: unknown) => saveCharacter(part, value, true), authority);
        api.addListener('qqbot/character/save', (part: SourcePart, value: unknown) => {
            const result = saveCharacter(part, value);
            if (result.ok) root.logger('qqbot').info(`控制台保存了角色资料（${part}），重新生成 ${result.written.length} 个文件：${result.written.join('、') || '无变化'}`);
            return result;
        }, authority);
        api.addListener('qqbot/ai-photos/list', (status: unknown, limit: unknown) => listAiPhotoDrafts(status, limit), authority);
        api.addListener('qqbot/ai-photos/preview', (id: unknown) => aiPhotoPreview(id), authority);
        api.addListener('qqbot/ai-photos/review', (action: unknown, id: unknown, confirmation: unknown) => reviewAiPhoto(action, id, confirmation, message => root.logger('qqbot').info(message)), authority);
        api.addListener('qqbot/ai-photos/runtime', () => aiPhotoRuntimeStatus(), authority);
        api.addListener('qqbot/ai-photo-references/list', () => listAiPhotoReferences(), authority);
        api.addListener('qqbot/ai-photo-references/add', (kind: unknown, image: unknown, referenceId: unknown, nonHumanConfirmed: unknown, confirmation: unknown) => addAiPhotoReference(kind, image, referenceId, nonHumanConfirmed, confirmation, message => root.logger('qqbot').info(message)), authority);
        api.addListener('qqbot/ai-photo-references/remove', (id: unknown, confirmation: unknown) => removeAiPhotoReference(id, confirmation, message => root.logger('qqbot').info(message)), authority);
        api.addListener('qqbot/external-drafts/list', (platform: unknown, status: unknown, limit: unknown) => listExternalDrafts(platform, status, limit), authority);
        api.addListener('qqbot/external-drafts/review', (action: unknown, id: unknown, confirmation: unknown) => reviewExternalDraft(action, id, confirmation, message => root.logger('qqbot').info(message)), authority);
    });
}

interface ConsoleApi {
    addEntry(files: { dev: string; prod: string }): void;
    addListener(event: string, callback: (...args: never[]) => unknown, options: { authority: number }): void;
}
