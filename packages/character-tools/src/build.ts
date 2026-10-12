// source/ → st/ 下每个档位的角色卡和场景世界书（ADR 0003、0010）。CLI（cli.ts）和控制台的「林梦瑶」页面共用。
// 生成之前先查资料之间的引用（档位名、说话方式、场景档），写错就报错，不生成。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { biographyTierRefs } from './biography-to-card.ts';
import { OPEN_AS_TIER, personaToCard } from './persona-to-card.ts';
import { withReadBooks } from './read-books-to-lorebook.ts';
import { scenesToLorebook, withKeyedTraits } from './scenes-to-lorebook.ts';
import { checkScheduleTiers, scheduleForTier } from './schedule-to-card.ts';
import { SECTION_KEYS, type CharacterSource, type TextField } from './source.ts';
import { checkPlansAgainstFree, worldTiers } from './world-source.ts';
import type { CharacterCardV2, WorldInfoBook } from './st-format.ts';

export interface BuiltTier {
    /** 档位名；承认版（ADR 0067）是「<档位>-open」 */
    tier: string;
    /** 承认版对应的原档位（禁用词、档位设定都按它查）；原卡没有 */
    base?: string;
    card: CharacterCardV2;
    lorebook: WorldInfoBook;
}

/** 承认版去掉的两个「被问是不是 AI 就否认」的场景（和名单外那一档去掉的一样，ADR 0003 决策 2）；这一档的场景池里没有的就不去 */
export const OPEN_DROP_SCENES = ['probe-are-you-ai', 'probe-prove-real'];

export interface Built {
    tiers: BuiltTier[];
    /** st/ 下的文件名 → 内容（JSON 文本，和 CLI 写出的逐字节相同） */
    files: Map<string, string>;
}

/** 资料之间的引用：档位名都存在、说话方式指向的键都在、作息按档位的说法每档恰好一句 */
export function checkReferences(source: CharacterSource): void {
    const names = source.tiers.tiers.map(t => t.name);
    const known = (tiers: string[], at: string) => {
        for (const name of tiers) if (!names.includes(name)) throw new Error(`${at}：没有档位 ${name}`);
    };
    const checkField = (field: TextField, at: string) => {
        if (field.tiers) known(field.tiers, `${at}.tiers`);
        field.variants?.forEach((v, i) => known(v.tiers, `${at}.variants[${i}].tiers`));
    };
    const { persona } = source;
    for (const [name, field] of Object.entries(persona.traits)) checkField(field, `persona.yml traits.${name}`);
    for (const key of SECTION_KEYS) {
        for (const [name, field] of Object.entries(persona.sections[key])) checkField(field, `persona.yml sections.${key}.${name}`);
    }
    for (const [name, field] of Object.entries(persona.social)) checkField(field, `persona.yml social.${name}`);
    checkField(source.tiers.discreet, 'tiers.yml discreet');
    source.moods?.moods.forEach((mood, i) => checkField(mood.style, `moods.yml moods[${i}].style`));
    source.books?.books.forEach((book, i) => {
        known(book.tiers, `books.yml books[${i}].tiers`);
        book.nodes.forEach((node, j) => {
            if (node.tiers) known(node.tiers, `books.yml books[${i}].nodes[${j}].tiers`);
        });
    });
    source.books?.read_books?.forEach((book, i) => known(book.tiers, `books.yml read_books[${i}].tiers`));
    if (source.world) for (const { at, tiers } of worldTiers(source.world)) known(tiers, `world.yml ${at}.tiers`);
    checkPlansAgainstFree(source.world?.plans, source.schedule.free);
    for (const ref of biographyTierRefs(source.biography)) known(ref.tiers, ref.at);
    for (const tier of source.tiers.tiers) {
        if (tier.social !== undefined && !persona.social[tier.social]) {
            throw new Error(`tiers.yml 档位 ${tier.name} 的 social「${tier.social}」在 persona.yml 的 social 里没有`);
        }
    }
    checkScheduleTiers(source.schedule, names);
}

/** 检查出的一个问题：哪一档、在哪、命中了什么 */
export interface Problem {
    tier: string;
    /** 卡的字段（description……）、「作息」、或「世界书 <场景 id>」 */
    where: string;
    /** 命中的词 */
    word: string;
    /** 命中处前后的一小段 */
    excerpt: string;
}

const PLACEHOLDERS = /<BOYFRIEND_REAL_NAME>|<HIS_NICKNAME_\d+>/g;

/**
 * 档位隐私检查（ADR 0003、0010）：每一档会进提示词的文字里，不能有这一档的禁用词，也不能有脱敏占位符。
 * 查卡里进提示词的字段、作息、世界书正文；世界书的触发词不进提示词，不查。
 */
export function checkPrivacy(built: Built, source: CharacterSource): Problem[] {
    const problems: Problem[] = [];
    const scan = (tier: string, where: string, text: string, words: string[]) => {
        for (const word of words) {
            let index = text.indexOf(word);
            while (index >= 0) {
                problems.push({ tier, where, word, excerpt: text.slice(Math.max(0, index - 12), index + word.length + 12).replace(/\n/g, ' ') });
                index = text.indexOf(word, index + word.length);
            }
        }
        for (const match of text.matchAll(PLACEHOLDERS)) problems.push({ tier, where, word: match[0], excerpt: match[0] });
    };
    for (const { tier, base, card, lorebook } of built.tiers) {
        const banned = source.tiers.tiers.find(t => t.name === (base ?? tier))!.banned;
        const { data } = card;
        for (const key of ['description', 'personality', 'scenario', 'post_history_instructions', 'mes_example', 'system_prompt'] as const) {
            scan(tier, key, data[key], banned);
        }
        const schedule = data.extensions.qqbot?.schedule;
        if (schedule) scan(tier, '作息', JSON.stringify(schedule), banned);
        // 日子的说法会进时间块（ADR 0011 决策 6）
        const dates = data.extensions.qqbot?.dates;
        if (dates) scan(tier, '重要的日子', JSON.stringify(dates), banned);
        const moods = data.extensions.qqbot?.moods;
        if (moods) scan(tier, '心情', JSON.stringify(moods), banned);
        const books = data.extensions.qqbot?.books;
        if (books) scan(tier, '在读的书', JSON.stringify(books), banned);
        const world = data.extensions.qqbot?.world;
        if (world) scan(tier, '她的世界', JSON.stringify(world), banned);
        // 她的过去（ADR 0022）：年表、素材块都会进提示词；触发词不进，不查
        const biography = data.extensions.qqbot?.biography;
        if (biography) {
            scan(tier, '她的过去 年表', biography.timeline.join('\n'), banned);
            for (const chunk of biography.chunks) scan(tier, `她的过去 ${chunk.id}`, `${chunk.title}\n${chunk.text}`, banned);
        }
        for (const entry of Object.values(lorebook.entries)) {
            const id = /（([^（）]+)）$/.exec(entry.comment)?.[1] ?? entry.comment;
            scan(tier, `世界书 ${id}`, entry.content, banned);
        }
    }
    return problems;
}

/** 把生成结果写进 st/：内容没变的不写（插件监听 st/，没变就不该触发重启） */
export function writeOutputs(outDir: string, built: Built): { written: string[]; unchanged: string[] } {
    mkdirSync(outDir, { recursive: true });
    const written: string[] = [];
    const unchanged: string[] = [];
    for (const [file, text] of built.files) {
        const path = join(outDir, file);
        if (existsSync(path) && readFileSync(path, 'utf8') === text) {
            unchanged.push(file);
            continue;
        }
        writeFileSync(path, text);
        written.push(file);
    }
    return { written, unchanged };
}

export function buildCharacter(source: CharacterSource, prefix = 'linmengyao'): Built {
    checkReferences(source);
    const tiers: BuiltTier[] = [];
    const files = new Map<string, string>();
    for (const tier of source.tiers.tiers) {
        const world = `${prefix}-scenes-${tier.name}`;
        const lorebook = withReadBooks(
            withKeyedTraits(scenesToLorebook(source.scenes, tier.scenes, tier.drop_scenes ?? []), source.persona, tier.name),
            source.books,
            tier.name,
        );
        const schedule = scheduleForTier(source.schedule, tier.name);
        const card = personaToCard(source, tier.name, { world, schedule });
        tiers.push({ tier: tier.name, card, lorebook });
        files.set(`${prefix}-${tier.name}.json`, JSON.stringify(card, null, 4) + '\n');
        files.set(`${world}.json`, JSON.stringify(lorebook, null, 4) + '\n');

        // 承认版（ADR 0067）：对方不知道她是程序时用。名单外那一档本来就是承认版，不再多做一份。
        // 与原卡只差两处：「被问是不是 AI」取承认说法；场景世界书去掉否认「是不是真人」的场景
        if (tier.name === OPEN_AS_TIER) continue;
        const openWorld = `${prefix}-scenes-${tier.name}-open`;
        const pool = new Set(source.scenes.filter(scene => scene.tiers.includes(tier.scenes)).map(scene => scene.id));
        const openDrop = [...(tier.drop_scenes ?? []), ...OPEN_DROP_SCENES.filter(id => pool.has(id) && !(tier.drop_scenes ?? []).includes(id))];
        const openLorebook = withReadBooks(
            withKeyedTraits(scenesToLorebook(source.scenes, tier.scenes, openDrop), source.persona, tier.name),
            source.books,
            tier.name,
        );
        const openCard = personaToCard(source, tier.name, { world: openWorld, schedule, open: true });
        if (openCard.data.description === card.data.description) {
            throw new Error(`档位 ${tier.name} 的承认版和原卡一样：persona.yml 的 identity_note 里没有写给 ${OPEN_AS_TIER} 的承认说法`);
        }
        tiers.push({ tier: `${tier.name}-open`, base: tier.name, card: openCard, lorebook: openLorebook });
        files.set(`${prefix}-${tier.name}-open.json`, JSON.stringify(openCard, null, 4) + '\n');
        files.set(`${openWorld}.json`, JSON.stringify(openLorebook, null, 4) + '\n');
    }
    return { tiers, files };
}
