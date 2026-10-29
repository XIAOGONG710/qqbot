// 梗百科字典（2026-10-29）：我们自己的一份词表，6599 条，字段是我们的口径
//（term / meaning / origin / tags / summary），由 scripts/import-meme-dict.mjs 从 cnmeme.wiki 的快照一次性转写。
//
// 为什么不直接读别人的库：那份是别人的 sqlite + 别人的字段，读它等于把运行时长在别人的格式上；
// 转成我们的 JSON 之后，运行时不认识 sqlite、不依赖那个仓库，格式也和我们自己学梗那套一致。
//
// 和 memes.ts 的分工：memes.ts 的她每 12 小时自己学、最多 40 个、会主动往外用；
// 这里是**查**——他这句里提到一个词，查得到就把「怎么用 / 出处 / 标签」递给她，不写进她自己的库。
import { existsSync, readFileSync } from 'node:fs';

export interface DictEntry {
    term: string;
    /** 怎么用 / 怎么接，压成一句 */
    meaning: string;
    /** 出处 */
    origin: string;
    /** 标签：圈层和风格，用来看合不合适 */
    tags: string;
    summary: string;
}

export interface MemeDict {
    count(): number;
    /** 完全同名 */
    lookup(term: string): DictEntry | undefined;
    /** 他这一句里提到的最长的那个词（2 字以上） */
    mention(text: string): DictEntry | undefined;
}

export interface DictFile {
    version: 1;
    source?: string;
    importedAt?: string;
    entries: DictEntry[];
}

/** 读字典；文件不在、读坏了都返回 undefined（不挡回复，也不报错刷屏） */
export function openMemeDict(path: string, log: (message: string) => void = () => undefined): MemeDict | undefined {
    if (!existsSync(path)) return undefined;
    let file: DictFile;
    try {
        file = JSON.parse(readFileSync(path, 'utf8')) as DictFile;
    } catch (error) {
        log(`梗百科字典读不了（${error instanceof Error ? error.message : String(error)}），只用自己学的梗`);
        return undefined;
    }
    const entries = Array.isArray(file.entries) ? file.entries.filter(e => e && typeof e.term === 'string' && e.term.length >= 2) : [];
    if (!entries.length) return undefined;
    const byTerm = new Map(entries.map(e => [e.term, e]));
    // 他一句话里要认出「最长的那个词」：按长度倒序试，命中就停（6599 条，几十次 includes，够快）
    const byLength = [...entries].sort((a, b) => [...b.term].length - [...a.term].length);
    return {
        count: () => entries.length,
        lookup: (term) => byTerm.get(term.trim()),
        mention: (text) => {
            const said = String(text ?? '');
            if (!said) return undefined;
            return byLength.find(e => said.includes(e.term));
        },
    };
}
