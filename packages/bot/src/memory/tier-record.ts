// 记下每个联系人上次用的档位（runtime/bot/tiers.json），档位变了就提示（ADR 0003 后果一节）。
// 只提示，不删聊天记录：从高档位换到低档位时，旧记录里可能有只该高档位知道的内容，要人工确认后清理。
// 换档时还记下时间：之后读聊天记录只看这之后的（currentTierHistory），换档前的消息不进提示词、不写进新档位的记忆；
// 启动时补回漏掉的消息也只取这之后的，否则归档掉的旧记录会从 QQ 的消息历史里又被拉回来。
// 10-04 尾号 73 降档时，聊天记录还没归档 bot 就启动了一次，旧片段直接写进了同学档的 bank：只靠手动归档不够。
// 写的时候先写临时文件再改名（ADR 0013 决策 3）；读坏了照样报错、不启动：丢了换档时间，换档前的消息会重新进提示词和新档位的记忆。

import { existsSync, readFileSync } from 'node:fs';
import { CONTACT_TIERS, UNLISTED_TIER, type Tier } from '../platform/config.ts';
import type { ChatHistory } from './history.ts';
import { writeJsonAtomic } from './json-file.ts';
import { stateObject, stateTimestamp } from './state-schema.ts';

const ORDER: readonly string[] = [...CONTACT_TIERS, UNLISTED_TIER];

interface Entry {
    tier: string;
    /** 换到这一档的时间（ISO）；第一次记下的联系人没有 */
    since?: string;
}

function validTierState(value: unknown): value is Record<string, string | Entry> {
    return stateObject(value) && Object.entries(value).every(([qq, entry]) => /^[1-9]\d*$/.test(qq) && Number.isSafeInteger(Number(qq))
        && (typeof entry === 'string' ? ORDER.includes(entry)
            : stateObject(entry) && typeof entry.tier === 'string' && ORDER.includes(entry.tier)
                && (entry.since === undefined || stateTimestamp(entry.since))));
}

export class TierRecord {
    readonly #path: string;
    readonly #tiers: Record<string, Entry>;

    constructor(path: string) {
        this.#path = path;
        let data: Record<string, string | Entry> = {};
        try {
            if (existsSync(path)) {
                const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
                if (!validTierState(parsed)) throw new Error('档位状态内容不符合 schema');
                data = parsed;
            }
        } catch (error) {
            throw new Error(`${path} 读不了（${error instanceof Error ? error.message : String(error)}）：它记着每个联系人换档的时间，` +
                '当成空的会让换档前的消息重新进提示词和记忆，所以不启动；修好或删掉它（删掉 = 都当没换过档）再启动');
        }
        // 旧格式只存档位名
        this.#tiers = Object.fromEntries(Object.entries(data).map(([qq, v]) => [qq, typeof v === 'string' ? { tier: v } : v]));
    }

    /** 记下这次的档位；和上次不同时返回提示文字 */
    update(qq: number, tier: Tier, now: Date = new Date()): string | undefined {
        if (!Number.isSafeInteger(qq) || qq <= 0 || !ORDER.includes(tier) || !Number.isFinite(now.getTime())) throw new Error('拒绝写入不符合 schema 的档位记录');
        const previous = this.#tiers[String(qq)]?.tier;
        if (previous === tier) return undefined;
        this.#tiers[String(qq)] = previous === undefined ? { tier } : { tier, since: now.toISOString() };
        writeJsonAtomic(this.#path, this.#tiers);
        return previous === undefined ? undefined : tierChangeWarning(qq, previous, tier);
    }

    /** 这个联系人从什么时候起是现在的档位；没换过档就是 undefined */
    since(qq: number): Date | undefined {
        const since = this.#tiers[String(qq)]?.since;
        return since ? new Date(since) : undefined;
    }
}

export function tierChangeWarning(qq: number, previous: string, current: string): string {
    const lower = ORDER.indexOf(current) > ORDER.indexOf(previous);
    return lower
        ? `QQ ${qq} 的档位从 ${previous} 降到 ${current}：旧聊天记录里可能有 ${previous} 才能知道的内容，确认后手动清理或归档 chats/${qq}.jsonl` +
            '（之前的消息已不进提示词、不写进新档位的记忆、不从 QQ 补回，原文可以放心归档）'
        : `QQ ${qq} 的档位从 ${previous} 变成 ${current}`;
}

/** 聊天记录只看现在这一档开始之后的；文件里的原文不动 */
export function currentTierHistory(history: Pick<ChatHistory, 'load' | 'append'>, record: TierRecord): Pick<ChatHistory, 'load' | 'append'> {
    return {
        load: qq => {
            const since = record.since(qq);
            const all = history.load(qq);
            return since ? all.filter(m => Date.parse(m.time) >= since.getTime()) : all;
        },
        append: (qq, message) => history.append(qq, message),
    };
}
