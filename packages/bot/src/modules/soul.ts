// 她在本机的那一份（DSH 的灵魂目录，platform/soul-rating.ts 的 soulDir()）往提示词里放的几行，作为解释器的模块（ADR 0336 第 5 步）。
// 读的都是她在那台机器上自己写下 / 攒下的东西，App 每一轮现读；这里只管放进哪个槽、什么时候不放：
// - selfThread：她自己最近的日子（日记最后一段的前两句）和这两天自己在做的（LIFE.json）；主动找他、只想一想、危机时不放。
// - refusal：她最近拒绝过的事，别装没发生过。
// - rating：他最近对她的评价，影响分寸（不是讨好）。
// - life：「[你现在的生活]」NOW.md——现在 App 每收到一条就用带 generated-at 的版本重写 NOW.md，读的时候跳过那一版，实际上不再出现（DSH 任务书 §2）。
// - wake：他走了六小时以上回来的第一轮，带上她这期间写的日记（配置 lifeInPrompt，规则在 memory/wake-backfill.ts）。
// 都只给男朋友档。不调模型；写这些文件的在 app.ts（拒绝、评价、NOW.md）和桌面上的她那边。
// 行为和迁移前 contact.ts 里的一样（行为基线 soul 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import type { Contact } from '../platform/config.ts';

export interface SoulOptions {
    selfThread: () => string | undefined;
    refusals: () => string | undefined;
    rating: () => string | undefined;
    life: () => string | undefined;
    /** 首轮铺底；不给就没有（App 在 lifeInPrompt 开着时给） */
    wake?: (contact: Contact) => string | undefined;
}

export function soulModule(options: SoulOptions): Module {
    return {
        id: 'soul',
        contribute(turn) {
            if (turn.contact.tier !== 'boyfriend') return [];
            const pieces: Piece[] = [];
            const thread = !turn.initiate && !turn.thinking && !turn.facts.crisis ? options.selfThread() : undefined;
            if (thread) pieces.push({ slot: 'selfThread', text: thread });
            const refusals = options.refusals();
            if (refusals) pieces.push({ slot: 'refusal', text: refusals });
            const rating = options.rating();
            if (rating) pieces.push({ slot: 'rating', text: rating });
            const life = options.life();
            if (life) pieces.push({ slot: 'life', text: `[你现在的生活] ${life}` });
            const wake = options.wake?.(turn.contact);
            if (wake) pieces.push({ slot: 'wake', text: wake });
            return pieces;
        },
    };
}
