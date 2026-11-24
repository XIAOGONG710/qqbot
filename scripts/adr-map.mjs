// ADR 地图：docs/adr 下每一份一行——编号、标题、文件里写的状态、它管的开关（功能总表 features.ts 的 adr 字段）和那些开关在线上快照里开没开。
// 为什么：近 300 份 ADR，文件头的「状态」常常停在写的那天（「未上线」的早就上了），新会话不知道哪份还算数。
// 线上开没开以快照为准（exchange/live 最新一份，scripts/read-switches.mjs 导出），文件里的状态只照抄、不当真。
// 用法：node scripts/adr-map.mjs [--out docs/adr/MAP.md]（不给 --out 就打印）。生成物别手改。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 一份 ADR 的头：标题、状态行（去掉加粗，截到 maxStatus 字） */
export function readAdr(text, maxStatus = 60) {
    const title = (/^#\s*(?:ADR\s*)?\d{4}\s*[：:]\s*(.+)$/m.exec(text)?.[1] ?? /^#\s*(.+)$/m.exec(text)?.[1] ?? '').trim();
    let status = (/^-\s*状态\s*[：:]\s*(.+)$/m.exec(text)?.[1] ?? '').replace(/\*\*/g, '').replace(/\|/g, '/').trim();
    if ([...status].length > maxStatus) status = `${[...status].slice(0, maxStatus).join('')}…`;
    return { title: title.replace(/\|/g, '/'), status };
}

/** 快照里 qqbot 插件那一块的开关值 */
export function liveValues(yamlText) {
    const yaml = require('js-yaml');
    const root = yaml.load(yamlText);
    const plugin = Object.values(root?.plugins ?? {}).find(p => p && typeof p === 'object' && 'contacts' in p) ?? {};
    return plugin;
}

/** 快照里的值 → 开 / 关 / 默认；{ enabled } 这种对象（dsh、memory、vision）看 enabled */
export const onOff = value => {
    if (value === undefined) return '默认';
    if (value !== null && typeof value === 'object') return value.enabled === true ? '开' : '关';
    return value === true || (typeof value === 'string' && value !== 'off' && value !== '') ? '开' : '关';
};

/**
 * files：[{ name, text }]；features：[{ key, adr }]；live：快照里的值（键 → 值），没有快照给 undefined。
 * 返回 markdown。
 */
// forcedOff：线上开着、但启动时被别的开关强制关掉的（fewerRules 的 relaxStyle），标「关（被 fewerRules 关掉）」
export function adrMap(files, features, live, source = '', forcedOff = new Set()) {
    const rows = [];
    const seen = new Map();
    for (const { name, text } of files) {
        const number = /^(\d{4})/.exec(name)?.[1];
        if (!number) continue;
        seen.set(number, [...(seen.get(number) ?? []), name]);
        const { title, status } = readAdr(text);
        const switches = features.filter(f => f.adr === number).map(f => f.key);
        const liveText = switches.map(key => {
            if (!live) return `\`${key}\``;
            const state = onOff(live[key]);
            return `\`${key}\` ${state === '开' && forcedOff.has(key) ? '关（被 fewerRules 关掉）' : state}`;
        }).join('、');
        rows.push(`| [${number}](${name}) | ${title} | ${status} | ${liveText} |`);
    }
    const dup = [...seen].filter(([, names]) => names.length > 1);
    return [
        '# ADR 地图（生成的，别手改）',
        '',
        '> 由 `node scripts/adr-map.mjs --out docs/adr/MAP.md` 生成。「文件里的状态」照抄每份 ADR 头上那行，常常停在写的那天；',
        `> 开关和线上值来自功能总表（\`packages/bot/src/platform/features.ts\` 的 adr 字段）和线上快照${source ? `（\`${source}\`）` : ''}——**以这一列为准**。「默认」= 快照里没写，按代码默认值。`,
        '> 编号登记、撞号的说明见 [INDEX.md](INDEX.md)。',
        '',
        ...(dup.length ? ['**同一个编号有两份的**：' + dup.map(([n, names]) => `${n}（${names.join('、')}）`).join('；'), ''] : []),
        '| ADR | 标题 | 文件里的状态 | 开关（线上） |',
        '|---|---|---|---|',
        ...rows,
        '',
    ].join('\n');
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invoked === fileURLToPath(import.meta.url)) {
    const dir = join(REPO, 'docs', 'adr');
    const files = readdirSync(dir).filter(name => /^\d{4}-.*\.md$/.test(name)).sort().map(name => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
    const { FEATURES } = await import(new URL('../packages/bot/src/platform/features.ts', import.meta.url).href);
    const liveDir = join(REPO, 'exchange', 'live');
    const snapshot = readdirSync(liveDir).filter(name => /^koishi-.*\.ya?ml$/.test(name)).sort().at(-1);
    const live = snapshot ? liveValues(readFileSync(join(liveDir, snapshot), 'utf8')) : undefined;
    // 少规矩（fewerRules）开着时，启动时 relaxStyle 把只管说话风格的那几个强制关掉：线上实际是关的
    const { relaxStyle } = await import(new URL('../packages/bot/src/language/fewer-rules.ts', import.meta.url).href);
    const forcedOff = live && onOff(live.fewerRules) === '开'
        ? new Set(Object.entries(relaxStyle({})).filter(([, value]) => value === false).map(([key]) => key))
        : new Set();
    const md = adrMap(files, FEATURES, live, snapshot ? `exchange/live/${snapshot}` : '', forcedOff);
    const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
    if (out) { writeFileSync(resolve(out), md); console.log(`写了 ${out}：${files.length} 份`); } else process.stdout.write(md);
}
