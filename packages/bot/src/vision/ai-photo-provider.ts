// AI 生图供应商池与每日预算（ADR 0244）。只记录调用次数和供应商 id，不记录提示词、图片、URL 或密钥。

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { generateAiPhoto, type GeneratedAiPhoto, type ImageGenerationOptions } from './ai-photo-drafts.ts';

export interface AiPhotoProvider {
    id: 'local' | 'primary' | 'fallback';
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    local: boolean;
}

interface UsageDay {
    day: string;
    attempts: number;
    generated: number;
    failed: number;
    byProvider: Partial<Record<AiPhotoProvider['id'], { attempts: number; generated: number; failed: number }>>;
}

interface UsageFile { version: 1; days: UsageDay[] }

export interface AiPhotoProviderPool {
    generate(prompt: string): Promise<GeneratedAiPhoto>;
    status(): { day: string; attempts: number; generated: number; failed: number; remaining: number; providers: readonly AiPhotoProvider['id'][] };
}

const DAY_KEPT = 31;
const ID_SET = new Set(['local', 'primary', 'fallback']);
const validCounter = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
const validUsage = (value: unknown): value is UsageFile => {
    if (!value || typeof value !== 'object') return false;
    const file = value as Partial<UsageFile>;
    return file.version === 1 && Array.isArray(file.days) && file.days.length <= DAY_KEPT && file.days.every(day => {
        if (!day || typeof day !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(day.day))) return false;
        if (!validCounter(day.attempts) || !validCounter(day.generated) || !validCounter(day.failed)) return false;
        if (!day.byProvider || typeof day.byProvider !== 'object' || Array.isArray(day.byProvider)) return false;
        return Object.entries(day.byProvider).every(([id, stats]) => ID_SET.has(id) && stats && typeof stats === 'object'
            && validCounter(stats.attempts) && validCounter(stats.generated) && validCounter(stats.failed));
    });
};

const localDay = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const positiveInt = (value: string | undefined, fallback: number, min: number, max: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const safeBaseUrl = (value: string | undefined, local: boolean): string | undefined => {
    if (!value?.trim()) return undefined;
    try {
        const url = new URL(value.trim());
        if (url.username || url.password || url.search || url.hash) return undefined;
        if (local) {
            if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) return undefined;
        } else if (url.protocol !== 'https:') return undefined;
        return url.toString();
    } catch { return undefined; }
};

/** 环境变量只在进程内解析；返回值不得写入日志或状态文件。优先本地，其次主服务、备用服务。 */
export function aiPhotoProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): AiPhotoProvider[] {
    const timeoutMs = positiveInt(env.QQBOT_IMAGE_TIMEOUT_MS, 90_000, 1_000, 300_000);
    const providers: AiPhotoProvider[] = [];
    const localBaseUrl = safeBaseUrl(env.QQBOT_IMAGE_LOCAL_BASE_URL, true);
    const primaryBaseUrl = safeBaseUrl(env.QQBOT_IMAGE_BASE_URL ?? 'https://api.openai.com/v1/', false);
    const fallbackBaseUrl = safeBaseUrl(env.QQBOT_IMAGE_FALLBACK_BASE_URL, false);
    if (localBaseUrl) providers.push({
        id: 'local', local: true, baseUrl: localBaseUrl,
        apiKey: env.QQBOT_IMAGE_LOCAL_API_KEY?.trim() || 'local-session',
        model: env.QQBOT_IMAGE_LOCAL_MODEL?.trim() || 'local-image', timeoutMs,
    });
    if (env.QQBOT_IMAGE_API_KEY?.trim() && primaryBaseUrl) providers.push({
        id: 'primary', local: false, baseUrl: primaryBaseUrl,
        apiKey: env.QQBOT_IMAGE_API_KEY.trim(), model: env.QQBOT_IMAGE_MODEL?.trim() || 'gpt-image-2.5-flare', timeoutMs,
    });
    if (env.QQBOT_IMAGE_FALLBACK_API_KEY?.trim() && fallbackBaseUrl) providers.push({
        id: 'fallback', local: false, baseUrl: fallbackBaseUrl,
        apiKey: env.QQBOT_IMAGE_FALLBACK_API_KEY.trim(), model: env.QQBOT_IMAGE_FALLBACK_MODEL?.trim() || 'gpt-image-2.5-flare', timeoutMs,
    });
    return providers;
}

export function createAiPhotoProviderPool(options: {
    dir: string;
    providers: readonly AiPhotoProvider[];
    dailyLimit?: number;
    now?: () => Date;
    log?: (message: string) => void;
    generate?: (prompt: string, options: ImageGenerationOptions) => Promise<GeneratedAiPhoto>;
}): AiPhotoProviderPool {
    const now = options.now ?? (() => new Date());
    const dailyLimit = Number.isInteger(options.dailyLimit) && options.dailyLimit! >= 1 && options.dailyLimit! <= 100 ? options.dailyLimit! : 4;
    const path = join(options.dir, 'usage.json');
    let file = readJsonOr<UsageFile>(path, { version: 1, days: [] }, options.log, { validate: validUsage, invalid: 'throw', label: 'AI 照片用量' });
    const providers = [...options.providers].sort((a, b) => Number(b.local) - Number(a.local));
    if (new Set(providers.map(provider => provider.id)).size !== providers.length) throw new Error('AI 生图供应商 id 重复');
    const call = options.generate ?? generateAiPhoto;
    const today = () => localDay(now());
    const current = () => {
        const day = today();
        return file.days.find(item => item.day === day) ?? { day, attempts: 0, generated: 0, failed: 0, byProvider: {} };
    };
    const save = (next: UsageDay) => {
        mkdirSync(options.dir, { recursive: true });
        file = { version: 1, days: [...file.days.filter(item => item.day !== next.day), next].sort((a, b) => a.day.localeCompare(b.day)).slice(-DAY_KEPT) };
        writeJsonAtomic(path, file);
    };
    const bump = (provider: AiPhotoProvider, outcome: 'attempt' | 'generated' | 'failed') => {
        const day = current();
        const existing = day.byProvider[provider.id] ?? { attempts: 0, generated: 0, failed: 0 };
        const stats = { ...existing, ...(outcome === 'attempt' ? { attempts: existing.attempts + 1 } : outcome === 'generated' ? { generated: existing.generated + 1 } : { failed: existing.failed + 1 }) };
        save({ ...day, ...(outcome === 'attempt' ? { attempts: day.attempts + 1 } : outcome === 'generated' ? { generated: day.generated + 1 } : { failed: day.failed + 1 }), byProvider: { ...day.byProvider, [provider.id]: stats } });
    };
    return {
        async generate(prompt) {
            if (!providers.length) throw new Error('没有配置 AI 生图服务');
            if (current().attempts >= dailyLimit) throw new Error(`今天的 AI 生图调用已达到上限（${dailyLimit} 次）`);
            for (const provider of providers) {
                if (current().attempts >= dailyLimit) break;
                bump(provider, 'attempt');
                try {
                    const image = await call(prompt, { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, timeoutMs: provider.timeoutMs });
                    bump(provider, 'generated');
                    options.log?.(`AI 照片：${provider.id === 'local' ? '本地' : provider.id === 'primary' ? '主服务' : '备用服务'}生成成功`);
                    return image;
                } catch {
                    bump(provider, 'failed');
                    options.log?.(`AI 照片：${provider.id === 'local' ? '本地' : provider.id === 'primary' ? '主服务' : '备用服务'}暂时不可用`);
                }
            }
            throw new Error('AI 生图服务暂时不可用，或今天的调用额度已经用完');
        },
        status() {
            const day = current();
            return { day: day.day, attempts: day.attempts, generated: day.generated, failed: day.failed, remaining: Math.max(0, dailyLimit - day.attempts), providers: providers.map(provider => provider.id) };
        },
    };
}

