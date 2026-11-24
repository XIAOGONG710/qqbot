// 线上开关快照里 qqbot 那一块的开关值（只有功能总表里的开 / 关和几档，没有联系人、模型、密钥）：
// 从 exchange/live/koishi-2026-11-20-1855.yaml 抄的，当时 FEATURES 里有的键（11-24 删掉的 shape 那一族等不在里面）；快照没写的按默认值。
// 开关合并（docs/plans/2026-11-24-switch-merge-design.md）拿它核对：线上这一套旧键能一字不差地并成新键，迁移前后解析出来的一样。
// 快照之后补开的（审计和信箱记的）：selfExport、selfReceipts（11-22）、desktopDay（11-23），见 LIVE_LATER_ON。

export const LIVE_2026_11_20: Readonly<Record<string, boolean | string>> = {
    schedule: true, selfDirectedMemory: true, openQuestions: true, bilibiliAccount: true, bilibili: 'on', bilibiliDm: 'on', bilibiliComment: 'on',
    bilibiliReplies: 'on', watching: true, biliFeed: 'on', memes: true, biliStickers: true, proactive: 'on', autonomousLife: true, projectChoice: true,
    lifeInPrompt: true, grievance: true, feedbackCommands: true, stickers: 'send', npcAsks: true, festivals: 'greet', rhythm: true, typingStatus: true,
    pokes: true, pokeBack: true, recalls: true, selfRecall: true, pokeOut: true, readReceipts: true, onlineStatus: true, profileLikes: true,
    signature: 'on', qzone: 'on', proactiveReach: true, innerLife: true, herFeelings: true, herNo: true, speechNotes: true, proactiveInvite: true,
    photos: true, deviceControl: 'on', proactiveRoom: true, weeklyReport: true, menu: true, curious: true, smallNews: true, quoteReply: true,
    factCheck: 'fix', lagTail: true, everydayLife: true, worldDrama: true, memoryFeelings: true, memoryReconcile: true, worldThreads: true,
    diaryLookback: true, hisReactions: true, herGuesses: true, afterNo: true, pursuits: true, deliberate: true, feelingReview: true, selfPursuits: true,
    depthRouting: true, readStickers: true, readingTakes: true, factHim: true, identityLedger: true, memoryAudit: true, timeline: true,
    diaryInsights: true, webLookup: 'auto', comeBack: true, interruptions: true, jokes: true, proactiveAsk: true, together: true, relationship: true,
    chatReview: true, realNights: true, tastes: true, acquaintances: true, dormancy: true, groupChat: 'on', jealousy: true, qzoneBrowse: 'on',
    qzonePeek: 'on', qzoneStrangers: 'on', qqControl: 'on', qqFriendGate: 'allow', realAirQuality: true, realDaylight: true, realCalendar: true,
    silenceNotice: true, crossRecent: true, fewerRules: true, selfPortrait: true, groupOwn: 'dryRun',
};

/** 快照之后在线上补开的（11-22、11-23）：上线前要用新快照重核 */
export const LIVE_LATER_ON: Readonly<Record<string, boolean>> = { selfExport: true, selfReceipts: true, desktopDay: true };
