// SillyTavern 角色卡 V2 与世界书的数据格式（本工具输出用）。
// 以 vendor/SillyTavern 源码为准：
//   角色卡：src/endpoints/characters.js（charaFormatData、readFromV2）
//   世界书条目：public/scripts/world-info.js（newWorldInfoEntryDefinition、createWorldInfoEntry）

export interface CharacterCardV2 {
    spec: 'chara_card_v2';
    spec_version: '2.0';
    data: {
        name: string;
        description: string;
        personality: string;
        scenario: string;
        first_mes: string;
        mes_example: string;
        creator_notes: string;
        system_prompt: string;
        post_history_instructions: string;
        alternate_greetings: string[];
        tags: string[];
        creator: string;
        character_version: string;
        // world：关联的世界书名（= 世界书文件名去掉 .json），ST 选中角色时按名字加载
        // regex_scripts：Scoped 正则（导入时 ST 会问是否允许）；qqbot：只给运行时用的字段，不进提示词（ADR 0002 决策 3）
        extensions: { world?: string; regex_scripts?: RegexScript[]; qqbot?: { banned: string[] } };
    };
}

/** 正则脚本，字段同 public/scripts/extensions/regex/index.js 保存脚本时写出的那些 */
export interface RegexScript {
    id: string;
    scriptName: string;
    findRegex: string;
    replaceString: string;
    trimStrings: string[];
    /** engine.js regex_placement：1 用户输入，2 AI 输出，5 世界书，6 推理 */
    placement: number[];
    disabled: boolean;
    markdownOnly: boolean;
    promptOnly: boolean;
    runOnEdit: boolean;
    /** engine.js substitute_find_regex：0 不替换宏 */
    substituteRegex: number;
    minDepth: number | null;
    maxDepth: number | null;
}

/** world-info.js 的 world_info_position */
export const WORLD_INFO_POSITION = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
} as const;

/** world-info.js 的 world_info_logic */
export const WORLD_INFO_LOGIC = {
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
} as const;

// 与 newWorldInfoEntryTemplate 字段、默认值一致（characterFilter* 在 ST 里也不进模板）
const ENTRY_TEMPLATE = {
    key: [] as string[],
    keysecondary: [] as string[],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: WORLD_INFO_LOGIC.AND_ANY as number,
    addMemo: false,
    order: 100,
    position: WORLD_INFO_POSITION.before as number,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null as number | null,
    caseSensitive: null as boolean | null,
    matchWholeWords: null as boolean | null,
    useGroupScoring: null as boolean | null,
    automationId: '',
    role: 0,
    sticky: null as number | null,
    cooldown: null as number | null,
    delay: null as number | null,
    triggers: [] as string[],
};

export type WorldInfoEntry = typeof ENTRY_TEMPLATE & { uid: number; displayIndex: number };

export interface WorldInfoBook {
    entries: Record<string, WorldInfoEntry>;
}

/** 等同于在 ST 里新建一条条目（createWorldInfoEntry）再改字段。 */
export function newWorldInfoEntry(uid: number, fields: Partial<typeof ENTRY_TEMPLATE>): WorldInfoEntry {
    return { uid, ...structuredClone(ENTRY_TEMPLATE), ...fields, displayIndex: uid };
}
