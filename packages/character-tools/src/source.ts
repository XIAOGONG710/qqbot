// 可编辑的角色资料（ADR 0010、0015）：characters/<角色>/source/ 下的 YAML 文件，转换器只读这里。
// 控制台的「林梦瑶」页面和人都可以改；legacy/ 是旧项目原件，只在迁移时读过一次
// （一次性脚本 src/migrate-legacy.ts，见提交 a80b240；迁移前后生成的 st/ 逐字节相同）。
//
//   persona.yml   人设：各段各字段的文字、给哪些档位、某几档用的改写版本
//   scenes.yml    场景（世界书）：触发词、例句、不要说的话、属于哪个场景档
//   schedule.yml  作息：几点睡、课表、假期、调休、空闲活动，和它们给哪些档位
//   tiers.yml     档位：对方是谁、说话方式、示例对话、禁用词……；顺序就是输出顺序
//   moods.yml     每日心情：权重、按当天课表调权重的条件、各档怎么说
//   books.yml     在读的书 + 已读书库：前者算进度，后者只在说到书名时进世界书
//   world.yml     她的世界（ADR 0021）：天气、楼下的猫、快递、作业、相机基金、和家里视频、学校里的小事（world-source.ts）
//
// 档位一律写名字（boyfriend、classmate……），不再用旧 tiers.toml 的一字母代号。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_SCHEMA, dump, load } from 'js-yaml';
import { checkBiography, type BiographySource } from './biography-to-card.ts';
import type { CourseKind } from './st-format.ts';
import { checkWorld, type WorldSource } from './world-source.ts';

/** 一段文字。人设各段的字段有 tiers（给哪些档位）；variants 是某几档用的改写版本，按顺序取第一条含这一档的 */
export interface TextField {
    text: string;
    tiers?: string[];
    variants?: { tiers: string[]; text: string; note?: string }[];
    /** 只有「重要的日子」一段有：运行时用的日期（ADR 0011 决策 6），档位跟着这句文字 */
    day?: DaySource;
    /**
     * 只有性格（traits）和各段（sections，日子那段除外）里能写：他说到这些词时才想起——不进卡的性格，进这一档的世界书（DSH 诊断 2.4：王者荣耀一大段每轮都在提示词里，
     * 同学档那一轮聊的是空洞骑士和追剧）
     */
    keys?: string[];
    note?: string;
}

/**
 * 重要的日子：name 是时间块里的说法（「他的生日」）；date 公历、lunar 农历，都是 MM-DD，至少写一个。
 * 两个都写时公历那天主动提、农历那天只在时间块里提一句；midnight：当天零点就主动发（否则并进当天的早安）
 */
export interface DaySource {
    name: string;
    date?: string;
    lunar?: string;
    midnight?: boolean;
}

/** 主动找人的时机（ADR 0011 决策 2）：早安、下课、睡前、冷场、待跟进的事、重要的日子；下雨（ADR 0050，只认真实天气）；她那边的事（0057、0064）；改约（ADR 0066，约好之后她这边出了事） */
export const OCCASIONS = ['morning', 'after_class', 'bedtime', 'quiet', 'share', 'follow_up', 'dates', 'weather', 'news', 'reschedule'] as const;
export type Occasion = (typeof OCCASIONS)[number];

/** 「她那边的事」的事件类（ADR 0064），和 bot 的 proactive.ts 的 NEWS_KINDS 一致（两个包各存一份） */
export const NEWS_KINDS = ['camera', 'homework_done', 'unwell', 'friend_changed', 'friend_sick'] as const;
export type NewsKind = (typeof NEWS_KINDS)[number];

/** 档位的回复节奏系数能写多少（ADR 0013 决策 1） */
export const PACE_MIN = 0.5;
export const PACE_MAX = 3;

/** 档位上的主动设置：没写的档位不主动 */
export interface ProactiveSource {
    occasions: Occasion[];
    /** 每天最多几条 */
    daily_max: number;
    /** 她主动发的连着几条没回就停，等他回 */
    unanswered_max: number;
    /** 「她那边的事」开哪几类（ADR 0064）：没写 = 只有相机 */
    news_kinds?: NewsKind[];
    note?: string;
}

/** description 的各段，顺序即输出顺序；标题写在代码里（persona-to-card.ts） */
export const SECTION_KEYS = ['relation', 'family', 'dorm', 'study', 'friends', 'money', 'heart', 'speech', 'taboo',
    'identity_note', 'daily_extra', 'dates', 'growth'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export interface PersonaSource {
    name: string;
    identity: string;
    personality: string;
    reply_style: string;
    redlines: { keywords: string[]; note: string };
    /** 性格：进 personality，按档位过滤 */
    traits: Record<string, TextField>;
    /** 进 description 的各段：段 → 字段 → 文字 */
    sections: Record<SectionKey, Record<string, TextField>>;
    /** 对各档的说话方式，档位用 social 指向这里的键 */
    social: Record<string, TextField>;
}

export interface SceneSource {
    id: string;
    kind: string;
    /** 场景档：档位用 scenes 指向它（例如女生熟人借用闺蜜的场景） */
    tiers: string[];
    trigger: string[];
    examples: string[];
    avoid: string[];
    /** 出处（「线上原话」等），不进卡 */
    source?: string;
}

export interface TierSource {
    name: string;
    /** scenario 第一句：正在聊天的 {{user}} 是谁 */
    user_is: string;
    /** description 开头说明「他」是男朋友 */
    knows_him?: boolean;
    /** 说话方式取人设 social 的哪个键；和 social_text 二选一 */
    social?: string;
    social_text?: string;
    /** scenario 末尾加上 tiers.yml 的 discreet */
    discreet?: boolean;
    /** 世界书用哪个场景档的场景，去掉哪些场景 id */
    scenes: string;
    drop_scenes?: string[];
    /** 放进 post_history_instructions 的分寸 */
    demeanor?: string;
    /** 示例对话：[对方, 她的第一行, 她的后续几行…] */
    examples?: string[][];
    /** 这一档的卡里不能出现的词（也是出口检查的词表） */
    banned: string[];
    /** 回复节奏系数（ADR 0013 决策 1）：冷场时多久看到、打字多久都乘它，越疏越慢；没写是 1 */
    pace?: number;
    /** 会不会主动找这一档的人、怎么找（ADR 0011）；名单外（unlisted）不能有 */
    proactive?: ProactiveSource;
    note?: string;
}

export interface TiersSource {
    /** 不知道她有男朋友的档位，scenario 末尾的那句 */
    discreet: TextField;
    tiers: TierSource[];
}

/** 每日心情会参考的当天情况（ADR 0015 决策 1） */
export const MOOD_DAYS = ['early', 'busy', 'no_class', 'holiday'] as const;
export type MoodDay = (typeof MOOD_DAYS)[number];

export interface MoodSource {
    name: string;
    weight: number;
    /** 心情只写「怎么说」；tiers 决定哪些档位能看到，variants 给某些档位换说法 */
    style: TextField;
    /** 当天命中这些情况时调权重；reason 就是时间块里给她的真实原因 */
    when: { day: MoodDay; factor: number; reason: string }[];
    note?: string;
}

export interface MoodsSource {
    moods: MoodSource[];
    note?: string;
}

export type BookState = 'reading' | 'put_down';

export interface BookProgressSource {
    start_day: string;
    start: number;
    /** 每 every_days 天前进 amount；put_down 的书不再前进 */
    every_days: number;
    amount: number;
    unit: string;
    /** 到这里停；读到全书总量时运行时会写「读完了」 */
    max?: number;
    state?: BookState;
}

export interface BookNodeSource {
    id: string;
    topic: string;
    /** 用这本书自己的进度单位 */
    from: number;
    keywords: string[];
    points: string[];
    sources: string[];
    /** 没写就是跟着整本书的档位；写了就进一步裁剪 */
    tiers?: string[];
    note?: string;
}

export interface BookSource {
    id: string;
    title: string;
    aliases: string[];
    author: string;
    kind: string;
    platform: string;
    status: string;
    /** herDays 开着时并入作息的空闲活动；放在新文件里，旧 schedule.yml 不加键 */
    activity?: { window: 'morning' | 'afternoon' | 'evening'; text: string };
    tiers: string[];
    /** 有可靠来源的总量；《药屋》没有可靠总卷数，所以不写 */
    total?: { amount: number; unit: string; source: string };
    progress: BookProgressSource;
    attitude: string;
    /** 命中这些词时只说还没看到，不提供情节 */
    unread_keywords: string[];
    nodes: BookNodeSource[];
    note?: string;
}

/** 已经读完的书：不算进度，只有书名或别名命中时才作为世界书资料进入提示词。 */
export interface ReadBookSource {
    id: string;
    title: string;
    aliases: string[];
    author: string;
    kind: string;
    platform: string;
    status: string;
    tiers: string[];
    attitude: string;
    /** 她确实记得、可以聊的要点。 */
    points: string[];
    /** 明确没看过或没有资料的边界。 */
    avoid: string[];
    /** 审核来源，不进提示词。 */
    sources: string[];
    note?: string;
}

export interface BooksSource {
    books: BookSource[];
    read_books?: ReadBookSource[];
    note?: string;
}

/** 按档位写不同说法：每个档位恰好出现一次 */
export interface ByTier {
    tiers: string[];
    text: string;
}

export interface ScheduleSource {
    /** 几点睡；睡到 wakeup.lazy */
    sleep: string;
    /** jitter（ADR 0078）：从 from 那天起起床的时刻每天浮动（±spread_minutes，周末没课再晚 weekend_minutes）；不写 = 每天精确在 early / lazy */
    wakeup: { early: string; lazy: string; jitter?: { from: string; spread_minutes: number; weekend_minutes: number; note?: string } };
    /** 节次 → "HH:MM-HH:MM" */
    periods: Record<string, string>;
    semester: { start: string; weeks: number };
    /** home：这段假期她在家过（空闲活动用 home 的那一份，睡觉说在家睡；世界层是否算在家看 world.yml 的 away_holidays） */
    holidays: { name: string; start: string; end: string; where?: ByTier[]; partner?: string; partner_back?: string; home?: boolean; note?: string }[];
    /** 调休补课：补星期几（1–7，0 = 没定，按没课） */
    makeups: { date: string; as_day: number; note?: string }[];
    courses: { name: string; day: number; slot: string; room: string; kind: CourseKind; weeks: string; practice?: number; practice_room?: string;
        /** 一次分配后持久保存的匿名同课程身份；不得从课程名哈希或每次按数组位置重编号。 */
        course_group?: string }[];
    /** 空闲时做什么；tiers 没写 = 所有档位都能看到 */
    /** cover：看不到这条的档位换成这句（ADR 0034：各档的列表一样长，同一时刻挑到同一格，不会男朋友看到「修片」、同学看到「打游戏」） */
    /** from：从这一天起才有（ADR 0053 之后：买了相机才有的活动；那天以前的抽签列表不变，过去的日子不被改写） */
    /** until：到这一天为止（新鲜期，例如新相机头两周天天摆弄） */
    /** home：只在 home 的假期里用的（在家的空闲活动，ADR 0076 调整）；没写的是在学校时的 */
    free: { window: 'morning' | 'afternoon' | 'evening'; text: string; tiers?: string[]; cover?: string; from?: string; until?: string; home?: boolean; note?: string }[];
    /** 课名、教室、课型叫法给哪些档位 */
    course_detail: { tiers: string[]; note?: string };
    /** 课型：上课时过多少分钟才看到消息、最多回几条 */
    kinds: Record<CourseKind, { label: string; see_after?: [number, number]; max_bubbles?: number }>;
    kinds_note?: string;
    /** 上学期间她在哪 */
    where: { by_tier: ByTier[]; note?: string };
    /** 上学期间他在哪，给哪些档位 */
    partner?: { text: string; tiers: string[]; note?: string };
}

export interface CharacterSource {
    persona: PersonaSource;
    scenes: SceneSource[];
    schedule: ScheduleSource;
    tiers: TiersSource;
    /** 新文件不存在时当作旧资料：不生成相应的卡片扩展 */
    moods?: MoodsSource;
    books?: BooksSource;
    world?: WorldSource;
    /** 她的过去（ADR 0022） */
    biography?: BiographySource;
}

export const SOURCE_FILES = {
    persona: 'persona.yml', scenes: 'scenes.yml', schedule: 'schedule.yml', tiers: 'tiers.yml', moods: 'moods.yml', books: 'books.yml', world: 'world.yml',
    biography: 'biography.yml',
} as const;

const HEADERS: Record<keyof typeof SOURCE_FILES, string> = {
    persona: '# 林梦瑶的人设（ADR 0010）。控制台「林梦瑶」页面和 packages/character-tools 都会改写这个文件，注释不会保留：说明写在 note 里。\n',
    scenes: '# 林梦瑶的场景（世界书，ADR 0010）。控制台「林梦瑶」页面和 packages/character-tools 都会改写这个文件，注释不会保留。\n',
    schedule: '# 林梦瑶的作息（ADR 0007、0010）。控制台「林梦瑶」页面和 packages/character-tools 都会改写这个文件，注释不会保留：说明写在 note 里。\n',
    tiers: '# 林梦瑶的档位（ADR 0003、0010）。顺序就是输出顺序。控制台「林梦瑶」页面和 packages/character-tools 都会改写这个文件，注释不会保留。\n',
    moods: '# 林梦瑶的每日心情（ADR 0015）。控制台「林梦瑶」页面和 packages/character-tools 都会改写这个文件，注释不会保留：说明写在 note 里。\n',
    books: '# 林梦瑶的书籍资料（ADR 0015）。控制台「林梦瑶」页面和 packages/character-tools 都会改写这个文件，注释不会保留：来源和取用规则写在字段或 note 里。\n',
    world: '# 林梦瑶的世界（ADR 0021）：会自己变的东西和推进规则。packages/character-tools 会改写这个文件，注释不会保留：说明写在 note 里。\n',
    biography: '# 林梦瑶的过去（ADR 0022），素材出自 characters/linmengyao/biography/autobiography-v1.md（作者定稿）。packages/character-tools 会改写这个文件，注释不会保留：说明写在 note 里。\n',
};

/** YAML 只用核心 schema：日期、时间都按字符串读写（不变成 Date） */
export function toYaml(value: unknown): string {
    return dump(value, { schema: CORE_SCHEMA, lineWidth: -1, noRefs: true, quotingType: '"' });
}

export function fromYaml(text: string, filename: string): unknown {
    return load(text, { schema: CORE_SCHEMA, filename });
}

export function writeSource(dir: string, source: CharacterSource): void {
    for (const [key, file] of Object.entries(SOURCE_FILES) as [keyof typeof SOURCE_FILES, string][]) {
        const value = source[key];
        if (value !== undefined) writeFileSync(join(dir, file), HEADERS[key] + toYaml(value));
    }
}

export function readSource(dir: string): CharacterSource {
    const read = (key: keyof typeof SOURCE_FILES) => fromYaml(readFileSync(join(dir, SOURCE_FILES[key]), 'utf8'), SOURCE_FILES[key]);
    const optional = (key: 'moods' | 'books' | 'world' | 'biography') => existsSync(join(dir, SOURCE_FILES[key])) ? read(key) : undefined;
    return checkSource({
        persona: read('persona'), scenes: read('scenes'), schedule: read('schedule'), tiers: read('tiers'),
        moods: optional('moods'), books: optional('books'), world: optional('world'), biography: optional('biography'),
    });
}

// ---------- 校验结构（档位之间的引用、内容的隐私检查在 build.ts） ----------

type Json = Record<string, unknown>;

class Checker {
    private readonly where: string;

    constructor(where: string) {
        this.where = where;
    }

    at(path: string): Checker {
        return new Checker(path.startsWith('[') ? `${this.where}${path}` : `${this.where}.${path}`);
    }

    fail(message: string): never {
        throw new Error(`${this.where} ${message}`);
    }

    object(value: unknown): Json {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail('应为对象');
        return value as Json;
    }

    string(value: unknown): string {
        if (typeof value !== 'string' || !value.trim()) this.fail('应为非空字符串');
        return (value as string).trim();
    }

    /** 没写、null、空白都当作没写（页面上清空一个可选项时会留下空串） */
    optionalString(value: unknown): string | undefined {
        if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined;
        return this.string(value);
    }

    strings(value: unknown, { allowEmpty = true } = {}): string[] {
        if (!Array.isArray(value) || !value.every(x => typeof x === 'string')) this.fail('应为字符串数组');
        const list = (value as string[]).map(x => x.trim());
        if (!allowEmpty && list.length === 0) this.fail('不能是空数组');
        if (list.some(x => !x)) this.fail('里有空字符串');
        return list;
    }

    integer(value: unknown, min: number, max: number): number {
        if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) this.fail(`应为 ${min}–${max} 的整数`);
        return value as number;
    }

    number(value: unknown, min: number, max: number): number {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) this.fail(`应为 ${min}–${max} 的数`);
        return value as number;
    }

    array(value: unknown): unknown[] {
        if (!Array.isArray(value)) this.fail('应为数组');
        return value as unknown[];
    }

    keys(obj: Json, allowed: string[]): void {
        const unknown = Object.keys(obj).filter(key => !allowed.includes(key));
        if (unknown.length) this.fail(`有不认识的键：${unknown.join('、')}`);
    }
}

function textField(c: Checker, value: unknown, { gated, day = false, keyed = false }: { gated: boolean; day?: boolean; keyed?: boolean }): TextField {
    const o = c.object(value);
    c.keys(o, ['text', 'tiers', 'variants', ...(day ? ['day'] : []), ...(keyed ? ['keys'] : []), 'note']);
    const field: TextField = { text: c.at('text').string(o.text) };
    if (keyed && o.keys !== undefined) field.keys = c.at('keys').strings(o.keys, { allowEmpty: false });
    if (gated) field.tiers = c.at('tiers').strings(o.tiers);
    else if (o.tiers !== undefined) c.at('tiers').fail('这个字段不按档位过滤，不要写 tiers');
    if (o.variants !== undefined && o.variants !== null && !(Array.isArray(o.variants) && o.variants.length === 0)) {
        field.variants = c.at('variants').array(o.variants).map((raw, i) => {
            const v = c.at(`variants[${i}]`);
            const variant = v.object(raw);
            v.keys(variant, ['tiers', 'text', 'note']);
            const note = v.at('note').optionalString(variant.note);
            return { tiers: v.at('tiers').strings(variant.tiers, { allowEmpty: false }), text: v.at('text').string(variant.text), ...(note ? { note } : {}) };
        });
    }
    if (day && !blankDay(o.day)) field.day = daySource(c.at('day'), o.day);
    const note = c.at('note').optionalString(o.note);
    if (note) field.note = note;
    return field;
}

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** 页面上把日期的几个框都清空时会留下空对象或空串：当作没写 */
function blankDay(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    const o = value as Json;
    const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
    return Object.keys(o).every(key => ['name', 'date', 'lunar', 'midnight'].includes(key))
        && blank(o.name) && blank(o.date) && blank(o.lunar) && o.midnight !== true;
}

function daySource(c: Checker, value: unknown): DaySource {
    const o = c.object(value);
    c.keys(o, ['name', 'date', 'lunar', 'midnight']);
    const monthDay = (key: 'date' | 'lunar') => {
        const text = c.at(key).optionalString(o[key]);
        if (text !== undefined && !MONTH_DAY.test(text)) c.at(key).fail(`应为 MM-DD：${text}`);
        return text;
    };
    const day: DaySource = { name: c.at('name').string(o.name) };
    const solar = monthDay('date');
    const lunar = monthDay('lunar');
    if (!solar && !lunar) c.fail('公历日期（date）和农历日期（lunar）至少写一个');
    if (lunar && Number(lunar.slice(3)) > 30) c.at('lunar').fail(`农历一个月最多 30 天：${lunar}`);
    if (solar) day.date = solar;
    if (lunar) day.lunar = lunar;
    if (o.midnight !== undefined && o.midnight !== null && typeof o.midnight !== 'boolean') c.at('midnight').fail('应为 true 或 false');
    if (o.midnight === true) day.midnight = true;
    return day;
}

/** 没写，或者页面上一个时机都没勾：不主动（和没写一样） */
function noOccasions(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    const occasions = (value as Json).occasions;
    return occasions === undefined || occasions === null || (Array.isArray(occasions) && occasions.length === 0);
}

function proactiveSource(c: Checker, value: unknown): ProactiveSource {
    const o = c.object(value);
    c.keys(o, ['occasions', 'daily_max', 'unanswered_max', 'news_kinds', 'note']);
    const occasions = c.at('occasions').strings(o.occasions);
    for (const occasion of occasions) {
        if (!OCCASIONS.includes(occasion as Occasion)) c.at('occasions').fail(`${occasion} 不是时机（${OCCASIONS.join(' / ')}）`);
    }
    if (new Set(occasions).size !== occasions.length) c.at('occasions').fail('有重复的时机');
    // 页面上没勾任何类和没写一样（按只有相机）
    const kinds = o.news_kinds === undefined || o.news_kinds === null ? [] : c.at('news_kinds').strings(o.news_kinds);
    for (const kind of kinds) {
        if (!NEWS_KINDS.includes(kind as NewsKind)) c.at('news_kinds').fail(`${kind} 不是她那边的事的类（${NEWS_KINDS.join(' / ')}）`);
    }
    if (new Set(kinds).size !== kinds.length) c.at('news_kinds').fail('有重复的类');
    // 页面上只勾了时机、没填条数时用 ADR 0011 确认的值
    const count = (key: 'daily_max' | 'unanswered_max', fallback: number) =>
        (o[key] === undefined || o[key] === null ? fallback : c.at(key).integer(o[key], 1, 10));
    return withNote(c.at('note'), o.note, {
        occasions: occasions as Occasion[],
        daily_max: count('daily_max', 2),
        unanswered_max: count('unanswered_max', 1),
        ...(kinds.length ? { news_kinds: kinds as NewsKind[] } : {}),
    });
}

function fieldMap(c: Checker, value: unknown, gated: boolean, day = false, keyed = false): Record<string, TextField> {
    const o = c.object(value);
    return Object.fromEntries(Object.entries(o).map(([key, field]) => [key, textField(c.at(key), field, { gated, day, keyed })]));
}

function byTier(c: Checker, value: unknown): ByTier[] {
    return c.array(value).map((raw, i) => {
        const b = c.at(`[${i}]`);
        const o = b.object(raw);
        b.keys(o, ['tiers', 'text']);
        return { tiers: b.at('tiers').strings(o.tiers, { allowEmpty: false }), text: b.at('text').string(o.text) };
    });
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: CourseKind[] = ['hard', 'machine', 'water', 'pe'];

function time(c: Checker, value: unknown): string {
    const text = c.string(value);
    if (!TIME.test(text)) c.fail(`应为 HH:MM：${text}`);
    return text;
}

function date(c: Checker, value: unknown): string {
    const text = c.string(value);
    const at = Date.parse(`${text}T00:00:00Z`);
    if (!DATE.test(text) || !Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== text) c.fail('应为真实 YYYY-MM-DD 日期');
    return text;
}

function withNote<T extends object>(c: Checker, value: unknown, base: T): T & { note?: string } {
    const note = c.optionalString(value);
    return note ? { ...base, note } : base;
}

export function checkSource(raw: { persona: unknown; scenes: unknown; schedule: unknown; tiers: unknown; moods?: unknown; books?: unknown; world?: unknown; biography?: unknown }): CharacterSource {
    // 人设
    const p = new Checker('persona.yml');
    const persona = p.object(raw.persona);
    p.keys(persona, ['name', 'identity', 'personality', 'reply_style', 'redlines', 'traits', 'sections', 'social']);
    const redlines = p.at('redlines').object(persona.redlines);
    p.at('redlines').keys(redlines, ['keywords', 'note']);
    const sections = p.at('sections').object(persona.sections);
    p.at('sections').keys(sections, [...SECTION_KEYS]);
    for (const key of SECTION_KEYS) if (!(key in sections)) p.at('sections').fail(`缺少段 ${key}`);

    // 场景
    const s = new Checker('scenes.yml');
    const scenes = s.array(raw.scenes).map((value, i): SceneSource => {
        const c = s.at(`[${i}]`);
        const o = c.object(value);
        c.keys(o, ['id', 'kind', 'tiers', 'trigger', 'examples', 'avoid', 'source']);
        const source = c.at('source').optionalString(o.source);
        return {
            id: c.at('id').string(o.id),
            kind: c.at('kind').string(o.kind),
            tiers: c.at('tiers').strings(o.tiers, { allowEmpty: false }),
            trigger: c.at('trigger').strings(o.trigger, { allowEmpty: false }),
            examples: c.at('examples').strings(o.examples),
            avoid: c.at('avoid').strings(o.avoid),
            ...(source ? { source } : {}),
        };
    });
    const ids = new Set<string>();
    for (const scene of scenes) {
        if (ids.has(scene.id)) s.fail(`场景 id ${scene.id} 重复`);
        ids.add(scene.id);
    }

    // 档位
    const t = new Checker('tiers.yml');
    const tiersRaw = t.object(raw.tiers);
    t.keys(tiersRaw, ['discreet', 'tiers']);
    const tiers = t.at('tiers').array(tiersRaw.tiers).map((value, i): TierSource => {
        const c = t.at(`tiers[${i}]`);
        const o = c.object(value);
        c.keys(o, ['name', 'user_is', 'knows_him', 'social', 'social_text', 'discreet', 'scenes', 'drop_scenes', 'demeanor', 'examples', 'banned', 'pace', 'proactive', 'note']);
        const examples = o.examples ?? [];
        if (!Array.isArray(examples) || !examples.every(e => Array.isArray(e) && e.length >= 2 && e.every(x => typeof x === 'string' && x.trim()))) {
            c.at('examples').fail('应为 [对方, 她, ...] 的数组');
        }
        const flag = (key: string) => {
            if (o[key] !== undefined && typeof o[key] !== 'boolean') c.at(key).fail('应为 true 或 false');
            return o[key] === true;
        };
        const tier: TierSource = {
            name: c.at('name').string(o.name),
            user_is: c.at('user_is').string(o.user_is),
            scenes: c.at('scenes').string(o.scenes),
            banned: c.at('banned').strings(o.banned),
        };
        if (flag('knows_him')) tier.knows_him = true;
        const social = c.at('social').optionalString(o.social);
        const socialText = c.at('social_text').optionalString(o.social_text);
        if (!social === !socialText) c.fail('要有 social 或 social_text 之一');
        if (social) tier.social = social;
        if (socialText) tier.social_text = socialText;
        if (flag('discreet')) tier.discreet = true;
        if (o.drop_scenes !== undefined && o.drop_scenes !== null) {
            const drop = c.at('drop_scenes').strings(o.drop_scenes);
            if (drop.length) tier.drop_scenes = drop;
        }
        const demeanor = c.at('demeanor').optionalString(o.demeanor);
        if (demeanor) tier.demeanor = demeanor;
        if ((examples as string[][]).length) tier.examples = (examples as string[][]).map(e => e.map(x => x.trim()));
        if (o.pace !== undefined && o.pace !== null) tier.pace = c.at('pace').number(o.pace, PACE_MIN, PACE_MAX);
        if (!noOccasions(o.proactive)) {
            // 名单外的人不知道这是 bot（ADR 0003 决策 2），不主动找
            if (tier.name === 'unlisted') c.at('proactive').fail('名单外的好友不主动找，不要写');
            tier.proactive = proactiveSource(c.at('proactive'), o.proactive);
        }
        const note = c.at('note').optionalString(o.note);
        if (note) tier.note = note;
        // 字段顺序固定，写回 YAML 时稳定
        return orderKeys(tier, ['name', 'user_is', 'knows_him', 'social', 'social_text', 'discreet', 'scenes', 'drop_scenes', 'demeanor', 'examples', 'banned', 'pace', 'proactive', 'note']);
    });
    const names = new Set<string>();
    for (const tier of tiers) {
        if (names.has(tier.name)) t.fail(`档位 ${tier.name} 重复`);
        names.add(tier.name);
    }

    // 作息
    const h = new Checker('schedule.yml');
    const schedule = h.object(raw.schedule);
    h.keys(schedule, ['sleep', 'wakeup', 'periods', 'semester', 'holidays', 'makeups', 'courses', 'free', 'course_detail', 'kinds', 'kinds_note', 'where', 'partner']);
    const wakeup = h.at('wakeup').object(schedule.wakeup);
    const periods = h.at('periods').object(schedule.periods);
    const semester = h.at('semester').object(schedule.semester);
    const kinds = h.at('kinds').object(schedule.kinds);
    h.at('kinds').keys(kinds, KINDS);
    const courseDetail = h.at('course_detail').object(schedule.course_detail);
    const where = h.at('where').object(schedule.where);
    const partner = schedule.partner === undefined ? undefined : h.at('partner').object(schedule.partner);
    const kindsNote = h.at('kinds_note').optionalString(schedule.kinds_note);

    const checkedSchedule: ScheduleSource = {
        sleep: time(h.at('sleep'), schedule.sleep),
        wakeup: {
            early: time(h.at('wakeup.early'), wakeup.early), lazy: time(h.at('wakeup.lazy'), wakeup.lazy),
            ...(wakeup.jitter !== undefined && wakeup.jitter !== null ? (() => {
                const j = h.at('wakeup.jitter');
                const o = j.object(wakeup.jitter);
                j.keys(o, ['from', 'spread_minutes', 'weekend_minutes', 'note']);
                return { jitter: withNote(j.at('note'), o.note, { from: date(j.at('from'), o.from), spread_minutes: j.at('spread_minutes').integer(o.spread_minutes, 0, 120), weekend_minutes: j.at('weekend_minutes').integer(o.weekend_minutes, 0, 240) }) };
            })() : {}),
        },
        periods: Object.fromEntries(Object.entries(periods).map(([slot, range]) => {
            const c = h.at(`periods.${slot}`);
            const [start, end, ...rest] = c.string(range).split('-');
            if (rest.length) c.fail('应为 HH:MM-HH:MM');
            return [slot, `${time(c, start)}-${time(c, end)}`];
        })),
        semester: { start: date(h.at('semester.start'), semester.start), weeks: h.at('semester.weeks').integer(semester.weeks, 1, 60) },
        holidays: h.at('holidays').array(schedule.holidays).map((value, i) => {
            const c = h.at(`holidays[${i}]`);
            const o = c.object(value);
            c.keys(o, ['name', 'start', 'end', 'where', 'partner', 'partner_back', 'home', 'note']);
            const holiday: ScheduleSource['holidays'][number] = { name: c.at('name').string(o.name), start: date(c.at('start'), o.start), end: date(c.at('end'), o.end) };
            if (o.where !== undefined && o.where !== null && !(Array.isArray(o.where) && o.where.length === 0)) holiday.where = byTier(c.at('where'), o.where);
            const partnerText = c.at('partner').optionalString(o.partner);
            if (partnerText) holiday.partner = partnerText;
            const back = c.at('partner_back').optionalString(o.partner_back);
            if (back) holiday.partner_back = back;
            if (o.home === true) holiday.home = true;
            return withNote(c.at('note'), o.note, holiday);
        }),
        makeups: h.at('makeups').array(schedule.makeups).map((value, i) => {
            const c = h.at(`makeups[${i}]`);
            const o = c.object(value);
            c.keys(o, ['date', 'as_day', 'note']);
            return withNote(c.at('note'), o.note, { date: date(c.at('date'), o.date), as_day: c.at('as_day').integer(o.as_day, 0, 7) });
        }),
        courses: h.at('courses').array(schedule.courses).map((value, i) => {
            const c = h.at(`courses[${i}]`);
            const o = c.object(value);
            c.keys(o, ['name', 'day', 'slot', 'room', 'kind', 'weeks', 'practice', 'practice_room', 'course_group']);
            const kind = c.at('kind').string(o.kind) as CourseKind;
            if (!KINDS.includes(kind)) c.at('kind').fail(`${kind} 不是课型（${KINDS.join(' / ')}）`);
            const slot = c.at('slot').string(o.slot);
            if (!(slot in periods)) c.at('slot').fail(`${slot} 不在 periods 里`);
            const course: ScheduleSource['courses'][number] = {
                name: c.at('name').string(o.name), day: c.at('day').integer(o.day, 1, 7), slot,
                room: c.at('room').string(o.room), kind, weeks: c.at('weeks').string(o.weeks),
            };
            if (o.course_group !== undefined) {
                const group = c.at('course_group').string(o.course_group);
                if (!/^cg-[0-9a-f]{32}$/.test(group)) c.at('course_group').fail('应为 cg- 后接 32 个小写十六进制字符的匿名令牌');
                course.course_group = group;
            }
            if (o.practice !== undefined && o.practice !== null) {
                course.practice = c.at('practice').integer(o.practice, 1, 60);
                course.practice_room = c.at('practice_room').string(o.practice_room);
            }
            return course;
        }),
        free: h.at('free').array(schedule.free).map((value, i) => {
            const c = h.at(`free[${i}]`);
            const o = c.object(value);
            c.keys(o, ['window', 'text', 'tiers', 'cover', 'from', 'until', 'home', 'note']);
            const window = c.at('window').string(o.window) as ScheduleSource['free'][number]['window'];
            if (!['morning', 'afternoon', 'evening'].includes(window)) c.at('window').fail(`${window} 不是 morning / afternoon / evening`);
            const item: ScheduleSource['free'][number] = { window, text: c.at('text').string(o.text) };
            // 一个档位都没勾 = 所有档位都能看到（和没写一样）
            if (o.tiers !== undefined && o.tiers !== null) {
                const tiers = c.at('tiers').strings(o.tiers);
                if (tiers.length) item.tiers = tiers;
            }
            if (o.cover !== undefined && o.cover !== null) {
                if (!item.tiers) c.at('cover').fail('只有写了 tiers 的才要 cover');
                item.cover = c.at('cover').string(o.cover);
            }
            if (o.from !== undefined && o.from !== null) item.from = date(c.at('from'), o.from);
            if (o.home === true) {
                if (item.from) c.at('home').fail('在家的活动不写 from');
                item.home = true;
            }
            if (o.until !== undefined && o.until !== null) {
                if (!item.from) c.at('until').fail('写了 until 也要写 from');
                item.until = date(c.at('until'), o.until);
            }
            return withNote(c.at('note'), o.note, item);
        }),
        course_detail: withNote(h.at('course_detail.note'), courseDetail.note, { tiers: h.at('course_detail.tiers').strings(courseDetail.tiers) }),
        kinds: Object.fromEntries(KINDS.map(kind => {
            const c = h.at(`kinds.${kind}`);
            const o = c.object(kinds[kind]);
            c.keys(o, ['label', 'see_after', 'max_bubbles']);
            const see = o.see_after ?? undefined;
            if (see !== undefined && !(Array.isArray(see) && see.length === 2 && see.every(n => typeof n === 'number' && n >= 0) && see[0] <= see[1])) {
                c.at('see_after').fail('应为 [最少分钟, 最多分钟]');
            }
            return [kind, {
                label: c.at('label').string(o.label),
                ...(see ? { see_after: see as [number, number] } : {}),
                ...(o.max_bubbles !== undefined && o.max_bubbles !== null ? { max_bubbles: c.at('max_bubbles').integer(o.max_bubbles, 1, 100) } : {}),
            }];
        })) as ScheduleSource['kinds'],
        ...(kindsNote ? { kinds_note: kindsNote } : {}),
        where: withNote(h.at('where.note'), where.note, { by_tier: byTier(h.at('where.by_tier'), where.by_tier) }),
        ...(partner ? {
            partner: withNote(h.at('partner.note'), partner.note, { text: h.at('partner.text').string(partner.text), tiers: h.at('partner.tiers').strings(partner.tiers) }),
        } : {}),
    };

    const moods = raw.moods === undefined ? undefined : checkMoods(raw.moods);
    const books = raw.books === undefined ? undefined : checkBooks(raw.books);
    const world = raw.world === undefined ? undefined : checkWorld(raw.world);
    // 控制台存别的部分时整份资料也要过这里，她的过去不能丢（ADR 0022）
    const biography = raw.biography === undefined ? undefined : checkBiography(raw.biography);

    return {
        persona: {
            name: p.at('name').string(persona.name),
            identity: p.at('identity').string(persona.identity),
            personality: p.at('personality').string(persona.personality),
            reply_style: p.at('reply_style').string(persona.reply_style),
            redlines: { keywords: p.at('redlines.keywords').strings(redlines.keywords), note: p.at('redlines.note').string(redlines.note) },
            traits: fieldMap(p.at('traits'), persona.traits, true, false, true),
            sections: Object.fromEntries(SECTION_KEYS.map(key => [key, fieldMap(p.at(`sections.${key}`), sections[key], true, key === 'dates', key !== 'dates')])) as PersonaSource['sections'],
            social: fieldMap(p.at('social'), persona.social, false),
        },
        scenes,
        schedule: checkedSchedule,
        tiers: { discreet: textField(t.at('discreet'), tiersRaw.discreet, { gated: false }), tiers },
        ...(moods ? { moods } : {}),
        ...(books ? { books } : {}),
        ...(world ? { world } : {}),
        ...(biography ? { biography } : {}),
    };
}

function checkMoods(raw: unknown): MoodsSource {
    const root = new Checker('moods.yml');
    const o = root.object(raw);
    root.keys(o, ['moods', 'note']);
    const moods = root.at('moods').array(o.moods).map((value, i): MoodSource => {
        const c = root.at(`moods[${i}]`);
        const mood = c.object(value);
        c.keys(mood, ['name', 'weight', 'style', 'when', 'note']);
        const when = c.at('when').array(mood.when).map((condition, j) => {
            const w = c.at(`when[${j}]`);
            const item = w.object(condition);
            w.keys(item, ['day', 'factor', 'reason']);
            const day = w.at('day').string(item.day) as MoodDay;
            if (!MOOD_DAYS.includes(day)) w.at('day').fail(`${day} 不是日子条件（${MOOD_DAYS.join(' / ')}）`);
            return { day, factor: w.at('factor').number(item.factor, 0.01, 100), reason: w.at('reason').string(item.reason) };
        });
        if (new Set(when.map(item => item.day)).size !== when.length) c.at('when').fail('有重复的日子条件');
        return withNote(c.at('note'), mood.note, {
            name: c.at('name').string(mood.name),
            weight: c.at('weight').number(mood.weight, 0.01, 100),
            style: textField(c.at('style'), mood.style, { gated: true }),
            when,
        });
    });
    if (!moods.length) root.at('moods').fail('不能是空数组');
    if (new Set(moods.map(mood => mood.name)).size !== moods.length) root.at('moods').fail('心情名字重复');
    return withNote(root.at('note'), o.note, { moods });
}

function checkBooks(raw: unknown): BooksSource {
    const root = new Checker('books.yml');
    const o = root.object(raw);
    root.keys(o, ['books', 'read_books', 'note']);
    const books = root.at('books').array(o.books).map((value, i): BookSource => {
        const c = root.at(`books[${i}]`);
        const book = c.object(value);
        c.keys(book, ['id', 'title', 'aliases', 'author', 'kind', 'platform', 'status', 'activity', 'tiers', 'total', 'progress', 'attitude', 'unread_keywords', 'nodes', 'note']);
        const progressRaw = c.at('progress').object(book.progress);
        c.at('progress').keys(progressRaw, ['start_day', 'start', 'every_days', 'amount', 'unit', 'max', 'state']);
        const stateText = c.at('progress.state').optionalString(progressRaw.state) as BookState | undefined;
        if (stateText !== undefined && !['reading', 'put_down'].includes(stateText)) c.at('progress.state').fail('应为 reading 或 put_down');
        const progress: BookProgressSource = {
            start_day: date(c.at('progress.start_day'), progressRaw.start_day),
            start: c.at('progress.start').integer(progressRaw.start, 0, 1_000_000),
            every_days: c.at('progress.every_days').integer(progressRaw.every_days, 1, 3650),
            amount: c.at('progress.amount').integer(progressRaw.amount, 0, 1_000_000),
            unit: c.at('progress.unit').string(progressRaw.unit),
        };
        if (progressRaw.max !== undefined && progressRaw.max !== null && progressRaw.max !== '') progress.max = c.at('progress.max').integer(progressRaw.max, 0, 1_000_000);
        if (stateText !== undefined) progress.state = stateText;
        if (progress.max !== undefined && progress.start > progress.max) c.at('progress').fail('start 不能大于 max');

        let total: BookSource['total'];
        if (!blank(book.total)) {
            const totalRaw = c.at('total').object(book.total);
            c.at('total').keys(totalRaw, ['amount', 'unit', 'source']);
            total = {
                amount: c.at('total.amount').integer(totalRaw.amount, 1, 1_000_000),
                unit: c.at('total.unit').string(totalRaw.unit),
                source: c.at('total.source').string(totalRaw.source),
            };
            if (total.unit !== progress.unit) c.at('total.unit').fail('要和 progress.unit 一样');
        }

        const nodes = c.at('nodes').array(book.nodes).map((value, j): BookNodeSource => {
            const n = c.at(`nodes[${j}]`);
            const node = n.object(value);
            n.keys(node, ['id', 'topic', 'from', 'keywords', 'points', 'sources', 'tiers', 'note']);
            // 页面上一个都不勾会留下空数组：和没写一样，跟着整本书
            const tiers = node.tiers === undefined || node.tiers === null || (Array.isArray(node.tiers) && !node.tiers.length)
                ? undefined : n.at('tiers').strings(node.tiers, { allowEmpty: false });
            const base = {
                id: n.at('id').string(node.id), topic: n.at('topic').string(node.topic),
                from: n.at('from').integer(node.from, 0, 1_000_000),
                keywords: n.at('keywords').strings(node.keywords, { allowEmpty: false }),
                points: n.at('points').strings(node.points, { allowEmpty: false }),
                sources: n.at('sources').strings(node.sources, { allowEmpty: false }),
                ...(tiers ? { tiers } : {}),
            };
            return withNote(n.at('note'), node.note, base);
        });
        if (new Set(nodes.map(node => node.id)).size !== nodes.length) c.at('nodes').fail('节点 id 重复');
        let activity: BookSource['activity'];
        if (!blank(book.activity)) {
            const item = c.at('activity').object(book.activity);
            c.at('activity').keys(item, ['window', 'text']);
            const window = c.at('activity.window').string(item.window) as NonNullable<BookSource['activity']>['window'];
            if (!['morning', 'afternoon', 'evening'].includes(window)) c.at('activity.window').fail('应为 morning / afternoon / evening');
            activity = { window, text: c.at('activity.text').string(item.text) };
        }
        const base: BookSource = {
            id: c.at('id').string(book.id), title: c.at('title').string(book.title),
            aliases: c.at('aliases').strings(book.aliases), author: c.at('author').string(book.author),
            kind: c.at('kind').string(book.kind), platform: c.at('platform').string(book.platform), status: c.at('status').string(book.status),
            ...(activity ? { activity } : {}), tiers: c.at('tiers').strings(book.tiers, { allowEmpty: false }), ...(total ? { total } : {}), progress,
            attitude: c.at('attitude').string(book.attitude), unread_keywords: c.at('unread_keywords').strings(book.unread_keywords), nodes,
        };
        return withNote(c.at('note'), book.note, base);
    });
    if (!books.length) root.at('books').fail('不能是空数组');
    if (new Set(books.map(book => book.id)).size !== books.length) root.at('books').fail('书的 id 重复');
    const readBooks = o.read_books === undefined || o.read_books === null ? [] : root.at('read_books').array(o.read_books).map((value, i): ReadBookSource => {
        const c = root.at(`read_books[${i}]`);
        const book = c.object(value);
        c.keys(book, ['id', 'title', 'aliases', 'author', 'kind', 'platform', 'status', 'tiers', 'attitude', 'points', 'avoid', 'sources', 'note']);
        const base: ReadBookSource = {
            id: c.at('id').string(book.id), title: c.at('title').string(book.title), aliases: c.at('aliases').strings(book.aliases),
            author: c.at('author').string(book.author), kind: c.at('kind').string(book.kind), platform: c.at('platform').string(book.platform),
            status: c.at('status').string(book.status), tiers: c.at('tiers').strings(book.tiers, { allowEmpty: false }),
            attitude: c.at('attitude').string(book.attitude), points: c.at('points').strings(book.points, { allowEmpty: false }),
            avoid: c.at('avoid').strings(book.avoid), sources: c.at('sources').strings(book.sources, { allowEmpty: false }),
        };
        return withNote(c.at('note'), book.note, base);
    });
    if (new Set(readBooks.map(book => book.id)).size !== readBooks.length) root.at('read_books').fail('书的 id 重复');
    return withNote(root.at('note'), o.note, { books, ...(readBooks.length ? { read_books: readBooks } : {}) });
}

/** 可选的一组（总量、看书的空闲活动）：没写、null，或者页面上把每一项都清空了，都当作没写 */
function blank(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value).every(item => item === undefined || item === null || (typeof item === 'string' && !item.trim()));
}

function orderKeys<T extends object>(obj: T, order: string[]): T {
    return Object.fromEntries(order.filter(key => key in obj).map(key => [key, (obj as Json)[key]])) as T;
}
