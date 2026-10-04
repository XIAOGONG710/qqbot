// 记下每个联系人上次用的档位（runtime/bot/tiers.json），档位变了就提示（ADR 0003 后果一节）。
// 只提示，不删聊天记录：从高档位换到低档位时，旧记录里可能有只该高档位知道的内容，要人工确认后清理。
// 换档时还记下时间：启动时补回漏掉的消息只取这之后的，否则归档掉的旧记录会从 QQ 的消息历史里又被拉回来。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONTACT_TIERS, UNLISTED_TIER, type Tier } from './config.ts';

const ORDER: readonly string[] = [...CONTACT_TIERS, UNLISTED_TIER];

interface Entry {
    tier: string;
    /** 换到这一档的时间（ISO）；第一次记下的联系人没有 */
    since?: string;
}

export class TierRecord {
    readonly #path: string;
    readonly #tiers: Record<string, Entry>;

    constructor(path: string) {
        this.#path = path;
        const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, string | Entry> : {};
        // 旧格式只存档位名
        this.#tiers = Object.fromEntries(Object.entries(data).map(([qq, v]) => [qq, typeof v === 'string' ? { tier: v } : v]));
    }

    /** 记下这次的档位；和上次不同时返回提示文字 */
    update(qq: number, tier: Tier, now: Date = new Date()): string | undefined {
        const previous = this.#tiers[String(qq)]?.tier;
        if (previous === tier) return undefined;
        this.#tiers[String(qq)] = previous === undefined ? { tier } : { tier, since: now.toISOString() };
        writeFileSync(this.#path, JSON.stringify(this.#tiers, null, 2) + '\n');
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
        ? `QQ ${qq} 的档位从 ${previous} 降到 ${current}：旧聊天记录里可能有 ${previous} 才能知道的内容，会被带进提示词。确认后手动清理或归档 chats/${qq}.jsonl` +
            '（补回漏掉的消息只取现在之后的，不会把旧记录从 QQ 里再拉回来）'
        : `QQ ${qq} 的档位从 ${previous} 变成 ${current}`;
}
