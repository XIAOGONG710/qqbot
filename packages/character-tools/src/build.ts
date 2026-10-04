// source/ → st/ 下每个档位的角色卡和场景世界书（ADR 0003、0010）。CLI（cli.ts）和控制台的「林梦瑶」页面共用。
// 生成之前先查资料之间的引用（档位名、说话方式、场景档），写错就报错，不生成。

import { personaToCard } from './persona-to-card.ts';
import { scenesToLorebook } from './scenes-to-lorebook.ts';
import { checkScheduleTiers, scheduleForTier } from './schedule-to-card.ts';
import { SECTION_KEYS, type CharacterSource, type TextField } from './source.ts';
import type { CharacterCardV2, WorldInfoBook } from './st-format.ts';

export interface BuiltTier {
    tier: string;
    card: CharacterCardV2;
    lorebook: WorldInfoBook;
}

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
    for (const tier of source.tiers.tiers) {
        if (tier.social !== undefined && !persona.social[tier.social]) {
            throw new Error(`tiers.yml 档位 ${tier.name} 的 social「${tier.social}」在 persona.yml 的 social 里没有`);
        }
    }
    checkScheduleTiers(source.schedule, names);
}

export function buildCharacter(source: CharacterSource, prefix = 'linmengyao'): Built {
    checkReferences(source);
    const tiers: BuiltTier[] = [];
    const files = new Map<string, string>();
    for (const tier of source.tiers.tiers) {
        const world = `${prefix}-scenes-${tier.name}`;
        const lorebook = scenesToLorebook(source.scenes, tier.scenes, tier.drop_scenes ?? []);
        const schedule = scheduleForTier(source.schedule, tier.name);
        const card = personaToCard(source, tier.name, { world, schedule });
        tiers.push({ tier: tier.name, card, lorebook });
        files.set(`${prefix}-${tier.name}.json`, JSON.stringify(card, null, 4) + '\n');
        files.set(`${world}.json`, JSON.stringify(lorebook, null, 4) + '\n');
    }
    return { tiers, files };
}
