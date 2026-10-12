// 把收藏库接到 QQ 账号自己的「收藏的表情」上（ADR 0063）。用 NapCat 的三个扩展接口：
//   add_custom_face（本地文件加进收藏）、fetch_custom_face_detail（列出收藏，每项有 md5 / resId / url）。只加不删（用户 10-12：「存着就行」）。
// 10-12 在她的真号上试过：加 1 张 → 列出来能看到 md5（大写）和 resId，各步 retcode 都是 0（试完用 delete_custom_face 删掉，没有留在收藏里）。
// 这个文件只管「怎么调」，不碰收藏库的逻辑；两个运行入口（独立运行、Koishi 插件）各自给一个调用函数。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { StickerFavorites } from './stickers.ts';

export type QqCall = (action: string, params: Record<string, unknown>) => Promise<unknown>;

interface FavoriteItem { md5: string; resId: string; url?: string }

function items(value: unknown): FavoriteItem[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(raw => {
        if (!raw || typeof raw !== 'object') return [];
        const r = raw as Record<string, unknown>;
        if (typeof r.md5 !== 'string' || typeof r.resId !== 'string') return [];
        return [{ md5: r.md5.toUpperCase(), resId: r.resId, ...(typeof r.url === 'string' && /^https?:\/\//i.test(r.url) ? { url: r.url } : {}) }];
    });
}

export function qqFavorites(call: QqCall): {
    favorites: StickerFavorites;
    /** 给收藏库的 discover：QQ 收藏池里还没被我们同步过的那些（也就是别处加进来的） */
    discover: (knownMd5: ReadonlySet<string>) => Promise<string[]>;
} {
    const list = async (count: number) => items(await call('fetch_custom_face_detail', { count }));
    return {
        favorites: {
            async add(file) {
                const md5 = createHash('md5').update(readFileSync(file)).digest('hex').toUpperCase();
                await call('add_custom_face', { file, is_origin: true });
                return md5;
            },
        },
        async discover(knownMd5) {
            return (await list(48)).filter(item => item.url && !knownMd5.has(item.md5)).map(item => item.url!);
        },
    };
}
