// 软风格规则（硬编码改造第四批「语言与理解（C）」，exchange/handoff/2026-11-28-hardcoded-policy-audit.md）：出口检查里只管「口气好不好」的那几样，
// 原来散写在 speech-check.ts（助手腔、算账、怪他、比委屈、重复、叮嘱重复）、expression.ts（医书词、书面腔）和 modules/review-exit.ts（认真求哄 / 转话题时
// 要她重写的那几个说法）里。现在都在这张表：默认值就是原来写死的（一个都没改），严厉程度从这一处调。
//
// 硬规则不在这里，照旧写死在代码里：做不到的事（照片、电话、语音……）、卡上的禁用词、照抄语音图片的写法、编一整段对话、文字亲密推回当面、
// 危机回合的方法 / 敷衍 / 收尾 / 答应过去 / 八股和固定兜底、书的进度数字、QQ 里没有的表情。那些是能力、事实和安全，不是口气。
//
// 要调：环境变量 QQBOT_STYLE_RULES 指向一个 JSON 文件，只写要改的键，例如 {"strictness": "relaxed", "repeat": true}。
// strictness 是总档：standard（默认，和原来一样）/ relaxed（软检查全关、那几组说法全清空，只留硬规则）；再按键单独改。
// 严格：文件读不了、不是 JSON 对象、有不认识的键、值的类型不对、说法不是非空字符串、re: 写的正则编不过、一组超过 STYLE_PHRASES_MAX 条，
// 有一样不对就**整个文件不用**，全部默认（STYLE_RULES_RESULT.issue 写原因，只写键名不写内容）。
// 进程启动时读一次；改了要重启 Koishi。只有 QQ 读（DSH 没有出口检查）。
//
// 那几组说法和角色卡的 voice.qq_private（persona.yml voice.qq_private，ADR 0353）是配套的：今天 qq_private 里写着「别用「行吧」「笨蛋」或「笨」」，
// 出口检查就拦「行吧」「笨」。改了 qq_private 的那句，要在这里把 careAvoid 一起改掉，不然出口检查还按旧的拦。

import { readFileSync } from 'node:fs';
import { ODD_BODY_WORDS, STILTED_WORDS } from './expression.ts';

/** 开关类的软检查：true 查（命中就带说明重写一次，和原来一样），false 不查 */
export const STYLE_CHECKS = {
    service: { where: 'speech-check.ts SERVICE', note: '助手腔（「有什么需要随时告诉我」这类）' },
    ledger: { where: 'speech-check.ts', note: '算账：说他隔了这么久才来' },
    blame: { where: 'speech-check.ts', note: '怪他没告诉她、没带上她' },
    contrast: { where: 'speech-check.ts', note: '拿他和自己比着说委屈' },
    repeat: { where: 'speech-check.ts', note: '重复的开头、口头禅、照说一遍原话（语气词开头直接去掉也归这一项）' },
    nag: { where: 'speech-check.ts NAGS', note: '同一段聊天里又叮嘱一遍早睡、吃饭、穿衣喝水' },
    oddBodyWords: { where: 'expression.ts ODD_BODY_WORDS', note: '医书里的词和小说神态（「肚子坠着」「嘴角上扬」）；也给挑候选、留话出站用' },
    stiltedWords: { where: 'expression.ts STILTED_WORDS', note: '书面腔、模型腔（「诚然」「着实」「我给满分」）；也给挑候选、留话出站用' },
} as const;
export type StyleCheck = keyof typeof STYLE_CHECKS;

/** 说法类：出口检查在这一类轮次里额外要她重写的说法；子串，或 re: 开头的正则（和卡上禁用词同一种写法） */
export const STYLE_PHRASES = {
    careAvoid: {
        value: ['行吧', '笨', '认真想听你哄我', 're:笑点[^。！？]{0,5}低'],
        where: 'review-exit.ts 认真求哄那一段', note: '他认真求哄时：不用口头禅「行吧」「笨」、不复述他的求哄原话、不评价他的笑点（和 voice.qq_private 那句配套）',
    },
    careTiredAvoid: {
        value: ['re:晚安|早点睡|抓紧睡|赶紧睡|快睡|去睡|睡吧|好好睡|哄(?:你|他)睡|(?:闭眼|躺下)(?:就)?睡'],
        where: 'review-exit.ts 认真求哄 + 前一句累了', note: '他累了一整天又认真求哄时：别催睡、别用晚安带过',
    },
    closingAvoid: {
        value: ['re:笑点[^。！？]{0,5}低'],
        where: 'review-exit.ts 转话题那一段', note: '他转话题时：别再评价他的笑点',
    },
    closingJokeAvoid: {
        value: ['re:笑话|笑点|笑(?:到|成|够)'],
        where: 'review-exit.ts 转话题 + 前一句在说笑话', note: '他从笑话转去说别的（新这句里没有「笑」）时：别回头接旧梗',
    },
} as const;
export type StylePhrases = keyof typeof STYLE_PHRASES;

export const STYLE_STRICTNESS = ['standard', 'relaxed'] as const;
export type StyleStrictness = (typeof STYLE_STRICTNESS)[number];
/** 一组说法最多几条、每条最多多少字（防手滑写进一大段） */
export const STYLE_PHRASES_MAX = 40;
export const STYLE_PHRASE_CHARS = 200;

export type StyleRules = { strictness: StyleStrictness } & Record<StyleCheck, boolean> & Record<StylePhrases, readonly string[]>;
export interface StyleRulesResult {
    values: Readonly<StyleRules>;
    /** 文件里改了哪些键（没设变量、文件没用上时是空的） */
    changed: readonly string[];
    /** 文件没用上的原因 */
    issue?: string;
}

const CHECK_KEYS = Object.keys(STYLE_CHECKS) as StyleCheck[];
const PHRASE_KEYS = Object.keys(STYLE_PHRASES) as StylePhrases[];

function presetOf(strictness: StyleStrictness): StyleRules {
    const on = strictness === 'standard';
    return {
        strictness,
        ...Object.fromEntries(CHECK_KEYS.map(key => [key, on])) as Record<StyleCheck, boolean>,
        ...Object.fromEntries(PHRASE_KEYS.map((key): [StylePhrases, readonly string[]] => [key, on ? STYLE_PHRASES[key].value : []])) as Record<StylePhrases, readonly string[]>,
    };
}

/** 默认值（就是原来写死的） */
export const STYLE_RULE_DEFAULTS: Readonly<StyleRules> = Object.freeze(presetOf('standard'));

function phraseIssue(key: string, value: unknown): string | undefined {
    if (!Array.isArray(value)) return `${key} 不是一组说法`;
    if (value.length > STYLE_PHRASES_MAX) return `${key} 超过 ${STYLE_PHRASES_MAX} 条`;
    for (const phrase of value) {
        if (typeof phrase !== 'string' || !phrase.trim() || [...phrase].length > STYLE_PHRASE_CHARS) return `${key} 里有一条不是非空的短字符串`;
        if (phrase.startsWith('re:')) {
            try { new RegExp(phrase.slice(3)); } catch { return `${key} 里有一条正则编不过`; }
            if (!phrase.slice(3)) return `${key} 里有一条正则是空的`;
        }
    }
    return undefined;
}

/** 用一份覆盖值（JSON 解析出来的）算出整张表：有一样不对就整个不用，返回默认值和原因 */
export function resolveStyleRules(overrides: unknown): StyleRulesResult {
    const fallback = (issue: string): StyleRulesResult => ({ values: STYLE_RULE_DEFAULTS, changed: [], issue });
    if (overrides === undefined) return { values: STYLE_RULE_DEFAULTS, changed: [] };
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return fallback('不是一个 JSON 对象');
    const given = overrides as Record<string, unknown>;
    const strictness = given.strictness ?? 'standard';
    if (!STYLE_STRICTNESS.includes(strictness as StyleStrictness)) return fallback(`strictness 只能是 ${STYLE_STRICTNESS.join(' / ')}`);
    const values: StyleRules = presetOf(strictness as StyleStrictness);
    for (const [key, value] of Object.entries(given)) {
        if (key === 'strictness') continue;
        if ((CHECK_KEYS as string[]).includes(key)) {
            if (typeof value !== 'boolean') return fallback(`${key} 不是 true / false`);
            values[key as StyleCheck] = value;
        } else if ((PHRASE_KEYS as string[]).includes(key)) {
            const issue = phraseIssue(key, value);
            if (issue) return fallback(issue);
            values[key as StylePhrases] = Object.freeze([...(value as string[])]);
        } else {
            return fallback(`不认识的键 ${JSON.stringify(key).slice(0, 60)}`);
        }
    }
    return { values: Object.freeze(values), changed: Object.keys(given) };
}

/** 读环境变量指的文件（没设就全默认）；读不了、不是 JSON 也整个不用 */
export function loadStyleRules(path: string | undefined): StyleRulesResult {
    if (!path) return resolveStyleRules(undefined);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return { values: STYLE_RULE_DEFAULTS, changed: [], issue: '文件读不了或不是 JSON' }; }
    return resolveStyleRules(parsed);
}

/** 这个进程用的那张表（含没用上的原因）；进程启动时读一次 */
export const STYLE_RULES_RESULT: StyleRulesResult = loadStyleRules(process.env.QQBOT_STYLE_RULES);
export const STYLE_RULES: Readonly<StyleRules> = STYLE_RULES_RESULT.values;

/** 日志那一行（只写键名和档，不写路径和说法）；全默认时没有 */
export function styleRulesLogLine(result: StyleRulesResult = STYLE_RULES_RESULT): string {
    if (result.issue) return `软风格规则：覆盖文件没用上（${result.issue}），全部默认`;
    if (!result.changed.length) return '';
    return `软风格规则：${result.values.strictness}，改了 ${result.changed.join('、')}`;
}

/** 出口检查要跳过的说话毛病（关掉的那几类）；全开时是空的 */
export function skippedSpeechKinds(rules: Readonly<StyleRules> = STYLE_RULES): ReadonlySet<string> {
    return new Set((['service', 'ledger', 'blame', 'contrast', 'repeat', 'nag'] as const).filter(key => !rules[key]));
}

/** 医书词 + 书面腔（开着的那几组）：出口检查、挑候选、留话出站都从这里拿，和原来的 [...ODD_BODY_WORDS, ...STILTED_WORDS] 一样 */
export function styleBannedWords(rules: Readonly<StyleRules> = STYLE_RULES): string[] {
    return [...(rules.oddBodyWords ? ODD_BODY_WORDS : []), ...(rules.stiltedWords ? STILTED_WORDS : [])];
}
