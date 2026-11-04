import { aiPhotoDraftFreshness, type AiPhotoContext, type AiPhotoDraftStore, type AiPhotoGenerator } from '../vision/ai-photo-drafts.ts';
import type { AiPhotoProvider } from '../vision/ai-photo-provider.ts';

export interface AiPhotoLivePreflight {
    ready: boolean;
    providers: readonly AiPhotoProvider['id'][];
    dailyLimit: number;
    visualReview: boolean;
    blockers: readonly string[];
}

/**
 * 真实调用前的纯检查。结果只含供应商角色和开关，不含 URL、模型名或密钥，
 * 因而可以安全地展示在本地终端和自动化报告中。
 */
export function aiPhotoLivePreflight(options: {
    providers: readonly AiPhotoProvider[];
    dailyLimit: number;
    visualReview: boolean;
}): AiPhotoLivePreflight {
    const blockers: string[] = [];
    if (!options.providers.length) blockers.push('没有配置生图服务');
    if (!options.visualReview) blockers.push('没有配置视觉审查服务');
    if (!Number.isInteger(options.dailyLimit) || options.dailyLimit < 1 || options.dailyLimit > 100) blockers.push('每日调用上限必须是 1–100 的整数');
    return {
        ready: blockers.length === 0,
        providers: options.providers.map(provider => provider.id),
        dailyLimit: options.dailyLimit,
        visualReview: options.visualReview,
        blockers,
    };
}

export interface AiPhotoLiveCheckResult {
    id: string;
    kind: AiPhotoContext['kind'];
    status: 'pending_review';
    mime: 'image/jpeg' | 'image/png' | 'image/webp';
    bytes: number;
    expiresAt: string;
}

/**
 * 执行一次会产生真实供应商调用的闭环冒烟：生成、质量门、草稿落盘、重新读取。
 * 它故意停在待审核状态，不批准、不进入照片货架，也不发送 QQ。
 */
export async function runAiPhotoLiveCheck(options: {
    confirmed: boolean;
    context: AiPhotoContext;
    store: Pick<AiPhotoDraftStore, 'generate' | 'list' | 'preview'>;
    generator: AiPhotoGenerator;
    now?: () => Date;
}): Promise<AiPhotoLiveCheckResult> {
    if (!options.confirmed) throw new Error('真实生图验收会消耗调用额度，必须显式添加 --confirm-live');
    const now = options.now ?? (() => new Date());
    if (!aiPhotoDraftFreshness(options.context, now()).fresh) throw new Error('验收事件已经过期，请使用当前时间创建新的事件键');
    if (options.store.list().some(entry => entry.eventKey === options.context.eventKey)) {
        throw new Error('这个事件键已经生成过，无法证明本次执行真的调用了生图服务；请换一个新事件键');
    }
    const entry = await options.store.generate(options.context, options.generator);
    if (entry.status !== 'pending_review') throw new Error('真实生图验收没有停在待审核状态');
    const freshness = aiPhotoDraftFreshness(entry, now());
    if (!freshness.fresh) throw new Error('真实生图验收完成时照片已经过期');
    const preview = options.store.preview(entry.id);
    if (!preview.bytes.length) throw new Error('真实生图验收无法重新读取草稿图片');
    return {
        id: entry.id,
        kind: entry.kind,
        status: 'pending_review',
        mime: preview.type,
        bytes: preview.bytes.length,
        expiresAt: freshness.expiresAt,
    };
}
