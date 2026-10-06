// 读取 SillyTavern 角色卡 JSON（V2，V3 的 data 字段与 V2 兼容）。
// 字段含义对照 vendor/SillyTavern/src/endpoints/characters.js readFromV2
// 与 public/script.js getCharacterCardFieldsLazy。

import { readFileSync } from 'node:fs';
import { parseDates, parseProactive, type ImportantDay, type ProactiveSettings } from '../proactive.ts';
import { PACE_RANGE } from '../reply-timing.ts';
import { parseSchedule, type Schedule } from '../schedule.ts';
import { parseBooks, parseMoods, type DailyMood, type ReadingBook } from '../her-days.ts';
import { parseWorld, type World } from '../world.ts';
import { parseRegexScripts, type RegexScript } from './regex.ts';

export interface Character {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    mesExample: string;
    /** 角色卡的主提示词覆盖（ST 的 prefer_character_prompt 默认开启） */
    systemPrompt: string;
    /** 角色卡的 post-history 指令覆盖（ST 的 prefer_character_jailbreak 默认开启） */
    postHistoryInstructions: string;
    /** 关联的世界书名，对应同目录下的 <world>.json */
    world: string;
    /** 角色卡上的 Scoped 正则脚本（extensions.regex_scripts），清理回复时执行作用于 AI 输出的那些 */
    regexScripts: RegexScript[];
    /** 这一档的禁用词（extensions.qqbot.banned，转换器从 source/tiers.yml 写入，不进提示词），出口检查用（ADR 0006） */
    banned: string[];
    /** 这一档的作息（extensions.qqbot.schedule，转换器写入，ADR 0007）；没有就不按作息 */
    schedule?: Schedule;
    /** 这一档知道的重要的日子（extensions.qqbot.dates，ADR 0011 决策 6）；没有就是空数组 */
    dates: ImportantDay[];
    /** 会不会主动找这一档的人（extensions.qqbot.proactive，ADR 0011 决策 1）；没有就不主动 */
    proactive?: ProactiveSettings;
    /** 这一档的回复节奏系数（extensions.qqbot.pace，ADR 0013 决策 1）；没有就是 1 */
    pace: number;
    /** 每日心情与在读的书（extensions.qqbot，ADR 0015）；旧卡没有就是空数组 */
    moods: DailyMood[];
    books: ReadingBook[];
    /** 她的世界（extensions.qqbot.world，ADR 0021）；旧卡没有。world 已经是世界书的名字 */
    herWorld?: World;
}

export function parseCharacterCard(json: unknown, source = '角色卡'): Character {
    const card = json as { spec?: unknown; data?: Record<string, unknown> };
    if (card.spec !== 'chara_card_v2' && card.spec !== 'chara_card_v3') {
        throw new Error(`${source}：不是角色卡 V2/V3（spec = ${String(card.spec)}）`);
    }
    const data = card.data ?? {};
    const str = (key: string): string => {
        const value = data[key] ?? '';
        if (typeof value !== 'string') throw new Error(`${source}：data.${key} 应为字符串`);
        return value.trim();
    };
    const extensions = (data.extensions ?? {}) as Record<string, unknown>;
    const name = str('name');
    if (!name) throw new Error(`${source}：缺少 data.name`);
    return {
        name,
        description: str('description'),
        personality: str('personality'),
        scenario: str('scenario'),
        mesExample: str('mes_example'),
        systemPrompt: str('system_prompt'),
        postHistoryInstructions: str('post_history_instructions'),
        world: typeof extensions.world === 'string' ? extensions.world : '',
        regexScripts: parseRegexScripts(extensions.regex_scripts, source),
        banned: parseBanned(extensions.qqbot, source),
        ...readSchedule(extensions.qqbot, source),
        dates: parseDates((extensions.qqbot as { dates?: unknown } | undefined)?.dates, source),
        ...readProactive(extensions.qqbot, source),
        pace: parsePace(extensions.qqbot, source),
        moods: parseMoods((extensions.qqbot as { moods?: unknown } | undefined)?.moods, source),
        books: parseBooks((extensions.qqbot as { books?: unknown } | undefined)?.books, source),
        ...readWorld(extensions.qqbot, source),
    };
}

function parsePace(qqbot: unknown, source: string): number {
    const pace = (qqbot as { pace?: unknown } | undefined)?.pace;
    if (pace === undefined) return 1;
    const [min, max] = PACE_RANGE;
    if (typeof pace !== 'number' || !(pace >= min && pace <= max)) throw new Error(`${source}：extensions.qqbot.pace 应为 ${min}–${max} 的数`);
    return pace;
}

function readProactive(qqbot: unknown, source: string): { proactive?: ProactiveSettings } {
    const proactive = (qqbot as { proactive?: unknown } | undefined)?.proactive;
    return proactive === undefined ? {} : { proactive: parseProactive(proactive, source) };
}

function parseBanned(qqbot: unknown, source: string): string[] {
    const banned = (qqbot as { banned?: unknown } | undefined)?.banned;
    if (banned === undefined) return [];
    if (!Array.isArray(banned) || !banned.every(w => typeof w === 'string' && w)) throw new Error(`${source}：extensions.qqbot.banned 应为字符串数组（每个词非空）`);
    return banned;
}

function readSchedule(qqbot: unknown, source: string): { schedule?: Schedule } {
    const schedule = (qqbot as { schedule?: unknown } | undefined)?.schedule;
    return schedule === undefined ? {} : { schedule: parseSchedule(schedule, source) };
}

export function loadCharacterCard(path: string): Character {
    return parseCharacterCard(JSON.parse(readFileSync(path, 'utf8')), path);
}

function readWorld(qqbot: unknown, source: string): { herWorld?: World } {
    const herWorld = parseWorld((qqbot as { world?: unknown } | undefined)?.world, source);
    return herWorld ? { herWorld } : {};
}
