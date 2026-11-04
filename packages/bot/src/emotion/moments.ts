// 作者写下的事（ADR 0102）：<数据目录>/moments.json。她生活里发生的、引起情绪的大事（考砸了、跟谁闹僵了、收到好消息）不是我编的，是作者定的，
// 所以放在一个作者自己改的文件里，而不是代码或模型里随机出：没有这个文件、里面没有事，心境就只来自她那边的日常事实和他的态度。
// 每次生成现取（按文件身份/时间/大小缓存）；写坏了不隔离、不覆盖，安全记日志并沿用上次有效快照，没有快照才当作没有。

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validMoments, type Moment } from './feelings.ts';

export const MOMENTS_FILE = 'moments.json';

export function momentsPath(dataDir: string): string {
    return join(dataDir, MOMENTS_FILE);
}

/** 读作者写下的事；明确删除清缓存；读不了/不合格沿用最后有效快照或空，安全日志不带原文。 */
export function momentsReader(dataDir: string, log: (message: string) => void): () => readonly Moment[] {
    const path = momentsPath(dataDir);
    let cached: { key: string; moments: Moment[] } | undefined;
    let complained = false;
    return () => {
        try {
            const stat = statSync(path, { bigint: true });
            const key = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
            if (cached?.key === key) return structuredClone(cached.moments);
            const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
            if (!validMoments(parsed)) throw new Error('内容不符合格式（{"moments":[{id, at, kind, strength, cause}]}）');
            cached = { key, moments: parsed.moments };
            complained = false;
            return structuredClone(cached.moments);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { cached = undefined; complained = false; return []; }
            if (!complained) { complained = true; log(`心境：${MOMENTS_FILE} 读不了（读取或格式校验失败），暂用上次有效事实；原文件未修改`); }
            return structuredClone(cached?.moments ?? []);
        }
    };
}
