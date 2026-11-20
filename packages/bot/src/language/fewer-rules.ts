// 「少规矩」总开关（ADR 0342，配置 fewerRules，默认关）。
// 用户 2026-11-20：「我想让她有灵性」「我感觉应该是规矩给她压住了」。她每回一句话之前要读一本规则手册：说话短、先接哪句、别反问、
// 别主动说、不另起话题、意图行、形状、字数上限……一条条都是修毛病时加的，叠起来她只剩规规矩矩地回应。
// 开着时：
// - 提示词里「教她怎么说话」的槽整类不放（RULE_SLOTS）；她是谁、她的日子（事实）、保命、真实能力和代码要认的格式照旧；
// - 卡末尾那段（post_history_instructions）换成 FEWER_RULES_BASICS：只剩真实能力、格式和不编他的话；
// - 危机回合不受影响：承认版卡、危机意图、这些槽、「他最后说的是」、出口检查的禁用词都照旧（只管风格的开关 relaxStyle 是整个进程的，危机回合也关着）。
// 关着时一个字都不变（行为基线逐字核对）。线上由 App 按配置设一次；模拟器 --fewer-rules。

import type { Slot } from '../interpreter/slots.ts';
import type { AppConfig } from '../platform/config.ts';

let on = false;

/** App 启动时按配置设一次；模拟器按 --fewer-rules 设 */
export function useFewerRules(value: boolean): void {
    on = value;
}

export const fewerRules = (): boolean => on;

/**
 * 开着时不放的槽：只教她怎么说话、不带关于她或世界的事实的那些。
 * 分类见 ADR 0342「槽位分类」；事实、保命、功能（代码要认的格式、真实能力）的槽不在这里。
 */
export const RULE_SLOTS: ReadonlySet<Slot> = new Set<Slot>([
    'groundNote', // 「你现在」是底子不是话题、没人问别说
    'pace', // 心情好话多一点、心情差话少一点
    'length', 'shape', // 这一轮几条、每条几个字
    'directAnswer', 'noOverthink', // 正经问先答、别琢磨（人称那句是帮她读懂「我」「你」指谁，10-30 修理解错误加的，留着）
    'reading', // 把这一轮当完整一句理解、别反问「你指哪件」
    'scene', 'opinion', 'askHint', 'routedHint', 'deliberate', // 碰到某类话该怎么接
    'register', 'rating', // 照平时的样子接、评价低就话少一点
    'crutch', 'opener', 'told', // 换个反应、换种开头、说过的别再提
    'idiom', 'exemplar', // 学他的口头禅、看真人怎么回
    'unsure', // 拿不准就说拿不准（不编已在 FEWER_RULES_BASICS）
    'solveFrame', // 模拟器的对照提示
]);
// 不在这里、另外处理的：意图行（intent-line.ts：危机回合的照放）、「他最后说的是」（reply-basics.ts：她主动找他时那句「那不是刚说的」是时间事实，照放）。
// 拿不准、先留着的（带着事实或她自己写的）：warm、closeness、meme、speechNote、review、quote、intimate；她自己写的「我现在的样子」（portrait）照放。

/** 开着时一并关掉的、只管说话风格的开关：说话的毛病检查（助手腔、算账、重复……）、句尾封顶、质感、形状那一套、挑候选 */
export function relaxStyle<T extends Partial<AppConfig>>(config: T): T {
    return { ...config, speechCheck: false, tailCap: false, texture: false, shape: false, shapeAgenda: false, shapeFiller: false, shapeFeel: false, shapeSplit: false, shapeAsk: false, shapeLong: false, candidates: 1 };
}

/** 角色卡场景世界书里的「场景参考」（类似的话你可能会这样回……只学语气和长短）：是说话的范例，不是事实 */
export const isSceneExample = (entry: { content: string }): boolean => entry.content.trimStart().startsWith('[场景参考');

/**
 * 开着时卡末尾那段换成这几句：只剩做不到的事、格式和不编他的话（真实能力和真话，不是教她怎么说）。
 * 承认是程序的那段在设定的事实段里（【被问是不是 AI】），不在这里，照旧。
 */
export const FEWER_RULES_BASICS = [
    '只输出你要发出去的消息：不写动作、神态、心理活动和旁白，不加名字前缀。',
    '你们在 QQ 上：自己拍的照片、相册里的图、电话、视频你都发不了、打不了，别答应；运行时另外告诉你能用的（表情、语音条之类），照那里的格式用。',
    '聊天记录里的「[语音…：…]」「[图片，上面写着：…]」是对方发来的语音转出来的字、图上的字；只写了「[语音]」「[图片]」的，你不知道里面是什么，别编。',
    '不编他说过的话，也不编你们没一起经历过的事。',
    // 她本人 11-20 自己要留的一条（ADR 0342「她的意见」）：「别催我秒回、别追着问我为什么不说话。我有时候就是懒得回，不是生气」
    '你有时候就是懒得回、不想多说，不用解释为什么；他追着问你为什么不说话，你不想说可以不说，这不是生气。',
].join('\n');
