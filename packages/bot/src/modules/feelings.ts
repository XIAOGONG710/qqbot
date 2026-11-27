// 心境这一组的段落作为解释器的模块（ADR 0336 第 5 步，「心境这一组：方案」第 3、4 步合成一步）：
// - feeling（ADR 0102）：她此刻有来由的心境——事实 → 带来由的评估 → 按半衰期衰减的感受，最多两种、「明显」以上才写；
//   他这一轮在关心她时难过的那一种换成「一直在忍、被一问就绷不住」的写法，前面说过的不再强调、哭过的不再给哭的许可（describeFeelings）。
// - pace（2026-10-30 情绪 → 行为）：按心境说一句「这会儿话多 / 话少」（moodPaceLine）。
// - dreams（2026-10-31 做梦）：昨晚 / 刚才午睡做的梦那一行，说这是梦、提不提由她（dreamNoteLine）。
//
// 怎么算（2026-11-16 起，ADR 0336「判断那一串」）：心境那一行和节奏在 decideAt.feelings 里算——联系人流水线原来的位置（最终的意图、小别扭是否生效之后，图片表情之前），
// 算完写进 turn.facts（felt / feelingLine / paceLine），contribute 时照放。梦那一行（dreamLine）和梦给心境的打分（dreamAppraisals）仍由流水线原位读梦后写进 facts。
// 走到这一步之前的取证（当时为什么没挪进 assess，现在哪几条不成立了）：
// - 算心境要读的几样都是按联系人给的流水线选项（作者写下的事、回想过的感受、群里的遭遇、她的追求、带结算的世界账、作息、今天的小事开关、onFeelings）：现在经 DecideCtx.feelings 递过来。
// - assess 和原位置之间隔着照片那一段（可能当场发起 AI 照片草稿、写状态文件）和意图改写、小别扭是否生效：decideAt 就在原位置，没有挪过它们。
// - 行为基线原来走不到追求和前一天她那边给心境的打分：补了 feelings-sources 场景（缺哪一件那一行都没有），再搬的。
// - 算出来的感受流水线后面还要用（不加「话多」的 low、生成时最多几条）：从 turn.facts.felt 读回。
// 小别扭、危机、档位、开关的条件都在算的地方；contribute 不再看 turn.facts.grievanceActive，也不看只想一想 / 主动找他（迁移前这三行都不看）。
// 不存状态、不调模型。都是同步的，不多等一个微任务（行为基线核对事件顺序）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { moodPaceLine, moodShape } from '../emotion/express.ts';
import { appraisals, asksAfterHer, criedRecently, describeFeelings, FEELING_NAME, feelingsAt, voicedKinds } from '../emotion/feelings.ts';
import { pursuitViews } from '../life/pursuits.ts';
import { herDay } from '../life/schedule.ts';
import { privateConversationRecovery } from '../emotion/recovery.ts';

export function feelingsModule(): Module {
    return {
        id: 'feelings',
        // 心境那一段（ADR 0336「判断那一串」，2026-11-16）：在联系人流水线原来的位置算（最终的意图、小别扭是否生效之后、图片表情之前），不是 assess——
        // 文件头那几条顾虑里「挪过照片那一段」没有了（位置没动）；按联系人给的那几样经 DecideCtx.feelings 递过来；基线 feelings-sources 补上了追求和前一天的打分。
        // 和迁移前流水线里的逐字一样：她的追求不看开没开心境（原来就这样，读带结算的世界账的事件）；前一天她那边、感受只在开了心境、男朋友档时算，危机回合不算感受；
        // 小别扭生效的这一轮不写那一行和节奏（由 0074 的态度管），交给桌面上的她的那一行按「没有人正好在关心她」重算。
        decideAt: {
            // 梦（2026-10-31）的读（ADR 0336「判断那一串」，2026-11-18）：联系人流水线在原来的位置调（照片判断之后、最终的意图之前）；
            // 开了心境、男朋友档、不是危机回合才读，那一行和它给心境的打分写进 facts，下面的 feelings 用
            dream: (turn, ctx) => {
                const dreams = turn.contact.tier === 'boyfriend' && !turn.facts.crisis && ctx.feelings?.herFeelings ? ctx.dreams?.() : undefined;
                if (dreams?.line) turn.facts.dreamLine = dreams.line;
                if (dreams?.appraisals.length) turn.facts.dreamAppraisals = dreams.appraisals;
            },
            feelings: (turn, ctx) => {
                const given = ctx.feelings;
                if (!given) return;
                const { contact, facts, history: chat, at: time, card } = turn;
                const boyfriend = contact.tier === 'boyfriend';
                const around = facts.world;
                const schedule = given.schedule;
                // 她自己的追求（ADR 0104）：进度只来自她做过的事（生活账里的摄影）和出分的小测
                const pursuitList = given.pursuits && boyfriend && schedule ? given.pursuits() : [];
                const views = pursuitList.length && schedule
                    ? pursuitViews(pursuitList, { now: time, schedule, quizzes: given.everydayLife, ...(card?.herWorld?.everydayFrom ? { quizFrom: card.herWorld.everydayFrom } : {}), ...(given.worldEvents ? { events: given.worldEvents() } : {}), ...(around ? { world: around } : {}) })
                    : [];
                // 前一天的世界（到那天结束）：小测出分这类事第二天她还记着（ADR 0106）；只在开了心境时算
                const previous = given.herFeelings && schedule && card?.herWorld && boyfriend
                    ? given.worldAt(card.herWorld, schedule, new Date(herDay(schedule, time).getTime() - 60_000))
                    : undefined;
                // 心境（ADR 0102）：事实 → 带来由的评估 → 按半衰期衰减的感受，不落盘、每一轮重算；只给男朋友档，危机回合不算
                const at = time.getTime();
                const entries = given.herFeelings && boyfriend && !facts.crisis
                    ? appraisals({ now: at, history: chat, trackRepairedReturn: given.feelingRecovery ?? false, ...(around ? { world: around } : {}), ...(previous ? { previousWorld: previous } : {}), moments: given.moments?.() ?? [], extra: [...views.flatMap(view => view.appraisals), ...(given.feelingReview?.() ?? []), ...(given.groupMood?.() ?? []), ...(given.desktopMood?.() ?? []), ...(facts.dreamAppraisals ?? [])] })
                    : [];
                const recovery = given.feelingRecovery && entries.length ? privateConversationRecovery(entries, chat, at) : undefined;
                const felt = feelingsAt(recovery?.list ?? entries, at);
                if (given.herFeelings && boyfriend && !facts.crisis) facts.felt = felt;
                const shown = felt.length > 0 && !facts.grievanceActive;
                const hisWords = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
                const feelingLine = shown
                    ? describeFeelings(felt, contact.name, { melt: asksAfterHer(hisWords), voiced: voicedKinds(chat, time.getTime()), mayCry: !criedRecently(chat, time.getTime()) })
                    : undefined;
                // 情绪 → 行为（2026-10-30）：心境不再只是提示词里的一行装饰，它决定这一轮说多说少
                const paceLine = shown ? moodPaceLine(moodShape(felt)) : undefined;
                if (paceLine) ctx.log('心境：这一轮按她此刻的心情收放了说话的量（日志不记内容）');
                // 桌面上的她读同一份（ADR 0197）：那一行按「没有人正好在关心她」重算（melt 只对 QQ 当下这一句话有意义），小别扭那一轮不交
                if (given.onFeelings && given.herFeelings && boyfriend && !facts.crisis) {
                    const neutral = shown
                        ? describeFeelings(felt, contact.name, { melt: false, voiced: voicedKinds(chat, time.getTime()), mayCry: !criedRecently(chat, time.getTime()) })
                        : undefined;
                    try { given.onFeelings({ at, felt, line: neutral, ...(recovery?.recoveries.length ? { recoveries: recovery.recoveries } : {}) }); } catch (error) { ctx.log(`心境：没能交给桌面上的她（${error instanceof Error ? error.message : String(error)}）`); }
                }
                if (feelingLine) ctx.log(`心境：${felt.filter(item => item.level !== 'faint').slice(0, 2).map(item => `${FEELING_NAME[item.kind]}·${item.level === 'strong' ? '很重' : '明显'}（${item.source === 'world' ? '她那边的事' : item.source === 'him' ? '他的态度' : item.source === 'self' ? '她自己回想的' : '作者写下的事'}）`).join('、')}（日志不记内容）`);
                if (feelingLine) facts.feelingLine = feelingLine;
                if (paceLine) facts.paceLine = paceLine;
            },
        },
        contribute(turn) {
            const { facts } = turn;
            const pieces: Piece[] = [];
            if (facts.feelingLine) pieces.push({ slot: 'feeling', text: facts.feelingLine });
            if (facts.paceLine) pieces.push({ slot: 'pace', text: facts.paceLine });
            if (facts.dreamLine) pieces.push({ slot: 'dreams', text: facts.dreamLine });
            return pieces;
        },
    };
}
