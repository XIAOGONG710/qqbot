import type { Executor } from '../executor/executor.ts';
import { dishesBetween, type Menu } from '../life/menu.ts';
import type { AppConfig } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import { PHOTO_RETRY_MAX, PHOTO_RETRY_MS, type PhotoShelf } from './photos.ts';

// 照片货架的发现与重试（ADR 0110 / 0128）：找猫的照片、给今天明天要吃的菜找照片；被限流 / 断网打断了就过一会儿再来
// （上线时第一次就撞上 Wikimedia 的 429，货架空了 6 小时），最多 PHOTO_RETRY_MAX 次。
// 原来在 app.ts 里（discoverPhotos / discoverFoodPhotos 和两个重试计时器），ADR 0336 第 6 步原样搬到这里；
// 什么时候找（货架的周期发现、第一次连上）仍由 App 和模块定，两个重试计时器的停法仍由 App 登记（food-retry / photo-retry）。
export interface PhotoDiscoveryDeps {
    photos: Pick<PhotoShelf, 'discover' | 'discoverFood'> | undefined;
    /** 吃的照片的来源接上了没有 */
    hasFoodSource: boolean;
    config: Pick<AppConfig, 'foodPhotos' | 'menu'>;
    stopped: () => boolean;
    /** 男朋友档那张卡上她那边的菜单；没有就用默认的 */
    menu: () => Menu | undefined;
    /** 菜单从哪天算起 */
    menuFrom: string | undefined;
    exec: Pick<Executor, 'after' | 'cancel'>;
    /** 重试间隔（测试用；默认 PHOTO_RETRY_MS） */
    retryMs: number | undefined;
    log: Log;
}

export interface PhotoDiscovery {
    discoverPhotos(): void;
    discoverFoodPhotos(): void;
    cancelPhotoRetry(): void;
    cancelFoodRetry(): void;
}

export function photoShelfDiscovery({ photos, hasFoodSource, config, stopped, menu, menuFrom, exec, retryMs: photoRetryMs, log }: PhotoDiscoveryDeps): PhotoDiscovery {
    let foodRetryTimer: ReturnType<Executor['after']> | undefined;
    let foodRetries = 0;
    let photoRetries = 0;
    let photoRetryTimer: ReturnType<Executor['after']> | undefined;
    const discoverPhotos = (): void => {
        if (!photos || stopped()) return;
        photos.discover().then(result => {
            if (result === 'done') { photoRetries = 0; return; }
            if (photoRetries >= PHOTO_RETRY_MAX || stopped()) return;
            photoRetries++;
            exec.cancel(photoRetryTimer);
            photoRetryTimer = exec.after(discoverPhotos, photoRetryMs ?? PHOTO_RETRY_MS);
            photoRetryTimer.unref();
        }).catch(error => log(`照片货架：找照片出错（${error instanceof Error ? error.message : String(error)}）`));
    };
    // 吃的照片（ADR 0128）：给今天、明天要吃的菜找照片；被限流 / 断网打断了同样过一会儿再来
    const discoverFoodPhotos = (): void => {
        if (!photos || !hasFoodSource || !config.foodPhotos || !config.menu || stopped()) return;
        const dishes = dishesBetween(new Date(), 2, menu(), menuFrom);
        if (!dishes.length) return;
        photos.discoverFood(dishes).then(result => {
            if (result === 'done') { foodRetries = 0; return; }
            if (foodRetries >= PHOTO_RETRY_MAX || stopped()) return;
            foodRetries++;
            exec.cancel(foodRetryTimer);
            foodRetryTimer = exec.after(discoverFoodPhotos, photoRetryMs ?? PHOTO_RETRY_MS);
            foodRetryTimer.unref();
        }).catch(error => log(`照片货架：找吃的照片出错（${error instanceof Error ? error.message : String(error)}）`));
    };
    return {
        discoverPhotos,
        discoverFoodPhotos,
        cancelPhotoRetry: () => exec.cancel(photoRetryTimer),
        cancelFoodRetry: () => exec.cancel(foodRetryTimer),
    };
}
