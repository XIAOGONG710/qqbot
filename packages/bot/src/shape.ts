// 形状控制（配置 shape，默认关）：按他这一轮说了多长，定她这一轮每条最多几个字、最多几条，并在发出去之前强制执行。
// 为什么：10-20 重算她的聊天记录，每条气泡中位 16 字、几乎全在 13–19 字之间，1–4 字的占 0%，真人是中位 6–7 字、长短不齐的重尾，
// 而且真人会跟着对方的长短走（他发 5 个字她也只回几个字）。「回短一点」只是提示词里的一句软话（shortReplies），模型不听；
// 这里换成具体的数字（每条不超过 N 个字，最多 M 条），超了重写一次，还超就在分句处截断。
// 数字不是编的：气泡字数档按真人聊天（情侣截图 482 个气泡 + 他自己发的话）的分布取，档的权重再按他这一轮的长短挪一挪。
// 不适用：主动找他、收尾、他明着让她讲、危机回合（调用方不传）。他在难受、报大事、等安慰、问起她认识的人时只用长的几档（不会只回两个字）。

import { ASKS_TO_EXPLAIN, saidSinceReply, unit, WORRIED_TEXT, type LengthContext } from './expression.ts';

export type ShapeKind = 'micro' | 'short' | 'medium' | 'long' | 'wide';

export interface ShapePlan {
    kind: ShapeKind;
    /** 每条最多几个字 */
    cap: number;
    /** 最多几条 */
    maxBubbles: number;
    /** 这一轮顺着他说，不驳他、不损他、不嘴硬（亲近的轮次除外：那条意图行里本来就有“再自然地保留一点嘴硬”） */
    plain?: boolean;
    /** 这一轮答完他的话之后，顺带说一件她自己今天的小事（配置 shapeAgenda）；这样的轮次至少 medium、至少 2 条，不再“顺着说” */
    agenda?: boolean;
    /** 这一轮只回一条不带内容的话（配置 shapeFiller，ADR 0095）：应一声 / 笑一下 / 拖个长音 / 叹一句自己此刻的状态；第一次重放里只说“不带内容”，她回的是短但有内容的顶嘴（「才没有」「包你满意」），所以直接定下是哪一种 */
    filler?: FillerKind;
    /** 他在用「～」或拖长音说话，这一轮她也可以拖个音（配置 shapeFiller） */
    stretch?: boolean;
    /** 这一轮语气松一点，句尾可以带个「～」或「……」（不管他拖没拖音；配置 shapeFiller，ADR 0098） */
    drawl?: boolean;
    /** 这一轮先说自己对他的一点小情绪，不把他的话处理完（配置 shapeFeel，ADR 0099）：撒娇要确认 / 夸张装崩溃 / 小委屈 / 不讲理地考验他，挑哪一种看他刚说的话 */
    feel?: boolean;
    /** 他要是在说她的不是 / 叮嘱她 / 拿她开玩笑，别一本正经地认错、答应改（配置 shapeFeel，ADR 0099）：提示词里加一句，顺着他玩或带点委屈 */
    pushback?: boolean;
    /** 带自己的事的轮次里这一次说哪一件（「作业」「天气」「身体」……，按轮抽，跳过她已经主动说过的）；调用方没给候选就没有，由模型自己挑 */
    agendaTopic?: string;
    /** 这一轮要分成几条发（配置 shapeSplit，ADR 0096）：不只是上限，提示词里写“分成 N 条”；没有就按 maxBubbles 当上限 */
    parts?: number;
}

/**
 * 顺着说的轮次占比。10-21 在他真实发的话上重放：变短之后她的短回复里 12% 以“不好笑”“随你”“想得美”“没你个头”这类驳回开头（真人接话只有 3%），
 * 回一两个字的只有真人的一半、带笑的更少——短被“嘴硬”填满了。真人的短回复更多是应一声、附和、笑一下、问一个字
 */
export const PLAIN_SHARE = 0.7;

/**
 * 带自己的小事的轮次占比（只在适用的轮次里算：不是收尾、不是认真接话、不是亲近、不是心情安静）。10-21 用同一把尺子量真人女生一侧：
 * 30% 的轮次里她会带上和他刚说的话无关的、自己的事；她的回复在旧代码是 19%，开了形状控制后降到 12–15%（压短时顺带压掉了“补一句自己的事”）。
 * 取 0.25，不是 0.3：她的“自己的事”只能从她那边已有的事实 / 心情 / 身体里挑（不编），连着说同一件事会像复读。
 * 10-21 第一次重放（0.2，没限意图）：带事的轮次里 89% 真说了一件她那边的事、只有 6% 带问号，但自带议程只从 15% 涨到 19%，而且他问了问题时
 * （意图行写着「不另起话题」）后面挂一句「刚喂了土豆」很生硬——真人的自带议程在他问问题时只有 17%、不问时 34%，所以只在意图行不拦着的轮次里加
 */
export const AGENDA_SHARE = 0.25;

/**
 * 废话轮次占比（ADR 0095）。10-21 在真人女生样本（120 轮）、他自己的线上聊天（393 轮）和她的线上回复（393 轮）上量：整轮只有笑 / 语气词 / 应一声 / 「无聊」「好困」的，
 * 真人女生 5%、他本人 1.3%、她 0.5%；含这类气泡的 10% / 5.9% / 0.5%。样本小且偏冲突片段、词表是精确匹配，绝对数偏低，所以取 0.07，只在适用的轮次里算
 */
export const FILLER_SHARE = 0.1; // 10-22 晚上从 0.07 调到 0.1，和 FEEL_SHARE 一起量过（真人整轮废话 5%、含废话的 10%，样本小，取偏高的一端）
/** 他在拖音时她跟着拖的比例。他自己的话里 26% 的轮次带「～」或拖音，她的线上回复只有 1.5% */
export const STRETCH_SHARE = 0.6;
export type FillerKind = 'ack' | 'laugh' | 'drawl' | 'state';
/** 各种废话的占比。真人女生样本里整轮废话的多半是应一声 / 语气词和“没事”“不知道”这类，笑最少；她线上一个都没有 */
const FILLER_KINDS: readonly [FillerKind, number][] = [['ack', 0.35], ['laugh', 0.25], ['drawl', 0.2], ['state', 0.2]];
/** 他在拖音：「～」，或者拖长的语气词。「呜呜」是难受 / 撒娇、「哈哈哈」是笑，不算拖音（第一次重放里她对每个「呜呜呜」都回了带～的话） */
/**
 * 他自己线上的话 11% 带「～」或「…」（拖音 / 省略），她 0%（10-22 用线上 505 条他的话、81 条形状控制后她的气泡量）。
 * 不管他有没有先拖音，约 12% 的轮次（不是认真接话 / 收尾 / 他说倒霉事时）提示她语气可以松一点；真模型多半会照做一部分，目标是气泡里 5–8%
 */
export const DRAWL_SHARE = 0.12;
/**
 * 情绪轮占比（ADR 0099），只在适用的轮次里算（和 filler 一样的“自由”轮次：意图行不拦着、他不在难受 / 撒娇 / 收尾）。
 * 10-22 在 72 对真人情侣聊天上带上文重放（她和真人回复同一个标注员分类）：真人女生 38% 的回复主要在表达自己对他 / 这件事的情绪或态度
 * （要抱抱、问他想不想自己、夸张地装崩溃、小委屈、考验他），她 25%；她的回复里“把他的话处理完整”的 39%（真人 22%）、主动补一个他没问的细节 36%（真人 21%）、
 * 俏皮话 28%（真人 17%）都偏多。真人这些话不讲道理、不体贴地处理事情——“嗯那我不活了”“你就是不信我”“要你要你”，她的是“那你快去别迟到”“行那我多动动”“是是是行了吧”。
 * 取 0.18：自由轮次约占六成，折成整体约 11%，再加上卡里本来就有的脾气
 * 10-22 晚上调到 0.3（带上文重放 216 条，herNo 同开）：带情绪 25% → 35%（真人 38%）、答得完整 44% → 39%（真人 23%）、补细节 31% → 26%（真人 20%）；让步 13% 没动
 *（让步是他批评 / 叮嘱她时的“好好好我改”，要靠 herNo 的“被磨时守着”和下一个版本的措辞，不靠这个比例）
 */
export const FEEL_SHARE = 0.3;
/** 情绪轮只在他说得不长的时候出现：他发了一大段在讲事，她转头撒娇是没在听 */
const FEEL_MAX_HIS = 40;
/**
 * 他自己情绪不对 / 想一个人待着 / 不舒服的话：这时她转头撒娇或闹情绪是没在听（10-22 重放里「我情绪不对你就别问了，你就晾我一会」那一轮抽到了情绪轮）。
 * 意图行 / WORRIED_TEXT / NEGATIVE 认不出这几类，只管情绪轮，宁可多排除
 */
const HIS_LOW = /情绪不对|情绪不好|别问|晾我|想静静|一个人待|烦心|压力|崩溃|撑不住|不舒服|生病|发烧|头疼|肚子疼|哭了|心里难受|低落|累死|好累/;
const STRETCHED = /[～~]|[啊哦嗯诶]{3,}/;
/** 废话轮次只在他说得短的时候出现：他发了一大段，她回「哈哈哈」就是敷衍 */
const FILLER_MAX_HIS = 12;
/**
 * 意图行不拦着她说自己的事的轮次：没有意图行，或者「回应他刚说的那件事」。别的意图行都明着不让另起话题 / 转去讲自己（回答问题、他的好事、答应的事、
 * 忙着、两个人的事、她那边的事还没说过——那条本来就让她接着说），加上去会和意图行打架
 */
const AGENDA_INTENT = /回应他刚说的那件事/;
/** 他在撒娇 / 呜呜 / 哭的话（不一定被“难过”的意图行认出来，比如玩笑式的「呜呜呜」）：这时转头说自己的事很冷，10-21 第二次重放里「呜呜呜」后面挂「我刚下楼喂土豆来着」 */
const EMOTIVE = /呜|嘤|哭/;
/**
 * 他在说倒霉事 / 难受的事（意图行不一定认得出：「悲，U盘坏了」第二次起的重放里她回「U盘坏了？里面的东西还读得出来不 / 我这边在捣鼓新相机」，他在难受她转头说自己的事）：
 * 这时不带自己的事、不只回一个词。只管 agenda / filler 两个开关，宁可多排除
 */
const NEGATIVE = /悲(?![剧观壮])|惨|倒霉|坏了|丢了|摔了|挂科|没过|被骂|心情不好|不开心|失眠|难受|烦/;

const BUCKETS: readonly { kind: ShapeKind; cap: number }[] = [
    { kind: 'micro', cap: 4 }, { kind: 'short', cap: 8 }, { kind: 'medium', cap: 14 }, { kind: 'long', cap: 24 }, { kind: 'wide', cap: 40 },
];

/** 各档权重（和为 1）：按他这一轮说了几个字挪。基线 ≈ 真人每条的分布（≤4 字约四分之一、≤8 字过半、≤14 字约八成） */
const WEIGHTS = {
    tiny: [0.4, 0.35, 0.18, 0.06, 0.01],
    base: [0.25, 0.3, 0.27, 0.14, 0.04],
    talky: [0.12, 0.25, 0.33, 0.25, 0.05],
    long: [0.06, 0.15, 0.3, 0.34, 0.15],
} as const;
/** 要认真接话的轮次只用后三档（不能只回两个字） */
const ENGAGED_WEIGHTS = [0, 0, 0.45, 0.4, 0.15] as const;
/** 亲近 / 撒娇的轮次：真人这时也是短短的几句（抱抱、想你），但不回「嗯」 */
const INTIMATE_WEIGHTS = [0, 0.35, 0.4, 0.2, 0.05] as const;
/**
 * 现有的「认真接话」名单（ENGAGED_INTENT）把「回应他刚说的那件事」也算进去了，而这是最常见的意图行——10-21 模拟里 104 轮有 72% 落在名单里，
 * 极短的两档只剩 28%（该有 55%），这也是 shortReplies 一直压不下来的原因。这里只把真正要有内容的拆出来：难受、报好事、等他的解释
 */
const SUBSTANTIVE_INTENT = /先接住他此刻的情绪|他刚说了件好事|他到现在才看到你前面发的|他在问一个很大、很抽象的问题|他在追你要一个答案|他在问你今天过得怎么样/;
const INTIMATE_INTENT = /只接他刚说的你们两个人的事|他在向你要亲近|他在撒娇要你哄他/;
/**
 * 收尾的意图行是「顺着他的话收尾，只回一两句」。不能像 lengthHint 那样看有没有「收尾」两个字：亲近那条意图行里写着「他真要收尾时回应后顺着收尾」，
 * 会被当成收尾——10-21 模拟里亲近的 35 轮因此一轮形状也没有，shortReplies 在这类轮次也一直没起作用
 */
const CLOSING_INTENT = /顺着他的话收尾/;
/** 收尾的轮次：真人这时就是一两个字（晚安、好哒、嗯嗯） */
const CLOSING_WEIGHTS = [0.4, 0.4, 0.15, 0.05, 0] as const;

/** 各种轮次的占比（调参用：模拟器的场景里可以改，线上用上面的常量）；不写的用默认 */
export interface ShapeShares { feel?: number; filler?: number; agenda?: number; plain?: number }

export type ShapeContext = Pick<LengthContext, 'history' | 'intent' | 'initiating' | 'low' | 'aboutPerson'> & { shares?: ShapeShares; agenda?: boolean; filler?: boolean; feel?: boolean; split?: boolean; agendaTopics?: readonly string[] };

const chars = (text: string) => [...text.replace(/\[[^\]]{1,6}\]/g, '#')].length;

/** 这一轮的形状；不适用返回 undefined（调用方照旧用 lengthHint） */
export function planShape(context: ShapeContext): ShapePlan | undefined {
    if (context.initiating) return undefined;
    const last = context.history.findLast(message => message.role === 'user');
    if (!last) return undefined;
    if (ASKS_TO_EXPLAIN.test(last.content)) return undefined;
    const said = saidSinceReply(context.history);
    const his = chars(said);
    const closing = Boolean(context.intent && CLOSING_INTENT.test(context.intent));
    const engaged = !closing && Boolean((context.intent && SUBSTANTIVE_INTENT.test(context.intent)) || WORRIED_TEXT.test(said) || context.aboutPerson);
    const intimate = !closing && !engaged && Boolean(context.intent && INTIMATE_INTENT.test(context.intent));
    let weights: readonly number[] = closing ? CLOSING_WEIGHTS : engaged ? ENGAGED_WEIGHTS : intimate ? INTIMATE_WEIGHTS : his <= 3 ? WEIGHTS.tiny : his <= 10 ? WEIGHTS.base : his <= 25 ? WEIGHTS.talky : WEIGHTS.long;
    // 心情安静、身体不舒服：往短里挪一点（话少、不展开），不用到最长的两档
    if (context.low && !engaged) weights = weights.map((weight, i) => weight * [1.5, 1.3, 1, 0.5, 0.2][i]!);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const key = `${last.time ?? ''} ${last.content}`;
    const roll = unit(`${key} shape`) * total;
    let acc = 0;
    let rolled = weights.length - 1;
    for (const [i, weight] of weights.entries()) {
        acc += weight;
        if (roll < acc) { rolled = i; break; }
    }
    // 意图行不拦着、他不在难受 / 撒娇 / 收尾：她可以带自己的事，也可以只回一条废话
    const free = (!context.intent || AGENDA_INTENT.test(context.intent)) && !EMOTIVE.test(said) && !NEGATIVE.test(said) && !closing && !engaged && !intimate && !context.low;
    const stretch = Boolean(context.filler) && !closing && !engaged && STRETCHED.test(said) && unit(`${key} shape stretch`) < STRETCH_SHARE;
    const drawl = Boolean(context.filler) && !stretch && !closing && !engaged && !NEGATIVE.test(said) && !EMOTIVE.test(said) && unit(`${key} shape drawl`) < DRAWL_SHARE;
    // 废话轮次：他的话短、不是问句，她就只回一条几个字、不带内容的
    if (Boolean(context.filler) && free && his <= FILLER_MAX_HIS && !/[？?]/.test(said) && unit(`${key} shape filler`) < (context.shares?.filler ?? FILLER_SHARE)) {
        const pick = unit(`${key} shape filler kind`);
        let acc = 0;
        const kind = FILLER_KINDS.find(([, share]) => (acc += share) > pick)?.[0] ?? FILLER_KINDS[FILLER_KINDS.length - 1]![0];
        return { kind: 'micro', cap: 4, maxBubbles: 1, filler: kind, ...(stretch ? { stretch: true } : {}) };
    }
    // 情绪轮：先说自己对他的小情绪，一两句、短的；不带自己的事、不“顺着说”（顺着说的那句写着别驳他别嘴硬，和这里打架）
    if (Boolean(context.feel) && free && his <= FEEL_MAX_HIS && !HIS_LOW.test(said) && unit(`${key} shape feel`) < (context.shares?.feel ?? FEEL_SHARE)) {
        const count = unit(`${key} shape feel count`) < 0.6 ? 1 : 2;
        return { kind: 'short', cap: 10, maxBubbles: count, feel: true, ...(drawl ? { drawl: true } : {}) };
    }
    // 不马上让步：和情绪轮同一个开关。不是收尾 / 认真接话 / 亲近的轮次，提示词里加一句“他说你的不是时别一本正经认错”
    const pushback = Boolean(context.feel) && !closing && !engaged && !intimate;
    const agenda = Boolean(context.agenda) && free && unit(`${key} shape agenda`) < (context.shares?.agenda ?? AGENDA_SHARE);
    // 带自己的事的轮次至少 medium：两三个字的档装不下“回完他的话再说一件自己的事”
    const bucket = BUCKETS[agenda ? Math.max(rolled, 2) : rolled]!;
    const countRoll = unit(`${key} shape count`);
    // 一轮几条：真人 1 条 51–65%、2 条 22–28%、3 条以上约 15–20%；极短的一档多半只发一条
    const rolledBubbles = closing ? (countRoll < 0.7 ? 1 : 2) : bucket.kind === 'micro' ? (countRoll < 0.8 ? 1 : 2) : countRoll < 0.55 ? 1 : countRoll < 0.83 ? 2 : 3;
    const maxBubbles = agenda ? Math.max(2, rolledBubbles) : rolledBubbles;
    const plain = !agenda && !intimate && unit(`${key} shape plain`) < (context.shares?.plain ?? PLAIN_SHARE);
    // 要分成几条：上面抽出来的条数本来只是上限，真模型多半只写一行（重放里 85% 是 1 条，真人女生 59%）；开了 shapeSplit 就把它当成目标写进提示词
    // 带自己的事的轮次：这一次说哪一件，按轮抽（同一轮每次一样）。10-22 用 72 句真人对话测：开了带事以后 21% 的回复提到相机 / 土豆 / 作业 / 快递（没开 7%），其中相机一件就 14%，模型总挑同两件
    const topics = context.agendaTopics ?? [];
    const agendaTopic = agenda && topics.length ? topics[Math.floor(unit(`${key} agenda topic`) * topics.length)] : undefined;
    const parts = Boolean(context.split) && !closing && bucket.kind !== 'micro' && maxBubbles >= 2 ? maxBubbles : undefined;
    return { kind: bucket.kind, cap: bucket.cap, maxBubbles, ...(plain ? { plain: true } : {}), ...(pushback ? { pushback: true } : {}), ...(agenda ? { agenda: true } : {}), ...(agendaTopic ? { agendaTopic } : {}), ...(stretch ? { stretch: true } : {}), ...(drawl ? { drawl: true } : {}), ...(parts ? { parts } : {}) };
}

/** 顺着说的那一句：给方向（应一声、附和、笑、接他的话、问一个字），不给台词 */
const PLAIN_NOTE = '；这一轮顺着他说就行：应一声、附和、笑一下、接他的话都可以，别反驳他、别损他、别嘴硬，也别用反问句回他；他用了网络缩写（zdjd、xswl 这类）你也可以顺着用';

/**
 * 不马上让步那一句（ADR 0099，挂在 shapeFeel 上）。10-22 带上文重放 72 对真人情侣聊天：「顺从 / 让步 / 认错 / 答应照他说的做 / 马上附和他的批评或建议」
 * 真人 4%（轻松的 2/46），她约 20%（轻松的 13%、冲突里 40%）：「那我跟着你练」「行，那我多动动」「好啦，不闹了」「好好好我注意」，真人是「嗯那我不活了」「不找就不找」「哎算了」。
 * 不写成“顶回去”：ADR 0091 的教训是短回复被「不好笑」「随你」这类驳回填满。这里只说别一本正经地认错 / 答应，往情绪那边走（玩笑式的夸张或委屈）
 */
const PUSHBACK_NOTE = '；他要是在说你的不是、叮嘱你或拿你开玩笑，别一本正经地认错、答应改、保证以后——顺着他玩（夸张地装崩溃、装可怜）或者带点委屈就行';

/** 带自己的事的那一句：事实只能从她那边已有的事实 / 身体 / 心情里挑，没有合适的就不说；不给台词，也不让她拿这件事去问他 */
const agendaNote = (topic?: string) => topic ? `；这一轮先回他刚说的，回完顺带说一句你自己的事，就说「${topic}」这一件（看「你那边」「你的身体」「你今天的心情」里对应的那一行，没写的细节不编；说过的别再说，他早知道的不用说）：随口说，像突然想起来的，不用接得很圆，也不用每次都从「刚」开头；说完不用问他，也别用反问句` : AGENDA_NOTE;
const AGENDA_NOTE = '；这一轮先回他刚说的，回完顺带说一句你自己的事：从「你那边」「你的身体」「你今天的心情」里挑一件他还不知道的（不是你正在做的那件事，他早知道了；前面说过的也别再说），事，或者此刻的感受：累、困、饿、烦、开心都行，随口说，像突然想起来的，不用接得很圆，也不用每次都从「刚」开头；那里没有合适的就别说，更别编；说完不用问他，也别用反问句';

/**
 * 分成几条的那一句：真人多条回复多半是一个意思拆成几个小片段（反应 → 补一句想法 / 细节 / 一个小问题），不是把一句话硬断开。
 * 小问题是真想知道的（「哪个手指头啊」），不是反问；顺着说的轮次里“别用反问句”照旧
 */
const splitNote = (parts: number) => `；这一轮分成 ${parts} 条发，一条一行：每条是一个小意思，不是把一句话硬断成两截——先一条反应或回答，后面接一句补充（想法、细节、理由；真有想知道的才问他一个小问题，不是反问，没有就别硬问）`;

/** 他在拖音：给方向，不给台词 */
const DRAWL_NOTE = '；这一轮语气松一点：句尾可以带个「～」或者「……」，拖个音、留半句，别每句都这样';
const STRETCH_NOTE = '；他在用「～」或拖长音说话，你也可以拖个音（句尾加～、叠个字），别每句都拖';

/**
 * 废话轮次那一行：定下是哪一种，只回一条、不超过 4 个字、什么内容也不带；不问他、不解释、不顶嘴。词只给“这一类里有哪些”，让她自己选，不给整句台词；
 * 状态那一种要和她此刻对得上（不是饭点说饿、大白天说困）
 */
const FILLER_LINES: Record<FillerKind, string> = {
    ack: '只应一声：嗯、哦、好吧、行这一类里选一个，别的什么都不说',
    laugh: '只笑一下：哈哈、嘿嘿、笑死这一类里选一个，别的什么都不说',
    drawl: '只拖个长音或者叹一声：啊啊啊、哎、唉这一类里选一个，别的什么都不说',
    state: '只说一下你此刻的状态，一个词就行：困、饿、无聊这一类，要和你这会儿对得上，别的什么都不说',
};
const fillerLine = (kind: FillerKind) => `[这一轮说话：只回一条，不超过 4 个字，${FILLER_LINES[kind]}；不问他，不解释，不顶嘴，不另起话题。他在难受、报大事、等安慰或闹别扭时不适用，照平常的说`;

/**
 * 情绪轮那一行（ADR 0099）：只给“他说了什么 → 她这一轮是哪种情绪”，不给台词；挑哪一种让模型看他刚说的话。
 * 夸张装崩溃那一种明写“玩笑里的夸张，不涉及伤害自己”：真人会说“我不活了”，但她的话进危机检测之前不该出现这类字眼
 */
const FEEL_NOTE = '这一轮不用把他的话回应完整，先说你此刻对他的一点小情绪，看他刚说的话挑一种最搭的：他说想你、亲你、抱你，就撒个娇，向他要点亲近或确认（想不想你、想了多少、要不要抱）；他戳到你的短处、拿你开玩笑，就夸张地装崩溃、装可怜（玩笑里的夸张，不是真的难过，更不涉及伤害自己）；他回得短、敷衍、不上心，就小声委屈或赌气地嫌他一句；他夸口、立保证，就不讲理地考验他一下；他夸你、说到让你不好意思的事，就害羞地嘴硬、岔开；他说的话让你有点泄气，就叹一声、算了。不讲道理，不解释，不安慰他，不去追问他；实在和他刚说的话搭不上，就照平常回';

/** 放进提示词的一行；不给台词，只给数字和方向 */
export function describeShape(plan: ShapePlan): string {
    if (plan.filler) return `${fillerLine(plan.filler)}${plan.stretch ? STRETCH_NOTE : ''}]`;
    if (plan.feel) return `[这一轮说话：${plan.maxBubbles === 1 ? '只回一条' : `最多 ${plan.maxBubbles} 条`}，每条不超过 ${plan.cap} 个字；${FEEL_NOTE}${plan.drawl ? DRAWL_NOTE : ''}]`;
    const split = plan.parts && !plan.agenda ? splitNote(plan.parts) : '';
    const plain = (plan.agenda ? agendaNote(plan.agendaTopic) : plan.plain ? PLAIN_NOTE : '') + (plan.pushback ? PUSHBACK_NOTE : '') + split + (plan.stretch ? STRETCH_NOTE : plan.drawl ? DRAWL_NOTE : '');
    const count = plan.parts ? `分成 ${plan.parts} 条发` : `最多 ${plan.maxBubbles} 条`;
    if (plan.kind === 'micro') {
        return `[这一轮说话：${plan.maxBubbles === 1 ? '只回一条' : `最多 ${plan.maxBubbles} 条`}，每条不超过 ${plan.cap} 个字——语气词、单个词都可以，不用凑成完整的句子；不展开，不另起话题。他在难受、报大事、等安慰或闹别扭时不适用，照平常的说${plain}]`;
    }
    if (plan.kind === 'short') {
        return `[这一轮说话：每条不超过 ${plan.cap} 个字，${count}；像手机上随手打的，半句也行，不用凑成完整的句子；不展开，不另起话题${plain}]`;
    }
    return `[这一轮说话：每条不超过 ${plan.cap} 个字，${count}；想到哪说到哪，不用把话说圆${plain}]`;
}

// ───────── 强制执行 ─────────

const STICKER_LINE = /^<sticker:[a-f0-9]{12}>$/i;
/** 超出多少算「太长」：给一点余地，免得 9 个字的话为了 8 的上限被砍 */
const slack = (cap: number) => Math.max(2, Math.ceil(cap * 0.35));
const limitOf = (plan: ShapePlan) => plan.cap + slack(plan.cap);
const BOUNDARY = /[，,。！!？?～~…、；;\s]/;

function lines(reply: string): string[] {
    return reply.split('\n').map(line => line.trim()).filter(Boolean);
}

/** 哪些行太长 / 条数超了 */
export function shapeProblems(reply: string, plan: ShapePlan): { tooLong: number; tooMany: number } {
    const text = lines(reply).filter(line => !STICKER_LINE.test(line));
    return { tooLong: text.filter(line => chars(line) > limitOf(plan)).length, tooMany: Math.max(0, text.length - plan.maxBubbles) };
}

/** 把一行截到上限以内，只在分句处截（不拦腰截断一个词）；找不到分句处就原样留着。返回 undefined = 没截 */
function cutLine(line: string, limit: number): string | undefined {
    const list = [...line];
    for (let end = Math.min(list.length - 1, limit); end >= 2; end--) {
        if (!BOUNDARY.test(list[end]!)) continue;
        const head = list.slice(0, end).join('').replace(/[，,、；;\s]+$/, '');
        if (chars(head) >= 2) return head;
    }
    return undefined;
}

/** 超出的条数去掉、太长的行在分句处截断；返回处理后的回复和改了什么（给日志） */
export function trimToShape(reply: string, plan: ShapePlan): { reply: string; notes: string[] } {
    const notes: string[] = [];
    let all = lines(reply);
    // 条数只数文字的行：图片表情的指令行不占名额，原样留着
    const textCount = all.filter(line => !STICKER_LINE.test(line)).length;
    if (textCount > plan.maxBubbles) {
        notes.push(`去掉第 ${plan.maxBubbles + 1} 条起的 ${textCount - plan.maxBubbles} 条`);
        let kept = 0;
        all = all.filter(line => STICKER_LINE.test(line) || ++kept <= plan.maxBubbles);
    }
    const limit = limitOf(plan);
    all = all.map(line => {
        if (STICKER_LINE.test(line) || chars(line) <= limit) return line;
        const cut = cutLine(line, limit);
        if (cut) notes.push(`一条 ${chars(line)} 字的截到 ${chars(cut)} 字`);
        else notes.push(`一条 ${chars(line)} 字的找不到分句处，原样留着`);
        return cut ?? line;
    });
    return { reply: all.join('\n'), notes };
}

export interface ShapeDeps {
    /** 在原来的提示词末尾加上这句说明重新生成，返回清理过的回复 */
    regenerate: (note: string) => Promise<string>;
    log: (message: string) => void;
}

/**
 * 夸张装崩溃那一种（情绪轮 / 不马上让步）：真人会说「我不活了」「我死了」，她的话里不要出现这类字眼（ADR 0099）——她是陪伴程序，不拿“不想活”开玩笑；
 * 「笑死了」「累死了」「困死了」这类日常夸张不在内（要“我死了”“想死”“去死”这几个才算）。只在带这类说明的轮次检查
 */
const SELF_HARM_JOKE = /不想活|不活了|活不下去|想死|去死|死了算|自杀|一了百了|我死了|死掉/;
const harmLines = (reply: string, plan: ShapePlan): number => plan.feel || plan.pushback ? lines(reply).filter(line => SELF_HARM_JOKE.test(line)).length : 0;

/** 出口：太长或条数超了、（情绪轮里）出现了拿“不想活”开玩笑的字眼，带说明重写一次；还超就截断，字眼的那几行去掉 */
export async function shapeReply(reply: string, plan: ShapePlan, deps: ShapeDeps): Promise<string> {
    const first = shapeProblems(reply, plan);
    const harm = harmLines(reply, plan);
    if (first.tooLong === 0 && first.tooMany === 0 && harm === 0) return reply;
    deps.log(`形状：${first.tooLong ? `有 ${first.tooLong} 条超过 ${limitOf(plan)} 字` : ''}${first.tooLong && first.tooMany ? '，' : ''}${first.tooMany ? `多了 ${first.tooMany} 条` : ''}${harm ? `${first.tooLong || first.tooMany ? '，' : ''}有 ${harm} 行拿“不想活”开玩笑` : ''}，带说明重写一次`);
    let current = reply;
    const reasons = [
        ...(first.tooLong || first.tooMany ? [`太长了——这一轮每条不超过 ${plan.cap} 个字，最多 ${plan.maxBubbles} 条。意思不变，缩短重写`] : []),
        ...(harm ? ['里面有拿“不想活”“去死”开玩笑的字眼，你是陪伴程序，不拿这个开玩笑。换个夸张的说法（无语、崩溃、丢人、没脸见人这类），意思和语气不变'] : []),
    ];
    try {
        const rewritten = await deps.regenerate(`[上一版回复没有发出去：${reasons.join('；另外')}，只输出要发的消息。]`);
        if (lines(rewritten).length > 0) current = rewritten;
    } catch (error) {
        deps.log(`形状：重写失败（${error instanceof Error ? error.message : String(error)}），直接截断`);
    }
    const trimmed = trimToShape(current, plan);
    if (trimmed.notes.length) deps.log(`形状：${trimmed.notes.join('；')}`);
    if (!harmLines(trimmed.reply, plan)) return trimmed.reply;
    deps.log('形状：重写后还有拿“不想活”开玩笑的字眼，那几行去掉');
    return lines(trimmed.reply).filter(line => !SELF_HARM_JOKE.test(line)).join('\n');
}
