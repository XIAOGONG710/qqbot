// 一轮回复的模块接线（ADR 0336 第 6 步收尾）：App（platform/app.ts）和模拟器（sim/runner.ts）都从这里取模块列表，不再各手写一份。
// 先后就是这里写的先后（照 App 原来的先后；模块之间靠 turn.facts 交接，写的在前、读的在后，段落的先后由槽位表定）。
// 规则：
// - 两边都挂的模块，选项必填；只在一边挂、或跟着开关挂的模块，给了对应的字段才挂（布尔的就是开关）。
// - 构造时不调用 deps 里的任何函数：App 里好些东西（设备服务、聊天记录、长期记忆、计划器……）在建解释器之后才建，
//   模拟器的计划器也在第一次建回复器之后才建；挂不挂只看 deps 的值本身（App 按配置、模拟器按场景先算好）。
// - 会换掉的东西（世界账、答应的事、聊天记录、内存里的列表）由调用方给取值函数，每次现取。
// - 小梗、口头习惯在外面建好再放进来：App 的那两个带定时抽取和收尾（status / stop 的先后跟着这里的位置），模拟器的只放提示词。

import type { Module } from '../interpreter/interpreter.ts';
import type { StoredMessage } from '../memory/history.ts';
import { asksModule } from '../modules/asks.ts';
import { booksModule } from '../modules/books.ts';
import { candidatesModule, type CandidatesModuleOptions } from '../modules/candidates.ts';
import { closenessModule } from '../modules/closeness.ts';
import { consentModule, type ConsentModuleOptions } from '../modules/consent.ts';
import { continuityModule } from '../modules/continuity.ts';
import { crisisModule } from '../modules/crisis.ts';
import { textureModule, typoModule } from '../modules/decorate.ts';
import { deliberateModule } from '../modules/deliberate.ts';
import { devicesModule, type DevicesModuleOptions } from '../modules/devices.ts';
import { exemplarsModule, type ExemplarsModuleOptions } from '../modules/exemplars.ts';
import { feelingsModule } from '../modules/feelings.ts';
import { groupModule } from '../modules/group.ts';
import { herNotesModule, type HerNotesOptions } from '../modules/her-notes.ts';
import { portraitModule, type PortraitModuleOptions } from '../modules/portrait.ts';
import { herNowModule, type HerNowOptions } from '../modules/her-now.ts';
import { humanStateModule } from '../modules/human-state.ts';
import { initiateNoteModule } from '../modules/initiate-note.ts';
import { innerModule, type InnerModuleOptions } from '../modules/inner.ts';
import { intentLineModule } from '../modules/intent-line.ts';
import { intentModule, type IntentModuleOptions } from '../modules/intent.ts';
import { interruptionsModule } from '../modules/interruptions.ts';
import { learningQuestionModule } from '../modules/learning-question.ts';
import { lengthModule } from '../modules/length.ts';
import { mediaDiscoveryModule, mediaOffersModule } from '../modules/media-offers.ts';
import { syncedJobsModule } from '../modules/synced-jobs.ts';
import { meetupModule, type MeetupModuleOptions } from '../modules/meetup.ts';
import { memeDictModule } from '../modules/meme-dict.ts';
import { memesModule } from '../modules/memes.ts';
import { memoryModule } from '../modules/memory.ts';
import { pastModule } from '../modules/past.ts';
import { peopleAroundModule } from '../modules/people-around.ts';
import { practiceModule } from '../modules/practice.ts';
import { quoteModule, type QuoteModuleOptions } from '../modules/quote.ts';
import { readingModule } from '../modules/reading.ts';
import { registerModule } from '../modules/register.ts';
import { repetitionModule } from '../modules/repetition.ts';
import { replyBasicsModule } from '../modules/reply-basics.ts';
import { reviewExitModule } from '../modules/review-exit.ts';
import { reviewFactsModule, type ReviewFactsOptions } from '../modules/review-facts.ts';
import { reviewFinalizeModule } from '../modules/review-finalize.ts';
import { reviewPullModule, type ReviewPullOptions } from '../modules/review-pull.ts';
import { reviewUnfinishedModule } from '../modules/review-unfinished.ts';
import { scenesModule } from '../modules/scenes.ts';
import { selfMemoryModule, type SelfMemoryOptions } from '../modules/self-memory.ts';
import { selfNotesModule, type SelfNotesModuleOptions } from '../modules/self-notes.ts';
import { shapeModule, type ShapeModuleOptions } from '../modules/shape.ts';
import { shellModule, type ShellModuleOptions } from '../modules/shell.ts';
import { solveFrameModule } from '../modules/solve-frame.ts';
import { soulModule, type SoulOptions } from '../modules/soul.ts';
import { timeBlockModule } from '../modules/time-block.ts';
import { timeNotesModule } from '../modules/time-notes.ts';
import { togetherModule } from '../modules/together.ts';
import { transcriptModule } from '../modules/transcript.ts';
import { voiceModule } from '../modules/voice.ts';
import { warmModule } from '../modules/warm.ts';
import { watchedModule } from '../modules/watched.ts';
import { workModeModule } from '../modules/work-mode.ts';
import type { WorldState } from '../world/world.ts';
import type { Log } from './log.ts';

export interface TurnModuleDeps {
    /** 模块的日志（前面的 [QQ] 由模块自己加）。App：App 的日志；模拟器：只记当前这个回复器的（重建之后旧的不再写 sim.log） */
    log: Log;
    /** 她猜的事按这个时刻算（App：执行器的时钟；模拟器：假时钟） */
    now: () => number;
    /** 某个人存下来的聊天记录，每次现取 */
    history: (qq: number) => StoredMessage[];
    /** 名单（她此刻：说过「睡了」看所有人的聊天记录） */
    contacts: NonNullable<HerNowOptions['contacts']>;
    /** 共享的世界账，每次现取 */
    worldState: () => (Pick<WorldState, 'at'> & Partial<Pick<WorldState, 'events'>>) | undefined;
    /** 此刻约好的见面（她此刻），每次现取 */
    appointmentsAt: NonNullable<HerNowOptions['appointmentsAt']>;
    /** 约定（他提到见面），每次现取 */
    promises: NonNullable<MeetupModuleOptions['promises']>;
    /** 作息、她自己的日子、小别扭、断网长尾、生活账进提示词（拍照修图）：都是构造时就定的开关 */
    schedule: boolean;
    herDays: boolean;
    grievance: boolean;
    lagTail: boolean;
    lifeInPrompt: boolean;
    intent: IntentModuleOptions;
    shape: Omit<ShapeModuleOptions, 'log'>;
    /** 她此刻的另几样（项目选择、昨晚怎么睡的、她自己定的计划；作息冲突的桌面那两样，ADR 0347 第 3 层 desktopConflict，App 才给） */
    herNow?: Pick<HerNowOptions, 'projectChoice' | 'realNights' | 'herPlan' | 'desktopNight' | 'desktopCalled'>;
    /** 她自己记下的东西：各样的读取函数，配置没开的不给 */
    herNotes?: Omit<HerNotesOptions, 'now' | 'log'>;
    /** 「我现在的样子」（ADR 0340）：配置 selfPortrait 开着才给 */
    portrait?: PortraitModuleOptions['portrait'];
    /** 命令结果和 <<执行>>（App 给；模拟器不跑命令，不给） */
    shell?: ShellModuleOptions;
    /** <<查>> 真的去查（App 开了长期记忆和 selfDirectedMemory 才给） */
    reviewPull?: ReviewPullOptions;
    /** 深思轮次换掉的说法（只有模拟器的 --deliberate-note） */
    deliberateNote?: string;

    // 下面的给了才挂
    selfMemory?: SelfMemoryOptions;
    workMode?: { modeOf: Parameters<typeof workModeModule>[0]; markers?: Parameters<typeof workModeModule>[1] };
    selfNotes?: SelfNotesModuleOptions;
    soul?: SoulOptions;
    learningQuestion?: Parameters<typeof learningQuestionModule>[0];
    /** 真人例子：有条目才挂 */
    exemplars?: ExemplarsModuleOptions['exemplars'];
    innerLine?: InnerModuleOptions['innerLine'];
    devices?: DevicesModuleOptions;
    consent?: ConsentModuleOptions;
    quote?: Pick<QuoteModuleOptions, 'share'>;
    factCheck?: ReviewFactsOptions;
    mediaDiscovery?: Parameters<typeof mediaDiscoveryModule>[0];
    syncedJobs?: Parameters<typeof syncedJobsModule>[0];
    /** 话说到一半（配置 speechCheck） */
    speechCheck?: boolean;
    /** 挑候选：count 大于 1 时才给 */
    candidates?: Omit<CandidatesModuleOptions, 'history'>;
    continuity?: boolean;
    group?: boolean;
    texture?: boolean;
    humanState?: boolean;
    /** 「做题式」写法的实验（模拟器 --frame solve） */
    solveFrame?: boolean;
    relationship?: boolean;
    jokes?: Module;
    idioms?: Module;
    together?: boolean;
    interruptions?: boolean;
    memes?: Parameters<typeof memesModule>[0];
    watched?: Parameters<typeof watchedModule>[0];
    memeDict?: Parameters<typeof memeDictModule>[0];
}

/** 一轮回复的模块，按先后；App 在最前面再加「旧逻辑」那一个（事件分发），模拟器原样交给联系人流水线 */
export function buildTurnModules(d: TurnModuleDeps): Module[] {
    const { log, herDays } = d;
    return [
        ...(d.syncedJobs ? [syncedJobsModule(d.syncedJobs)] : []),
        herNowModule({
            schedule: d.schedule, herDays, ...d.herNow,
            worldState: d.worldState, appointmentsAt: d.appointmentsAt, contacts: d.contacts, history: d.history, log,
        }),
        crisisModule({ grievance: d.grievance, log }),
        intentModule(d.intent),
        replyBasicsModule(),
        asksModule(log),
        readingModule(log),
        registerModule(log),
        scenesModule(log),
        voiceModule(log),
        ...(d.selfMemory ? [selfMemoryModule(d.selfMemory)] : []),
        ...(d.workMode ? [workModeModule(d.workMode.modeOf, d.workMode.markers)] : []),
        ...(d.selfNotes ? [selfNotesModule(d.selfNotes)] : []),
        herNotesModule({ ...d.herNotes, now: d.now, log }),
        ...(d.portrait ? [portraitModule({ portrait: d.portrait, log })] : []),
        ...(d.soul ? [soulModule(d.soul)] : []),
        ...(d.learningQuestion ? [learningQuestionModule(d.learningQuestion)] : []),
        shellModule(d.shell),
        repetitionModule(log),
        booksModule({ herDays }),
        pastModule(log),
        peopleAroundModule({ herDays, log }),
        meetupModule({ herDays, worldState: d.worldState, promises: d.promises, log }),
        ...(d.exemplars?.length ? [exemplarsModule({ exemplars: d.exemplars, log })] : []),
        practiceModule({ lifeInPrompt: d.lifeInPrompt, herDays, worldState: d.worldState }),
        ...(d.innerLine ? [innerModule({ innerLine: d.innerLine, log })] : []),
        ...(d.devices ? [devicesModule(d.devices)] : []),
        ...(d.consent ? [consentModule(d.consent)] : []),
        shapeModule({ ...d.shape, log }),
        lengthModule({ log }),
        ...(d.quote ? [quoteModule({ history: d.history, ...d.quote, log })] : []),
        initiateNoteModule(),
        reviewFinalizeModule(),
        reviewExitModule(),
        ...(d.factCheck ? [reviewFactsModule(d.factCheck)] : []),
        ...(d.speechCheck ? [reviewUnfinishedModule()] : []),
        reviewPullModule(d.reviewPull),
        timeBlockModule({ lagTail: d.lagTail }),
        ...(d.continuity ? [continuityModule()] : []),
        ...(d.group ? [groupModule()] : []),
        memoryModule(),
        warmModule({ log }),
        feelingsModule(),
        timeNotesModule(),
        mediaOffersModule(),
        ...(d.candidates ? [candidatesModule({ ...d.candidates, history: d.history })] : []),
        ...(d.texture ? [textureModule()] : []),
        typoModule(),
        intentLineModule(),
        ...(d.humanState ? [humanStateModule()] : []),
        deliberateModule(d.deliberateNote ? { note: d.deliberateNote } : {}),
        transcriptModule(),
        ...(d.solveFrame ? [solveFrameModule()] : []),
        ...(d.relationship ? [closenessModule(log)] : []),
        ...(d.jokes ? [d.jokes] : []),
        ...(d.idioms ? [d.idioms] : []),
        ...(d.together ? [togetherModule(log)] : []),
        ...(d.interruptions ? [interruptionsModule(log)] : []),
        ...(d.memes ? [memesModule(d.memes, log)] : []),
        ...(d.watched ? [watchedModule(d.watched, log)] : []),
        ...(d.memeDict ? [memeDictModule(d.memeDict, log)] : []),
        ...(d.mediaDiscovery ? [mediaDiscoveryModule(d.mediaDiscovery)] : []),
    ];
}
