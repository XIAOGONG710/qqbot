// 编辑页的表单（Schema）：人设、档位、作息（ADR 0010）。世界书在 scenes.js。
// 形状和 characters/<角色>/source/ 的 YAML 一样（packages/character-tools/src/source.ts），服务端保存前再校验一遍。
import { Schema } from '@koishijs/client';
import { tierLabel } from './common.js';

/** description 各段，顺序和标题同 persona-to-card.ts */
const SECTIONS = [
    ['relation', '和他的关系'], ['family', '家'], ['dorm', '宿舍'], ['study', '专业'], ['friends', '朋友'], ['money', '钱'],
    ['heart', '心事'], ['speech', '口癖与称呼'], ['taboo', '雷区'], ['identity_note', '被问是不是 AI'], ['daily_extra', '日常'],
    ['dates', '重要的日子'], ['growth', '会变'],
];

const textarea = () => Schema.string().role('textarea', { rows: [2, 10] });
const note = () => textarea().description('**说明**：为什么这样写，不进卡');
const tierNames = source => source.tiers.tiers.map(t => t.name);
const tierBoxes = names => Schema.array(Schema.union(names.map(name => Schema.const(name).description(tierLabel(name))))).role('checkbox');

function field(names, gated) {
    return Schema.object({
        text: textarea().description('**文字**'),
        ...(gated ? { tiers: tierBoxes(names).description('**给哪些档位**：没勾的档位的卡里没有这一句') } : {}),
        variants: Schema.array(Schema.object({
            tiers: tierBoxes(names).description('**这几档**'),
            text: textarea().description('**改成**'),
            note: note(),
        })).description('**某几档用的改写版本**：按顺序取第一条含这一档的，其余档位用上面的文字'),
        note: note(),
    });
}

export function personaSections(source) {
    const names = tierNames(source);
    const fields = (gated, description) => Schema.object({ fields: Schema.dict(field(names, gated)).description(description) });
    return [
        {
            key: 'basic', label: '身份和说话方式',
            schema: Schema.object({
                name: Schema.string().description('**名字**'),
                identity: Schema.string().description('**身份**：description 的第一句'),
                personality: textarea().description('**自我定位**：personality 的第一段'),
                reply_style: textarea().description('**说话方式**：post_history_instructions 的第一段'),
                redlines: Schema.object({
                    keywords: Schema.array(Schema.string()).description('**不接的话题**'),
                    note: textarea().description('**碰到这类话题怎么办**'),
                }),
            }),
            get: d => ({ name: d.name, identity: d.identity, personality: d.personality, reply_style: d.reply_style, redlines: d.redlines }),
            set: (d, v) => { Object.assign(d, v); },
        },
        { key: 'traits', label: '性格', schema: fields(true, '**性格**：进 personality，按档位过滤'), get: d => ({ fields: d.traits }), set: (d, v) => { d.traits = v.fields; } },
        ...SECTIONS.map(([key, title]) => ({
            key, label: title,
            schema: fields(true, `**${title}**：description 里的一段，按档位过滤；键名只是标识`),
            get: d => ({ fields: d.sections[key] }),
            set: (d, v) => { d.sections[key] = v.fields; },
        })),
        { key: 'social', label: '对各档的说话方式', schema: fields(false, '**对各档的说话方式**：档位页里的「说话方式」指向这里的键'), get: d => ({ fields: d.social }), set: (d, v) => { d.social = v.fields; } },
    ];
}

export function tierSections(source) {
    const socialKeys = Object.keys(source.persona.social);
    const labels = [...new Set(source.scenes.flatMap(s => s.tiers))];
    const tierSchema = Schema.object({
        name: Schema.string().disabled().description('**档位**：名字不能改（运行时按名字找卡）'),
        user_is: textarea().description('**对方是谁**：scenario 的第一句'),
        knows_him: Schema.boolean().description('**知道她有男朋友**：description 开头说明「他」是男朋友'),
        social: Schema.union(socialKeys.map(key => Schema.const(key))).description('**说话方式**：用人设里「对各档的说话方式」的哪一条（和下面的「直接写」二选一）'),
        social_text: textarea().description('**说话方式（直接写）**'),
        discreet: Schema.boolean().description('**加上「通用」里那句**：不知道她有男朋友的档位'),
        scenes: Schema.union(labels.map(label => Schema.const(label))).description('**世界书用哪个场景档的场景**'),
        drop_scenes: Schema.array(Schema.string()).description('**去掉的场景**：场景 id'),
        demeanor: textarea().description('**分寸**：放进 post_history_instructions，离回复最近'),
        examples: Schema.array(Schema.array(Schema.string()).description('第一行是对方说的，后面是她的几行（每行发成一条 QQ 消息）')).description('**示例对话**'),
        banned: Schema.array(Schema.string()).description('**禁用词**：这一档的卡、作息、世界书正文里不能出现；也是出口检查的词表'),
        note: note(),
    });
    return [
        {
            key: '__common', label: '通用',
            schema: Schema.object({
                discreet: Schema.object({
                    text: textarea().description('**不知道她有男朋友的档位，scenario 末尾的那句**'),
                    note: note(),
                }),
            }),
            get: d => ({ discreet: d.discreet }),
            set: (d, v) => { d.discreet = v.discreet; },
        },
        ...source.tiers.tiers.map((tier, i) => ({
            key: tier.name, label: tierLabel(tier.name), schema: tierSchema,
            get: d => d.tiers[i],
            set: (d, v) => { d.tiers[i] = v; },
        })),
    ];
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KIND_LABELS = { hard: '硬课', machine: '上机', water: '水课', pe: '体育' };
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function scheduleSections(source) {
    const names = tierNames(source);
    const slots = Object.keys(source.schedule.periods);
    const byTier = description => Schema.array(Schema.object({
        tiers: tierBoxes(names).description('**这几档**'),
        text: Schema.string().description('**说法**'),
    })).description(`${description}：每个档位恰好出现一次`);
    return [
        {
            key: 'time', label: '作息时间',
            schema: Schema.object({
                sleep: Schema.string().pattern(TIME).description('**几点睡**：睡到「平时几点起」'),
                wakeup: Schema.object({
                    early: Schema.string().pattern(TIME).description('**有早课时几点起**'),
                    lazy: Schema.string().pattern(TIME).description('**平时几点起**'),
                }),
                semester: Schema.object({
                    start: Schema.string().pattern(DATE).description('**开学**：第 1 周的第一天，YYYY-MM-DD'),
                    weeks: Schema.natural().description('**一学期几周**'),
                }),
                periods: Schema.dict(Schema.string().pattern(/^\d\d:\d\d-\d\d:\d\d$/)).description('**节次**：键是节次（例如 1-2），值是 HH:MM-HH:MM'),
            }),
            get: d => ({ sleep: d.sleep, wakeup: d.wakeup, semester: d.semester, periods: d.periods }),
            set: (d, v) => { Object.assign(d, v); },
        },
        {
            key: 'courses', label: '课表',
            schema: Schema.object({
                courses: Schema.array(Schema.object({
                    name: Schema.string().description('**课名**'),
                    day: Schema.union(WEEKDAYS.map((label, i) => Schema.const(i + 1).description(label))).description('**星期**'),
                    slot: Schema.union(slots.map(slot => Schema.const(slot))).description('**节次**：在「作息时间」里加了新节次，保存后才能选'),
                    room: Schema.string().description('**教室**'),
                    kind: Schema.union(Object.entries(KIND_LABELS).map(([kind, label]) => Schema.const(kind).description(label))).description('**课型**'),
                    weeks: Schema.string().description('**哪几周**：例如 1-16、1-8,10-16'),
                    practice: Schema.natural().description('**第几周起改在机房上**：没有就空着'),
                    practice_room: Schema.string().description('**机房**'),
                })).description('**课**'),
            }),
            get: d => ({ courses: d.courses }),
            set: (d, v) => { d.courses = v.courses; },
        },
        {
            key: 'holidays', label: '假期和调休',
            schema: Schema.object({
                holidays: Schema.array(Schema.object({
                    name: Schema.string().description('**假期**'),
                    start: Schema.string().pattern(DATE).description('**从**'),
                    end: Schema.string().pattern(DATE).description('**到**'),
                    where: byTier('**放假时她在哪**（不写就只说放假）'),
                    partner: Schema.string().description('**放假时他在哪**：只给「他在哪」那几档（按档位的说法里）；{{user}} 换成称呼'),
                    partner_back: Schema.string().description('**放完假 7 天内他在哪**'),
                    note: note(),
                })).description('**假期**'),
                makeups: Schema.array(Schema.object({
                    date: Schema.string().pattern(DATE).description('**调休日**'),
                    as_day: Schema.union([Schema.const(0).description('没定（按没课）'), ...WEEKDAYS.map((label, i) => Schema.const(i + 1).description(`补${label}的课`))]).description('**补哪天的课**'),
                    note: note(),
                })).description('**调休**'),
            }),
            get: d => ({ holidays: d.holidays, makeups: d.makeups }),
            set: (d, v) => { Object.assign(d, v); },
        },
        {
            key: 'free', label: '空闲活动',
            schema: Schema.object({
                free: Schema.array(Schema.object({
                    window: Schema.union([Schema.const('morning').description('上午'), Schema.const('afternoon').description('下午'), Schema.const('evening').description('晚上')]).description('**时段**'),
                    text: Schema.string().description('**做什么**'),
                    tiers: tierBoxes(names).description('**给哪些档位**：一个都不勾 = 所有档位都能看到'),
                    note: note(),
                })).description('**没课时她在做什么**'),
            }),
            get: d => ({ free: d.free }),
            set: (d, v) => { d.free = v.free; },
        },
        {
            key: 'tiers', label: '按档位的说法',
            schema: Schema.object({
                course_detail: Schema.object({
                    tiers: tierBoxes(names).description('**课名、教室、课型叫法给哪些档位**：其他档位只知道「在上课」'),
                    note: note(),
                }),
                where: Schema.object({ by_tier: byTier('**上学期间她在哪**'), note: note() }),
                partner: Schema.object({
                    text: Schema.string().description('**上学期间他在哪**：{{user}} 换成称呼'),
                    tiers: tierBoxes(names).description('**「他在哪」给哪些档位**（假期里的也是）'),
                    note: note(),
                }),
                kinds: Schema.object(Object.fromEntries(Object.entries(KIND_LABELS).map(([kind, label]) => [kind, Schema.object({
                    label: Schema.string().description(`**${label}的叫法**`),
                    see_after: Schema.tuple([Schema.natural(), Schema.natural()]).description('**上课时过多少分钟才看到消息**：[最少, 最多]'),
                    max_bubbles: Schema.natural().description('**最多回几条**'),
                })]))).description('**课型**'),
                kinds_note: note(),
            }),
            get: d => ({ course_detail: d.course_detail, where: d.where, partner: d.partner, kinds: d.kinds, kinds_note: d.kinds_note }),
            set: (d, v) => { Object.assign(d, v); },
        },
    ];
}
