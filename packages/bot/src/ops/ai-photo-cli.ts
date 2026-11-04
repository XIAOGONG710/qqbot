// AI 生活照草稿（ADR 0239）：generate 只生成待审核草稿；approve 才进入照片货架；这里不负责发 QQ。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiPhotoDraftStore, AI_PHOTO_KINDS, generateAiPhoto, type AiPhotoContext, type AiPhotoDraftStatus, type AiPhotoKind } from '../vision/ai-photo-drafts.ts';
import { photoShelf } from '../vision/photos.ts';
import { aiPhotoProvidersFromEnv, createAiPhotoProviderPool } from '../vision/ai-photo-provider.ts';
import { aiPhotoReferenceStore } from '../vision/ai-photo-references.ts';
import { aiPhotoReviewModelFromImageDescriber, createAiPhotoVisualReviewer, qualityCheckedAiPhotoGenerator } from '../vision/ai-photo-quality-adapter.ts';
import { configuredImageDescriber } from '../vision/vision.ts';
import { loadConfig } from '../platform/config.ts';
import { aiPhotoLivePreflight, runAiPhotoLiveCheck } from './ai-photo-live-check.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const baseDir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--dir') ?? resolve(repoRoot, 'runtime/bot'));
const command = args[0];
let draftStore: ReturnType<typeof aiPhotoDraftStore> | undefined;
const drafts = () => draftStore ??= aiPhotoDraftStore({ dir: resolve(baseDir, 'ai-photo-drafts'), log: line => console.log(line) });

const usage = () => [
    '用法：',
    '  preflight [--dir <数据目录>]  # 只检查配置，不访问供应商',
    `  generate --kind <${AI_PHOTO_KINDS.join('|')}> --event <稳定事件键> --subject "画面主体" --caption "照片说明" --at <ISO 时间>`,
    '           [--dish "菜名"] [--weather "天气"] [--place "普通地点"] [--activity "正在做什么"] [--dir <数据目录>]',
    `  smoke --confirm-live --kind <${AI_PHOTO_KINDS.join('|')}> --event <全新事件键> --subject "画面主体" --caption "照片说明" --at <当前 ISO 时间>`,
    '           [--dish "菜名"] [--weather "天气"] [--place "普通地点"] [--activity "正在做什么"] [--dir <数据目录>]',
    '  list [--status pending_review|approved|rejected] [--dir <数据目录>]',
    '  approve <编号> [--dir <数据目录>]',
    '  reject <编号> [--dir <数据目录>]',
    '',
    'generate 至少需要一个生图服务：QQBOT_IMAGE_LOCAL_BASE_URL 或 QQBOT_IMAGE_API_KEY；也可配置备用服务。',
    'QQBOT_IMAGE_DAILY_LIMIT 控制每日总尝试次数（默认 4，失败与降级也计数）。',
    'preflight 不联网；smoke 必须显式写 --confirm-live，会消耗额度，但只生成待审核草稿。',
    '生成结果只在本地等待审核，不会自动发送。',
].join('\n');

const contextFromArgs = (): AiPhotoContext => {
    const kind = one('--kind');
    const eventKey = one('--event');
    const subject = one('--subject');
    const caption = one('--caption');
    const at = one('--at') ?? new Date().toISOString();
    if (!kind || !AI_PHOTO_KINDS.includes(kind as AiPhotoKind) || !eventKey || !subject || !caption) throw new Error(usage());
    return {
        kind: kind as AiPhotoKind, eventKey, subject, caption, at,
        ...(one('--dish') ? { dish: one('--dish') } : {}),
        ...(one('--weather') ? { weather: one('--weather') } : {}),
        ...(one('--place') ? { place: one('--place') } : {}),
        ...(one('--activity') ? { activity: one('--activity') } : {}),
    };
};

const preflightVisionConfigured = (): boolean => {
    try {
        const configured = process.env.QQBOT_CONFIG?.trim() || 'runtime/bot/config.json';
        const path = isAbsolute(configured) ? configured : resolve(repoRoot, configured);
        if (!existsSync(path)) return false;
        const file = JSON.parse(readFileSync(path, 'utf8')) as { vision?: { provider?: unknown; model?: unknown } };
        return Boolean(file.vision && typeof file.vision.provider === 'string' && file.vision.provider.trim()
            && typeof file.vision.model === 'string' && file.vision.model.trim());
    } catch { return false; }
};

const liveStack = (fullConfig: boolean) => {
    const providers = aiPhotoProvidersFromEnv();
    const dailyLimit = Number(process.env.QQBOT_IMAGE_DAILY_LIMIT ?? 4);
    const config = fullConfig ? loadConfig(repoRoot) : undefined;
    const preflight = aiPhotoLivePreflight({ providers, dailyLimit, visualReview: fullConfig ? Boolean(config?.vision) : preflightVisionConfigured() });
    return { providers, dailyLimit, config, preflight };
};

async function run(): Promise<void> {
    if (command === 'preflight') {
        const { preflight } = liveStack(false);
        console.log(`生图服务：${preflight.providers.length ? preflight.providers.map(id => id === 'local' ? '本地' : id === 'primary' ? '主服务' : '备用服务').join('、') : '未配置'}`);
        console.log(`视觉审查：${preflight.visualReview ? '已配置' : '未配置'}`);
        console.log(`每日调用上限：${preflight.dailyLimit}`);
        console.log(preflight.ready ? '预检通过：可以执行真实生图验收' : `预检未通过：${preflight.blockers.join('；')}`);
        if (!preflight.ready) process.exitCode = 2;
        return;
    }
    if (command === 'generate' || command === 'smoke') {
        const context = contextFromArgs();
        const { providers, dailyLimit, config, preflight } = liveStack(true);
        if (!preflight.ready) throw new Error(`真实生图链路未就绪：${preflight.blockers.join('；')}`);
        const pool = createAiPhotoProviderPool({ dir: resolve(baseDir, 'ai-photo-usage'), providers, dailyLimit, log: line => console.log(line), generate: generateAiPhoto });
        if (!config?.vision) throw new Error('没有配置视觉审查服务，质量门已阻止生成草稿');
        const references = aiPhotoReferenceStore({ file: resolve(baseDir, 'ai-photo-references/index.json'), log: line => console.log(line) });
        const reviewer = createAiPhotoVisualReviewer(aiPhotoReviewModelFromImageDescriber(prompt => configuredImageDescriber(config, prompt, 'background')!));
        const generator = qualityCheckedAiPhotoGenerator({ context, reviewer, references, generate: prompt => pool.generate(prompt), maxQualityRegenerations: 1, log: line => console.log(line) });
        if (command === 'smoke') {
            const result = await runAiPhotoLiveCheck({ confirmed: args.includes('--confirm-live'), context, store: drafts(), generator });
            console.log(`真实生图验收通过：${result.kind}，${result.mime}，${result.bytes} 字节，有效至 ${result.expiresAt}`);
            console.log('结果停在待审核区；没有进入照片货架，也没有发送 QQ');
            const usageStatus = pool.status();
            console.log(`今日调用 ${usageStatus.attempts} 次，剩余 ${usageStatus.remaining} 次`);
            const report = one('--report');
            if (report) writeFileSync(resolve(report), `${JSON.stringify({
                version: 1,
                passed: true,
                checkedAt: new Date().toISOString(),
                draft: {
                    id: result.id,
                    kind: result.kind,
                    status: result.status,
                    mime: result.mime,
                    bytes: result.bytes,
                    expiresAt: result.expiresAt,
                },
                usage: { attempts: usageStatus.attempts, remaining: usageStatus.remaining },
            }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
            return;
        }
        const entry = await drafts().generate(context, generator);
        console.log(`待审核：${entry.id}  ${entry.kind}  ${entry.caption}`);
        console.log(`图片：${resolve(baseDir, 'ai-photo-drafts/files', entry.file)}`);
        const usageStatus = pool.status();
        console.log(`今日调用 ${usageStatus.attempts} 次，剩余 ${usageStatus.remaining} 次`);
        return;
    }
    if (command === 'list') {
        const status = one('--status');
        if (status && !['pending_review', 'approved', 'rejected'].includes(status)) throw new Error(usage());
        const entries = drafts().list(status as AiPhotoDraftStatus | undefined);
        if (!entries.length) console.log('没有符合条件的 AI 照片草稿');
        for (const entry of entries) console.log(`${entry.id}  ${entry.status.padEnd(14)}  ${entry.kind.padEnd(4)}  ${entry.caption}`);
        const count = drafts().status();
        console.log(`共 ${count.total} 张：待审核 ${count.pending}，已通过 ${count.approved}，已拒绝 ${count.rejected}`);
        return;
    }
    const id = args[1];
    if (command === 'approve') {
        if (!id) throw new Error(usage());
        const shelf = photoShelf({ dir: resolve(baseDir, 'photos'), log: line => console.log(line) });
        const entry = drafts().approve(id, shelf);
        console.log(`已通过：${entry.id}；照片货架编号 ${entry.shelfId}`);
        return;
    }
    if (command === 'reject') {
        if (!id) throw new Error(usage());
        const entry = drafts().reject(id);
        console.log(`已拒绝：${entry.id}`);
        return;
    }
    throw new Error(usage());
}

run().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
});
