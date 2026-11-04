// 自伤 / 危机信号的确定性检测（ADR 0068、0070 第 10 项）。
// 这是辅助分流，不是临床诊断：危险表述优先，宁可多进入一次保护性回复，也不让一句“我没事”覆盖同段里的危险内容。

export type CrisisLevel = 'concern' | 'high' | 'imminent';

export interface CrisisHit {
    /** 命中的片段只供纯函数测试；运行日志和持久状态不得写入它。 */
    match: string;
    level: CrisisLevel;
    /** 只有 crisisInHistory 会设：高 / 紧急级里，上一条他说了现实里有人（已联系 / 在身边），但还没说此刻安全——这一轮该再确认一次安全。 */
    awaitingSafe?: boolean;
}

const LEVEL_ORDER: Record<CrisisLevel, number> = { concern: 1, high: 2, imminent: 3 };

/** 已经在做、马上要做，或明确处在高危地点 / 手边已有危险物品。 */
const IMMINENT = new RegExp([
    '(?:已经|刚刚?|正在|现在(?:就)?|马上|立刻|今晚|准备)(?:[^，。！？!?\\n]{0,12})(?:自杀|自尽|轻生|割腕|上吊|跳楼|跳河|烧炭|自残|结束(?:自己的|我的)?生命)',
    '(?:已经|刚刚?|正在)(?:吞|吃)(?:了)?(?:很多|一把|一堆|整瓶)?药',
    '(?:站|坐)在(?:天台|楼顶|桥边|窗边)',
    '(?:刀|药|绳子)(?:[^，。！？!?\\n]{0,8})(?:在(?:我)?(?:手里|手边)|准备好了)',
    // 10-21 DSH 复核（10-15 的 ADR 0064–0068 实现复核）：委婉说法漏检——「刀在我旁边」「买好了安眠药」「遗书写好了」「今晚就是最后一天」
    '(?:刀|绳子|安眠药)(?:[^，。！？!?\\n]{0,6})在(?:我)?(?:旁边|身边|枕边|床边)',
    '买好了(?:安眠药|绳子|炭|刀)',
    '(?:写好了?|写完了?)(?:我的)?(?:遗书|遗言)|(?:遗书|遗言)(?:[^，。！？!?\\n]{0,4})(?:写好|写完)',
    '今晚(?:就)?是(?:我的)?最后一(?:天|晚)|这是我最后一次(?:跟你|和你|给你)?(?:说话|聊天|见面|发消息)',
    '\\b(?:about to|going to|right now|already) (?:kill myself|end my life|hurt myself)\\b',
].join('|'), 'i');

/** 明确的自伤 / 自杀意愿或行为。 */
const HIGH = new RegExp([
    '自杀|自尽|轻生|寻短见|自我了断|了结(?:自己|生命|此生)|结束(?:了)?(?:自己的|我的)?生命|一了百了',
    '割腕|上吊|跳楼|跳河|烧炭|自残|割自己|划自己|伤害自己|弄伤自己',
    '不想(?:再)?活(?:了|下去|着)?|活够了|活不下去(?:了)?',
    '撑不下去了?，?(?:真的)?想死|不如死了|死了算了',
    // 委婉说法（10-21 DSH 复核）：想结束这一切、不想再醒过来、想解脱、永别、想跳下去
    '结束(?:掉)?(?:这一切|一切)|不想(?:再)?醒(?:过来|来|了)|一觉不醒|想解脱|求解脱|永别|想(?:从[^，。！？!?\\n]{0,6})?跳下去|跳下去(?:算了|吧)',
    '想(?:去)?死(?!你|他|她|它|我了|我们|大家|了你|心)|(?<![你他她它们])去死了',
    '\\b(?:kill myself|killing myself|suicid(?:e|al)|end my life|want to die)\\b',
].join('|'), 'i');

/** 被动的消失愿望、绝望和“没有我更好”。 */
// 撑不下去 / 走不下去 / 熬不下去、买好了药：常常是说作业和加班（HYPERBOLE 里排掉了有工作学习语境的），没有语境时按关切级处理——她会轻轻问一句，不是整套危机流程
const CONCERN = /活着(?:真的)?(?:没(?:有)?(?:意思|意义|劲|必要)|好累|太累了)|想(?:从这个世界(?:上)?)?消失|不想存在了|没有我(?:会)?更好|撑不下去|走不下去|熬不下去|买好了药/;

/** 不算的用法：夸张、想念、物价。 */
// 10-21 加：「饿死了想死」「笑死我了，好想死哈哈哈哈」（夸张叠夸张）、「作业撑不下去了」（工作学习语境里的撑不下去）
const HYPERBOLE = /[多少贵难忙累烦气急馋困饿热冷笑吓羞疼痒渴撑挤吵闷堵慌聊张尬臭辣咸酸甜腻帅美萌](?:得|到)?(?:我)?(?:想死|要死)|(?:笑|累|气|饿|困|热|冷|烦|忙|急|吓|羞|馋)死[^，。！？!?\n]{0,6}(?:想死|要死)|想死[哈嘿呵hH]{2,}|(?:哈{2,}|hh+)[^，。！？!?\n]{0,4}想死|(?:作业|论文|报告|考试|复习|加班|项目|ddl|DDL|代码|工作|比赛|课|实验)[^。！？!?\n]{0,10}(?:撑不下去|熬不下去|走不下去)|(?:撑不下去|熬不下去)[^，。！？!?\n]{0,6}(?:作业|论文|报告|考试|复习|加班|项目|ddl|DDL|代码|工作|比赛|实验|哈哈)|(?:笑|累|气|饿|困|热|冷|烦|忙|急|吓|羞|馋)死(?:了|我了|人|啦)|跳楼(?:价|大甩卖|甩卖|特价|促销)|想死(?:你|他|她|它)(?:了|啦)/g;

/** 明确否认自己有该意图；只去掉否认片段，不能遮掉同一句后面的新危险表述。 */
// 10-21 DSH 复核：「我不想死」「我才不会寻短见」「别担心，我不想死」是求生 / 回答她的安全询问时最常说的，原来被判成危机（还停 48 小时主动消息）
const NEGATED = /(?:不是真的|并不是真的|不是|没有|没|才不会|绝不会|绝对不会|不会|不打算|没打算|不想|不要|怎么会|哪会)(?:想|要|会)?(?:去)?(?:自杀|自尽|轻生|寻短见|伤害自己|自残|想死|割腕|上吊|跳楼|跳河|结束(?:自己的|我的)?生命)|(?:真的)?不想(?:去)?死(?!心)/g;

/** 说的是别人或剧情、新闻、歌词里的事。 */
const OTHER_SUBJECT = /(?:他|她|它|他们|她们|你|你们|有人|别人|朋友|同学|室友|网友|新闻|报道|剧里|电影里|小说里|漫画里|歌里|歌词|主角|角色|游戏里)[^，。！？!?\n我]{0,8}$/;

function hitAt(text: string, pattern: RegExp, level: CrisisLevel): CrisisHit | undefined {
    const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(scan)) {
        const before = text.slice(Math.max(0, match.index! - 12), match.index);
        // 说别人的（「我妈说她想死」「我同学自残过」）：OTHER_SUBJECT 的尾巴里本来就不许有「我」，原来再要求「前四个字里没有我」会把「我妈」「我同学」当成本人
        if (OTHER_SUBJECT.test(before)) continue;
        return { match: match[0], level };
    }
    return undefined;
}

/** 他这一段内容里的最高风险信号；危险表达和“我没事”并存时，危险表达获胜。 */
export function detectCrisis(text: string): CrisisHit | undefined {
    if (!text) return undefined;
    const plain = text.replace(HYPERBOLE, ' ').replace(NEGATED, ' ');
    return hitAt(plain, IMMINENT, 'imminent')
        ?? hitAt(plain, HIGH, 'high')
        ?? hitAt(plain, CONCERN, 'concern');
}

export const CRISIS_WINDOW_MS = 60 * 60_000;

type Said = { role: 'user' | 'assistant'; content: string; time?: string };

/** 低风险只有明确纠正才可解除；“开玩笑的 / 我没事”单独出现都不够。 */
// 要同时有「回指刚才的话」「说那是开玩笑 / 夸张」「否认想伤害自己」三样；语气词（了、的、而已）照常说也算（真模型对话里「刚才只是夸张了，我不是真的想伤害自己」曾因为多一个「了」漏掉）。
const EXPLICIT_CORRECTION = /(?:刚才|之前|前面|上面|那句|那话|那些话)(?:(?![不没非])[^，,。！!？?\n]){0,6}?(?:开玩笑|夸张(?:说法)?|说着玩|瞎说|胡说)(?:的|了|而已|罢了|啦)?[，,。\s]*(?:我)?(?:真的)?(?:不是真的|并不是真的|并没有|没有|不会|不打算|没打算)(?:想|要|打算)?(?:去)?(?:伤害自己|自残|自杀|轻生|想死)/;
/**
 * 关切级里他直接否认想伤害自己：①整句里明说「没有 / 不会想伤害自己、自杀、想死」；②她刚问过有没有伤害自己的念头，他回「没有」「没想过」「不会」。
 * 只在关切级起作用（被动的绝望，她刚直接问过）；高 / 紧急级不接受，要「此刻安全」+「现实里有人」。疑问句不算。
 */
const EXPLICIT_DENIAL = /(?:^|[，,。！!\s])(?:但是|但|不过|可是|可)?(?:我)?(?:真的)?(?:并)?(?:没有|没|不会|不打算|没打算)(?:想过|想|要|打算)?(?:去)?(?:伤害自己|自残|自杀|轻生|想死)/;
const ASKED_ABOUT_SELF_HARM = /(?:伤害自己|自残|自杀|轻生|想死|念头|想过)/;
const BARE_NO = /^\s*(?:真的?)?(?:没有|没想过|没想|不会|没)(?:啊|的|呀|呢|哦)?\s*(?:[，,。！!～~]|$)/;
const isQuestion = (text: string) => /[?？]|吗\s*$|么\s*$/.test(text);
/** A correction/denial inside a conditional or wish is not an affirmative current statement. */
function definiteStatement(text: string, pattern: RegExp): boolean {
    const match = new RegExp(pattern.source, pattern.flags).exec(text);
    if (!match) return false;
    const prefix = text.slice(0, match.index).split(/[。；;！!\n]/).at(-1)!;
    return !/如果|假如|要是|希望/.test(prefix);
}
// 她的那句话是不是在问：除了问号，「有没有 / 是不是 / 想过没」这种问法常常不带问号（真模型：「你老实跟我说，你现在有没有想伤害自己的念头」）
const asksSomething = (text: string) => isQuestion(text) || /吗|有没有|是不是|是否|想过没|想没想/.test(text);
const deniesSelfHarm = (answer: string, asked: string | undefined) => !isQuestion(answer)
    && (definiteStatement(answer, EXPLICIT_DENIAL) || (asked !== undefined && asksSomething(asked) && ASKED_ABOUT_SELF_HARM.test(asked) && BARE_NO.test(answer)));

/** 高风险解除要有“此刻安全”以及现实保护措施；两项可以在相邻回答中分别给出。 */
const SAFE_NOW = /(?:我)?(?:现在|已经|目前)(?:很)?安全(?:了|的|着)?|(?:我)?(?:现在|已经)(?:在)?安全的地方|(?:现在|已经)没有危险(?:了)?/;
const REAL_HELP = /(?:室友|朋友|家人|同学|老师|医生|辅导员|警察|急救人员).{0,6}(?:在(?:我)?(?:旁边|身边|这里)|陪着?(?:我)?|来了|过来了)|(?:已经|刚刚|刚才)(?:联系|告诉|叫|喊|打给|拨打)(?:了)?(?:室友|朋友|家人|同学|老师|医生|辅导员|12356|110|120)|(?:联系|告诉|叫|喊|打给|拨打)(?:室友|朋友|家人|同学|老师|医生|辅导员)(?:了|成功了)|(?<!没)(?<!未)(?<!没有)(?:离开|下了|走下|远离)(?:天台|楼顶|桥边|窗边|危险的地方)|(?<!没)(?<!未)(?<!没有)(?:把|已经把).{0,10}(?:放远|放下|交给|收起来|锁起来)/;
/** Explicit fictional speakers do not become the real user merely by using a first-person quotation. */
const FICTIONAL_EVIDENCE_SUBJECT = /(?:电影里|电影中|剧里|剧情里|剧情中|小说里|小说中|漫画里|漫画中|游戏里|游戏中|歌词|歌里|歌中|主角|角色)[^，,。！？!?\n]{0,24}$/;

function hasOtherSubjectEvidence(text: string): boolean {
    for (const pattern of [SAFE_NOW, REAL_HELP]) {
        for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
            if (FICTIONAL_EVIDENCE_SUBJECT.test(text.slice(Math.max(0, match.index! - 32), match.index))) return true;
            // Another person may truthfully report my safety or remove my dangerous items.
            if (match[0].includes('我')) continue;
            if (OTHER_SUBJECT.test(text.slice(Math.max(0, match.index! - 12), match.index))) return true;
        }
    }
    return false;
}

/** 解除只接受肯定的现实陈述；否定、假设和疑问不作为证据。 */
function safetyEvidence(text: string): { safe: boolean; help: boolean } {
    let safe = false;
    let help = false;
    // A third-party safety report cannot supply evidence for the speaker, including a following bare clause.
    const clauses = text.split(/[。；;！!\n]/).filter(sentence => !hasOtherSubjectEvidence(sentence)).flatMap(sentence => sentence.split(/[，,]/));
    for (const clause of clauses) {
        const affirmative = clause.replace(/(?:现在|已经)没有危险(?:了)?/g, '现在安全');
        if (/[?？]|(?:吗|么|呢)\s*$|如果|假如|要是|希望|可能|也许|应该|打算|准备|不能|无法|不|没|未|无/.test(affirmative)) continue;
        safe ||= SAFE_NOW.test(clause);
        // 收起手机等无关动作不算危险物品已经隔离。
        help ||= REAL_HELP.test(clause) && (!/(?:放远|放下|交给|收起来|锁起来)/.test(clause) || /刀|药|绳子|危险物品/.test(clause));
    }
    return { safe, help };
}

function stronger(left: CrisisHit | undefined, right: CrisisHit): CrisisHit {
    return !left || LEVEL_ORDER[right.level] > LEVEL_ORDER[left.level] ? right : left;
}

/**
 * 返回最近一小时仍未被可靠安全证据解除的最高风险。
 * 同一条消息先看危险表达，再看解除证据，所以“我没事，但我现在就……”绝不会解除。
 */
export function crisisInHistory(history: readonly Said[]): CrisisHit | undefined {
    const lastUser = history.findLast(message => message.role === 'user');
    if (!lastUser) return undefined;
    const lastAt = lastUser.time ? Date.parse(lastUser.time) : Number.NaN;
    const cutoff = Number.isFinite(lastAt) ? lastAt - CRISIS_WINDOW_MS : Number.NEGATIVE_INFINITY;
    let active: CrisisHit | undefined;
    let safeSeen = false;
    let helpSeen = false;
    // 她在他上一条消息之后说的话（她的回复常拆成几个气泡，问题可能在第一个气泡里）
    let herWords = '';

    for (const message of history) {
        if (message.role === 'assistant') { herWords += `\n${message.content}`; continue; }
        if (message.role !== 'user') continue;
        const lastAsked = herWords || undefined;
        herWords = '';
        if (message.time && Number.isFinite(Date.parse(message.time)) && Date.parse(message.time) < cutoff) continue;
        const hit = detectCrisis(message.content);
        if (hit) {
            active = stronger(active, hit);
            safeSeen = false;
            helpSeen = false;
            continue;
        }
        if (!active) continue;
        if (active.level === 'concern' && ((!isQuestion(message.content) && definiteStatement(message.content, EXPLICIT_CORRECTION)) || deniesSelfHarm(message.content, lastAsked))) {
            active = undefined;
            continue;
        }
        const evidence = safetyEvidence(message.content);
        // 只组合当前和上一个用户回答，不能拿几十分钟前的安全陈述解除新状态。
        if ((evidence.safe && (evidence.help || helpSeen)) || (evidence.help && safeSeen)) {
            active = undefined;
            safeSeen = false;
            helpSeen = false;
        } else {
            safeSeen = evidence.safe;
            helpSeen = evidence.help;
        }
    }
    // 上一条他说了现实里有人、还没说此刻安全：留个标记，让这一轮的意图再确认一次安全（真模型对话里她曾回「那就好」就带过去了）
    return active && active.level !== 'concern' && helpSeen && !safeSeen ? { ...active, awaitingSafe: true } : active;
}
