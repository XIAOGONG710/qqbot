// SillyTavern 世界书的关键词激活子集。
//
// 行为对照 vendor/SillyTavern/public/scripts/world-info.js（1.19.0）：
//   WorldInfoBuffer.get / matchKeys、checkWorldInfo、getSortedEntries、parseRegexFromString。
// 实现的部分：常驻条目、主关键词（含 /正则/flags）、次关键词四种逻辑、大小写 / 整词匹配、
// 条目级扫描深度、生成类型过滤、概率、预算（ignoreBudget）、按 order 排序，插入位置只支持角色设定前 / 后。
// 没实现的功能（递归扫描、包含组、sticky/cooldown/delay、@@ 装饰器、其他插入位置等）
// 在加载时直接报错，避免与 ST 试聊的效果悄悄不一致。

import { readFileSync } from 'node:fs';

/** world-info.js 的 world_info_position（只支持这两种） */
export const POSITION = { before: 0, after: 1 } as const;

/** world-info.js 的 world_info_logic */
export const LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 } as const;

const MAX_SCAN_DEPTH = 1000;

export interface WorldInfoEntry {
    uid: number;
    world: string;
    comment: string;
    key: string[];
    keysecondary: string[];
    content: string;
    constant: boolean;
    selective: boolean;
    selectiveLogic: number;
    order: number;
    position: number;
    disable: boolean;
    ignoreBudget: boolean;
    probability: number;
    useProbability: boolean;
    scanDepth: number | null;
    caseSensitive: boolean | null;
    matchWholeWords: boolean | null;
    triggers: string[];
}

/** ST 世界书全局设置（world-info.js 顶部的 world_info_* 变量），默认值同 ST */
export interface WorldInfoSettings {
    /** world_info_depth：扫描最近几条消息 */
    depth: number;
    /** world_info_budget：占上下文的百分比 */
    budgetPercent: number;
    /** world_info_budget_cap：0 = 不封顶 */
    budgetCap: number;
    /** world_info_include_names：扫描文本带上“名字: ” */
    includeNames: boolean;
    caseSensitive: boolean;
    matchWholeWords: boolean;
}

export const DEFAULT_WORLD_INFO_SETTINGS: WorldInfoSettings = {
    depth: 2,
    budgetPercent: 25,
    budgetCap: 0,
    includeNames: true,
    caseSensitive: false,
    matchWholeWords: false,
};

// ---------- 加载 ----------

const isSet = (value: unknown) => value !== undefined && value !== null && value !== false && value !== 0 && value !== '';

/** 解析世界书 JSON；条目顺序同 ST（Object.keys(data.entries)） */
export function parseWorldInfo(json: unknown, world: string): WorldInfoEntry[] {
    const data = json as { entries?: Record<string, Record<string, unknown>> };
    if (!data || typeof data.entries !== 'object' || data.entries === null) {
        throw new Error(`世界书 ${world}：缺少 entries`);
    }
    return Object.keys(data.entries).map(id => {
        const raw = data.entries![id]!;
        const where = `世界书 ${world} 条目 ${id}（${String(raw.comment ?? '')}）`;
        const unsupported: string[] = [];
        const position = Number(raw.position ?? POSITION.before);
        if (position !== POSITION.before && position !== POSITION.after) unsupported.push(`插入位置 ${position}`);
        for (const field of ['group', 'sticky', 'cooldown', 'delay', 'delayUntilRecursion', 'matchPersonaDescription',
            'matchCharacterDescription', 'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes']) {
            if (isSet(raw[field])) unsupported.push(field);
        }
        const filter = raw.characterFilter as { names?: unknown[]; tags?: unknown[] } | undefined;
        if (filter && ((filter.names?.length ?? 0) > 0 || (filter.tags?.length ?? 0) > 0)) unsupported.push('characterFilter');
        const content = String(raw.content ?? '');
        if (content.startsWith('@@')) unsupported.push('@@ 装饰器');
        if (unsupported.length) throw new Error(`${where} 用到了运行时未实现的功能：${unsupported.join('、')}`);

        const strings = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
        const nullable = <T>(value: unknown, type: 'number' | 'boolean') => (typeof value === type ? (value as T) : null);
        return {
            uid: Number(raw.uid ?? id),
            world,
            comment: String(raw.comment ?? ''),
            key: strings(raw.key),
            keysecondary: strings(raw.keysecondary),
            content,
            constant: raw.constant === true,
            selective: raw.selective !== false,
            selectiveLogic: Number(raw.selectiveLogic ?? LOGIC.AND_ANY),
            order: Number(raw.order ?? 100),
            position,
            disable: raw.disable === true,
            ignoreBudget: raw.ignoreBudget === true,
            probability: Number(raw.probability ?? 100),
            useProbability: raw.useProbability !== false,
            scanDepth: nullable<number>(raw.scanDepth, 'number'),
            caseSensitive: nullable<boolean>(raw.caseSensitive, 'boolean'),
            matchWholeWords: nullable<boolean>(raw.matchWholeWords, 'boolean'),
            triggers: strings(raw.triggers),
        };
    });
}

export function loadWorldInfo(path: string, world: string): WorldInfoEntry[] {
    return parseWorldInfo(JSON.parse(readFileSync(path, 'utf8')), world);
}

// ---------- 匹配 ----------

/** 同 world-info.js parseRegexFromString：形如 /pattern/flags 的关键词按正则匹配 */
export function parseRegexFromString(input: string): RegExp | null {
    const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;
    let [, pattern = '', flags] = match;
    if (pattern.match(/(^|[^\\])\//)) return null;
    pattern = pattern.replace('\\/', '/');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matchKeys(haystack: string, needle: string, entry: WorldInfoEntry, settings: WorldInfoSettings): boolean {
    const keyRegex = parseRegexFromString(needle);
    if (keyRegex) return keyRegex.test(haystack);

    const caseSensitive = entry.caseSensitive ?? settings.caseSensitive;
    const transform = (s: string) => (caseSensitive ? s : s.toLowerCase());
    haystack = transform(haystack);
    const key = transform(needle);

    if (entry.matchWholeWords ?? settings.matchWholeWords) {
        if (key.split(/\s+/).length > 1) return haystack.includes(key);
        return new RegExp(`(?:^|\\W)(${escapeRegex(key)})(?:$|\\W)`).test(haystack);
    }
    return haystack.includes(key);
}

/** 同 WorldInfoBuffer.get（无递归、无注入时） */
function scanText(chat: string[], entry: WorldInfoEntry, settings: WorldInfoSettings): string {
    let depth = entry.scanDepth ?? settings.depth;
    if (depth <= 0) return '';
    if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH;
    const MATCHER = '\x01';
    return MATCHER + chat.slice(0, depth).map(m => m.trim()).join('\n' + MATCHER);
}

// ---------- 激活 ----------

export interface ScanInput {
    entries: WorldInfoEntry[];
    /** 聊天记录，最新的在前；每条已按 includeNames 拼好（“名字: 内容”） */
    chat: string[];
    /** 上下文 token 上限，用来算预算 */
    maxContext: number;
    settings: WorldInfoSettings;
    /** 宏替换（关键词和内容都要替换） */
    substitute: (text: string) => string;
    countTokens: (text: string) => number;
    random?: () => number;
}

export interface ScanResult {
    before: string;
    after: string;
    /** 被激活的条目（内容已做宏替换），按激活顺序 */
    activated: WorldInfoEntry[];
}

const byOrderDesc = (a: WorldInfoEntry, b: WorldInfoEntry) => b.order - a.order;

export function checkWorldInfo(input: ScanInput): ScanResult {
    const { chat, settings, substitute, countTokens } = input;
    const random = input.random ?? Math.random;
    // getSortedEntries：按 order 从大到小（稳定排序）
    const sorted = [...input.entries].sort(byOrderDesc);

    let budget = Math.round(settings.budgetPercent * input.maxContext / 100) || 1;
    if (settings.budgetCap > 0 && budget > settings.budgetCap) budget = settings.budgetCap;

    const candidates: WorldInfoEntry[] = [];
    for (const entry of sorted) {
        if (entry.disable) continue;
        // 生成类型过滤：机器人只有普通生成
        if (entry.triggers.length > 0 && !entry.triggers.includes('normal')) continue;
        if (entry.constant) {
            candidates.push(entry);
            continue;
        }
        if (entry.key.length === 0) continue;

        const text = scanText(chat, entry, settings);
        const primary = entry.key.find(key => {
            const substituted = substitute(key);
            return substituted && matchKeys(text, substituted.trim(), entry, settings);
        });
        if (primary === undefined) continue;

        if (!(entry.selective && entry.keysecondary.length)) {
            candidates.push(entry);
            continue;
        }
        if (matchSecondary(entry, text, input)) candidates.push(entry);
    }

    // 概率与预算（同 checkWorldInfo 的 PROBABILITY CHECKS 段；无递归时 textToScanTokens 为 0）
    const activated: WorldInfoEntry[] = [];
    let overflowed = false;
    let newContent = '';
    let ignoresBudget = candidates.filter(e => e.ignoreBudget).length;
    for (const entry of candidates) {
        ignoresBudget -= entry.ignoreBudget ? 1 : 0;
        if (overflowed && !entry.ignoreBudget) {
            if (ignoresBudget > 0) continue;
            break;
        }
        if (entry.useProbability && entry.probability !== 100 && !(random() * 100 <= entry.probability)) continue;

        const content = substitute(entry.content);
        newContent += `${content}\n`;
        if (!entry.ignoreBudget && countTokens(newContent) >= budget) {
            overflowed = true;
            continue;
        }
        activated.push({ ...entry, content });
    }

    // BUILDING PROMPT：order 从大到小排好后逐个 unshift，结果是 order 小的在前
    const before: string[] = [];
    const after: string[] = [];
    for (const entry of [...activated].sort(byOrderDesc)) {
        if (!entry.content) continue;
        (entry.position === POSITION.before ? before : after).unshift(entry.content);
    }
    return { before: before.join('\n'), after: after.join('\n'), activated };
}

function matchSecondary(entry: WorldInfoEntry, text: string, input: ScanInput): boolean {
    let hasAnyMatch = false;
    let hasAllMatch = true;
    for (const key of entry.keysecondary) {
        const substituted = input.substitute(key);
        const matched = Boolean(substituted) && matchKeys(text, substituted.trim(), entry, input.settings);
        if (matched) hasAnyMatch = true;
        else hasAllMatch = false;
        if (entry.selectiveLogic === LOGIC.AND_ANY && matched) return true;
        if (entry.selectiveLogic === LOGIC.NOT_ALL && !matched) return true;
    }
    if (entry.selectiveLogic === LOGIC.NOT_ANY && !hasAnyMatch) return true;
    if (entry.selectiveLogic === LOGIC.AND_ALL && hasAllMatch) return true;
    return false;
}
