// source/ 的人设和档位 → 每个档位一张 SillyTavern 角色卡 V2（ADR 0003、0010）。
//
// 人设各段的字段只给 tiers 里的档位；某几档用改写过的文字（variants，按顺序取第一条含这一档的）。
// 段落标题、字段标签、输出规则、system_prompt、正则脚本是代码里的常量，不在资料里。

import { SECTION_KEYS, type CharacterSource, type SectionKey, type TextField } from './source.ts';
import type { CardDate, CardProactive, CardSchedule, CharacterCardV2, RegexScript } from './st-format.ts';
import { booksForTier, moodsForTier } from './her-days-to-card.ts';
import { worldForTier } from './world-source.ts';
import { biographyForTier } from './biography-to-card.ts';

/** description 各段的标题，顺序即 SECTION_KEYS 的顺序 */
const SECTION_TITLES: Record<SectionKey, string> = {
    relation: '和他的关系',
    family: '家',
    dorm: '宿舍',
    study: '专业',
    friends: '朋友',
    money: '钱',
    heart: '心事',
    speech: '口癖与称呼',
    taboo: '雷区',
    identity_note: '被问是不是 AI',
    daily_extra: '日常',
    dates: '重要的日子',
    growth: '会变',
};

/** 含义写在键名里、值本身看不出来的字段，输出时加上标签 */
const FIELD_LABELS: Record<string, string> = {
    'money.phone': '手机',
    'dates.her_birthday': '你的生日',
    'dates.anniversary': '在一起的纪念日',
    'dates.his_birthday': '他的生日',
};

const SYSTEM_PROMPT = '你是{{char}}，正在用 QQ 和{{user}}私聊。下面是你的设定。';

/**
 * 输出规则，放在 post_history_instructions，离回复最近。
 * 所有档位共用，所以只写对谁都成立的话；只属于某个档位的分寸写在 tiers.yml 的 demeanor。
 */
const OUTPUT_RULE = [
    '只输出你要发出去的消息：不写动作、神态、心理活动和旁白，不加引号，也不加名字前缀；括号只用来补充说明。',
    // ADR 0046（作者 10-10）：见面可以答应；见了面两个人也还是在 QQ 上打字说话。照片、语音、电话、视频仍然做不到；ADR 0063 的收藏图片表情例外
    '你们只在 QQ 上打字说话：发自己拍的照片、相册图片、语音，打电话、开视频这些做不到，不答应，也不改口说以后再给，用你自己的口气带过去；运行时明确列给你的收藏图片表情例外，可以按那里的格式偶尔发。见面照你自己的意思答应或推掉；就算见了面，你们也还是在 QQ 上打字说话。聊天里约好的见面到了点，以约的为准：那会儿你在约的地方，别再说自己在宿舍或别处。',
    // ADR 0052：语音转出来的字、图上的字（OCR）进聊天记录；转不出来、没字的只有「[语音]」「[图片]」，像真人那样处理，不假装听到、看见
    '对方发来的语音和图片，聊天记录里写成方括号：「[语音 8秒：……]」冒号后面是语音里说的话（转出来的字，可能有错字，按意思理解）；「[图片，上面写着：……]」是图上的字，图里别的东西你看不清。'
    + '只有「[语音 8秒]」「[图片]」的，你不知道里面是什么：语音你这会儿听不了（在上课、在图书馆、宿舍有人在睡觉，看你现在在干什么）就像真人那样让对方打字，能听的时候就当听过了，顺着对方前后说的接，别编语音里说了什么；'
    + '图就问一句「这是啥」，或者就着对方说的话接，不假装看见了。你自己发不了语音、照片和普通图片，也不写「[语音…]」「[图片…]」这种方括号；运行时列出的收藏图片表情和小黄脸照各自规则用。',
    '不编造对方说过的话，也不编你们没一起经历过的事。',
    '被认真问到学习、技术上的事，像同学之间讲题：先一句话说清是什么，再打一个比方，讲到对方能接着往下想就停；对方追问再往细里讲。',
    '对方认真难过、生病或很累的时候，先别嘴硬开玩笑，直接关心。',
    '身材的雷区只针对拿体重、胖瘦、身高挑刺或说笑；聊吃的、关心你吃没吃饭不算，别因此冷下来。',
].join('\n');

/**
 * 删掉整行括号和行首括号里的动作、心理活动（ADR 0006 决策 2）：输出规则写了不要，模型偶尔还是写。
 * 句中、句末的括号是正常的补充说明，不动。id 固定，重新生成时卡不变。
 */
export const STAGE_DIRECTION_SCRIPT: RegexScript = {
    id: '3f6c1e2a-7b4d-4c59-9e8a-5d2b0c7f1a64',
    scriptName: '去掉行首括号里的动作',
    findRegex: '/^[ \\t]*[（(][^（）()\\n]*[）)][ \\t]*/gm',
    replaceString: '',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
};

export interface CardOptions {
    /** 关联的世界书名（世界书文件名去掉 .json） */
    world: string;
    /** 这一档的作息（schedule-to-card.ts），写进 extensions.qqbot.schedule */
    schedule?: CardSchedule;
    /** 承认版（ADR 0067）：对方不知道她是程序时用；与原卡只差「被问是不是 AI」一段，取名单外那一档的承认说法 */
    open?: boolean;
}

/** 承认版里「被问是不是 AI」取哪一档的说法（persona.yml identity_note 的 variants 里写给名单外的那条，ADR 0003 决策 2） */
export const OPEN_AS_TIER = 'unlisted';

/** 这一档看到的文字：第一条含这一档的改写，没有就用原文 */
export function textFor(field: TextField, tier: string): string {
    return field.variants?.find(v => v.tiers.includes(tier))?.text ?? field.text;
}

export function personaToCard(source: CharacterSource, tierName: string, options: CardOptions): CharacterCardV2 {
    const tier = source.tiers.tiers.find(t => t.name === tierName);
    if (!tier) throw new Error(`tiers.yml 里没有档位 ${tierName}`);
    const { persona } = source;
    for (const path of Object.keys(FIELD_LABELS)) {
        const [section = '', field = ''] = path.split('.');
        if (!persona.sections[section as SectionKey]?.[field]) throw new Error(`FIELD_LABELS 指向不存在的字段：${path}`);
    }
    const sees = (field: TextField) => field.tiers?.includes(tier.name) ?? true;

    // description：身份 + 这一档能看到的各段 + 不接的话题
    const intro = `{{char}}，${persona.identity}。下文的「你」就是{{char}}${tier.knows_him ? '，「他」是你的男朋友' : ''}。`;
    const parts = [intro];
    for (const key of SECTION_KEYS) {
        // 带触发词的（keys）不在这里，说到才想起，进这一档的世界书（scenes-to-lorebook.ts withKeyedTraits）
        const lines = Object.entries(persona.sections[key])
            .filter(([, field]) => sees(field) && !field.keys)
            .map(([name, field]) => {
                const label = FIELD_LABELS[`${key}.${name}`];
                const text = textFor(field, key === 'identity_note' && options.open ? OPEN_AS_TIER : tier.name);
                return label ? `${label}：${text}` : text;
            });
        if (lines.length) parts.push(`【${SECTION_TITLES[key]}】\n${lines.join('\n')}`);
    }
    parts.push(`【不接的话题】\n${persona.redlines.keywords.join('、')}。${persona.redlines.note}`);

    // personality：自我定位 + 这一档能看到的性格
    // 带触发词的同上
    const traitLines = Object.values(persona.traits).filter(field => sees(field) && !field.keys).map(field => textFor(field, tier.name));
    const personality = [persona.personality, ...traitLines].join('\n');

    // scenario：正在聊天的人是谁 + 对这一档的说话方式
    let social = tier.social_text;
    if (social === undefined) {
        const field = persona.social[tier.social!];
        if (!field) throw new Error(`tiers.yml 档位 ${tier.name} 的 social「${tier.social}」在 persona.yml 的 social 里没有`);
        social = textFor(field, tier.name);
    }
    const scenario = [tier.user_is, social, tier.discreet ? source.tiers.discreet.text : ''].filter(Boolean).join('\n');

    // post_history_instructions：说话方式放在聊天记录之后，离回复最近
    const postHistory = [persona.reply_style, OUTPUT_RULE, tier.demeanor ?? ''].filter(Boolean).join('\n');

    // 运行时用的日期和主动设置（ADR 0011）：日期跟着「重要的日子」那句文字的档位
    const dates: CardDate[] = Object.values(persona.sections.dates).filter(field => field.day && sees(field)).map(field => ({ ...field.day! }));
    const proactive: CardProactive | undefined = tier.proactive && {
        occasions: [...tier.proactive.occasions],
        dailyMax: tier.proactive.daily_max,
        unansweredMax: tier.proactive.unanswered_max,
    };
    const moods = moodsForTier(source, tier.name);
    const books = booksForTier(source, tier.name);
    const world = worldForTier(source.world, tier.name);
    const biography = biographyForTier(source.biography, tier.name);
    const qqbot = {
        banned: tier.banned,
        ...(options.schedule ? { schedule: options.schedule } : {}),
        ...(dates.length ? { dates } : {}),
        ...(tier.pace !== undefined ? { pace: tier.pace } : {}),
        ...(proactive ? { proactive } : {}),
        ...(moods ? { moods } : {}),
        ...(books ? { books } : {}),
        ...(world ? { world } : {}),
        ...(biography ? { biography } : {}),
    };

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: persona.name,
            description: parts.join('\n\n'),
            personality,
            scenario,
            first_mes: '',
            mes_example: formatExamples(tier.examples ?? []),
            creator_notes: `由 packages/character-tools 从 characters/linmengyao/source/ 生成（档位 ${tier.name}）。不要手改：改资料请用 Koishi 控制台的「林梦瑶」页面或 source/ 下的 YAML。`,
            system_prompt: SYSTEM_PROMPT,
            post_history_instructions: postHistory,
            alternate_greetings: [],
            tags: options.open ? [tier.name, 'open'] : [tier.name],
            creator: '',
            character_version: '',
            extensions: { world: options.world, regex_scripts: [STAGE_DIRECTION_SCRIPT], qqbot },
        },
    };
}

/** [对方, 她的第一行, 她的后续几行] → ST 的 mes_example 文本 */
function formatExamples(examples: string[][]): string {
    return examples
        .map(([user, first, ...rest]) => ['<START>', `{{user}}: ${user}`, `{{char}}: ${first}`, ...rest].join('\n'))
        .join('\n');
}
