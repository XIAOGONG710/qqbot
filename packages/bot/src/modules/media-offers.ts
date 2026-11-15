// 这一轮给她看的图片表情和照片清单作为解释器的模块（ADR 0336 第 5 步）：
// - sticker（ADR 0063 / 0099 / 0132）：抽到这一轮发图片表情时，按他这句话从收藏里挑的几张和「这一轮要发一个 / 只发一个」那一句。
// - photo（ADR 0109 / 0128 / 0240）：他要看、货架里有、允许发的那一类照片的编号清单；「现在的照片」有审核通过的匹配图时只给那一张。
//
// 这一模块只放，不取：清单留在联系人流水线原来的位置（拼段落之前、contribute 之前）取，写进 turn.facts，这里照原样放。原因：
// - 两个货架每取一次都碰外部：照片货架每次都重读索引文件（独立的 photo-cli 可能刚改过），表情收藏要确认索引、逐张查文件在不在；
//   索引坏了会抛错。迁移前它们在所有模块的 contribute 之前取，抛错时一个模块的 contribute 都还没跑（命令结果读了就删之类都还没发生）；
//   挪进 contribute 就要看模块排在哪、前面的模块已经做了什么。
// - 取的次数是行为：迁移前条件一次、内容一次（照片有审核过的那一张时一次都不取），原位不动就照旧，不用另证。
// - 算清单要的几样（抽没抽到、只发表情、哪一类、哪道菜、审核过的那一张）都是照片 / 图片表情那一串的中间结果，旧逻辑后面清理回复还要用。
// 条件都在取的地方（档位、危机、被吵醒、小别扭、他难过、这一轮发照片就不发表情……），这里不再看。
// 不存状态、不调模型、不记日志。同步返回，不多等一个微任务（行为基线核对事件顺序）。

import type { Module, TurnFacts } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';

/** 这几样由联系人流水线写进 turn.facts，这里只读（字段说明见 interpreter.ts 的 TurnFacts） */
export type MediaOffersFacts = Pick<TurnFacts, 'stickerLine' | 'photoLine'>;

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
    };
}
