// 已批准的真人语料（ADR 0190，scripts/build-exemplars.mjs 生成 <数据目录>/exemplars/corpus.jsonl）的读取。
// 原来还按他的话挑几条放进提示词当口气参考（配置 exemplars，exemplar 槽）——那个槽在 fewerRules 下整类不放，随 fewerRules 转正删了
// （2026-11-24，减法单子 二.1）。语料本身还给她自己的说话习惯（ADR 0193，speech-notes.ts）抽样用。
import { existsSync, readFileSync } from 'node:fs';

export interface Exemplar {
    id: string;
    /** 来源（语料文件 + 段落号），审计用 */
    source: string;
    license: string;
    relation?: string;
    scene?: number;
    /** 他说的那句 */
    said: string;
    /** 真人女生的回法（一条到三条气泡） */
    replied: string[];
}

/** 读语料：一行一个 JSON；坏行跳过，文件不在返回空 */
export function loadExemplars(path: string, log: (message: string) => void = () => undefined): Exemplar[] {
    if (!existsSync(path)) return [];
    const out: Exemplar[] = [];
    for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
        try {
            const row = JSON.parse(line) as Exemplar;
            if (row?.said && Array.isArray(row.replied) && row.replied.length) out.push(row);
        } catch { /* 坏行跳过 */ }
    }
    log(`真人例子：${out.length} 条（${path}）`);
    return out;
}
