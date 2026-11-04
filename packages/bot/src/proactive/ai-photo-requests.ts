// AI 生活照请求编排（ADR 0240）：世界账/QQ 只提出草稿请求，真正图片仍须人工审核后才进照片货架。
// 这里不发送消息，也不把普通照片货架中的旧图当成“现在拍的”。

import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { lastMealDish, worldNews, type WorldNow } from '../world/world.ts';
import type { PhotoKind } from '../vision/photos.ts';
import type { AiPhotoContext, AiPhotoDraft, AiPhotoDraftStore, AiPhotoGenerator, AiPhotoKind } from '../vision/ai-photo-drafts.ts';

export const AI_PHOTO_DAILY_MAX = 3;
export const AI_PHOTO_FAILURE_COOLDOWN_MS = 30 * 60_000;

export type AiPhotoRequestOutcome = 'generated' | 'existing' | 'daily_limit' | 'cooldown' | 'in_flight' | 'failed';

interface RequestState {
    version: 1;
    lastFailureAt?: string;
}

const validState = (value: unknown): value is RequestState => {
    if (!value || typeof value !== 'object') return false;
    const state = value as Partial<RequestState>;
    return state.version === 1 && (state.lastFailureAt === undefined || Number.isFinite(Date.parse(state.lastFailureAt)));
};

const sameLocalDay = (left: Date, right: Date) => left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();

export interface AiPhotoRequestService {
    request(context: AiPhotoContext): Promise<AiPhotoRequestOutcome>;
    find(eventKey: string): AiPhotoDraft | undefined;
    observeWorld(world: WorldNow, at: Date): Promise<AiPhotoRequestOutcome[]>;
}

export interface AiPhotoRequestServiceOptions {
    store: AiPhotoDraftStore;
    /** 第二个参数让质量门能核对这一张对应的世界事实；旧的一参生成器仍可直接传入。 */
    generator: (prompt: string, context: AiPhotoContext) => ReturnType<AiPhotoGenerator>;
    stateFile: string;
    now?: () => Date;
    dailyMax?: number;
    failureCooldownMs?: number;
    log?: (message: string) => void;
}

/** 世界事件只取已经发生的猫/饭照片事件；eventKey 与世界账事件一一对应。 */
export function worldAiPhotoContexts(world: WorldNow, at: Date): AiPhotoContext[] {
    const weather = world.weather?.now ? `${world.weather.now.text}，${world.weather.now.temp}℃`
        : world.weather ? `${world.weather.rain ? '有雨' : '无雨'}，${world.weather.low}–${world.weather.high}℃` : undefined;
    const contexts: AiPhotoContext[] = [];
    for (const news of worldNews(world, ['cat_photo', 'food_photo']).filter(value => value.at <= at)) {
        if (news.kind === 'cat_photo' && world.cat) {
            contexts.push({
                kind: 'cat' as const,
                eventKey: `world:${news.id}`,
                subject: `${world.cat.name}在${world.atSchool ? '普通校园角落' : '普通住宅区角落'}停留`,
                caption: `${world.cat.name}在路边待着`,
                at: news.at.toISOString(),
                ...(weather ? { weather } : {}),
                place: world.atSchool ? '普通校园户外角落' : '普通住宅区户外角落',
                activity: `刚喂过${world.cat.name}`,
            });
        }
        if (news.kind === 'food_photo' && news.dish) {
            const meal = world.routine?.meals.find(value => value.dish === news.dish);
            const place = meal?.where === 'canteen' ? '普通食堂餐桌' : meal?.where === 'takeout' ? '普通宿舍外卖桌' : '普通家用餐桌';
            contexts.push({
                kind: 'food' as const,
                eventKey: `world:${news.id}`,
                subject: `${news.dish}刚摆在${place}`,
                caption: `${news.dish}，这一顿刚吃的`,
                dish: news.dish,
                at: news.at.toISOString(),
                ...(weather ? { weather } : {}),
                place,
                activity: '准备吃饭',
            });
        }
    }
    return contexts;
}

const photoKind: Record<PhotoKind, AiPhotoKind> = { cat: 'cat', food: 'food', work: 'desk', view: 'view' };

/** QQ 明确要“现在/刚刚”的照片时，按当前世界事实建立稳定请求；没有当前菜名时不伪造食物照。 */
export function currentAiPhotoContext(kind: PhotoKind, world: WorldNow, at: Date, dish?: string): AiPhotoContext | undefined {
    if (kind === 'cat') return worldAiPhotoContexts(world, at).find(context => context.kind === 'cat');
    const actualDish = kind === 'food' ? (dish ?? lastMealDish(world, at)?.dish) : undefined;
    if (kind === 'food' && !actualDish) return undefined;
    const localHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(at);
    const hour = `${world.day}:${localHour}`;
    const weather = world.weather?.now ? `${world.weather.now.text}，${world.weather.now.temp}℃` : undefined;
    const setting = world.atSchool ? '普通校园或宿舍环境' : '普通住宅环境';
    const details: Record<PhotoKind, Pick<AiPhotoContext, 'subject' | 'caption' | 'place' | 'activity'>> = {
        cat: { subject: `${world.cat?.name ?? '熟悉的三花猫'}在普通户外角落`, caption: `${world.cat?.name ?? '三花猫'}在路边待着`, place: world.atSchool ? '普通校园户外角落' : '普通住宅区户外角落', activity: '随手看见猫' },
        food: { subject: `${actualDish}摆在普通餐桌上`, caption: `${actualDish}，这一顿吃的`, place: setting, activity: '准备吃饭' },
        work: { subject: '正在使用的普通学生书桌，摆着日常学习和摄影用品', caption: '现在桌上随手拍的一张', place: setting, activity: '在桌边做自己的事' },
        view: { subject: '从当前位置看到的普通窗外或路边景色', caption: '这会儿眼前的景色', place: setting, activity: '随手看向窗外或路边' },
    };
    return {
        kind: photoKind[kind],
        // 只在同一世界日期和小时内去重；隔天或下一顿即使菜名相同，也不能复用旧图冒充“现在”。
        eventKey: `qq-current:${kind}:${hour}${kind === 'food' ? `:${actualDish}` : ''}`,
        ...details[kind],
        at: at.toISOString(),
        ...(actualDish ? { dish: actualDish } : {}),
        ...(weather ? { weather } : {}),
    };
}

export function isExplicitCurrentPhotoRequest(text: string): boolean {
    return /现在|当前|这会儿|此刻|刚刚|刚才|刚拍|现拍|这顿|今天这/.test(text);
}

export function aiPhotoRequestService(options: AiPhotoRequestServiceOptions): AiPhotoRequestService {
    const now = options.now ?? (() => new Date());
    const dailyMax = Math.max(1, Math.floor(options.dailyMax ?? AI_PHOTO_DAILY_MAX));
    const cooldownMs = Math.max(0, options.failureCooldownMs ?? AI_PHOTO_FAILURE_COOLDOWN_MS);
    let state = readJsonOr<RequestState>(options.stateFile, { version: 1 }, options.log, { validate: validState, label: 'AI 照片自动请求状态' });
    const inFlight = new Set<string>();
    const persist = () => {
        mkdirSync(dirname(options.stateFile), { recursive: true });
        writeJsonAtomic(options.stateFile, state);
    };
    const find = (eventKey: string) => options.store.list().find(entry => entry.eventKey === eventKey);
    const service: AiPhotoRequestService = {
        find,
        async request(context) {
            if (find(context.eventKey)) return 'existing';
            if (inFlight.has(context.eventKey)) return 'in_flight';
            const at = now();
            if (state.lastFailureAt && at.getTime() - Date.parse(state.lastFailureAt) < cooldownMs) return 'cooldown';
            const createdToday = options.store.list().filter(entry => /^(?:world|qq-current):/.test(entry.eventKey) && sameLocalDay(new Date(entry.createdAt), at)).length;
            if (createdToday >= dailyMax) return 'daily_limit';
            inFlight.add(context.eventKey);
            try {
                await options.store.generate(context, prompt => options.generator(prompt, context));
                if (state.lastFailureAt) { state = { version: 1 }; persist(); }
                return 'generated';
            } catch {
                state = { version: 1, lastFailureAt: at.toISOString() };
                persist();
                options.log?.('AI 照片草稿：生成失败，进入冷却；错误正文不写日志');
                return 'failed';
            } finally {
                inFlight.delete(context.eventKey);
            }
        },
        async observeWorld(world, at) {
            const outcomes: AiPhotoRequestOutcome[] = [];
            for (const context of worldAiPhotoContexts(world, at)) outcomes.push(await service.request(context));
            return outcomes;
        },
    };
    return service;
}

export type CurrentAiPhotoResult =
    | { state: 'approved'; eventKey: string; shelfId: string }
    | { state: 'pending' | 'requested' | 'unavailable'; eventKey?: string };

/** 同步给聊天流水线一个结果；新请求后台生成，绝不阻塞 QQ 回复，也绝不自动发送。 */
export function requestCurrentAiPhoto(service: AiPhotoRequestService, kind: PhotoKind, world: WorldNow, at: Date, dish?: string): CurrentAiPhotoResult {
    const context = currentAiPhotoContext(kind, world, at, dish);
    if (!context) return { state: 'unavailable' };
    const existing = service.find(context.eventKey);
    if (existing?.status === 'approved' && existing.shelfId) return { state: 'approved', eventKey: context.eventKey, shelfId: existing.shelfId };
    if (existing) return { state: existing.status === 'pending_review' ? 'pending' : 'unavailable', eventKey: context.eventKey };
    void service.request(context);
    return { state: 'requested', eventKey: context.eventKey };
}

export const defaultAiPhotoStateFile = (dataDir: string) => join(dataDir, 'ai-photo-drafts', 'auto-state.json');
