// 可编辑的角色资料（ADR 0010）：characters/<角色>/source/ 下的 4 个 YAML 文件，转换器只读这里。
// 控制台的「林梦瑶」页面和人都可以改；legacy/ 是旧项目原件，只在迁移时读过一次
// （一次性脚本 src/migrate-legacy.ts，见提交 a80b240；迁移前后生成的 st/ 逐字节相同）。
//
//   persona.yml   人设：各段各字段的文字、给哪些档位、某几档用的改写版本
//   scenes.yml    场景（世界书）：触发词、例句、不要说的话、属于哪个场景档
//   schedule.yml  作息：几点睡、课表、假期、调休、空闲活动，和它们给哪些档位
//   tiers.yml     档位：对方是谁、说话方式、示例对话、禁用词……；顺序就是输出顺序
//
// 档位一律写名字（boyfriend、classmate……），不再用旧 tiers.toml 的一字母代号。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_SCHEMA, dump, load } from 'js-yaml';
import type { CourseKind } from './st-format.ts';

/** 一段文字。人设各段的字段有 tiers（给哪些档位）；variants 是某几档用的改写版本，按顺序取第一条含这一档的 */
export interface TextField {
    text: string;
    tiers?: string[];
    variants?: { tiers: string[]; text: string; note?: string }[];
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
    note?: string;
}

export interface TiersSource {
    /** 不知道她有男朋友的档位，scenario 末尾的那句 */
    discreet: TextField;
    tiers: TierSource[];
}

/** 按档位写不同说法：每个档位恰好出现一次 */
export interface ByTier {
    tiers: string[];
    text: string;
}

export interface ScheduleSource {
    /** 几点睡；睡到 wakeup.lazy */
    sleep: string;
    wakeup: { early: string; lazy: string };
    /** 节次 → "HH:MM-HH:MM" */
    periods: Record<string, string>;
    semester: { start: string; weeks: number };
    holidays: { name: string; start: string; end: string; where?: ByTier[]; partner?: string; partner_back?: string; note?: string }[];
    /** 调休补课：补星期几（1–7，0 = 没定，按没课） */
    makeups: { date: string; as_day: number; note?: string }[];
    courses: { name: string; day: number; slot: string; room: string; kind: CourseKind; weeks: string; practice?: number; practice_room?: string }[];
    /** 空闲时做什么；tiers 没写 = 所有档位都能看到 */
    free: { window: 'morning' | 'afternoon' | 'evening'; text: string; tiers?: string[]; note?: string }[];
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
}

export const SOURCE_FILES = { persona: 'persona.yml', scenes: 'scenes.yml', schedule: 'schedule.yml', tiers: 'tiers.yml' } as const;

const HEADERS: Record<keyof typeof SOURCE_FILES, string> = {
    persona: '# 林梦瑶的人设（ADR 0010）。控制台「林梦瑶」页面和 packages/character-tools 都会改写这个文件，注释不会保留：说明写在 note 里。\n',
    scenes: '# 林梦瑶的场景（世界书，ADR 0010）。控制台「林梦瑶」页面和 packages/character-tools 都会改写这个文件，注释不会保留。\n',
    schedule: '# 林梦瑶的作息（ADR 0007、0010）。控制台「林梦瑶」页面和 packages/character-tools 都会改写这个文件，注释不会保留：说明写在 note 里。\n',
    tiers: '# 林梦瑶的档位（ADR 0003、0010）。顺序就是输出顺序。控制台「林梦瑶」页面和 packages/character-tools 都会改写这个文件，注释不会保留。\n',
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
        writeFileSync(join(dir, file), HEADERS[key] + toYaml(source[key]));
    }
}

export function readSource(dir: string): CharacterSource {
    const read = (key: keyof typeof SOURCE_FILES) => fromYaml(readFileSync(join(dir, SOURCE_FILES[key]), 'utf8'), SOURCE_FILES[key]);
    return checkSource({ persona: read('persona'), scenes: read('scenes'), schedule: read('schedule'), tiers: read('tiers') });
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

    optionalString(value: unknown): string | undefined {
        return value === undefined || value === null ? undefined : this.string(value);
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

    array(value: unknown): unknown[] {
        if (!Array.isArray(value)) this.fail('应为数组');
        return value as unknown[];
    }

    keys(obj: Json, allowed: string[]): void {
        const unknown = Object.keys(obj).filter(key => !allowed.includes(key));
        if (unknown.length) this.fail(`有不认识的键：${unknown.join('、')}`);
    }
}

function textField(c: Checker, value: unknown, { gated }: { gated: boolean }): TextField {
    const o = c.object(value);
    c.keys(o, ['text', 'tiers', 'variants', 'note']);
    const field: TextField = { text: c.at('text').string(o.text) };
    if (gated) field.tiers = c.at('tiers').strings(o.tiers);
    else if (o.tiers !== undefined) c.at('tiers').fail('这个字段不按档位过滤，不要写 tiers');
    if (o.variants !== undefined) {
        field.variants = c.at('variants').array(o.variants).map((raw, i) => {
            const v = c.at(`variants[${i}]`);
            const variant = v.object(raw);
            v.keys(variant, ['tiers', 'text', 'note']);
            const note = v.at('note').optionalString(variant.note);
            return { tiers: v.at('tiers').strings(variant.tiers, { allowEmpty: false }), text: v.at('text').string(variant.text), ...(note ? { note } : {}) };
        });
    }
    const note = c.at('note').optionalString(o.note);
    if (note) field.note = note;
    return field;
}

function fieldMap(c: Checker, value: unknown, gated: boolean): Record<string, TextField> {
    const o = c.object(value);
    return Object.fromEntries(Object.entries(o).map(([key, field]) => [key, textField(c.at(key), field, { gated })]));
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
    if (!DATE.test(text)) c.fail(`应为 YYYY-MM-DD：${text}`);
    return text;
}

function withNote<T extends object>(c: Checker, value: unknown, base: T): T & { note?: string } {
    const note = c.optionalString(value);
    return note ? { ...base, note } : base;
}

export function checkSource(raw: { persona: unknown; scenes: unknown; schedule: unknown; tiers: unknown }): CharacterSource {
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
        c.keys(o, ['name', 'user_is', 'knows_him', 'social', 'social_text', 'discreet', 'scenes', 'drop_scenes', 'demeanor', 'examples', 'banned', 'note']);
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
        if (o.drop_scenes !== undefined) tier.drop_scenes = c.at('drop_scenes').strings(o.drop_scenes);
        const demeanor = c.at('demeanor').optionalString(o.demeanor);
        if (demeanor) tier.demeanor = demeanor;
        if ((examples as string[][]).length) tier.examples = (examples as string[][]).map(e => e.map(x => x.trim()));
        const note = c.at('note').optionalString(o.note);
        if (note) tier.note = note;
        // 字段顺序固定，写回 YAML 时稳定
        return orderKeys(tier, ['name', 'user_is', 'knows_him', 'social', 'social_text', 'discreet', 'scenes', 'drop_scenes', 'demeanor', 'examples', 'banned', 'note']);
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
        wakeup: { early: time(h.at('wakeup.early'), wakeup.early), lazy: time(h.at('wakeup.lazy'), wakeup.lazy) },
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
            c.keys(o, ['name', 'start', 'end', 'where', 'partner', 'partner_back', 'note']);
            const holiday: ScheduleSource['holidays'][number] = { name: c.at('name').string(o.name), start: date(c.at('start'), o.start), end: date(c.at('end'), o.end) };
            if (o.where !== undefined) holiday.where = byTier(c.at('where'), o.where);
            const partnerText = c.at('partner').optionalString(o.partner);
            if (partnerText) holiday.partner = partnerText;
            const back = c.at('partner_back').optionalString(o.partner_back);
            if (back) holiday.partner_back = back;
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
            c.keys(o, ['name', 'day', 'slot', 'room', 'kind', 'weeks', 'practice', 'practice_room']);
            const kind = c.at('kind').string(o.kind) as CourseKind;
            if (!KINDS.includes(kind)) c.at('kind').fail(`${kind} 不是课型（${KINDS.join(' / ')}）`);
            const slot = c.at('slot').string(o.slot);
            if (!(slot in periods)) c.at('slot').fail(`${slot} 不在 periods 里`);
            const course: ScheduleSource['courses'][number] = {
                name: c.at('name').string(o.name), day: c.at('day').integer(o.day, 1, 7), slot,
                room: c.at('room').string(o.room), kind, weeks: c.at('weeks').string(o.weeks),
            };
            if (o.practice !== undefined) {
                course.practice = c.at('practice').integer(o.practice, 1, 60);
                course.practice_room = c.at('practice_room').string(o.practice_room);
            }
            return course;
        }),
        free: h.at('free').array(schedule.free).map((value, i) => {
            const c = h.at(`free[${i}]`);
            const o = c.object(value);
            c.keys(o, ['window', 'text', 'tiers', 'note']);
            const window = c.at('window').string(o.window) as ScheduleSource['free'][number]['window'];
            if (!['morning', 'afternoon', 'evening'].includes(window)) c.at('window').fail(`${window} 不是 morning / afternoon / evening`);
            const item: ScheduleSource['free'][number] = { window, text: c.at('text').string(o.text) };
            if (o.tiers !== undefined) item.tiers = c.at('tiers').strings(o.tiers, { allowEmpty: false });
            return withNote(c.at('note'), o.note, item);
        }),
        course_detail: withNote(h.at('course_detail.note'), courseDetail.note, { tiers: h.at('course_detail.tiers').strings(courseDetail.tiers) }),
        kinds: Object.fromEntries(KINDS.map(kind => {
            const c = h.at(`kinds.${kind}`);
            const o = c.object(kinds[kind]);
            c.keys(o, ['label', 'see_after', 'max_bubbles']);
            const see = o.see_after;
            if (see !== undefined && !(Array.isArray(see) && see.length === 2 && see.every(n => typeof n === 'number' && n >= 0) && see[0] <= see[1])) {
                c.at('see_after').fail('应为 [最少分钟, 最多分钟]');
            }
            return [kind, {
                label: c.at('label').string(o.label),
                ...(see ? { see_after: see as [number, number] } : {}),
                ...(o.max_bubbles !== undefined ? { max_bubbles: c.at('max_bubbles').integer(o.max_bubbles, 1, 100) } : {}),
            }];
        })) as ScheduleSource['kinds'],
        ...(kindsNote ? { kinds_note: kindsNote } : {}),
        where: withNote(h.at('where.note'), where.note, { by_tier: byTier(h.at('where.by_tier'), where.by_tier) }),
        ...(partner ? {
            partner: withNote(h.at('partner.note'), partner.note, { text: h.at('partner.text').string(partner.text), tiers: h.at('partner.tiers').strings(partner.tiers) }),
        } : {}),
    };

    return {
        persona: {
            name: p.at('name').string(persona.name),
            identity: p.at('identity').string(persona.identity),
            personality: p.at('personality').string(persona.personality),
            reply_style: p.at('reply_style').string(persona.reply_style),
            redlines: { keywords: p.at('redlines.keywords').strings(redlines.keywords), note: p.at('redlines.note').string(redlines.note) },
            traits: fieldMap(p.at('traits'), persona.traits, true),
            sections: Object.fromEntries(SECTION_KEYS.map(key => [key, fieldMap(p.at(`sections.${key}`), sections[key], true)])) as PersonaSource['sections'],
            social: fieldMap(p.at('social'), persona.social, false),
        },
        scenes,
        schedule: checkedSchedule,
        tiers: { discreet: textField(t.at('discreet'), tiersRaw.discreet, { gated: false }), tiers },
    };
}

function orderKeys<T extends object>(obj: T, order: string[]): T {
    return Object.fromEntries(order.filter(key => key in obj).map(key => [key, (obj as Json)[key]])) as T;
}
