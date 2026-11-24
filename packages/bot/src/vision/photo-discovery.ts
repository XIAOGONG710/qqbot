import type { Executor } from '../executor/executor.ts';
import type { Log } from '../platform/log.ts';
import { PHOTO_RETRY_MAX, PHOTO_RETRY_MS, type PhotoShelf } from './photos.ts';

// 照片货架的发现与重试（ADR 0110）：找猫的照片；被限流 / 断网打断了就过一会儿再来
// （上线时第一次就撞上 Wikimedia 的 429，货架空了 6 小时），最多 PHOTO_RETRY_MAX 次。
// 原来在 app.ts 里（discoverPhotos 和重试计时器），ADR 0336 第 6 步原样搬到这里；
// 什么时候找（货架的周期发现、第一次连上）仍由 App 和模块定，重试计时器的停法仍由 App 登记（photo-retry）。
// 给菜找照片（ADR 0128，配置 foodPhotos）从没上过线，11-24 连开关一起删了（减法单子 二.2）。
export interface PhotoDiscoveryDeps {
    photos: Pick<PhotoShelf, 'discover'> | undefined;
    stopped: () => boolean;
    exec: Pick<Executor, 'after' | 'cancel'>;
    /** 重试间隔（测试用；默认 PHOTO_RETRY_MS） */
    retryMs: number | undefined;
    log: Log;
}

export interface PhotoDiscovery {
    discoverPhotos(): void;
    cancelPhotoRetry(): void;
}

export function photoShelfDiscovery({ photos, stopped, exec, retryMs: photoRetryMs, log }: PhotoDiscoveryDeps): PhotoDiscovery {
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
    return {
        discoverPhotos,
        cancelPhotoRetry: () => exec.cancel(photoRetryTimer),
    };
}
