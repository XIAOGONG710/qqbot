// 出口检查（ADR 0006 决策 3）：清理之后、拆条发送之前，查做不到的事和低档位禁用词。
// 命中就在提示词末尾加一句说明，意思不变重写一次；重写的结果仍命中的行删掉。重写失败就用第一版、删掉命中的行。
// 括号里的动作不在这里：卡上的 ST 正则在清理时就删了（st/regex.ts，决策 2）。

export interface ExitIssue {
    /** 回复里的第几行（从 0 开始，按 \n 分） */
    line: number;
    kind: 'promise' | 'banned';
    /** 命中的片段 */
    match: string;
}

// 做不到的事：bot 只能发文字（决策 3）。主动给人看 / 发照片、语音、视频、红包，打电话、开视频，或者说得像已经发了。
// 拒绝的说法不算：前面三个字以内有「不、没、别、懒得」（「才不想给你看」「我又没开相册给你看」），
// 或者紧跟着「不行、不了、不方便、没法、算了」（「打电话不行」）；隔了标点的不管。
// 再往前就不算了：「等它好好坐着不动我再拍了发你」是承诺。
const CLAUSE = '[^，。！？、,.!?\\s]';
const NOT_NEGATED = `(?<!(?:[不没别]|懒得)${CLAUSE}{0,3})`;
const NOT_REFUSED = `(?!${CLAUSE}{0,2}(?:不行|不了|不方便|没法|算了))`;
const PROMISE = new RegExp(NOT_NEGATED + '(?:' + [
    '给你(?:看|发|拍|翻|传|寄)',
    '发(?:给)?你',
    '拍(?:给你|了?一?张|了好几张)',
    '刚拍的',
    '翻(?:两|几)张',
    '(?:打|开)个?(?:电话|视频)',
    '(?:视频|语音)通话',
    '发(?:个|条|段)?语音',
    '发个?红包',
    '(?:要|想)(?:不要)?看(?:不|吗|嘛)$',
].join('|') + ')' + NOT_REFUSED);

export function inspectReply(reply: string, banned: readonly string[]): ExitIssue[] {
    const issues: ExitIssue[] = [];
    for (const [line, text] of reply.split('\n').entries()) {
        const promise = PROMISE.exec(text.trim());
        if (promise) issues.push({ line, kind: 'promise', match: promise[0] });
        for (const word of banned) if (text.includes(word)) issues.push({ line, kind: 'banned', match: word });
    }
    return issues;
}

/** 删掉有问题的行 */
export function dropLines(reply: string, issues: readonly ExitIssue[]): string {
    const bad = new Set(issues.map(i => i.line));
    return reply.split('\n').filter((_, i) => !bad.has(i)).join('\n').trim();
}

/** 日志里的一句：第几行、哪一类、命中什么 */
export function summarizeIssues(issues: readonly ExitIssue[]): string {
    return issues.map(i => `第 ${i.line + 1} 行${i.kind === 'promise' ? '做不到的事' : '禁用词'}「${i.match}」`).join('、');
}

/** 重写时加在提示词末尾的说明：哪一句不能发、为什么 */
export function rewriteNote(reply: string, issues: readonly ExitIssue[], userName: string): string {
    const lines = reply.split('\n');
    const reasons = [...new Set(issues.map(i => i.line))].map(line => {
        const why = issues.filter(i => i.line === line).map(i => (i.kind === 'promise'
            ? '答应或者像是已经给对方发照片、语音、视频，或者打电话，可你只能打字聊天'
            : `提到了「${i.match}」，这是不该对${userName}说的`));
        return `「${lines[line]!.trim()}」${[...new Set(why)].join('；')}`;
    });
    return `[上一版回复没有发出去：${reasons.join('；')}。意思不变，重写这次的回复，只输出要发的消息。]`;
}

export interface ReviewOptions {
    banned: readonly string[];
    userName: string;
    /** 在原来的提示词末尾加上这句说明重新生成，返回清理过的回复 */
    regenerate: (note: string) => Promise<string>;
    log: (message: string) => void;
}

export async function reviewReply(reply: string, options: ReviewOptions): Promise<string> {
    const issues = inspectReply(reply, options.banned);
    if (issues.length === 0) return reply;
    options.log(`出口检查：${summarizeIssues(issues)}，带说明重写一次`);
    let rewritten: string;
    try {
        rewritten = await options.regenerate(rewriteNote(reply, issues, options.userName));
    } catch (error) {
        options.log(`出口检查：重写失败（${error instanceof Error ? error.message : String(error)}），用第一版、删掉命中的行`);
        return dropLines(reply, issues);
    }
    const left = inspectReply(rewritten, options.banned);
    if (left.length === 0) {
        options.log('出口检查：重写后通过');
        return rewritten;
    }
    options.log(`出口检查：重写后仍有${summarizeIssues(left)}，删掉这几行`);
    return dropLines(rewritten, left);
}
