// 人格自检（ADR 0167）：拿最近十条回复，对照设定卡逐条看「有没有跑成通用助手」。
// 参考：B 站视频《Skill·人格自检》里的做法——「聊久了模型会慢慢变成通用助手腔；用设定文件逐条对照最近十条回复；
// 检查结果不发群，改就行」。这里只做只读报告，不进运行时、不改任何东西。
//
// 分两层：
//   ① 规则层（纯函数，不花 token）：禁用词、助手腔套话、句号结尾、每条长度、问句占比、开头重复；
//   ② 模型层（buildJudgePrompt）：把设定卡和这十条交给模型，要它逐条说「哪句不像她 / 为什么」，输出 JSON。
// 报告只给作者看：例子截短、不带他的话、默认不进任何日志。

export interface SelfCheckFinding {
    rule: 'banned' | 'assistant_tone' | 'period_end' | 'too_long' | 'too_many_questions' | 'same_opener';
    label: string;
    count: number;
    examples: string[];
}

export interface SelfCheckInput {
    replies: readonly string[];
    /** 这一档卡上的禁用词（card.banned） */
    banned?: readonly string[];
    /** 超过多少字算偏长（默认 25；她平时一条 6–12 字） */
    maxChars?: number;
}

const ASSISTANT_TONE = /希望对你有帮助|首先[，,]|其次[，,]|总之[，,]|综上|需要注意的是|如果你愿意|当然可以|好的[，,]?我(?:来|帮)|我可以帮你|有什么可以帮/;
const FACE = /\[[^\]]{1,8}\]/g;

const clean = (text: string): string => text.replace(FACE, '').trim();
const shorten = (text: string, n = 14): string => {
    const flat = clean(text).replace(/\s+/g, ' ');
    return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};
const hits = <T>(list: readonly T[]): T[] => [...list];

/** 最近 n 条她的回复（从聊天记录里取，按时间正序）；非文字占位（图片 / 表情包 / 私信）不算 */
export function recentReplies(rows: readonly { role: string; content: string; time?: string }[], limit = 10): string[] {
    return rows
        .filter(row => row.role === 'assistant')
        .map(row => row.content)
        .filter(text => text && !/^\[(?:图片表情|表情包|sticker|图片|B 站私信)/.test(text) && !/^https?:\/\//.test(text.trim()))
        .slice(-limit);
}

/** 规则层的检查：只报线索，不下结论 */
export function checkReplies(input: SelfCheckInput): SelfCheckFinding[] {
    const maxChars = input.maxChars ?? 25;
    const banned = input.banned ?? [];
    const replies = input.replies.map(clean).filter(Boolean);
    if (!replies.length) return [];
    const findings: SelfCheckFinding[] = [];

    const bannedHits = replies.filter(text => banned.some(word => word && text.includes(word)));
    if (bannedHits.length) findings.push({ rule: 'banned', label: '用了这一档的禁用词', count: bannedHits.length, examples: hits(bannedHits).slice(0, 3).map(text => shorten(text)) });

    const toneHits = replies.filter(text => ASSISTANT_TONE.test(text));
    if (toneHits.length) findings.push({ rule: 'assistant_tone', label: '助手腔套话（「首先」「希望对你有帮助」这类）', count: toneHits.length, examples: toneHits.slice(0, 3).map(text => shorten(text)) });

    const periodEnds = replies.filter(text => text.endsWith('。'));
    if (periodEnds.length > Math.max(1, Math.floor(replies.length * 0.3))) {
        findings.push({ rule: 'period_end', label: '句号结尾太多（聊天里真人很少句号收尾）', count: periodEnds.length, examples: periodEnds.slice(0, 3).map(text => shorten(text)) });
    }

    const long = replies.filter(text => [...text].length > maxChars);
    if (long.length) findings.push({ rule: 'too_long', label: `超过 ${maxChars} 字的长句`, count: long.length, examples: long.slice(0, 3).map(text => shorten(text)) });

    const questions = replies.filter(text => /[？?]/.test(text));
    if (questions.length >= 3 && questions.length / replies.length >= 0.3) {
        findings.push({ rule: 'too_many_questions', label: '问句太多（像客服在追问）', count: questions.length, examples: questions.slice(0, 3).map(text => shorten(text)) });
    }

    const openers = replies.map(text => [...text].slice(0, 2).join('')).filter(opener => opener.length === 2);
    const repeated = openers.filter((opener, index) => openers.indexOf(opener) !== index);
    const repeatedKinds = [...new Set(repeated)];
    if (repeatedKinds.length) {
        const worst = repeatedKinds.map(opener => ({ opener, count: openers.filter(other => other === opener).length })).sort((a, b) => b.count - a.count)[0]!;
        if (worst.count >= 3) findings.push({ rule: 'same_opener', label: `开头老是同一种（「${worst.opener}」出现 ${worst.count} 次）`, count: worst.count, examples: [] });
    }

    return findings;
}

/** 模型层的提示词：把设定卡和这十条一起给它，要逐条判断「像不像她」 */
export function buildJudgePrompt(card: { name: string; description: string; personality: string; banned?: readonly string[] }, replies: readonly string[]): string {
    return [
        `你是${card.name}这个角色的审稿人。下面是她的设定：`,
        card.description.trim(),
        card.personality.trim(),
        card.banned?.length ? `这一档不能出现的词：${card.banned.join('、')}` : '',
        '',
        '下面是她最近说的十条（编号）。逐条判断：像不像这个设定里的她？像，就说「像」；不像，就用一句话说哪里不像（太客气、像助手、太文雅、讲道理、说教、不像 20 岁的人……）。',
        '只输出 JSON：{"verdicts":[{"i":1,"ok":true},{"i":2,"ok":false,"why":"…"}],"drift":"如果整体有同一个跑偏方向，用一句话说"}',
        '不要复述原文，不要给改写的句子。',
        '',
        ...replies.map((text, index) => `${index + 1}. ${clean(text)}`),
    ].filter(line => line !== '').join('\n');
}
