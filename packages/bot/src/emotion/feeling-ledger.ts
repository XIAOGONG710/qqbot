// 感觉账（ADR 0347 第 5 层）：只追加，每天明显以上的感受。
//
// 为什么：回想记下的感受最多同时 8 条、放下就丢了种类（feeling-review.ts 的 MAX_ACTIVE / MAX_RETIRE），
// 几天以前的事就配不上感觉了。她说「翻日记那种感觉挺怪的，字都对，就是跟我隔一层」，
// 要的是想起来的时候，那件事还带着当时的感觉。
//
// 她定下的几条（11-22 三问，原话在 ADR 0347「第 5 层：实现记录」）：
//   · 疼（痛经）和她妈那块的慌，不想原样带上来——「知道有过那么回事就行」「带上来也还是慌，我又没法解决，只会白添堵」。
//     这两类照记，但召回时只说「身上不太舒服」「心里一直悬着」，不说是什么事。
//   · 衰减不按天数硬删：「想起来还会笑的那种就留着」「三个月前那些……留个大概就行」。
//     所以账一条不删，只把 90 天以前的降成「粗」；开心、松口气不降。
//   · 自己那些破事（熬夜、考砸、作业拖）不是不许知道，是不想被追着问：账照记，召回时不主动引申。
//
// 账写在灵魂目录（和 FEELINGS.json 一处），桌面插件按同一个文件配当时的感觉；只是追加，写坏了也不回头改。

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FEELING_KINDS, FEELING_NAME, type Felt, type FeelingKind } from './feelings.ts';

export const LEDGER_FILE = 'feeling-ledger.jsonl';
export const ledgerPath = (soulDir: string) => join(soulDir, LEDGER_FILE);
/** 超过这么久就只剩个大概（不删） */
export const COARSE_AFTER_DAYS = 90;
export const DAY_MS = 86_400_000;

/** 她不想原样带上的两类；'' 就是照原样记 */
export type Withhold = '' | 'pain' | 'mother';
export type LedgerLevel = 'clear' | 'strong';

export interface LedgerEntry {
    at: number;
    kind: FeelingKind;
    level: LedgerLevel;
    cause: string;
    source: string;
    aboutHim: boolean;
    withhold: Withhold;
    /** 读出来时算的：这条只剩个大概 */
    coarse?: boolean;
}

/** 疼：说了不说是什么事她也知道 */
const PAIN = /痛经|来事|肚子疼|疼得|身上不舒服/;
/** 她妈那块的慌：只说心里一直悬着 */
const MOTHER = /妈/;
/** 想起来还会笑的那种，不降粗 */
const LOOSE_KINDS: ReadonlySet<FeelingKind> = new Set(['joy', 'relief']);

export function withholdOf(kind: FeelingKind, cause: string): Withhold {
    if (PAIN.test(cause)) return 'pain';
    if (kind === 'worry' && MOTHER.test(cause)) return 'mother';
    return '';
}

/** 她愿意被带上的说法；'' 的那种照原样 */
export function withheldCause(withhold: Withhold): string | undefined {
    if (withhold === 'pain') return '身上不太舒服';
    if (withhold === 'mother') return '心里一直悬着';
    return undefined;
}

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

function asEntry(value: unknown): LedgerEntry | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const row = value as Partial<LedgerEntry>;
    if (typeof row.at !== 'number' || !Number.isFinite(row.at)) return undefined;
    if (!FEELING_KINDS.includes(row.kind as FeelingKind)) return undefined;
    if (row.level !== 'clear' && row.level !== 'strong') return undefined;
    const withhold = row.withhold === 'pain' || row.withhold === 'mother' ? row.withhold : '';
    return {
        at: row.at,
        kind: row.kind as FeelingKind,
        level: row.level,
        cause: String(row.cause ?? ''),
        source: String(row.source ?? ''),
        aboutHim: Boolean(row.aboutHim),
        withhold,
    };
}

/** 只追加：明显以上的感受记一行，同一天同一件同一类不重复记。返回追加了几条 */
export function appendFeelings(soulDir: string, felt: readonly Felt[], at: number): number {
    const seen = new Set(readLedger(soulDir, at).map(row => `${dayOf(row.at)}|${row.kind}|${row.cause}`));
    const rows: string[] = [];
    for (const item of felt) {
        if (item.level === 'faint') continue;
        const key = `${dayOf(at)}|${item.kind}|${item.cause}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry: LedgerEntry = {
            at,
            kind: item.kind,
            level: item.level,
            cause: item.cause,
            source: item.source,
            aboutHim: item.aboutHim,
            withhold: withholdOf(item.kind, item.cause),
        };
        rows.push(JSON.stringify(entry));
    }
    if (!rows.length) return 0;
    appendFileSync(ledgerPath(soulDir), `${rows.join('\n')}\n`, 'utf8');
    return rows.length;
}

/** 整本账（读的时候算粗细）；文件不在、坏行都跳过 */
export function readLedger(soulDir: string, now = Date.now()): LedgerEntry[] {
    let text = '';
    try {
        text = readFileSync(ledgerPath(soulDir), 'utf8');
    } catch {
        return [];
    }
    const out: LedgerEntry[] = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            continue;
        }
        const entry = asEntry(parsed);
        if (!entry) continue;
        const ageDays = (now - entry.at) / DAY_MS;
        entry.coarse = entry.withhold !== '' || (ageDays > COARSE_AFTER_DAYS && !LOOSE_KINDS.has(entry.kind));
        out.push(entry);
    }
    return out;
}

/**
 * 召回时附的一句（照 ADR 0218 的措辞：只写感觉，不重复经过，写明现在不一定还这样）。
 * 她不想原样带上的那两类在这里换说法；粗的只记得个大概。
 */
export function ledgerNote(entry: LedgerEntry): string {
    // 疼 / 她妈那块的慌：只说换过的那句，不带程度（「很身上不太舒服」不成话，也不该让她再疼一遍）
    const withheld = withheldCause(entry.withhold);
    // 因为他难过 / 烦 / 担心的：她 11-22「会带一点。想起来还是有点堵，但堵一会儿就过去了，不会攒着」——附，但最多到「有点」
    const softened = entry.aboutHim && ABOUT_HIM_SOFTENED.has(entry.kind);
    const said = withheld ?? `${entry.level === 'strong' && !softened ? '很' : '有点'}${FEELING_NAME[entry.kind]}`;
    const loose = entry.coarse ? '只记得个大概：' : '';
    return `那时候你心里${loose}${said}（那是你当时的感觉，现在不一定还这样）`;
}

/** 因为他而起、只带一点的那几种（她 11-22 第 3 问） */
const ABOUT_HIM_SOFTENED: ReadonlySet<FeelingKind> = new Set(['sad', 'annoyed', 'worry']);
