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
