// 从人设卡生成 DSH 桌面读的那一份 PERSONA.md（任务书 §1 第 3 条）。
//   用法：node scripts/build-dsh-persona.mjs [--card <卡>] [--out <文件>]
// 默认卡：characters/linmengyao/st/linmengyao-boyfriend-open.json
// 默认输出：~/.dsh/linmengyao/PERSONA.md
// 只读卡、只写一个生成物；不改卡，也不改 profile。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { renderPersona } from '../packages/bot/src/st/persona-render.ts';

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
};

const cardPath = option('--card', 'characters/linmengyao/st/linmengyao-boyfriend-open.json');
const out = option('--out', join(homedir(), '.dsh', 'linmengyao', 'PERSONA.md'));
const raw = readFileSync(cardPath, 'utf8');
const card = JSON.parse(raw).data;
const sha = createHash('sha256').update(raw).digest('hex').slice(0, 12);

const text = renderPersona({
    card,
    names: { user: '宝宝', char: card.name ?? '林梦瑶' },
    source: `${cardPath} · sha ${sha}`,
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
console.log(`写了 ${out}（${text.length} 字，卡 sha ${sha}）`);
