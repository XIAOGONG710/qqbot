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
        // regex_scripts：Scoped 正则（导入时 ST 会问是否允许）
        // qqbot：只给运行时用的字段，ST 不读（ADR 0002 决策 3）。banned 不进提示词；schedule 由运行时算成一行状态放进时间块（ADR 0007）；
        // dates、proactive：重要的日子和主动找人的设置（ADR 0011）；moods、books：她自己的日子（ADR 0015）；
        // pace：回复节奏系数（ADR 0013）；biography：她的过去（ADR 0022），有线索才放进提示词。可选字段没有资料时不写
        extensions: {
            world?: string;
            regex_scripts?: RegexScript[];
            qqbot?: {
                banned: string[];
                schedule?: CardSchedule;
                dates?: CardDate[];
                pace?: number;
                proactive?: CardProactive;
                moods?: CardMood[];
                books?: CardBook[];
                /** 她的世界（ADR 0021） */
                world?: CardWorld;
                biography?: CardBiography;
            };
        };
    };
}

/**
 * 她的世界（ADR 0021）：转换器按档位裁剪（这一档看不到的整块不写），字段名换成驼峰；
 * 推进规则在 packages/bot/src/world.ts，同一天对所有人一样
 */
export interface CardWorld {
    startDay: string;
    awayHolidays: string[];
    weather?: { rainChance: number; temps: Record<string, [number, number]> };
    cat?: { name: string; feed: [string, string]; seenChance: number; food: { bagDays: number; left: number; reorderAt: number } };
    /** afterMealFrom：从这天起取快递撞上饭点就吃完再去（ADR 0042） */
    parcels?: { perWeek: number; arriveDays: [number, number]; keepDays: number; items: string[]; afterMealFrom?: string };
    cameraFund?: { goal: number; saved: number; weekly: number; depositDay: number };
    homework?: { kinds: string[]; chance: number; earlyChance: number };
    familyCall?: { weekday: number; time: string };
    /** 她世界里的人（NPC）：name 已按档位换成这一档的叫法 */
    people: {
        id: string; name: string; relation: string;
        /** 她们自己的日子（ADR 0033） */
        life?: { sick?: { perMonth: number; days: [number, number] }; busy?: { perMonth: number; days: [number, number]; labels: string[] }; home?: { weekendChance: number; holidays: boolean } };
    }[];
    events: {
        id: string; text: string; person?: string; window: 'morning' | 'afternoon' | 'evening'; chance: number; when: 'school' | 'class_day' | 'any'; weekday?: number;
        skipWhen?: ('sick' | 'busy' | 'home')[]; onlyWhen?: ('sick' | 'busy' | 'home')[];
        /** 花了钱（ADR 0035） */
        cost?: { amount: [number, number]; what: string };
    }[];
    /** 她的身体（ADR 0025）：period.detail 是这一档说得出口生理期 */
    body?: { period?: { first: string; cycle: [number, number]; days: number; crampsChance: number; detail: boolean }; cold?: { perMonth: number; days: number } };
    /** 她的日常（ADR 0031）：午饭、晚饭、洗澡 */
    routine?: { lunch: { from: string; spread: number; minutes: number }; dinner: { from: string; spread: number; minutes: number }; takeoutChance: number; shower: { from: string; spread: number; minutes: [number, number]; chance: number } };
    /** 她一天的打算会改（ADR 0034） */
    plans?: { outings: { text: string; indoors: string }[]; study: string[]; rest: string };
    /** 她的钱（ADR 0035）：detail 是这一档说得出口余额、花了多少 */
    money?: {
        allowance: number; payday: number; start: number; askHome: number;
        prices: { canteen: [number, number]; takeout: [number, number]; misc: [number, number]; catFood: number; parcels: Record<string, number> };
        sideJobs?: { perMonth: number; pay: [number, number]; kinds: string[] };
        saving: { keepPerDay: number; step: number; max: number };
        detail: boolean;
    };
}

/** 她的过去（ADR 0022）：这一档看得到的年表（「何时：何事」一行一件）和素材块；keys 不进提示词 */
export interface CardBiography {
    timeline: string[];
    chunks: { id: string; title: string; keys: string[]; gap?: 'refuse' | 'vague' | 'unsaid'; text: string }[];
}

/** 每日心情：转换器已经按档位裁剪、把 TextField 变成最终写法 */
export interface CardMood {
    name: string;
    weight: number;
    style: string;
    when: { day: 'early' | 'busy' | 'no_class' | 'holiday'; factor: number; reason: string }[];
}

export interface CardBook {
    id: string;
    title: string;
    aliases: string[];
    author: string;
    kind: string;
    platform: string;
    status: string;
    activity?: { window: 'morning' | 'afternoon' | 'evening'; text: string };
    total?: { amount: number; unit: string };
    progress: {
        startDay: string;
        start: number;
        everyDays: number;
        amount: number;
        unit: string;
        max?: number;
        state: 'reading' | 'put_down';
    };
    attitude: string;
    unreadKeywords: string[];
    nodes: { id: string; topic: string; from: number; keywords: string[]; points: string[] }[];
}

/** 这一档知道的一个重要的日子（ADR 0011 决策 6）：date 公历、lunar 农历，MM-DD；midnight：当天零点主动发 */
export interface CardDate {
    name: string;
    date?: string;
    lunar?: string;
    midnight?: boolean;
}

/** 这一档的主动设置（ADR 0011 决策 1）：哪几种时机、每天最多几条、连着几条没回就停 */
export interface CardProactive {
    occasions: string[];
    dailyMax: number;
    unansweredMax: number;
}

/** 课型：硬课、机房课、水课、体育（timetable.toml 的 tier） */
export type CourseKind = 'hard' | 'machine' | 'water' | 'pe';

/** 一个档位的作息（ADR 0007 决策 1）。时间 HH:MM、日期 YYYY-MM-DD，都是本地时间；没写的字段是这一档不该知道的 */
export interface CardSchedule {
    /** 几点睡 */
    sleep: string;
    /** 有课在 earlySlot 那一节的日子 early 起，否则 lazy */
    wake: { early: string; lazy: string; earlySlot: string };
    periods: Record<string, { start: string; end: string }>;
    /** start 是第 1 周的周一 */
    semester: { start: string; weeks: number };
    /** 含首尾两天；where：放假时她在哪，partner：他在哪，partnerBack：放完假 PARTNER_BACK_DAYS 天内他在哪（{{user}} 由运行时换成称呼） */
    holidays: { name: string; start: string; end: string; where?: string; partner?: string; partnerBack?: string }[];
    /** 调休补课：asDay 补星期几的课（1–7），0 = 没课 */
    makeups: { date: string; asDay: number }[];
    /** label：课型的叫法；seeAfterMin：上这种课时过多少分钟才看到消息；maxBubbles：最多回几条 */
    kinds: Record<CourseKind, { label?: string; seeAfterMin?: [number, number]; maxBubbles?: number }>;
    /** day 1–7 是周一到周日；weeks 如 "1-2,4-16,18"；practice：从第几周起转机房实训（按机房课算） */
    courses: { day: number; slot: string; weeks: string; kind: CourseKind; name?: string; room?: string; practice?: { fromWeek: number; room?: string } }[];
    /** 没课时在干什么：上午（起床到 afternoonFrom）、下午（到 eveningFrom）、晚上（到睡觉）各几条，同一天同一时段固定一条 */
    free: { morning: string[]; afternoon: string[]; evening: string[]; afternoonFrom: string; eveningFrom: string };
    /** 上学期间她在哪 */
    where: string;
    /** 上学期间他在哪（只有知道他的档位） */
    partner?: string;
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
