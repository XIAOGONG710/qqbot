// persona.toml → SillyTavern 角色卡 V2。
//
// 每个键都必须在下面登记为“转换”或“跳过（附原因）”；出现未登记的键直接报错，
// 保证 legacy 里的内容不会被悄悄漏掉。

import { getString, getStringArray, getTable, type Table } from './legacy.ts';
import type { CharacterCardV2 } from './st-format.ts';

/** 顶层表：不是角色设定的旧引擎参数 */
const SKIPPED_TOP_LEVEL: Record<string, string> = {
    engine: '旧引擎运行参数（心跳、配额等）',
    reply: '旧引擎回复节奏参数（冷却、延迟等），拟人发送在 M4 重新设计',
    corpus: '旧引擎语料配置',
    vision: '旧引擎看图配置',
};

/** [persona] 下按章节写进 description 的表，顺序即输出顺序 */
const DESCRIPTION_SECTIONS: [key: string, title: string][] = [
    ['relation', '和他的关系'],
    ['family', '家'],
    ['dorm', '宿舍'],
    ['study', '专业'],
    ['friends', '朋友'],
    ['money', '钱'],
    ['heart', '心事'],
    ['speech', '口癖与称呼'],
    ['taboo', '雷区'],
    ['identity_note', '被问是不是 AI'],
    ['daily_extra', '日常'],
    ['dates', '重要的日子'],
    ['growth', '会变'],
];

/** 含义写在键名里、值本身看不出来的字段，输出时加上标签 */
const FIELD_LABELS: Record<string, string> = {
    'money.phone': '手机',
    'dates.her_birthday': '你的生日',
    'dates.anniversary': '在一起的纪念日',
    'dates.his_birthday': '他的生日',
};

/** [persona] 下暂不转换的表 */
const SKIPPED_PERSONA: Record<string, string> = {
    daily_moods: 'M3：每日心情要由运行时按天抽取，ST 没有对应机制',
    him: 'M2：别人提起他时的识别；含脱敏占位符',
    social_extra: 'M2：对女生熟人的说话方式',
};

/** [persona.social] 里只转男朋友档，其余档位留给 M2 */
const SOCIAL_FOR_M1 = 'boyfriend';
const SKIPPED_SOCIAL: Record<string, string> = {
    roommate: 'M2：按对象分档',
    classmate: 'M2：按对象分档',
    stranger: 'M2：按对象分档',
    group: 'M2：按对象分档（群聊）',
    secret: 'M2：对外不提恋爱关系，只在非男朋友档有意义',
    warmth: '旧引擎按档位的数值旋钮，不是角色设定',
};

/**
 * [persona.traits] 原文以他的视角写“你”（= 他），而卡里其余部分的“你”都是她。
 * 这里只改人称，并核对原文，原文一变就报错。
 */
const TRAIT_PRONOUN_FIX: Record<string, [original: string, fixed: string]> = {
    hard_but_caring: ['嘴硬，不吃逗，但会自己跑来关心你。', '嘴硬，不吃逗，但会自己跑来关心他。'],
    clingy: ['会想你，会直接说。', '会想他，会直接说。'],
    noisy: ['有力气的时候很吵，会拉着人一起玩。', '有力气的时候很吵，会拉着人一起玩。'],
};

const SYSTEM_PROMPT = '你是{{char}}，正在用 QQ 和{{user}}私聊。下面是你的设定。';

const OUTPUT_RULE = '只输出你要发出去的消息：不写动作、表情、心理活动和旁白，不加引号，也不加名字前缀。';

export interface CardOptions {
    /** 关联的世界书名（世界书文件名去掉 .json） */
    world: string;
}

export function personaToCard(personaToml: Table, options: CardOptions): CharacterCardV2 {
    for (const key of Object.keys(personaToml)) {
        if (key !== 'persona' && !(key in SKIPPED_TOP_LEVEL)) throw new Error(`persona.toml 顶层出现未登记的键：${key}`);
    }
    const persona = getTable(personaToml, 'persona', 'persona.toml');

    const handled = new Set(['name', 'identity', 'personality', 'reply_style', 'traits', 'social', 'redlines',
        ...DESCRIPTION_SECTIONS.map(([key]) => key), ...Object.keys(SKIPPED_PERSONA)]);
    for (const key of Object.keys(persona)) {
        if (!handled.has(key)) throw new Error(`[persona] 出现未登记的键：${key}`);
    }

    for (const path of Object.keys(FIELD_LABELS)) {
        const [section = '', field = ''] = path.split('.');
        if (!(field in getTable(persona, section, 'persona'))) throw new Error(`FIELD_LABELS 指向不存在的字段：${path}`);
    }

    const name = getString(persona, 'name', 'persona');

    // description：身份 + 各章节 + 不接的话题
    const parts = [`{{char}}，${getString(persona, 'identity', 'persona')}。下文的「你」就是{{char}}，「他」是你的男朋友。`];
    for (const [key, title] of DESCRIPTION_SECTIONS) {
        const section = getTable(persona, key, 'persona');
        const lines = Object.keys(section).map(field => {
            const text = getString(section, field, `persona.${key}`);
            const label = FIELD_LABELS[`${key}.${field}`];
            return label ? `${label}：${text}` : text;
        });
        parts.push(`【${title}】\n${lines.join('\n')}`);
    }
    const redlines = getTable(persona, 'redlines', 'persona');
    checkKeys(redlines, ['keywords', 'note'], 'persona.redlines');
    parts.push(`【不接的话题】\n${getStringArray(redlines, 'keywords', 'persona.redlines').join('、')}。${getString(redlines, 'note', 'persona.redlines')}`);

    // personality：自我定位 + 三面性格
    const traits = getTable(persona, 'traits', 'persona');
    checkKeys(traits, Object.keys(TRAIT_PRONOUN_FIX), 'persona.traits');
    const traitLines = Object.entries(TRAIT_PRONOUN_FIX).map(([key, [original, fixed]]) => {
        const text = getString(traits, key, 'persona.traits');
        if (text !== original) throw new Error(`persona.traits.${key} 与预期原文不符，请核对人称改写：${text}`);
        return fixed;
    });
    const personality = [getString(persona, 'personality', 'persona'), ...traitLines].join('\n');

    // scenario：当前聊天对象（M1 只有男朋友）
    const social = getTable(persona, 'social', 'persona');
    checkKeys(social, [SOCIAL_FOR_M1, ...Object.keys(SKIPPED_SOCIAL)], 'persona.social');
    const scenario = [
        '正在和你私聊的{{user}}就是你的男朋友，也就是设定里的「他」。',
        getString(social, SOCIAL_FOR_M1, 'persona.social'),
    ].join('\n');

    // post_history_instructions：说话方式放在聊天记录之后，离回复最近
    const postHistory = [getString(persona, 'reply_style', 'persona'), OUTPUT_RULE].join('\n');

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: parts.join('\n\n'),
            personality,
            scenario,
            first_mes: '',
            mes_example: '',
            creator_notes: '由 packages/character-tools 从 characters/linmengyao/legacy/persona.toml 转换生成。',
            system_prompt: SYSTEM_PROMPT,
            post_history_instructions: postHistory,
            alternate_greetings: [],
            tags: [],
            creator: '',
            character_version: '',
            extensions: { world: options.world },
        },
    };
}

/** 表里的键必须恰好是 expected（顺序不限） */
function checkKeys(table: Table, expected: string[], where: string): void {
    const actual = Object.keys(table);
    const unknown = actual.filter(key => !expected.includes(key));
    const missing = expected.filter(key => !(key in table));
    if (unknown.length || missing.length) {
        throw new Error(`${where} 键不符：未登记 [${unknown.join(', ')}]，缺少 [${missing.join(', ')}]`);
    }
}

export const skippedForReport = { SKIPPED_TOP_LEVEL, SKIPPED_PERSONA, SKIPPED_SOCIAL };
