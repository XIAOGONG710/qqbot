// persona.toml + tiers.toml → 每个档位一张 SillyTavern 角色卡 V2（ADR 0003）。
//
// persona.toml 的每个键都必须在下面登记为“转换”或“跳过（附原因）”；
// 写进卡的字段还要在 tiers.toml 的 [visible] 里登记给哪些档位。
// 出现未登记的键直接报错，保证 legacy 里的内容不会被悄悄漏掉，也不会悄悄给错档位。

import { getString, getStringArray, getTable, isTable, type Table } from './legacy.ts';
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
    him: '别人提起他时的识别（旧引擎动态判定 known 档用）；含脱敏占位符',
};

/** [persona.social] 里转换的档位说话方式，和跳过的键 */
const SOCIAL_KEYS = ['boyfriend', 'roommate', 'classmate', 'stranger'];
const SKIPPED_SOCIAL: Record<string, string> = {
    group: '群聊里程碑',
    secret: '用 tiers.toml 的 discreet 代替：原句会让低档位知道她有男朋友',
    warmth: '旧引擎按档位的数值旋钮，不是角色设定',
};
const SOCIAL_EXTRA_KEYS = ['girl_friend'];

const SYSTEM_PROMPT = '你是{{char}}，正在用 QQ 和{{user}}私聊。下面是你的设定。';

/**
 * 输出规则，放在 post_history_instructions，离回复最近。
 * 所有档位共用，所以只写对谁都成立的话；只属于某个档位的分寸写在 tiers.toml 的 demeanor。
 */
const OUTPUT_RULE = [
    '只输出你要发出去的消息：不写动作、神态、心理活动和旁白，不加引号，也不加名字前缀；括号只用来补充说明。',
    '你只能打字聊天。发照片、打电话、见面这些做不到的事，不答应，也不改口说以后再给，用你自己的口气带过去。',
    '不编造对方说过的话，也不编你们没一起经历过的事。',
    '对方认真难过、生病或很累的时候，先别嘴硬开玩笑，直接关心。',
    '身材的雷区只针对拿体重、胖瘦、身高挑刺或说笑；聊吃的、关心你吃没吃饭不算，别因此冷下来。',
].join('\n');

export interface Tier {
    name: string;
    code: string;
    /** scenario 第一句：正在聊天的 {{user}} 是谁 */
    userIs: string;
    /** description 开头说明「他」是男朋友 */
    knowsHim: boolean;
    /** 说话方式取 persona.toml 的哪个字段（social.* / social_extra.*） */
    social?: string;
    /** legacy 里没有、在 tiers.toml 里写的说话方式 */
    socialText?: string;
    discreet: boolean;
    /** 场景世界书用 speech_library.toml 里哪个档位的场景 */
    scenes: string;
    dropScenes: string[];
    demeanor: string;
    /** [对方, 她的第一行, 她的后续几行…] */
    examples: string[][];
    banned: string[];
}

interface Rewrite {
    field: string;
    tiers: Set<string>;
    original?: string;
    replace?: [from: string, to: string][];
    text?: string;
}

export interface TierConfig {
    tiers: Tier[];
    /** 字段路径 → 可见的档位名 */
    visible: Map<string, Set<string>>;
    rewrites: Rewrite[];
    discreet: string;
}

export function parseTierConfig(toml: Table): TierConfig {
    const where = 'tiers.toml';
    const tierTable = getTable(toml, 'tier', where);
    const tiers = Object.keys(tierTable).map((name): Tier => {
        const t = getTable(tierTable, name, `${where} tier`);
        const at = `${where} tier.${name}`;
        const optionalString = (key: string) => (t[key] === undefined ? undefined : getString(t, key, at));
        const examples = t.examples ?? [];
        if (!Array.isArray(examples) || !examples.every(e => Array.isArray(e) && e.length >= 2 && e.every(x => typeof x === 'string'))) {
            throw new Error(`${at}.examples 应为 [对方, 她, ...] 的数组`);
        }
        return {
            name,
            code: getString(t, 'code', at),
            userIs: getString(t, 'user_is', at),
            knowsHim: t.knows_him === true,
            social: optionalString('social'),
            socialText: optionalString('social_text'),
            discreet: t.discreet === true,
            scenes: getString(t, 'scenes', at),
            dropScenes: t.drop_scenes === undefined ? [] : getStringArray(t, 'drop_scenes', at),
            demeanor: optionalString('demeanor') ?? '',
            examples: examples as string[][],
            banned: getStringArray(t, 'banned', at),
        };
    });
    const byCode = new Map(tiers.map(t => [t.code, t.name]));
    if (byCode.size !== tiers.length) throw new Error(`${where} 档位代号重复`);
    const decode = (codes: string, at: string) => new Set([...codes].map(code => {
        const name = byCode.get(code);
        if (!name) throw new Error(`${at} 里的档位代号 ${code} 不存在`);
        return name;
    }));
    for (const tier of tiers) {
        if (!tier.social === !tier.socialText) throw new Error(`${where} tier.${tier.name} 要有 social 或 social_text 之一`);
    }

    const visibleTable = getTable(toml, 'visible', where);
    const visible = new Map(Object.keys(visibleTable).map(path => [path, decode(getString(visibleTable, path, `${where} visible`), `visible."${path}"`)]));

    const rewritesRaw = toml.rewrite ?? [];
    if (!Array.isArray(rewritesRaw)) throw new Error(`${where} rewrite 应为 [[rewrite]] 数组`);
    const rewrites = rewritesRaw.map((raw: unknown, i): Rewrite => {
        const at = `${where} rewrite[${i}]`;
        if (!isTable(raw)) throw new Error(`${at} 应为表`);
        const replace = raw.replace;
        if (replace !== undefined && !(Array.isArray(replace) && replace.every(p => Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'string')))) {
            throw new Error(`${at}.replace 应为 [原文片段, 新片段] 的数组`);
        }
        const text = raw.text === undefined ? undefined : getString(raw, 'text', at);
        if ((replace === undefined) === (text === undefined)) throw new Error(`${at} 要有 replace 或 text 之一`);
        return {
            field: getString(raw, 'field', at),
            tiers: decode(getString(raw, 'tiers', at), `${at}.tiers`),
            original: raw.original === undefined ? undefined : getString(raw, 'original', at),
            replace: replace as [string, string][] | undefined,
            text,
        };
    });

    return { tiers, visible, rewrites, discreet: getString(toml, 'discreet', where) };
}

export interface CardOptions {
    /** 关联的世界书名（世界书文件名去掉 .json） */
    world: string;
}

export function personaToCard(personaToml: Table, config: TierConfig, tierName: string, options: CardOptions): CharacterCardV2 {
    const tier = config.tiers.find(t => t.name === tierName);
    if (!tier) throw new Error(`tiers.toml 里没有档位 ${tierName}`);

    for (const key of Object.keys(personaToml)) {
        if (key !== 'persona' && !(key in SKIPPED_TOP_LEVEL)) throw new Error(`persona.toml 顶层出现未登记的键：${key}`);
    }
    const persona = getTable(personaToml, 'persona', 'persona.toml');
    const handled = new Set(['name', 'identity', 'personality', 'reply_style', 'traits', 'social', 'social_extra', 'redlines',
        ...DESCRIPTION_SECTIONS.map(([key]) => key), ...Object.keys(SKIPPED_PERSONA)]);
    for (const key of Object.keys(persona)) {
        if (!handled.has(key)) throw new Error(`[persona] 出现未登记的键：${key}`);
    }
    for (const path of Object.keys(FIELD_LABELS)) {
        const [section = '', field = ''] = path.split('.');
        if (!(field in getTable(persona, section, 'persona'))) throw new Error(`FIELD_LABELS 指向不存在的字段：${path}`);
    }
    checkKeys(getTable(persona, 'social', 'persona'), [...SOCIAL_KEYS, ...Object.keys(SKIPPED_SOCIAL)], 'persona.social');
    checkKeys(getTable(persona, 'social_extra', 'persona'), SOCIAL_EXTRA_KEYS, 'persona.social_extra');

    // 写进卡的字段（traits 和 description 各章节）都要登记可见性，登记的也都要存在
    const gated = ['traits', ...DESCRIPTION_SECTIONS.map(([key]) => key)]
        .flatMap(section => Object.keys(getTable(persona, section, 'persona')).map(field => `${section}.${field}`));
    for (const path of gated) if (!config.visible.has(path)) throw new Error(`tiers.toml [visible] 没有登记 ${path}`);
    for (const path of config.visible.keys()) if (!gated.includes(path)) throw new Error(`tiers.toml [visible] 登记了不存在的字段 ${path}`);

    // 按档位改写后的字段原文
    const text = (path: string): string => {
        const [section = '', field = ''] = path.split('.');
        const original = getString(getTable(persona, section, 'persona'), field, `persona.${section}`);
        const rewrite = config.rewrites.find(r => r.field === path && r.tiers.has(tier.name));
        return rewrite ? applyRewrite(rewrite, original) : original;
    };
    // 每条改写在所有档位上都检查一遍，不只是当前档位用到的
    for (const rewrite of config.rewrites) {
        const [section = '', field = ''] = rewrite.field.split('.');
        applyRewrite(rewrite, getString(getTable(persona, section, 'persona'), field, `persona.${section}`));
    }
    const sees = (path: string) => config.visible.get(path)!.has(tier.name);

    const name = getString(persona, 'name', 'persona');

    // description：身份 + 这一档能看到的各章节 + 不接的话题
    const intro = `{{char}}，${getString(persona, 'identity', 'persona')}。下文的「你」就是{{char}}${tier.knowsHim ? '，「他」是你的男朋友' : ''}。`;
    const parts = [intro];
    for (const [key, title] of DESCRIPTION_SECTIONS) {
        const lines = Object.keys(getTable(persona, key, 'persona'))
            .filter(field => sees(`${key}.${field}`))
            .map(field => {
                const label = FIELD_LABELS[`${key}.${field}`];
                return label ? `${label}：${text(`${key}.${field}`)}` : text(`${key}.${field}`);
            });
        if (lines.length) parts.push(`【${title}】\n${lines.join('\n')}`);
    }
    const redlines = getTable(persona, 'redlines', 'persona');
    checkKeys(redlines, ['keywords', 'note'], 'persona.redlines');
    parts.push(`【不接的话题】\n${getStringArray(redlines, 'keywords', 'persona.redlines').join('、')}。${getString(redlines, 'note', 'persona.redlines')}`);

    // personality：自我定位 + 这一档能看到的性格
    const traitLines = Object.keys(getTable(persona, 'traits', 'persona')).filter(f => sees(`traits.${f}`)).map(f => text(`traits.${f}`));
    const personality = [getString(persona, 'personality', 'persona'), ...traitLines].join('\n');

    // scenario：正在聊天的人是谁 + 对这一档的说话方式
    const scenario = [tier.userIs, tier.socialText ?? text(tier.social!), tier.discreet ? config.discreet : '']
        .filter(Boolean).join('\n');

    // post_history_instructions：说话方式放在聊天记录之后，离回复最近
    const postHistory = [getString(persona, 'reply_style', 'persona'), OUTPUT_RULE, tier.demeanor].filter(Boolean).join('\n');

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: parts.join('\n\n'),
            personality,
            scenario,
            first_mes: '',
            mes_example: formatExamples(tier.examples),
            creator_notes: `由 packages/character-tools 从 characters/linmengyao/legacy/persona.toml 和 tiers.toml 转换生成（档位 ${tier.name}）。`,
            system_prompt: SYSTEM_PROMPT,
            post_history_instructions: postHistory,
            alternate_greetings: [],
            tags: [tier.name],
            creator: '',
            character_version: '',
            extensions: { world: options.world },
        },
    };
}

function applyRewrite(rewrite: Rewrite, original: string): string {
    const where = `tiers.toml 对 ${rewrite.field} 的改写`;
    if (rewrite.original !== undefined && rewrite.original !== original) {
        throw new Error(`${where}：原文变了，请核对改写（现在是：${original}）`);
    }
    if (rewrite.text !== undefined) return rewrite.text;
    let result = original;
    for (const [from, to] of rewrite.replace!) {
        const count = original.split(from).length - 1;
        if (count !== 1) throw new Error(`${where}：「${from}」在原文里出现 ${count} 次，应恰好 1 次`);
        result = result.replace(from, to);
    }
    return result;
}

/** [对方, 她的第一行, 她的后续几行] → ST 的 mes_example 文本 */
function formatExamples(examples: string[][]): string {
    return examples
        .map(([user, first, ...rest]) => ['<START>', `{{user}}: ${user}`, `{{char}}: ${first}`, ...rest].join('\n'))
        .join('\n');
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
