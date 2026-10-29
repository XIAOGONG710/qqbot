// 首轮铺底（2026-10-29）：他走了很久再回来，第一轮把她自己写的日记塞一句进提示词。
// 为什么：每轮都是拿他这一句去检索记忆，隔夜第一句和昨天的记忆没有词面交集 → 查不到 → 她像失忆。
// 三条约束（用户定的）：只在离开 ≥6 小时时；≤300 字；内容来自她自己的日记（JOURNAL.md），不是我们写的人设简介。
// 不做的事：不新增开关（挂在 lifeInPrompt 下）、不碰记忆库、不改召回逻辑。

/** 离开多久算「走了很久」 */
export const WAKE_GAP_MS = 6 * 3_600_000;
/** 铺底最多多少字 */
export const BACKFILL_MAX_CHARS = 300;

export interface WakeBackfillInput {
    /** 聊天记录里最后一条的时间（ISO）；没有记录就不铺 */
    lastAt?: string;
    /** 现在（毫秒） */
    now: number;
    /** 她的日记全文（JOURNAL.md 的原文） */
    journal: string;
    /** 日志用：不影响返回 */
    log?: (message: string) => void;
}

/** 日记按「## YYYY-MM-DD」切成一段段，取最后一段 */
export function lastJournalEntry(journal: string): { date: string; text: string } | undefined {
    const parts = journal.split(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/m);
    // split 带捕获组：['前言', '日期1', '正文1', '日期2', '正文2', ...]
    let date = '';
    let body = '';
    for (let i = 1; i < parts.length; i += 2) {
        date = parts[i]!;
        body = parts[i + 1] ?? '';
    }
    const text = body.replace(/\s+/g, ' ').trim();
    return date && text ? { date, text } : undefined;
}

/** 按句号切到不超过 max 字；切不出来就硬截 */
function clamp(text: string, max: number): string {
    if ([...text].length <= max) return text;
    const chars = [...text];
    const cut = chars.slice(0, max).join('');
    const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('.'));
    return at >= max / 3 ? cut.slice(0, at + 1) : cut;
}

/**
 * 该铺就返回一行提示词，不该铺返回 undefined。
 * 判据只有两个：离开时长 ≥6 小时、日记里有内容。别的都在上游决定（lifeInPrompt 开着才接进来）。
 */
export function wakeBackfill(input: WakeBackfillInput): string | undefined {
    if (!input.lastAt) return undefined;
    const last = Date.parse(input.lastAt);
    if (!Number.isFinite(last)) return undefined;
    if (input.now - last < WAKE_GAP_MS) return undefined;
    const entry = lastJournalEntry(input.journal);
    if (!entry) return undefined;
    const hours = Math.floor((input.now - last) / 3_600_000);
    input.log?.(`首轮铺底：他走了 ${hours} 小时，带上 ${entry.date} 的日记（${[...entry.text].length} 字）`);
    return `（他走了 ${hours} 小时。这期间你自己过的日子，你写的：${clamp(entry.text, BACKFILL_MAX_CHARS)}）`;
}
