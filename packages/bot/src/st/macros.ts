// SillyTavern 宏的最小子集：{{user}} {{char}}，以及旧写法 <USER> <BOT>。
// 对照 public/scripts/macros/definitions/env-macros.js（宏名不区分大小写）
// 和 macros/engine/MacroEngine.js（<USER>/<BOT> 先转成 {{user}}/{{char}}）。
// 其他宏原样保留；{{original}} 只在替换主提示词 / post-history 指令时由调用方传入。

export interface MacroNames {
    user: string;
    char: string;
}

export function substituteMacros(text: string, names: MacroNames, extra: Record<string, string> = {}): string {
    const values: Record<string, string> = { user: names.user, char: names.char };
    for (const [key, value] of Object.entries(extra)) values[key.toLowerCase()] = value;
    return text
        .replace(/<USER>/gi, '{{user}}')
        .replace(/<BOT>/gi, '{{char}}')
        .replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, name: string) => values[name.toLowerCase()] ?? whole);
}
