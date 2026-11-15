// 这一轮给她看的图片表情和照片清单作为解释器的模块（ADR 0336 第 5 步）：
// - sticker（ADR 0063 / 0099 / 0132）：抽到这一轮发图片表情时，按他这句话从收藏里挑的几张和「这一轮要发一个 / 只发一个」那一句。
// - photo（ADR 0109 / 0128 / 0240）：他要看、货架里有、允许发的那一类照片的编号清单；「现在的照片」有审核通过的匹配图时只给那一张。
//
// 这一模块只放，不取：清单留在联系人流水线原来的位置（拼段落之前、contribute 之前）取，写进 turn.facts，这里照原样放。原因：
// - 两个货架每取一次都碰外部：照片货架每次都重读索引文件（独立的 photo-cli 可能刚改过），表情收藏要确认索引、逐张查文件在不在；
//   索引坏了会抛错。迁移前它们在所有模块的 contribute 之前取，抛错时一个模块的 contribute 都还没跑（命令结果读了就删之类都还没发生）；
//   挪进 contribute 就要看模块排在哪、前面的模块已经做了什么。
// - 取的次数是行为：迁移前条件一次、内容一次（照片有审核过的那一张时一次都不取），原位不动就照旧，不用另证。
// - 算清单要的几样（抽没抽到、只发表情、哪一类、哪道菜、审核过的那一张）都是照片 / 图片表情那一串的中间结果，清理（下面的 cleanAt）还要用，也写在 turn.facts 上。
// 条件都在取的地方（档位、危机、被吵醒、小别扭、他难过、这一轮发照片就不发表情……），这里不再看。
// 不存状态、不调模型、不记日志。同步返回，不多等一个微任务（行为基线核对事件顺序）。
//
// 清理（ADR 0336「生成之后那一段」第 9 步，cleanAt）：生成的每一稿都按清理顺序表过一遍这三步，和迁移前联系人流水线里的逐字一样：
// - stickers：有收藏库时按这一轮允不允许（turn.facts.stickersAllowed）留一个认识的编号、去掉多的和冒充图片的文字（收藏库自己记日志）；没有收藏库一律摘掉编号。
// - photos：有照片货架时只留这一轮那一类（turn.facts.photo / photoDish）的一张；这一轮不发照片就全摘掉；没有货架一律摘掉。
// - stickerOnly：只发表情的轮次（turn.facts.stickerOnly）模型多写了文字就去掉、只留表情那一行；它没写表情就照它写的发。
// 货架是联系人流水线的（清单的取、聊天记录的写法也用），经 CleanCtx 给；这一模块 App 和模拟器都总是挂，不挂的话编号会原样发出去。

import type { Module, TurnFacts } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { stripStickerArtifacts } from '../social/stickers.ts';
import { stripPhotoArtifacts } from '../vision/photos.ts';

/** 这几样由联系人流水线写进 turn.facts，这里只读（字段说明见 interpreter.ts 的 TurnFacts） */
export type MediaOffersFacts = Pick<TurnFacts, 'stickerLine' | 'photoLine'>;

/** 只发表情那一行（stickers.ts 的 EXACT_TOKEN） */
const STICKER_ONLY_LINE = /^<sticker:[a-f0-9]{12}>$/i;

export function mediaOffersModule(): Module {
    return {
        id: 'media-offers',
        contribute(turn) {
            const facts = turn.facts;
            const pieces: Piece[] = [];
            if (facts.stickerLine) pieces.push({ slot: 'sticker', text: facts.stickerLine });
            if (facts.photoLine) pieces.push({ slot: 'photo', text: facts.photoLine });
            return pieces;
        },
        cleanAt: {
            stickers: (text, turn, ctx) => ctx.stickers?.clean(text, Boolean(turn.facts.stickersAllowed)) ?? stripStickerArtifacts(text),
            photos: (text, turn, ctx) => {
                const { photo, photoDish } = turn.facts;
                return ctx.photos ? ctx.photos.clean(text, photo !== undefined, photo ? { kind: photo, ...(photoDish ? { dish: photoDish } : {}) } : undefined) : stripPhotoArtifacts(text);
            },
            stickerOnly: (text, turn) => {
                if (!turn.facts.stickerOnly) return text;
                const only = text.split('\n').map(line => line.trim()).filter(line => STICKER_ONLY_LINE.test(line));
                return only.length ? only.join('\n') : text;
            },
        },
    };
}
