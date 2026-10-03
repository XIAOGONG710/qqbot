// 记下每个联系人上次用的档位（runtime/bot/tiers.json），档位变了就提示（ADR 0003 后果一节）。
// 只提示，不删聊天记录：从高档位换到低档位时，旧记录里可能有只该高档位知道的内容，要人工确认后清理。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONTACT_TIERS, UNLISTED_TIER, type Tier } from './config.ts';

const ORDER: readonly string[] = [...CONTACT_TIERS, UNLISTED_TIER];

export class TierRecord {
    readonly #path: string;
    readonly #tiers: Record<string, string>;

    constructor(path: string) {
        this.#path = path;
        this.#tiers = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, string> : {};
    }

    /** 记下这次的档位；和上次不同时返回提示文字 */
    update(qq: number, tier: Tier): string | undefined {
        const previous = this.#tiers[String(qq)];
        if (previous === tier) return undefined;
        this.#tiers[String(qq)] = tier;
        writeFileSync(this.#path, JSON.stringify(this.#tiers, null, 2) + '\n');
        return previous === undefined ? undefined : tierChangeWarning(qq, previous, tier);
    }
}

export function tierChangeWarning(qq: number, previous: string, current: string): string {
    const lower = ORDER.indexOf(current) > ORDER.indexOf(previous);
    return lower
        ? `QQ ${qq} 的档位从 ${previous} 降到 ${current}：旧聊天记录里可能有 ${previous} 才能知道的内容，会被带进提示词。确认后手动清理或归档 chats/${qq}.jsonl`
        : `QQ ${qq} 的档位从 ${previous} 变成 ${current}`;
}
