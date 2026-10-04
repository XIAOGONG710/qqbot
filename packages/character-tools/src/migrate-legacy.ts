// 一次性迁移（ADR 0010）：legacy/ + tiers.toml → source/ 下的 4 个 YAML。
// 用法：node packages/character-tools/src/migrate-legacy.ts
//
// - 15 条改写按 tiers.toml 的规则套用一遍，存成各档的最终文字（variants），why 变成 note；
// - tiers.toml 里写在条目前面的注释变成那一项的 note，文件开头、[visible]、档位键说明这些总说明搬进 characters/linmengyao/README.md；
// - 转换器没用到的 legacy 内容不迁移（书、兴趣、关注、每日心情、him、旧引擎参数、作息分段的权重、课的老师 / 简称 / 备注……）。
// 迁移后转换器只读 source/；生成的 st/ 必须和迁移前逐字节相同。

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { getString, getTable, readScenes, readToml, type Table } from './legacy.ts';
import { applyRewrite, parseTierConfig } from './persona-to-card.ts';
import { checkSource, readSource, SECTION_KEYS, writeSource, type ByTier, type CharacterSource, type ScheduleSource, type TextField } from './source.ts';
import type { CourseKind } from './st-format.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const characterDir = join(repoRoot, 'characters/linmengyao');
const legacyDir = join(characterDir, 'legacy');
const sourceDir = join(characterDir, 'source');

const tiersPath = join(characterDir, 'tiers.toml');
const tiersToml = readToml(tiersPath);
const config = parseTierConfig(tiersToml);
const tierNames = config.tiers.map(t => t.name);
const ordered = (set: Set<string>) => tierNames.filter(name => set.has(name));
const comments = commentsBeforeKeys(readFileSync(tiersPath, 'utf8'));
const usedComments = new Set<string>();
const comment = (key: string): string | undefined => {
    const text = comments.get(key);
    if (text !== undefined) usedComments.add(key);
    return text;
};
const joinNotes = (...notes: (string | undefined)[]) => notes.filter(Boolean).join('\n') || undefined;

// ---------- 人设 ----------
const personaToml = readToml(join(legacyDir, 'persona.toml'));
const persona = getTable(personaToml, 'persona', 'persona.toml');
const rawRewrites = tiersToml.rewrite as Table[];
/** 改写前面的注释只有一段：「下面五条」（第 4–8 条），五条都挂上 */
const blockBeforeRewrite = (index: number): string | undefined => {
    for (let i = index; i >= 0 && i > index - 5; i--) {
        const text = comments.get(`[[rewrite]]#${i}|`);
        if (text?.includes('下面五条')) {
            usedComments.add(`[[rewrite]]#${i}|`);
            return text;
        }
    }
    return undefined;
};
const usedRewrites = new Set<number>();

function field(path: string, gated: boolean): TextField {
    const [section = '', key = ''] = path.split('.');
    const original = getString(getTable(persona, section, 'persona'), key, `persona.${section}`);
    const variants = config.rewrites.flatMap((rewrite, i) => {
        if (rewrite.field !== path) return [];
        usedRewrites.add(i);
        const why = typeof rawRewrites[i]!.why === 'string' ? (rawRewrites[i]!.why as string).trim() : undefined;
        const note = joinNotes(blockBeforeRewrite(i), why);
        return [{ tiers: ordered(rewrite.tiers), text: applyRewrite(rewrite, original), ...(note ? { note } : {}) }];
    });
    return {
        text: original,
        ...(gated ? { tiers: ordered(config.visible.get(path)!) } : {}),
        ...(variants.length ? { variants } : {}),
    };
}

const fields = (section: string) => Object.fromEntries(Object.keys(getTable(persona, section, 'persona')).map(key => [key, field(`${section}.${key}`, true)]));
const redlines = getTable(persona, 'redlines', 'persona');
const socialKeys = Object.keys(getTable(persona, 'social', 'persona')).filter(key => ['boyfriend', 'roommate', 'classmate', 'stranger'].includes(key));
const social: Record<string, TextField> = {
    ...Object.fromEntries(socialKeys.map(key => [key, field(`social.${key}`, false)])),
    girl_friend: field('social_extra.girl_friend', false),
};

// ---------- 场景 ----------
const scenes = readScenes(join(legacyDir, 'speech_library.toml')).map(scene => ({
    id: scene.id, kind: scene.kind, tiers: scene.tier, trigger: scene.trigger, examples: scene.examples, avoid: scene.avoid,
    ...(scene.source ? { source: scene.source } : {}),
}));

// ---------- 作息 ----------
const scheduleToml = readToml(join(legacyDir, 'schedule.toml'));
const timetable = readToml(join(legacyDir, 'timetable.toml'));
const segments = (scheduleToml.schedule as Table).segments as Table[];
const sleeping = segments.filter(seg => seg.active === false);
if (sleeping.length !== 1) throw new Error('schedule.toml 应恰好有一段 active = false');
const [sleep = '', sleepEnd = ''] = getString(sleeping[0]!, 'hours', 'schedule.segments').split('-');
const wakeup = getTable(timetable, 'wakeup', 'timetable.toml');
if (sleepEnd.trim() !== getString(wakeup, 'lazy', 'timetable.wakeup')) throw new Error('睡到几点和平时几点起对不上');
const list = (key: string) => timetable[key] as Table[];
const s = config.schedule;

/** 档位名 → 说法 的表，按说法分组（档位按 tiers 的顺序） */
function group(map: Map<string, string>): ByTier[] {
    const groups: ByTier[] = [];
    for (const name of tierNames) {
        const text = map.get(name)!;
        const found = groups.find(g => g.text === text);
        if (found) found.tiers.push(name);
        else groups.push({ tiers: [name], text });
    }
    return groups;
}

const freeOnlyNote = comment('[schedule.free_only]|');
const holidayNotes = (name: string) => joinNotes(comment(`[schedule.holiday."${name}"]|`), comment(`[schedule.holiday."${name}"]|partner_back`));
const makeupNote = comment('[schedule.makeup]|');
const schedule: ScheduleSource = {
    sleep: sleep.trim(),
    wakeup: { early: getString(wakeup, 'early', 'timetable.wakeup'), lazy: getString(wakeup, 'lazy', 'timetable.wakeup') },
    periods: Object.fromEntries(Object.entries(getTable(timetable, 'periods', 'timetable.toml')).map(([slot, range]) => [slot, String(range).trim()])),
    semester: { start: getString(getTable(timetable, 'semester', 'timetable'), 'start', 'semester'), weeks: (timetable.semester as Table).weeks as number },
    holidays: list('holiday').map(h => {
        const name = getString(h, 'name', 'holiday');
        const extra = s.holidays.get(name);
        const note = extra ? holidayNotes(name) : undefined;
        return {
            name, start: getString(h, 'start', 'holiday'), end: getString(h, 'end', 'holiday'),
            ...(extra ? { where: group(extra.where) } : {}),
            ...(extra?.partner ? { partner: extra.partner } : {}),
            ...(extra?.partnerBack ? { partner_back: extra.partnerBack } : {}),
            ...(note ? { note } : {}),
        };
    }),
    makeups: list('makeup').map(m => {
        const day = getString(m, 'date', 'makeup');
        return { date: day, as_day: s.makeup.get(day) ?? (m.as_day as number), ...(makeupNote ? { note: makeupNote } : {}) };
    }),
    courses: list('course').map(c => ({
        name: getString(c, 'name', 'course'), day: c.day as number, slot: getString(c, 'slot', 'course'), room: getString(c, 'room', 'course'),
        kind: getString(c, 'tier', 'course') as CourseKind, weeks: getString(c, 'weeks', 'course'),
        ...(c.practice !== undefined ? { practice: c.practice as number, practice_room: getString(c, 'practice_room', 'course') } : {}),
    })),
    free: list('free').map(f => {
        const text = getString(f, 'text', 'free');
        const only = s.freeOnly.get(text);
        return {
            window: getString(f, 'window', 'free') as ScheduleSource['free'][number]['window'], text,
            ...(only ? { tiers: ordered(only) } : {}),
            ...(only && freeOnlyNote ? { note: freeOnlyNote } : {}),
        };
    }),
    course_detail: { tiers: ordered(s.courseDetail), ...noteOf(comment('[schedule]|course_detail')) },
    kinds: Object.fromEntries(Object.entries(s.kinds).map(([kind, k]) => [kind, {
        label: k.label, ...(k.seeAfterMin ? { see_after: k.seeAfterMin } : {}), ...(k.maxBubbles ? { max_bubbles: k.maxBubbles } : {}),
    }])) as ScheduleSource['kinds'],
    ...noteOf(comment('[schedule.kinds.hard]|'), 'kinds_note'),
    where: { by_tier: group(s.where), ...noteOf(comment('[schedule]|where')) },
    ...(s.partner ? { partner: { text: s.partner, tiers: ordered(s.partnerTiers), ...noteOf(comment('[schedule]|partner')) } } : {}),
};

// ---------- 档位 ----------
const tiers = config.tiers.map(tier => ({
    name: tier.name,
    user_is: tier.userIs,
    ...(tier.knowsHim ? { knows_him: true } : {}),
    ...(tier.social ? { social: tier.social.replace(/^social(_extra)?\./, '') } : {}),
    ...(tier.socialText ? { social_text: tier.socialText } : {}),
    ...(tier.discreet ? { discreet: true } : {}),
    scenes: tier.scenes,
    ...(tier.dropScenes.length ? { drop_scenes: tier.dropScenes } : {}),
    ...(tier.demeanor ? { demeanor: tier.demeanor } : {}),
    ...(tier.examples.length ? { examples: tier.examples.map(e => e.map(x => x.trim())) } : {}),
    banned: tier.banned,
    ...noteOf(comment(`[tier.${tier.name}]|examples`) ?? comment(`[tier.${tier.name}]|demeanor`)),
}));

const source: CharacterSource = {
    persona: {
        name: getString(persona, 'name', 'persona'),
        identity: getString(persona, 'identity', 'persona'),
        personality: getString(persona, 'personality', 'persona'),
        reply_style: getString(persona, 'reply_style', 'persona'),
        redlines: { keywords: (redlines.keywords as string[]).map(x => x.trim()), note: getString(redlines, 'note', 'redlines') },
        traits: fields('traits'),
        sections: Object.fromEntries(SECTION_KEYS.map(key => [key, fields(key)])) as CharacterSource['persona']['sections'],
        social,
    },
    scenes,
    schedule,
    tiers: { discreet: { text: config.discreet, ...noteOf(comment('|discreet')) }, tiers },
};

for (let i = 0; i < config.rewrites.length; i++) {
    if (!usedRewrites.has(i)) throw new Error(`第 ${i + 1} 条改写（${config.rewrites[i]!.field}）没有迁移`);
}

// 没挂到任何一项上的注释：总说明，搬进 README（这里只列出来）
const general = [...comments.keys()].filter(key => !usedComments.has(key));

mkdirSync(sourceDir, { recursive: true });
if (existsSync(join(sourceDir, 'persona.yml')) && !process.argv.includes('--force')) {
    throw new Error(`${sourceDir} 已经有资料了：迁移只做一次（重做加 --force）`);
}
const checked = checkSource(source as never);
writeSource(sourceDir, checked);
if (!isDeepStrictEqual(readSource(sourceDir), checked)) throw new Error('写出的 YAML 读回来和迁移结果不一样');
console.log(`写入 ${sourceDir}：人设 ${Object.keys(source.persona.traits).length + SECTION_KEYS.reduce((n, k) => n + Object.keys(source.persona.sections[k]).length, 0)} 个字段、` +
    `改写 ${config.rewrites.length} 条、场景 ${scenes.length} 个、课 ${schedule.courses.length} 门、档位 ${tiers.length} 个`);
console.log(`没挂到条目上的注释（总说明，搬进 README）：${general.join('、') || '无'}`);

function noteOf(note: string | undefined, key = 'note'): Record<string, string> {
    return note ? { [key]: note } : {};
}

/**
 * tiers.toml 里写在键或表头前面的注释：「表头|键」→ 注释文字（表头前面的用「表头|」）。
 * [[rewrite]] 这种重复的表头加 #序号；「---------- 标题 ----------」这种分隔行不算。
 */
function commentsBeforeKeys(text: string): Map<string, string> {
    const result = new Map<string, string>();
    let header = '';
    const counts = new Map<string, number>();
    let pending: string[] = [];
    let inArray = false;
    let inString = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (inArray) {
            if (/^\]/.test(line)) inArray = false;
            continue;
        }
        if (inString) {
            if (line.includes('"""')) inString = false;
            continue;
        }
        if (line.startsWith('#')) {
            const body = line.replace(/^#\s?/, '');
            // 分隔行开始新的一块：前面的是总说明，不挂到后面的键上
            if (/^-{3,}.*-{3,}$/.test(body)) pending = [];
            else pending.push(body);
            continue;
        }
        if (!line) continue;
        const headerMatch = /^\[\[?([^\]]+)\]\]?$/.exec(line);
        if (headerMatch) {
            const isArray = line.startsWith('[[');
            const name = line;
            let key = name;
            if (isArray) {
                const n = counts.get(name) ?? 0;
                counts.set(name, n + 1);
                key = `${name}#${n}`;
            }
            header = key;
            if (pending.length) result.set(`${header}|`, pending.join('\n'));
            pending = [];
            continue;
        }
        const keyMatch = /^("[^"]+"|[A-Za-z_][\w-]*)\s*=/.exec(line);
        if (keyMatch) {
            if (pending.length) result.set(`${header}|${keyMatch[1]}`, pending.join('\n'));
            pending = [];
            // 多行数组、多行字符串：跳到结尾
            if (/=\s*\[\s*$/.test(line)) inArray = true;
            if ((line.split('"""').length - 1) % 2 === 1) inString = true;
        }
    }
    return result;
}
