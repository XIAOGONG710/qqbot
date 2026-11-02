// 她的私人空间（ADR 0200）：她自己总结 / 回想 / 追求出来的东西，默认不给他看。
// 用户 10-30：「不需要我看，给她私人空间」。以前有四条「只能看、不能改」的命令把这些东西念给他：
//   /追求（selfPursuits）、/说话习惯（speechNotes）、/心境（herFeelings 的自述和回想）、/自我认识（diaryInsights）。
// 现在这四条要 ownerPeek 开着才念；没开，他打这几条得到一句固定的话（不进聊天记录、不交给她）。
// 不在这里面的：/设定（设定账本、记忆账本：是「有没有被人悄悄改过」的留痕，不是她的想法）、/说话趋势（只有数字）、/像AI /像真人（是他自己的话）、/为什么。

import type { AppConfig } from './config.ts';

/** 念她私人内容的命令 → 哪个功能开着时它才算命令（功能没开，它还是一句普通的话） */
export const PEEK_COMMANDS: readonly { command: string; active: (config: AppConfig) => boolean }[] = [
    { command: '/追求', active: config => Boolean(config.selfPursuits && config.pursuits) },
    { command: '/说话习惯', active: config => Boolean(config.speechNotes) },
    { command: '/心境', active: config => Boolean(config.herFeelings) },
    { command: '/自我认识', active: config => Boolean(config.diaryInsights) },
];

export const PEEK_OFF_NOTICE = '（这条是她自己的，现在不给看——配置里 ownerPeek 关着。她的事她自己留着。）';

/** 他这句话是不是在要看她私人的东西、而且 ownerPeek 关着：是就该回那句固定的话，别的都不用管 */
export function peekRefused(plain: string | undefined, config: AppConfig): boolean {
    if (config.ownerPeek || !plain) return false;
    return PEEK_COMMANDS.some(entry => entry.command === plain && entry.active(config));
}

/**
 * 她私人空间里的状态文件（数据目录里）：她自己总结 / 回想 / 追求出来的东西。除了她自己的提示词和桌面上她读的导出，
 * 没有任何功能读它们；迁移 / 导出 / 存档工具不带它们；日志只记条数，不记内容。
 * （speech-feedback.json 是他自己标的话，不在这里。）
 */
export const PRIVATE_FILES: readonly string[] = ['speech-notes.json', 'diary-insights.json', 'feeling-review.json', 'pursuits-self.json', 'INSIGHTS.json', 'FEELINGS.json', 'reading-takes.json', 'open-questions.json', 'her-guesses.json', 'chat-review.json'];

export const isPrivateFile = (name: string): boolean => PRIVATE_FILES.includes(name);
