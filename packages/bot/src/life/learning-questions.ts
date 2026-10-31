// 她学习时没懂的地方，拿去问他（2026-10-31 用户：「她现在的说话方式还在学习，可是她学的不会的没有问过我」）
//
// 她在学怎么说话（说话笔记、翻日记、读的书、梦），一定会有不懂的——但她以前从没把这些带到聊天里。
// 这里做一件事：从她最近的"学"里挑一个真没想通的问题，存下来，聊天时递给她，让她来问他。
// 不新增指令（用户 10-31 定的规矩），全靠提示词里的这一行。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LearningQuestion {
    /** 写下这个问题的时间（毫秒） */
    at: number;
    /** 问题本身，一句 */
    question: string;
    /** 从哪儿来的（说话笔记 / 日记 / 书 / 梦） */
    from: string;
}

const FILE = 'learning-questions.json';
const path = (dataDir: string) => join(dataDir, FILE);

export function loadQuestion(dataDir: string): LearningQuestion | undefined {
    try {
        const file = path(dataDir);
        if (!existsSync(file)) return undefined;
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as LearningQuestion;
        return typeof parsed.question === 'string' && parsed.question.trim() ? parsed : undefined;
    } catch { return undefined; }
}

export function saveQuestion(dataDir: string, question: LearningQuestion): void {
    try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(path(dataDir), JSON.stringify(question, null, 1));
    } catch { /* 存不下不影响聊天 */ }
}

/** 超过两天没问出口就作废（别让她抱着一个问题追你三天） */
export const QUESTION_TTL_MS = 2 * 24 * 3_600_000;

/** 递给她的一行：这是你没想通的事，想问就问他 */
export function questionLine(question: LearningQuestion | undefined, now: number): string | undefined {
    if (!question) return undefined;
    if (now - question.at > QUESTION_TTL_MS) return undefined;
    return `[你这两天在学说话/翻自己的东西的时候，有一个没想通的地方：${question.question.slice(0, 120)}（来自${question.from}）。要是这会儿聊到了，就问问他——他答不上来也没关系，你想让他知道你在琢磨这个]`;
}

/** 让她自己想一个"没搞懂的问题" */
export function questionPrompt(materials: { notes: string; journal: string; books: string; name: string }): { system: string; user: string } {
    return {
        system: `你是${materials.name}。翻一遍自己最近记下的东西（说话的习惯、日记、读的书），挑出一个**你还真没想通**的地方，写成一句你会问他本人的问题。

要求：
- 问的是"为什么/怎么才算/这样做行不行"这类你真拿不准的，不是知识问答；
- 用你自己的口气，一句，不超过 40 字；
- 不要写"我有个问题"这种开场，直接是那句问话；
- 实在没有就不写，只输出 SKIP。`,
        user: [
            `你的说话笔记：${materials.notes.slice(0, 600) || '（还没有）'}`,
            `你的日记：${materials.journal.slice(0, 600) || '（还没有）'}`,
            `你在读的书：${materials.books.slice(0, 300) || '（没有）'}`,
            '挑一个你真没想通的问题。',
        ].join('\n'),
    };
}
