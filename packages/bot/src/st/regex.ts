// SillyTavern 正则脚本（Regex 扩展）里运行时用得到的部分：角色卡上的 Scoped 脚本（data.extensions.regex_scripts），
// 只在 AI 输出位置执行。对照 public/scripts/extensions/regex/engine.js 的 getRegexedString / runRegexScript
// 和 public/scripts/utils.js 的 regexFromString（ADR 0006 决策 2）。
// ST 在 cleanUpMessage 里、停止串之后、去行尾空白之前调用（public/script.js:6481），运行时在 cleanUpReply 的同一位置调用。
// 没有实现：全局 / 预设脚本，其他位置（用户输入、世界书、推理），minDepth / maxDepth（AI 输出位置不传 depth，不生效）。
// 宏只有 macros.ts 的子集（{{user}} {{char}}）。

import { substituteMacros, type MacroNames } from './macros.ts';

/** engine.js regex_placement.AI_OUTPUT */
export const AI_OUTPUT = 2;

/** engine.js substitute_find_regex */
const SUBSTITUTE = { NONE: 0, RAW: 1, ESCAPED: 2 } as const;

export interface RegexScript {
    scriptName: string;
    findRegex: string;
    replaceString: string;
    trimStrings: string[];
    placement: number[];
    disabled: boolean;
    /** 只作用于显示 / 只作用于提示词：都不是 AI 输出的正文，运行时跳过（getRegexedString 不传 isMarkdown / isPrompt 时同样跳过） */
    markdownOnly: boolean;
    promptOnly: boolean;
    substituteRegex: number;
}

/** 读角色卡的 extensions.regex_scripts；ST 不是数组就当没有（getScriptsByType），字段缺了按 ST 新建脚本时的默认值 */
export function parseRegexScripts(value: unknown, source = '角色卡'): RegexScript[] {
    if (!Array.isArray(value)) return [];
    return value.map((item, i): RegexScript => {
        if (typeof item !== 'object' || item === null) throw new Error(`${source}：regex_scripts[${i}] 应为对象`);
        const s = item as Record<string, unknown>;
        const strings = (key: string) => (Array.isArray(s[key]) ? (s[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
        return {
            scriptName: typeof s.scriptName === 'string' ? s.scriptName : '',
            findRegex: typeof s.findRegex === 'string' ? s.findRegex : '',
            replaceString: typeof s.replaceString === 'string' ? s.replaceString : '',
            trimStrings: strings('trimStrings'),
            placement: Array.isArray(s.placement) ? (s.placement as unknown[]).map(Number) : [],
            disabled: Boolean(s.disabled),
            markdownOnly: Boolean(s.markdownOnly),
            promptOnly: Boolean(s.promptOnly),
            substituteRegex: Number(s.substituteRegex ?? SUBSTITUTE.NONE),
        };
    });
}

/** utils.js regexFromString：'/模式/标志' 或不带斜杠的模式；写错了返回 undefined（ST 跳过这条脚本） */
export function regexFromString(input: string): RegExp | undefined {
    try {
        const m = input.match(/(\/?)(.+)\1([a-z]*)/i)!;
        if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) return RegExp(input);
        return new RegExp(m[2]!, m[3]);
    } catch {
        return undefined;
    }
}

/** engine.js sanitizeRegexMacro：宏的值放进正则前转义 */
function sanitizeRegexMacro(x: string): string {
    const named: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' };
    return x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, s => named[s] ?? `\\${s}`);
}

export function runRegexScript(script: RegexScript, rawString: string, names: MacroNames): string {
    if (script.disabled || !script.findRegex || !rawString) return rawString;
    let regexString = script.findRegex;
    if (script.substituteRegex === SUBSTITUTE.RAW) regexString = substituteMacros(regexString, names);
    else if (script.substituteRegex === SUBSTITUTE.ESCAPED) {
        regexString = substituteMacros(regexString, { user: sanitizeRegexMacro(names.user), char: sanitizeRegexMacro(names.char) });
    }
    const findRegex = regexFromString(regexString);
    if (!findRegex) return rawString;

    return rawString.replace(findRegex, (...args: unknown[]) => {
        let match: unknown = args[0];
        const replaceString = script.replaceString.replace(/{{match}}/gi, '$0');
        const replaceWithGroups = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num: string | undefined, groupName: string | undefined) => {
            if (num) {
                match = args[Number(num)];
            } else if (groupName) {
                const groups = args[args.length - 1];
                match = groups && typeof groups === 'object' && (groups as Record<string, unknown>)[groupName];
            }
            if (!match) return '';
            // filterString：捕获内容里去掉 trimStrings（trimStrings 先替换宏）
            let filtered = String(match);
            for (const trim of script.trimStrings) filtered = filtered.replaceAll(substituteMacros(trim, names), '');
            return filtered;
        });
        return substituteMacros(replaceWithGroups, names);
    });
}

/** getRegexedString(text, AI_OUTPUT)：按顺序执行作用于 AI 输出的脚本 */
export function applyAiOutputScripts(text: string, scripts: readonly RegexScript[], names: MacroNames): string {
    let result = text;
    if (!text) return result;
    for (const script of scripts) {
        if (script.markdownOnly || script.promptOnly) continue;
        if (script.placement.includes(AI_OUTPUT)) result = runRegexScript(script, result, names);
    }
    return result;
}
