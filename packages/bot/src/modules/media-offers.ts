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
//
// 这一轮发不发照片（ADR 0336「判断那一串」，decideAt.photo）：assess 之后、算最终意图之前。和迁移前联系人流水线里的逐字一样：
// - 只给男朋友档；只想一想、危机、小别扭 / 和好、他难过（意图是先接住他此刻的情绪）的轮次不发；货架和「现在的照片」的解析都没有时不看。
// - 他明确要看猫 / 风景 / 她的片子 / 吃的（主动那条自己带着哪一类、哪道菜），货架里有、允许发（没连着发、今天没发够、没被吵醒）就发：写 photo（吃的再写 photoDish）。
//   没说哪一类（只说「发张照片」）取货架上有的第一类；吃的只拿她最近那一顿那道菜的。
// - 他明确要「现在」的照片（ADR 0240）：只有已审核、和此刻精确匹配的那一张能发（写 photo、photoPrompt）；没有就写 photoUnavailable，不拿旧图冒充。
// 货架和解析经 DecideCtx 给；日志是这个联系人的。
//
// 图片表情这一轮用不用（「判断那一串」第 3 步，decideAt.stickers）：连续性取完之后、深思之前。和迁移前联系人流水线里的逐字一样：
// - 有收藏库（ctx.stickers）、不是只想一想才看；允不允许按聊天记录、最终的意图、被吵醒、危机定（imageStickerAllowance），这一轮发照片就不发表情：写 stickersAllowed；不允许记一行原因。
// - 允许时抽签：他这句有明确反应（哈哈、图……）按 chance 抽，没有的按 uncued 抽（没给就不抽，种子分开）；抽到写 stickerDraw（带他这一轮说的话，收藏库按它挑）。
// - 抽到之后再抽是不是只发表情、不写文字（onlyChance）：写 stickerOnly。

import type { Module, TurnFacts } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { imageStickerAllowance, stickerCued, stickerOnlyTurn, stickerTurn, STICKER_TURN_CHANCE, stripStickerArtifacts } from '../social/stickers.ts';
import { isExplicitCurrentPhotoRequest } from '../proactive/ai-photo-requests.ts';
import { photoAllowance, photoWanted, PHOTO_KINDS, stripPhotoArtifacts } from '../vision/photos.ts';
import { lastMealDish } from '../world/world.ts';

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
        decideAt: {
            photo: (turn, ctx) => {
                const { contact, facts, initiate, history: chat, at: time } = turn;
                const around = facts.world;
                if (!(ctx.photos || ctx.currentAiPhoto) || contact.tier !== 'boyfriend' || turn.thinking || facts.crisis || facts.grievance || (facts.baseIntent && /先接住他此刻的情绪/.test(facts.baseIntent))) return;
                const photoRequestText = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
                const wanted = initiate ? initiate.photo : photoWanted(photoRequestText);
                const kind = wanted === 'any' ? PHOTO_KINDS.find(k => ctx.photos?.has(k)) : wanted;
                // 吃的（ADR 0128）：只拿她最近吃的那一顿那道菜的；主动那条自己带着菜名
                const dish = kind === 'food' ? (initiate?.photoDish ?? (around ? lastMealDish(around, time)?.dish : undefined)) : undefined;
                const wantsCurrent = !initiate && Boolean(wanted) && isExplicitCurrentPhotoRequest(photoRequestText);
                const currentKind = wanted === 'any' ? (around && lastMealDish(around, time)?.dish ? 'food' : 'view') : wanted;
                if (wantsCurrent && currentKind && around && ctx.currentAiPhoto) {
                    const currentDish = currentKind === 'food' ? lastMealDish(around, time)?.dish : undefined;
                    const resolved = ctx.currentAiPhoto({ kind: currentKind, ...(currentDish ? { dish: currentDish } : {}), at: time, world: around });
                    const exact = resolved.state === 'approved'
                        ? ctx.photos?.list(currentKind, currentDish).find(entry => entry.id === resolved.shelfId)
                        : undefined;
                    if (exact) {
                        const allowance = photoAllowance(chat, time.getTime(), false, Boolean(turn.woken));
                        if (allowance.allowed) {
                            facts.photo = currentKind;
                            if (currentDish) facts.photoDish = currentDish;
                            facts.photoPrompt = `[和他这次“现在的照片”请求精确对应、已经人工审核过的照片（只能发这一张，编号不解释）：先用一句话带一下，然后另起一行只写 <photo:${exact.id}>]\n- <photo:${exact.id}>：${exact.caption}`;
                            ctx.log(`AI 照片草稿：当前请求已有审核通过的匹配照片 ${exact.id}，这一轮可发`);
                        } else ctx.log(`AI 照片草稿：当前请求已有匹配照片，但这一轮不发（${allowance.reason}）`);
                    } else {
                        facts.photoUnavailable = true;
                        ctx.log(`AI 照片草稿：当前请求没有已审核匹配照片（${resolved.state}），不拿旧图冒充`);
                    }
                } else if (kind && ctx.photos?.has(kind, dish)) {
                    const allowance = photoAllowance(chat, time.getTime(), false, Boolean(turn.woken));
                    if (allowance.allowed) {
                        facts.photo = kind;
                        if (dish) facts.photoDish = dish;
                        ctx.log(`照片货架：他想看${kind}${dish ? `（${dish}）` : ''}，货架里有，这一轮发一张`);
                    } else ctx.log(`照片货架：这一轮不发（${allowance.reason}）`);
                }
            },
            stickers: (turn, ctx) => {
                if (!ctx.stickers || turn.thinking) return;
                const { facts, history: chat } = turn;
                const allowance = imageStickerAllowance(chat, facts.intent, Boolean(turn.woken), facts.crisis?.level);
                const allowed = allowance.allowed && !facts.photo;
                if (allowed) facts.stickersAllowed = true;
                const saidNow = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
                // 没有明确反应的轮次也抽一抽（ADR 0132）：她拿不到小黄脸以后，表情包得顶上；抽签的种子和有反应的那条路分开
                const drawn = allowed && (stickerCued(saidNow)
                    ? stickerTurn(chat, ctx.stickers.chance ?? STICKER_TURN_CHANCE)
                    : Boolean(ctx.stickers.uncued) && saidNow.trim().length > 0 && stickerTurn(chat, ctx.stickers.uncued!, 'sticker uncued'));
                // 这一轮只发表情、不写文字（ADR 0099）：清理时模型多写了文字就去掉，只留那一行表情
                const only = drawn && stickerOnlyTurn(chat, ctx.stickers.onlyChance ?? 0);
                if (only) facts.stickerOnly = true;
                if (drawn) {
                    facts.stickerDraw = { text: saidNow, ...(only ? { only: true } : {}) };
                    ctx.log(only ? '图片表情：这一轮抽到只发表情、不写文字' : '图片表情：这一轮抽到要发一个');
                }
                if (!allowed) ctx.log(`图片表情：这轮不用（${allowance.reason}）`);
            },
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
