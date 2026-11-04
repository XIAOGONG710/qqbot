import type { ExternalDraft, ExternalDraftStore } from './external-drafts.ts';
import type { ExternalPlatform } from './external-platforms.ts';

export interface OfficialPublishResult {
    outcome: 'accepted' | 'rejected' | 'unknown';
    /** 只存平台返回的非敏感短编号；不得放 URL、令牌或正文。 */
    receipt?: string;
}

export interface OfficialPlatformAdapter {
    platform: ExternalPlatform;
    authorized(): Promise<boolean>;
    publish(draft: Readonly<ExternalDraft>, idempotencyKey: string): Promise<OfficialPublishResult>;
}

export type OfficialPublishDecision =
    | { status: 'published' | 'failed'; receipt?: string }
    | { status: 'reconcile'; reason: string };

const safeReceipt = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(value) ? value : undefined;

/**
 * 官方 SDK / API 的统一提交门槛。草稿必须先人工批准，本次调用还要再次确认；
 * 网络结果不确定时保留 publishing，禁止自动重发，交给 reconcile 查询官方状态。
 */
export async function publishExternalDraft(options: {
    store: Pick<ExternalDraftStore, 'beginPublish' | 'updateStatus'>;
    adapter: OfficialPlatformAdapter;
    draftId: string;
    confirmation: 'confirmed' | string;
    now?: Date;
}): Promise<OfficialPublishDecision> {
    if (options.confirmation !== 'confirmed') throw new Error('发布外部平台内容必须再次人工确认');
    if (!await options.adapter.authorized()) throw new Error('官方平台账号尚未授权');
    const reserved = options.store.beginPublish(options.draftId, options.adapter.platform, options.now);
    if (!reserved) throw new Error('找不到外部平台草稿');
    if (!reserved.started) return { status: 'reconcile', reason: '上次发布结果未知，请先向官方平台核对' };
    const requestId = reserved.draft.publishRequestId;
    if (!requestId) throw new Error('发布幂等编号缺失');
    let result: OfficialPublishResult;
    try { result = await options.adapter.publish(reserved.draft, requestId); }
    catch { return { status: 'reconcile', reason: '官方平台响应不确定，请先核对，不能自动重试' }; }
    if (!result || typeof result !== 'object' || !['accepted', 'rejected', 'unknown'].includes(result.outcome)) {
        return { status: 'reconcile', reason: '官方平台返回了未知状态，请人工核对' };
    }
    const receipt = safeReceipt(result.receipt);
    if (result.outcome === 'unknown') return { status: 'reconcile', reason: '官方平台尚未给出确定结果' };
    if (result.outcome === 'accepted') {
        options.store.updateStatus(options.draftId, 'published', receipt ? `回执 ${receipt}` : '官方平台已接受', options.now);
        return { status: 'published', ...(receipt ? { receipt } : {}) };
    }
    options.store.updateStatus(options.draftId, 'failed', '官方平台明确拒绝', options.now);
    return { status: 'failed' };
}
