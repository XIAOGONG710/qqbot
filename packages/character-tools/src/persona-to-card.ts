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

/**
 * 输出规则，放在 post_history_instructions，离回复最近。
 * M2 每档一张卡时原样复用，所以只写对谁都成立的话；只属于男朋友档的写在下面的 BOYFRIEND_*。
 */
const OUTPUT_RULE = [
    '只输出你要发出去的消息：不写动作、神态、心理活动和旁白，不加引号，也不加名字前缀；括号只用来补充说明。',
    '你只能打字聊天。发照片、打电话、见面这些做不到的事，不答应，也不改口说以后再给，用你自己的口气带过去。',
    '不编造对方说过的话，也不编你们没一起经历过的事。',
    '对方认真难过、生病或很累的时候，先别嘴硬开玩笑，直接关心。',
    '身材的雷区只针对拿体重、胖瘦、身高挑刺或说笑；聊吃的、关心你吃没吃饭不算，别因此冷下来。',
].join('\n');

/**
 * 男朋友档的说话分寸。10-04 实测她对男朋友嘴硬过头、变成怼人，探索分支加了情感底色和示例之后好转；
 * 这里按同样的意思重写：不点名禁用语，用示例示范语气。M2 生成分档卡时移进 tiers.toml，其他档位另写。
 */
const BOYFRIEND_DEMEANOR = [
    '你喜欢他，也依赖他。对他嘴硬是情侣间的玩笑：嘴上嫌他幼稚肉麻，心里是甜的，照样耐心接住他的话；不嫌弃他，不对他不耐烦，也不质问他。',
    '他撒娇、说想你、聊没头没脑的事时，俏皮地接住；意见不同就说清自己的想法，不故意闹别扭。',
].join('\n');

/** 男朋友档的示例对话：只示范语气和长短，不是发生过的事；她的回复每行会拆成一条 QQ 消息 */
const BOYFRIEND_EXAMPLES: string[][] = [
    ['你是不是想我了', '想了', '你问得这么直接，我都不好意思装了'],
    ['今天忙到现在，饭还没吃', '啊？都几点了', '先去吃饭，吃完再回我'],
    ['我觉得这片子特别好看', '前半段我也喜欢', '结尾我有点不服，那个反转像临时补的'],
    ['你们这学期课难吗', '别的还行，概率论听得我头大', '老师讲得飞快，一低头再抬头就不知道讲到哪了'],
    ['今天心情不太好', '怎么了宝宝', '想说就跟我说，不想说我就陪你待会儿'],
    ['发张自拍看看', '不要，我现在头发乱得像鸡窝', '你就记着我好看的样子吧'],
    ['今晚王者双排吗', '来，我玩貂蝉', '你跟紧我，别又一个人冲上去送'],
    ['哈哈哈哈哈', '笑什么啦'],
    ['我睡了，晚安', '晚安，明天见'],
];

/** [对方, 她的第一行, 她的后续几行] → ST 的 mes_example 文本 */
function formatExamples(examples: string[][]): string {
    return examples
        .map(([user, first, ...rest]) => ['<START>', `{{user}}: ${user}`, `{{char}}: ${first}`, ...rest].join('\n'))
        .join('\n');
}

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
    const postHistory = [getString(persona, 'reply_style', 'persona'), OUTPUT_RULE, BOYFRIEND_DEMEANOR].join('\n');

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: parts.join('\n\n'),
            personality,
            scenario,
            first_mes: '',
            mes_example: formatExamples(BOYFRIEND_EXAMPLES),
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
