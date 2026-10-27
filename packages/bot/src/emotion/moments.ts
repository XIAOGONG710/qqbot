// 作者写下的事（ADR 0102）：<数据目录>/moments.json。她生活里发生的、引起情绪的大事（考砸了、跟谁闹僵了、收到好消息）不是我编的，是作者定的，
// 所以放在一个作者自己改的文件里，而不是代码或模型里随机出：没有这个文件、里面没有事，心境就只来自她那边的日常事实和他的态度。
// 每次生成现取（按文件的修改时间缓存）；写坏了不隔离、不覆盖，记一行日志当作没有（作者的文件不能被我们挪走）。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validMoments, type Moment } from './feelings.ts';

export const MOMENTS_FILE = 'moments.json';

export function momentsPath(dataDir: string): string {
    return join(dataDir, MOMENTS_FILE);
}

/** 读作者写下的事；文件不存在 = 没有；读不了 / 不合格 = 没有（记一行，同一个坏文件只记一次） */
export function momentsReader(dataDir: string, log: (message: string) => void): () => readonly Moment[] {
    const path = momentsPath(dataDir);
    let cached: { key: string; moments: Moment[] } | undefined;
    let complained = '';
    return () => {
        try {
            if (!existsSync(path)) return [];
            const stat = statSync(path);
            const key = `${stat.mtimeMs}:${stat.size}`;
            if (cached?.key === key) return cached.moments;
            const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
            if (!validMoments(parsed)) throw new Error('内容不符合格式（{"moments":[{id, at, kind, strength, cause}]}）');
            cached = { key, moments: parsed.moments };
            return cached.moments;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (complained !== detail) { complained = detail; log(`心境：${MOMENTS_FILE} 读不了（${detail}），当作没有作者写下的事`); }
            return cached?.moments ?? [];
        }
    };
}
