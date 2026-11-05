/** Parse before resolving any data path or reading a file. */
export function parseMemeArgs(args: readonly string[]): {
    command: 'list' | 'add' | 'remove'; dir?: string; example?: string; positional: string[];
} {
    const command = args[0];
    if (command !== 'list' && command !== 'add' && command !== 'remove') throw new Error('用法：list | add "<词>" "<意思>" | remove "<词>" [--dir <数据目录>]');
    const positional: string[] = [], options = new Map<string, string>();
    for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (!arg.startsWith('--')) { positional.push(arg); continue; }
        if (arg !== '--dir' && arg !== '--example') throw new Error(`未知参数：${arg}`);
        if (options.has(arg)) throw new Error(`重复参数：${arg}`);
        const value = args[++i];
        if (value === undefined || !value.trim() || value.startsWith('--')) throw new Error(`${arg} 缺少有效值`);
        options.set(arg, value);
    }
    if (options.has('--example') && command !== 'add') throw new Error('--example 只用于 add');
    const expected = command === 'add' ? 2 : command === 'remove' ? 1 : 0;
    if (positional.length !== expected || positional.some(value => !value.trim())) throw new Error(`${command} 需要 ${expected} 个非空位置参数`);
    return { command, positional, ...(options.has('--dir') ? { dir: options.get('--dir')! } : {}), ...(options.has('--example') ? { example: options.get('--example')! } : {}) };
}
