// 「此刻的她」导出（SELF.json，ADR 0347 第 2 层，方案 docs/plans/2026-11-22-same-her-layer2-self.md 二、2，配置 selfExport，默认关）。
// QQ 是唯一算她此刻的地方：联系人流水线的快照（platform/contact.ts 的 snapshot）用拼 QQ 提示词的同一批模块给出段落，这里只做四件事——
// 1. 拼成 SelfExport（格式在 self-types.ts，DSH 插件按同一格式读）：lines 是和 QQ「此刻」块逐字相同的那几行，pending 是攒着想跟他说的；
// 2. validUntil：状态行下一次会变的时刻（睡到几点、几点下课、几点上课）和 at + 10 分钟取早的，过了桌面就不能再当「现在」；
// 3. 校验（写之前把关，格式不对就不写，宁可让桌面按过期降级）；
// 4. 原子写；内容没变、上一份不到 5 分钟、它的 validUntil 也还没到时不重写（同 FEELINGS.json 的做法）。
// 不读文件以外的状态、不调模型；日志由调用方记，只记行数和件数，不记内容。

import { join } from 'node:path';
import type { Piece } from '../interpreter/slots.ts';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { activityWithChat } from './now-export.ts';
import { herDay, type Schedule, type State } from './schedule.ts';
import { SELF_FILE, SELF_KIND, SELF_VERSION, type SelfExport, type SelfLine, type SelfPending, type SelfPendingKind } from './self-types.ts';

/** 定时多久写一次 */
export const SELF_REFRESH_MS = 5 * 60_000;
/** 一份最多管多久（状态行没有更早的变化时） */
export const SELF_VALID_MS = 10 * 60_000;
/** 内容没变时，隔这么久也重写一次时间戳 */
export const SELF_REWRITE_MS = 5 * 60_000;
/** 攒着的最多放几件 */
export const SELF_PENDING_MAX = 4;

export const selfExportPath = (soulDir: string): string => join(soulDir, SELF_FILE);

/**
 * 状态行下一次会变的时刻（describeState 用的就是这几个字段）：睡觉到 activity.until、上课到 lesson.end、课间 / 刚起床到 next.start、
 * 空闲时后面还有课到 nextClass.start；和 at + SELF_VALID_MS 取早的。没有状态（没开作息）、或那一刻不在 at 之后，就是 at + SELF_VALID_MS
 */
export function selfValidUntil(state: State | undefined, at: Date): Date {
    const cap = at.getTime() + SELF_VALID_MS;
    const activity = state?.activity;
    const change = !activity ? undefined
        : activity.kind === 'sleep' ? activity.until
        : activity.kind === 'class' ? activity.lesson.end
        : activity.kind === 'between' ? activity.next.start
        : state.nextClass?.start;
    const next = change?.getTime();
    return new Date(next !== undefined && next > at.getTime() && next < cap ? next : cap);
}

const PENDING_KINDS: readonly SelfPendingKind[] = ['inner', 'news', 'followUp'];
const isIso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isLine = (value: unknown): value is SelfLine => typeof value === 'object' && value !== null
    && typeof (value as SelfLine).slot === 'string' && typeof (value as SelfLine).text === 'string' && (value as SelfLine).text.length > 0;
const isPending = (value: unknown): value is SelfPending => {
    if (typeof value !== 'object' || value === null) return false;
    const item = value as SelfPending;
    return typeof item.id === 'string' && item.id.length > 0 && PENDING_KINDS.includes(item.kind)
        && (item.goes === undefined || item.goes === 'tell' || item.goes === 'ask')
        && typeof item.text === 'string' && item.text.length > 0 && isIso(item.since);
};

/** 格式对不对（插件那边按同样的条件读；这里写之前把关） */
export function isSelfExport(value: unknown): value is SelfExport {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const self = value as SelfExport;
    return self.kind === SELF_KIND && self.version === SELF_VERSION
        && isIso(self.generatedAt) && isIso(self.at) && isIso(self.validUntil) && Date.parse(self.validUntil) > Date.parse(self.at)
        && typeof self.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(self.day) && typeof self.asleep === 'boolean'
        && Array.isArray(self.lines) && self.lines.every(isLine)
        && Array.isArray(self.pending) && self.pending.length <= SELF_PENDING_MAX && self.pending.every(isPending)
        && (self.paused === undefined || self.paused === 'crisis')
        && (self.paused !== 'crisis' || self.pending.length === 0);
}

const formatDay = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;

export interface SelfInput {
    /** 渲染用的「此刻」 */
    at: Date;
    /** 快照给的段落（已按 SELF_SLOTS 收好、按 NOW_SLOTS 排好） */
    pieces: readonly Piece[];
    /** 快照算出来的状态行和作息（validUntil、asleep、她的那一天） */
    state?: State;
    schedule?: Schedule;
    /** 他最后一条消息的时刻：刚聊着就不算在睡（同 NOW.md 的 asleep 行，activityWithChat 的窗口） */
    lastChatAt?: number;
    /** 攒着想跟他说的（计划器给；没有就是空的） */
    pending?: readonly SelfPending[];
    /** 危机暂停中（他最近说过想伤害自己的话）：攒着的整块不出 */
    paused?: boolean;
}

/** 拼成一份 SelfExport（generatedAt 就是 at） */
export function renderSelf(input: SelfInput): SelfExport {
    const { at, state, schedule } = input;
    const sleeping = state?.activity.kind === 'sleep';
    const chatting = activityWithChat('', input.lastChatAt, at.getTime()) !== '';
    const pending = input.paused ? [] : (input.pending ?? []).filter(isPending).slice(0, SELF_PENDING_MAX).map(item => ({ ...item }));
    return {
        kind: SELF_KIND,
        version: SELF_VERSION,
        generatedAt: at.toISOString(),
        at: at.toISOString(),
        validUntil: selfValidUntil(state, at).toISOString(),
        day: formatDay(schedule ? herDay(schedule, at) : at),
        asleep: Boolean(sleeping && !chatting),
        lines: input.pieces.map(piece => ({ slot: piece.slot, text: piece.text })),
        pending,
        ...(input.paused ? { paused: 'crisis' as const } : {}),
    };
}

/** 不算时间的那部分：一样就是「内容没变」 */
const content = (self: Partial<SelfExport>) => JSON.stringify({ day: self.day, asleep: self.asleep, lines: self.lines, pending: self.pending, paused: self.paused ?? null });

/**
 * 写 SELF.json：格式不对就抛错（不写半截 / 坏的）；内容没变、上一份不到 SELF_REWRITE_MS、它的 validUntil 还没到时不重写。
 * 原子写，免得桌面读到半截。返回有没有写
 */
export function writeSelfExport(path: string, self: SelfExport): boolean {
    if (!isSelfExport(self)) throw new TypeError('SELF.json 格式不对，不写');
    const now = Date.parse(self.generatedAt);
    const current = readJsonOr<unknown>(path, undefined);
    if (isSelfExport(current)) {
        const written = Date.parse(current.generatedAt);
        if (content(current) === content(self) && written <= now && now - written < SELF_REWRITE_MS && Date.parse(current.validUntil) > now) return false;
    }
    writeJsonAtomic(path, self);
    return true;
}
