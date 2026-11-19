// 她自己想一想的那几样（夜里 / 聊完之后）作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：
// - 追求（ADR 0178）：每晚 20 点以后想一次要不要放下 / 改主意 / 提新的。
// - 说话习惯（ADR 0193）：每晚 22 点以后总结一次，带上他标过的「像真人 / 像 AI」。
// - 聊天回顾（ADR 0221）：22 点以后看一次今天和他的聊天里数得出来的几处。
// - 心境回想（ADR 0197）：一段聊天结束半小时后回想、记下有依据的感受；每 10 分钟看一眼（其余每 30 分钟）。
// - 自我认识（ADR 0194）：22 点以后翻日记写对自己的认识；每次想完（不管想没想出来）都给桌面上的她写一份。
// - 读完看完的想法（ADR 0204）、没想完的问题（ADR 0207，用深思的模型）、她猜的事（ADR 0213，要她那边的世界）。
// - 我现在的样子（ADR 0340）：22 点以后把上面这些、她在电脑上写的 SOUL.md 和最近的聊天整份重写成一份，排在最后；每一拍之后给桌面刷新一份 PORTRAIT.json。
// 到没到点、够不够、想几次都在各自的 reflectIfDue / reviewIfDue 里；这里只是接线：一样一个定时任务，上一次没想完就跳过这一拍，停下之后不再想。
//
// 定时（start: 'built'）：和迁移前一样在 App 搭好时就开、不等连上 NapCat；先后也照旧（追求、说话习惯、聊天回顾、心境回想、自我认识、读完看完、没想完的问题、她猜的事）——
// 同一刻到点的计时器按开的先后触发，行为基线核对这个先后。读这些文件、放进提示词的那一半在 her-notes / learning-question / feelings 那几个模块里。
// 模型调用、读写文件都由 App 给的函数做（模块不直接碰）；日志是 App 的。

import type { Module, ScheduleSpec } from '../interpreter/interpreter.ts';
import type { Contact } from '../platform/config.ts';
import type { TierCard } from '../platform/contact.ts';
import type { Log } from '../platform/log.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import type { WorldNow } from '../world/world.ts';
import type { FeelingKind } from '../emotion/feelings.ts';
import { reflectIfDue as reflectPursuits } from '../life/self-pursuits.ts';
import type { pursuitsReader } from '../life/pursuits.ts';
import { reflectIfDue as reflectSpeechNotes } from '../language/speech-notes.ts';
import { reviewChatIfDue } from '../language/chat-review.ts';
import { reviewIfDue as reviewFeelings } from '../emotion/feeling-review.ts';
import { reflectIfDue as reflectInsights } from '../life/diary-insights.ts';
import { bookItems, reflectIfDue as reflectTakes, videoItems } from '../life/reading-takes.ts';
import { ponderIfDue } from '../life/open-questions.ts';
import { reflectPortraitIfDue, refreshPortraitExport } from '../life/self-portrait.ts';
import { pendingWorld, reviewGuessesIfDue, worldFactsBetween } from '../life/her-guesses.ts';
import { herDay } from '../life/schedule.ts';
import type { Watched } from '../language/watching.ts';
import { substituteMacros } from '../st/macros.ts';
import type { Exemplar } from '../language/exemplars.ts';
import type { recentFeedback } from '../language/speech-feedback.ts';

type Generate = (messages: OpenAIMessage[]) => Promise<string>;

export interface ReflectionsOptions {
    /** 男朋友档的那一位（没有就一样都不想） */
    owner: Contact | undefined;
    /** 她这一档的角色卡（App 的 cardFor，有缓存） */
    character: (tier: Contact['tier']) => TierCard['character'];
    contacts: () => readonly Contact[];
    dataDir: string;
    /** 灵魂目录（桌面上的她也读的那几份） */
    soulDir: () => string;
    now: () => Date;
    log: Log;
    /** App 停下了（停下之后不再起新的一拍） */
    stopped: () => boolean;
    /** 后台模型调用（经执行器），按温度给 */
    generate: (temperature: number) => Generate;
    /** 他这一档的聊天记录 */
    history: (qq: number) => StoredMessage[];
    /** 各样开不开（App 按配置给；追求还要 pursuits 开着，心境回想还要 herFeelings 开着） */
    selfPursuits?: { base: () => ReturnType<typeof pursuitsReader> };
    speechNotes?: { corpus: () => Exemplar[]; feedback: () => ReturnType<typeof recentFeedback> };
    chatReview?: boolean;
    feelingReview?: { existing: () => { kind: FeelingKind; cause: string }[] };
    diaryInsights?: { exportInsights: () => void };
    readingTakes?: { watched: () => readonly Watched[] };
    /** 没想完的问题用深思的模型（开思考） */
    openQuestions?: { ponder: Generate };
    /** 她猜的事：她那边的世界（世界账）在某一刻的样子 */
    herGuesses?: { worldAt: (time: Date) => WorldNow | undefined };
    /** 「我现在的样子」（ADR 0340）：每晚整份重写一次；排在所有反思的最后，先看今晚别的笔记想出了什么 */
    selfPortrait?: boolean;
}

export function reflectionsModule(options: ReflectionsOptions): Module {
    const { owner, dataDir, log } = options;
    const schedules: ScheduleSpec[] = [];
    if (!owner) return { id: 'reflections', schedules };
    const now = () => options.now().getTime();
    const persona = () => {
        const character = options.character(owner.tier);
        return substituteMacros(character.description, { user: owner.name, char: character.name }).slice(0, 700);
    };
    const names = () => ({ char: options.character(owner.tier).name, user: owner.name });
    const others = () => options.contacts().filter(contact => contact.qq !== owner.qq).map(contact => contact.name);
    const history = () => options.history(owner.qq);
    /** 一样一个定时任务：上一次没想完就跳过这一拍；出错只记日志 */
    const every = (ms: number, think: () => Promise<unknown>, failed: string, done?: () => void) => {
        let busy = false;
        schedules.push({
            every: ms, start: 'built',
            run: () => {
                if (busy || options.stopped()) return;
                busy = true;
                void think().catch(error => log(`${failed}（${error instanceof Error ? error.message : String(error)}）`)).finally(() => { busy = false; done?.(); });
            },
        });
    };
    const { selfPursuits, speechNotes, feelingReview, diaryInsights, readingTakes, openQuestions, herGuesses } = options;
    if (selfPursuits) every(30 * 60_000, () => reflectPursuits({
        dataDir, now, generate: options.generate(0.9), base: selfPursuits.base(),
        chat: () => history().slice(-16).map(message => ({ role: message.role, content: message.content })),
        persona, names: names(), log,
    }), '追求：想的时候出错');
    if (speechNotes) every(30 * 60_000, () => reflectSpeechNotes({
        dataDir, now, generate: options.generate(0.9), history, corpus: speechNotes.corpus, persona, names: names(),
        // 他标过的「像真人」/「这句像 AI」（ADR 0195）：只进每晚想的这一次，不进聊天时的提示词
        feedback: speechNotes.feedback, log,
    }), '说话习惯：想的时候出错');
    if (options.chatReview) every(30 * 60_000, () => {
        const character = options.character(owner.tier);
        return reviewChatIfDue({
            dataDir, now, generate: options.generate(0.8), history,
            dayStart: at => (character.schedule ? herDay(character.schedule, new Date(at)).getTime() : new Date(new Date(at).setHours(0, 0, 0, 0)).getTime()),
            persona, names: names(), log,
        });
    }, '聊天回顾：看的时候出错');
    if (feelingReview) every(10 * 60_000, () => reviewFeelings({
        dataDir, soulDir: options.soulDir(), now, generate: options.generate(0.9), history, persona, names: names(), others,
        // 心里已经有的（最近 6 小时内给他算过的明显感受）：别重复记
        existing: feelingReview.existing, log,
    }), '心境回想：想的时候出错');
    if (diaryInsights) every(30 * 60_000, () => reflectInsights({
        dataDir, soulDir: options.soulDir(), now, generate: options.generate(0.9), history, persona, names: names(), others, log,
    }), '自我认识：想的时候出错', diaryInsights.exportInsights);
    if (readingTakes) every(30 * 60_000, () => {
        const character = options.character(owner.tier);
        return reflectTakes({
            dataDir, now, generate: options.generate(0.9),
            items: () => {
                const at = options.now();
                return [
                    ...(character.schedule ? bookItems(character.schedule, character.books, at) : []),
                    ...videoItems(readingTakes.watched(), at),
                ];
            },
            history, persona, names: names(), others, log,
        });
    }, '读完看完的想法：想的时候出错');
    if (openQuestions) every(30 * 60_000, () => ponderIfDue({
        dataDir, now, generate: openQuestions.ponder, history, persona, names: names(), others, log,
    }), '没想完的问题：想的时候出错');
    if (herGuesses) every(30 * 60_000, () => reviewGuessesIfDue({
        dataDir, now, generate: options.generate(0.7), history,
        world: (from, to) => worldFactsBetween(herGuesses.worldAt, from, to),
        pending: at => pendingWorld(herGuesses.worldAt(new Date(at))),
        persona, names: names(), others, log,
    }), '她猜的事：对的时候出错');
    if (options.selfPortrait) every(30 * 60_000, () => reflectPortraitIfDue({
        dataDir, soulDir: options.soulDir(), now, generate: options.generate(0.9), history, persona, names: names(), others, log,
    }), '我现在的样子：想的时候出错', () => { refreshPortraitExport(options.soulDir(), dataDir, now()); });
    return { id: 'reflections', schedules };
}
