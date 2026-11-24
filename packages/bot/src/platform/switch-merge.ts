// 开关合并（docs/plans/2026-11-24-switch-merge-design.md 第一节）：把一组旧开关并成一个新键时，新旧两边的映射只在这张表里写一次。
// parseAppConfig（配置输入的规范化）、Koishi 插件（migrateSwitches 写回 koishi.yml、toAppConfigInput 的取舍）、日志都调这里，不各写一份。
// 纯数据 + 纯函数，不 import config.ts（默认值由调用方传进来，避免循环引用）。
//
// 过渡期的规则（设计第一节 2）：
//   只有新键      → 新键；旧字段 = toLegacy(新键)
//   只有旧键      → 新键 = fromLegacy(旧键)；旧字段**原样**往下传（哪怕旧键之间对不上，app 还读旧字段的这一步也和今天一样）
//   两边都写了    → 以新键为准；旧字段 = toLegacy(新键)；日志说一句（existing 的组除外：新键本来就是旧键那边的总开关，按「只有旧键」）
//   都没写        → 新键 = 默认值；旧字段 = toLegacy(默认值)
// 表是空的时候，所有函数都原样返回输入（同一个对象），行为和没有这套机制时逐字一样。

type Input = Record<string, unknown>;

export interface SwitchMerge {
    /** 新键（AppConfig / koishi.yml 里的名字） */
    readonly key: string;
    /** 新键允许的值（布尔就是 [false, true]）；输入里写了别的值直接报错 */
    readonly values: readonly unknown[];
    /**
     * 新键合并前就是一个开关（proactive、qzone……；不是新起的名字）：它在输入里的值本来就算数，是旧键这一边的总开关。
     * 这种组写着旧键时一律按「只有旧键」处理（新键也写着不算「两边都写了」），没写旧键才由新键派生旧字段
     */
    readonly existing?: boolean;
    /** 被并进来的旧键，按 FEATURES 里原来的先后 */
    readonly legacy: readonly string[];
    /** 旧键 → 新键的值。只在输入里没写新键、写了至少一个旧键时用；input 里没写的旧键（和新键）已按默认值补上 */
    fromLegacy(input: Input): unknown;
    /** 新键 → 旧键的值：返回值要恰好含 legacy 里的每一个键（过渡期给还在读旧键的代码用；也是「可表达」的判据） */
    toLegacy(value: unknown, config: Input): Input;
    /** 这一项在这种输入下本来就不起作用（比如 requires 不满足）：对不上也不算「表达不了」 */
    ignorable?(legacyKey: string, input: Input): boolean;
}

const PRESENCE = ['off', 'dryRun', 'on'] as const;
const BOOL = [false, true] as const;

/** 新键合并前就是开关、旧键各自等于它（「跟着它走」）：旧 → 新取新键自己的值，新 → 旧每个旧键都是这个值 */
function follows(key: string, values: readonly unknown[], legacy: readonly string[], extra: Partial<SwitchMerge> = {}): SwitchMerge {
    return {
        key, values, legacy, existing: true,
        fromLegacy: input => input[key],
        toLegacy: value => Object.fromEntries(legacy.map(name => [name, value])),
        ...extra,
    };
}

/**
 * 已经合并的组，按设计第三节的顺序一组一个提交（docs/plans/2026-11-24-switch-merge-design.md 第二节逐组写了映射、线上值和基线核对）。
 * app 代码过渡期照旧读旧字段（parseAppConfig 按上面的规则给出），所以基线逐字不变；改读新键的一组一组来。
 */
export const SWITCH_MERGES: readonly SwitchMerge[] = [
    // 1. QQ 空间（设计第二节 18）：签名、翻空间、刷好友动态、刷陌生人都是同一种三档，跟着 qzone
    follows('qzone', PRESENCE, ['signature', 'qzoneBrowse', 'qzonePeek', 'qzoneStrangers']),
    // 2. 事实检查（11）：检查开着就也查「替他说的」；检查关着时 factHim 本来不起作用
    {
        key: 'factCheck', existing: true, values: ['off', 'log', 'fix'], legacy: ['factHim'],
        fromLegacy: input => input.factCheck,
        toLegacy: value => ({ factHim: value !== 'off' }),
        ignorable: (_, input) => input.factCheck === 'off',
    },
    // 3. 账号控制（15）：控制面全开（on）时好友申请「名单内同意」；不是 on 时 qqFriendGate 本来不起作用（app.ts 那句「要 qqControl 设为 on」）。
    //    「名单外驳回」（all）线上没用过，不留：写着 all 的表达不了、不迁移
    {
        key: 'qqControl', existing: true, values: ['off', 'read', 'on'], legacy: ['qqFriendGate'],
        fromLegacy: input => input.qqControl,
        toLegacy: value => ({ qqFriendGate: value === 'on' ? 'allow' : 'off' }),
        ignorable: (_, input) => input.qqControl !== 'on',
    },
    // 4. 生活账（12）：作业接管空闲、生活账进提示词都要 autonomousLife 的账，跟着它
    follows('autonomousLife', BOOL, ['projectChoice', 'lifeInPrompt']),
    // 5. 看图（16）：看懂他发的表情包跟着「听语音、看图」。新装默认从「不读表情包」变成读（仍要配看图模型才真读，app.ts 的 stickerReader）
    follows('media', BOOL, ['readStickers']),
    // 6. 真实世界（4）：新起的名字 realWorld，四路真实数据一起开关；旧键里 realWeather 当总开关（它原来默认开，另三个默认关：
    //    新装默认从「只有天气」变成四路都开，线上四个都开着不受影响）
    {
        key: 'realWorld', values: BOOL, legacy: ['realWeather', 'realAirQuality', 'realDaylight', 'realCalendar'],
        fromLegacy: input => input.realWeather === true,
        toLegacy: value => ({ realWeather: value, realAirQuality: value, realDaylight: value, realCalendar: value }),
    },    // 7. B 站（3）：她的 B 站号、私信、回复、话题评论、认识的人、B 站表情包都跟着 bilibili；「刷到视频分享给他」跟着 watching（看什么由它定，发不发由 bilibili 定）。
    //    watching 单留（watched 场景只开它、不开 bilibili）。B 站表情包还要「图片表情」开着：没开时它本来不起作用
    {
        key: 'bilibili', existing: true, values: PRESENCE,
        legacy: ['bilibiliAccount', 'bilibiliDm', 'bilibiliReplies', 'bilibiliComment', 'acquaintances', 'biliStickers'],
        fromLegacy: input => input.bilibili,
        toLegacy: (value, config) => ({
            bilibiliAccount: value !== 'off', bilibiliDm: value, bilibiliReplies: value, bilibiliComment: value, acquaintances: value !== 'off',
            biliStickers: value !== 'off' && (config.stickers ?? 'off') !== 'off',
        }),
        ignorable: (key, input) => key === 'biliStickers' && (input.stickers ?? 'off') === 'off',
    },
    // 要排在 bilibili 后面：派生 biliFeed 时读的是已经定下来的 bilibili
    {
        key: 'watching', existing: true, values: BOOL, legacy: ['biliFeed'],
        fromLegacy: input => input.watching,
        toLegacy: (value, config) => ({ biliFeed: value === true ? (config.bilibili ?? 'off') : 'off' }),
    },    // 8. 感觉账并进心境（8 的前一半）：有心境就记账；心境关着时感觉账本来不起作用（唯一读处在 herFeelings 分支里）。
    //    新装默认：两个都没写时 feelingLedger 从开变成跟着 herFeelings（默认关），没有心境本来就没有账，行为不变。
    //    feltLedgerRecall 并进 memoryFeelings 那一半阻塞（线上关着，并进来 = 给线上开了），不在这里
    follows('herFeelings', BOOL, ['feelingLedger'], { ignorable: (_, input) => input.herFeelings !== true }),
];

/** 过渡期还认、但已经并进新键的旧键（dashboard 的「每个开关都登记过」把它们也算已登记） */
export function legacySwitchKeys(merges: readonly SwitchMerge[] = SWITCH_MERGES): ReadonlySet<string> {
    return new Set(merges.flatMap(merge => merge.legacy));
}

/** 这一组的旧键在输入里写了哪些（undefined 算没写） */
export function writtenLegacy(merge: SwitchMerge, input: Input): string[] {
    return merge.legacy.filter(key => input[key] !== undefined);
}

/** 给 fromLegacy / toLegacy 看的输入：新键和旧键没写的按默认值补上，其余原样 */
function filled(merge: SwitchMerge, input: Input, defaults: Input): Input {
    const view: Input = { ...input };
    for (const key of [merge.key, ...merge.legacy]) {
        if (view[key] === undefined && defaults[key] !== undefined) view[key] = defaults[key];
    }
    return view;
}

function checkValue(merge: SwitchMerge, value: unknown): void {
    if (!merge.values.includes(value)) {
        // 开 / 关的说法和 config.ts 的 bool() 一样（旧报错信息不变）
        if (merge.values.length === 2 && merge.values.includes(true) && merge.values.includes(false)) throw new Error(`配置 ${merge.key} 应为 true 或 false`);
        throw new Error(`配置 ${merge.key} 应为 ${merge.values.map(v => JSON.stringify(v)).join(' / ')} 之一`);
    }
}

/** 旧键对应的新值（输入里只有旧键时新键取这个） */
export function legacyValue(merge: SwitchMerge, input: Input, defaults: Input): unknown {
    return merge.fromLegacy(filled(merge, input, defaults));
}

/** 和派生值对不上的旧键：[旧键, 写的值, 由新键派生出来的值] */
function mismatches(merge: SwitchMerge, input: Input, value: unknown, defaults: Input, onlyWritten: boolean): [string, unknown, unknown][] {
    const view = filled(merge, input, defaults);
    const derived = merge.toLegacy(value, view);
    return merge.legacy
        .filter(key => !onlyWritten || input[key] !== undefined)
        .filter(key => !Object.is(derived[key], view[key]) && !merge.ignorable?.(key, view))
        .map(key => [key, view[key], derived[key]]);
}

/** 这一组的旧键能不能一字不差地用新键表达：toLegacy(fromLegacy(x)) 和 x 一样（ignorable 的子项不算） */
export function representable(merge: SwitchMerge, input: Input, defaults: Input): boolean {
    return mismatches(merge, input, legacyValue(merge, input, defaults), defaults, false).length === 0;
}

/**
 * parseAppConfig 之前的规范化：按上面的四条规则补上新键、派生旧字段。不改输入，有改动时返回新对象；
 * 表是空的就原样返回同一个对象。新键的值不在 values 里时报错。
 */
export function mergeSwitchInput(input: Input, defaults: Input, merges: readonly SwitchMerge[] = SWITCH_MERGES): Input {
    let out = input;
    for (const merge of merges) {
        if (out === input) out = { ...input };
        const value = out[merge.key];
        if (value !== undefined) checkValue(merge, value);
        if (writtenLegacy(merge, out).length && (value === undefined || merge.existing)) {
            // 只有旧键：新键由旧键算出，旧字段原样留着
            out[merge.key] = legacyValue(merge, out, defaults);
        } else {
            // 只有新键 / 两边都写了（以新键为准）/ 都没写（新键取默认值）：旧字段由新键派生
            const next = value ?? defaults[merge.key];
            if (next !== undefined) out[merge.key] = next;
            Object.assign(out, merge.toLegacy(next, filled(merge, out, defaults)));
        }
    }
    return out;
}

const show = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);

/** 给日志的说明：哪些旧键被读成了哪个新值、哪些组两边都写了以新键为准、哪些组表达不了。没什么可说的就是空数组 */
export function switchMergeNotes(input: Input, defaults: Input, merges: readonly SwitchMerge[] = SWITCH_MERGES): string[] {
    const notes: string[] = [];
    for (const merge of merges) {
        const written = writtenLegacy(merge, input);
        if (!written.length) continue;
        if (input[merge.key] !== undefined && !merge.existing) {
            const differ = mismatches(merge, input, input[merge.key], defaults, true);
            notes.push(`开关合并：${merge.key} 和旧键 ${written.join('、')} 都写了，以 ${merge.key} 为准`
                + (differ.length ? `（和 ${merge.key} 对不上、按 ${merge.key} 改掉的：${differ.map(([key, was, now]) => `${key} ${show(was)}→${show(now)}`).join('，')}）` : ''));
            continue;
        }
        const value = legacyValue(merge, input, defaults);
        notes.push(`开关合并：旧键 ${written.join('、')} 已并进 ${merge.key}（= ${show(value)}），请改用 ${merge.key}`
            + (representable(merge, input, defaults) ? '' : `；这几项和 ${merge.key} 对不上：${mismatches(merge, input, value, defaults, false)
                .map(([key, was, now]) => `${key}=${show(was)}（${merge.key}=${show(value)} 时是 ${show(now)}）`).join('，')}，过渡期照旧按旧键`));
    }
    return notes;
}

/** 表本身的自检（测试里跑）：新键不重复、旧键只属于一组、fromLegacy 的结果合法、toLegacy 对每个值都恰好给出全部旧键 */
export function checkSwitchMerges(merges: readonly SwitchMerge[], defaults: Input): string[] {
    const problems: string[] = [];
    const owner = new Map<string, string>();
    for (const merge of merges) {
        for (const key of [merge.key, ...merge.legacy]) {
            if (owner.has(key)) problems.push(`${key} 同时出现在 ${owner.get(key)} 和 ${merge.key} 两组里`);
            owner.set(key, merge.key);
        }
        if (!merge.values.length) problems.push(`${merge.key} 没写 values`);
        if (defaults[merge.key] !== undefined && !merge.values.includes(defaults[merge.key])) problems.push(`${merge.key} 的默认值不在 values 里`);
        const fromDefaults = legacyValue(merge, {}, defaults);
        if (!merge.values.includes(fromDefaults)) problems.push(`${merge.key}：旧键都按默认值时 fromLegacy 给出 ${show(fromDefaults)}，不在 values 里`);
        for (const value of merge.values) {
            const keys = Object.keys(merge.toLegacy(value, filled(merge, {}, defaults))).sort();
            if (keys.join() !== [...merge.legacy].sort().join()) problems.push(`${merge.key}=${show(value)}：toLegacy 给出 ${keys.join('、')}，应恰好是 ${merge.legacy.join('、')}`);
        }
    }
    return problems;
}
