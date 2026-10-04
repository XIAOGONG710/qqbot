// 读取 SillyTavern 角色卡 JSON（V2，V3 的 data 字段与 V2 兼容）。
// 字段含义对照 vendor/SillyTavern/src/endpoints/characters.js readFromV2
// 与 public/script.js getCharacterCardFieldsLazy。

import { readFileSync } from 'node:fs';
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
    };
}

export function loadCharacterCard(path: string): Character {
    return parseCharacterCard(JSON.parse(readFileSync(path, 'utf8')), path);
}
