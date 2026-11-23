// 提示词指纹清单（研究 docs/research/2026-11-22-private-companion-v2.md 五、建议 1；ADR 0336 附「提示词指纹清单」）。
// 每次生成（回他、主动找他、想一想；v2 起还有群里开口、审稿重写、挑候选）冻结一份「这一份提示词里放了什么」，**不含任何正文**：
//   每段的槽、产出它的模块、在哪张表（main 之后 / 聊天记录之后 / 「此刻」块）、字数、正文的 sha256，
//   加上这一轮的联系人、时刻、最终发给模型的消息条数、每条的角色 / 字数 / sha256 和整份的 sha256。
//   不按槽拼的提示词（群里开口、审稿重写、挑候选）没有段落（pieces 是空的），只记最终的消息。
// 用处：
//   1. ADR 0347 第 2 层验收「SELF 的行和 QQ『此刻』块一字不差」：逐行比 sha256，不开敏感日志、不碰正文（scripts/prompt-manifest-diff.mjs）；
//   2. ADR 0336 后面拆模块时，看出哪个模块改了哪个槽；
//   3. 排查「她刚才为什么这么说」：哪些段落在、哪些被预算挤掉了。诊断只认这一份冻结的清单，不另拼一份。
// 默认就写（不看 QQBOT_SENSITIVE_LOGS），由宿主（platform/main.ts、Koishi 插件）给 App，同按天日志；写在 <数据目录>/logs/prompt-manifest-<YYYY-MM-DD>.jsonl，
// 一次生成一行、只追加，保留 MANIFEST_KEEP_DAYS 天。写不进去不影响她回话。
// 哈希也算私人的：短的一行（「现在是晚上九点」）能被穷举出来，所以文件在 PRIVATE 名单里（private-space.ts、scripts/ginka-guard.mjs），迁移 / 存档 / 第三方都不带。

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PlacedPiece } from '../interpreter/slots.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import type { Log } from './log.ts';

/** 2：多了 group / review / candidate 三种（pieces 为空）和 reason / stage / calls；1 的行只有 reply / initiate / think，别的字段一样 */
export const MANIFEST_VERSION = 2;
/** 留几天（含今天）：够看一周多的变化，又不会越积越多 */
export const MANIFEST_KEEP_DAYS = 14;
/** 清单文件名：prompt-manifest-<本地日期>.jsonl */
export const MANIFEST_FILE = /^prompt-manifest-(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const manifestFileName = (day: string): string => `prompt-manifest-${day}.jsonl`;

/**
 * 这一次生成是什么：
 * - 按槽拼的（联系人流水线 buildPrompt，有 pieces）：回他、主动找他、只想一想（内心，ADR 0101）；
 * - 不按槽拼的（pieces 为空，只记消息）：群里开口（social/group-room.ts；qq 记群号、reason 记为什么开口）、
 *   审稿重写（同一份提示词末尾加一条说明再生成一次；stage 记审稿哪一步要的）、
 *   挑候选（同一份提示词生成 calls 个挑一个，ADR 0041；那一轮的 reply / initiate 行照旧有，messages.sha256 和它一样）
 */
export const SLOT_KINDS = ['reply', 'initiate', 'think'] as const;
export const MANIFEST_KINDS = [...SLOT_KINDS, 'group', 'review', 'candidate'] as const;
export type ManifestKind = (typeof MANIFEST_KINDS)[number];

/** 一段：槽、模块、在哪张表、字数、正文的 sha256；被预算挤掉的（buildPrompt 的 omittedAfterHistory）标 omitted */
export interface ManifestPiece {
    slot: string;
    module: string;
    list: PlacedPiece['list'];
    chars: number;
    sha256: string;
    omitted?: true;
}

/** 最终发给模型的一条消息（ST 后处理之后）：角色、字数、sha256 */
export interface ManifestMessage { role: string; chars: number; sha256: string }

export interface PromptManifest {
    /** 旧的行是 1（见 MANIFEST_VERSION） */
    v: 1 | typeof MANIFEST_VERSION;
    /** 联系人的 QQ；群里开口（group）时是群号 */
    qq: number;
    /** 这一轮的时刻（ISO） */
    at: string;
    kind: ManifestKind;
    pieces: ManifestPiece[];
    /** 最终消息的正文字数合计 */
    chars: number;
    /** 最终消息：条数、整份的 sha256（按 role + content 序列化）、每一条的 */
    messages: { count: number; sha256: string; list: ManifestMessage[] };
    /** 为保留他最后一条消息被省略的「聊天记录之后」段数（同 PromptResult） */
    omittedAfterHistory?: number;
    /** 预算放不下、没调模型直接回了固定的话 */
    fallback?: true;
    /** group：为什么开口（被 @、接话、冷场冒一句……，social/group-chat.ts 的 SpeakReason） */
    reason?: string;
    /** review：审稿哪一步要的重写（interpreter.ts 的 REVIEW_STAGES） */
    stage?: string;
    /** candidate：同一份提示词生成了几个 */
    calls?: number;
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface ManifestInput {
    qq: number;
    at: Date;
    kind: ManifestKind;
    /** 真正放进去的段落（slots.ts 的 placedPieces；模块由解释器标上）；不按槽拼的不给 */
    placed?: readonly PlacedPiece[];
    /** 最终发给模型的消息 */
    messages: readonly OpenAIMessage[];
    omittedAfterHistory?: number;
    fallback?: boolean;
    reason?: string;
    stage?: string;
    calls?: number;
}

/**
 * 算一份清单（纯函数，不碰文件）。被预算挤掉的段：buildPrompt 从「聊天记录之后」那一串（每段一条，最后是「此刻」块一条；空的不算）的最前面省略 omittedAfterHistory 条，
 * 这里按同样的次序把对应的段标 omitted（「此刻」块整条被挤掉时，它的每一行都标）
 */
export function promptManifest(input: ManifestInput): PromptManifest {
    const placed = input.placed ?? [];
    const omitted = new Set<PlacedPiece>();
    const skip = input.omittedAfterHistory ?? 0;
    if (skip > 0) {
        const history = placed.filter(item => item.list === 'history' && item.piece.text);
        const now = placed.filter(item => item.list === 'now');
        const candidates: PlacedPiece[][] = [...history.map(item => [item]), ...(now.length ? [now] : [])];
        for (const group of candidates.slice(0, skip)) for (const item of group) omitted.add(item);
    }
    const pieces = placed.map((item): ManifestPiece => ({
        slot: item.piece.slot,
        module: item.piece.module ?? '?',
        list: item.list,
        chars: item.piece.text.length,
        sha256: sha256(item.piece.text),
        ...(omitted.has(item) ? { omitted: true as const } : {}),
    }));
    const list = input.messages.map(message => ({ role: message.role, chars: message.content.length, sha256: sha256(message.content) }));
    return {
        v: MANIFEST_VERSION,
        qq: input.qq,
        at: input.at.toISOString(),
        kind: input.kind,
        pieces,
        chars: list.reduce((sum, message) => sum + message.chars, 0),
        messages: { count: list.length, sha256: sha256(JSON.stringify(input.messages.map(({ role, content }) => [role, content]))), list },
        ...(input.omittedAfterHistory ? { omittedAfterHistory: input.omittedAfterHistory } : {}),
        ...(input.fallback ? { fallback: true as const } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.stage ? { stage: input.stage } : {}),
        ...(input.calls ? { calls: input.calls } : {}),
    };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 本地日期 YYYY-MM-DD（同 log.ts 的按天日志） */
export const manifestDay = (time: Date): string => `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;

/** 该删的旧清单：文件名里的日期早于「今天往前 keepDays - 1 天」的；别的文件不碰 */
export function expiredManifests(names: readonly string[], today: Date, keepDays = MANIFEST_KEEP_DAYS): string[] {
    const oldest = manifestDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (keepDays - 1)));
    return names.filter(name => {
        const day = MANIFEST_FILE.exec(name)?.[1];
        return day !== undefined && day < oldest;
    });
}

export interface ManifestLogOptions {
    /** 现在几点（按它定写哪一天的文件、删哪几天的），默认真实时间 */
    now?: () => Date;
    keepDays?: number;
    /** 写不进去时记一句（不记内容）；默认不记 */
    log?: Log;
}

/**
 * 按天追加清单：<dir>/prompt-manifest-<YYYY-MM-DD>.jsonl，一次生成一行。每天第一次写的时候顺手删掉超过 keepDays 的旧文件。
 * 写失败只记一句（接着失败不重复记），不抛：清单是诊断用的，不能挡她回话
 */
export function createPromptManifestLog(dir: string, options: ManifestLogOptions = {}): (manifest: PromptManifest) => void {
    const now = options.now ?? (() => new Date());
    const keepDays = options.keepDays ?? MANIFEST_KEEP_DAYS;
    let prunedFor: string | undefined;
    let failing = false;
    return manifest => {
        const time = now();
        const day = manifestDay(time);
        try {
            mkdirSync(dir, { recursive: true });
            if (prunedFor !== day) {
                prunedFor = day;
                for (const name of expiredManifests(readdirSync(dir), time, keepDays)) rmSync(join(dir, name), { force: true });
            }
            appendFileSync(join(dir, manifestFileName(day)), `${JSON.stringify(manifest)}\n`);
            if (failing) options.log?.('提示词指纹清单：又能写了');
            failing = false;
        } catch (error) {
            if (!failing) options.log?.(`提示词指纹清单：没写进去（${error instanceof Error ? error.message : String(error)}），不影响回复`);
            failing = true;
        }
    };
}
