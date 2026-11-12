// 她身边的人（ADR 0033）作为解释器的模块（ADR 0336 第 5 步）：
// - assess：他这次的话里说起卡上她身边的某个人（全名，或三个字的名字的后两个字），算出那人最近两周怎么样（她知道的），写进 turn.facts.aboutPeople；
//   刚说起过的，接下来没有名字也沿用一会儿（追问「那她现在呢」本身没有名字；从聊天记录往回推，不记在内存里，ADR 0039）。
//   旧逻辑的形状和长短读它：说起她身边的人的那一轮按认真接话算、不加「回很短」。
// - contribute：往 npcs 槽放那几段。
// 跟着「她自己的日子」（配置 herDays）开，卡上有她的世界才有；她身边的人按档位裁在卡里，所以用这一轮的卡（turn.card）；
// 危机回合照样放；主动找他时不想（没有「他这次说的」）。不存状态、不调模型。
// 认人和写法的规则都在 world/npc.ts（npcMentioned）、world/world.ts（recentWith）、life/people.ts（lingering），这里只是接线；
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 people 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { lingering } from '../life/people.ts';
import type { Log } from '../platform/log.ts';
import { npcMentioned } from '../world/npc.ts';
import { recentWith } from '../world/world.ts';

export interface PeopleAroundModuleOptions {
    /** 她自己的日子（配置 herDays） */
    herDays?: boolean;
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export function peopleAroundModule(options: PeopleAroundModuleOptions): Module {
    return {
        id: 'people-around',
        assess(turn) {
            const world = turn.card?.herWorld;
            const schedule = options.herDays ? turn.card?.schedule : undefined;
            if (!world || !schedule || turn.initiate) return;
            const people = world.people;
            let found = npcMentioned(turn.history, people);
            // 认出来的是空列表时算没有（lingering 接着往前找）
            if (!found.length) found = lingering(turn.history, turn.at.getTime(), upTo => { const earlier = npcMentioned(upTo, people); return earlier.length ? earlier : undefined; })?.found ?? [];
            if (!found.length) return;
            const lines = found.flatMap(person => {
                const recent = recentWith(world, schedule, turn.at, person.id);
                return recent ? [`[${person.name}最近两周（${person.relation}；你知道的事，他问到了照实说，没写到的别编）：${recent.length ? recent.join('；') : '没病没忙，照常'}]`] : [];
            });
            if (lines.length) options.log(`[${turn.contact.qq}] 想起${found.map(person => person.name).join('、')}最近的事`);
            turn.facts.aboutPeople = { names: found.map(person => person.name), lines };
        },
        contribute(turn) {
            return (turn.facts.aboutPeople?.lines ?? []).map(text => ({ slot: 'npcs' as const, text }));
        },
    };
}
