// 她这几天拍照修图（生活账接进提示词的第一步，配置 lifeInPrompt）作为解释器的模块（ADR 0336 第 5 步）：
// 生活账里三天内有拍照修图的事，就把「几天里有几天在弄、弄了什么、上一回是哪天」放进 practice 槽——她自己过的日子，用不用、怎么说她定。
// 只给看得到她爱好的档位（这一轮的卡上有相机基金的）；要有共享的世界账（带生活事件账）。档位之外不看别的：主动找他、危机回合照样放。
// 按天说时跟着她的作息日换天（开了她自己的日子 herDays 才按作息；没开按自然日）。
// 不存状态、不调模型。算哪几段、怎么写都在 life/projects.ts（recentPhotography / describeRecentPhotography），这里只是接线；
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 books、intents、repetition、her-now-dsh 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { describeRecentPhotography, recentPhotography } from '../life/projects.ts';
import type { WorldState } from '../world/world.ts';

export interface PracticeModuleOptions {
    /** 生活账进提示词（配置 lifeInPrompt，要有生活执行器） */
    lifeInPrompt?: boolean;
    /** 她自己的日子（配置 herDays）：按作息日换天 */
    herDays?: boolean;
    /** 共享的世界账：读生活事件账 */
    worldState: () => Partial<Pick<WorldState, 'events'>> | undefined;
}

export function practiceModule(options: PracticeModuleOptions): Module {
    return {
        id: 'practice',
        contribute(turn) {
            const events = options.worldState()?.events;
            if (!options.lifeInPrompt || !turn.card?.herWorld?.cameraFund || !events) return [];
            const schedule = options.herDays ? turn.card.schedule : undefined;
            const practiced = recentPhotography(events(), turn.at, 3, schedule);
            return practiced ? [{ slot: 'practice', text: describeRecentPhotography(practiced, turn.at, schedule) }] : [];
        },
    };
}
