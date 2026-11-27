// 她的私人空间（ADR 0200）：她自己总结 / 回想 / 追求出来的东西，默认不给他看。
// 用户 10-30：「不需要我看，给她私人空间」。以前有四条「只能看、不能改」的命令把这些东西念给他：
//   /追求（selfPursuits）、/说话习惯（speechNotes）、/心境（herFeelings 的自述和回想）、/自我认识（diaryInsights）。
// 2026-10-31 指令收敛后这四条一律回「这些指令已经不用了」；原来管它们的开关 ownerPeek 和拦截函数没人调，11-24 删了（减法单子 二.3，用户拍板）。
// PRIVATE_FILES 仍在用（迁移、导出不带这些文件）。
// 不在这里面的：/设定（设定账本、记忆账本：是「有没有被人悄悄改过」的留痕，不是她的想法）、/说话趋势（只有数字）、/像AI /像真人（是他自己的话）、/为什么。

import { SELF_FILE } from '../life/self-types.ts';
import { MANIFEST_FILE } from './prompt-manifest.ts';

/**
 * 她私人空间里的状态文件（数据目录里）：她自己总结 / 回想 / 追求出来的东西。除了她自己的提示词和桌面上她读的导出，
 * 没有任何功能读它们；迁移 / 导出 / 存档工具不带它们；日志只记条数，不记内容。
 * SELF.json（ADR 0347 第 2 层「此刻的她」）带着她的念头、心境和从他聊天里来的答应的事，同样只给桌面上的她。
 * （speech-feedback.json 是他自己标的话，不在这里。）
 */
export const PRIVATE_FILES: readonly string[] = ['speech-notes.json', 'diary-insights.json', 'feeling-review.json', 'pursuits-self.json', 'INSIGHTS.json', 'FEELINGS.json', SELF_FILE, 'reading-takes.json', 'open-questions.json', 'her-guesses.json', 'chat-review.json'];

/**
 * 名字带日期、按天滚动的私人文件：提示词指纹清单（logs/prompt-manifest-<日期>.jsonl，platform/prompt-manifest.ts）。
 * 里面没有正文，只有槽、模块和 sha256；但短的一行（时间、状态）能按哈希穷举回去，所以同样不带、不给第三方
 */
export const PRIVATE_PATTERNS: readonly RegExp[] = [MANIFEST_FILE, /^notebook-learning(?:-\d+)?\.json$/];

export const isPrivateFile = (name: string): boolean => PRIVATE_FILES.includes(name) || PRIVATE_PATTERNS.some(pattern => pattern.test(name));
