// DSH 面板改角色资料的入口（ADR 0010）：面板跑在 DSH 进程里，读不了 TypeScript，
// 所以由它起一个子进程跑这个 CLI，用 JSON 进 JSON 出，改的还是 character-editing.ts 那一层。
// 用法（相对路径按仓库根解析）：
//   node --import tsx packages/character-tools/src/character-cli.ts load    --source <资料目录> [--out <st 目录>] [--prefix <前缀>]
//   node --import tsx packages/character-tools/src/character-cli.ts preview --source <…> …  < 请求.json
//   node --import tsx packages/character-tools/src/character-cli.ts save    --source <…> …  < 请求.json
// 请求体：{ "part": "scenes", "value": <改过的那一部分>, "token": <读资料时拿到的快照> }
// 输出：load 给 { token, parts, missing }；preview / save 给 PreviewOutcome / SaveOutcome，
// 结构和 Koishi 控制台完全相同，页面只拿到字段位置、问题类别和合成样本。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EDIT_PARTS, createCharacterEditor, type CharacterPaths, type EditPart } from './character-editing.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const command = process.argv[2];
const { values: args } = parseArgs({
    args: process.argv.slice(3),
    options: { source: { type: 'string' }, out: { type: 'string' }, prefix: { type: 'string' } },
});

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function reply(value: unknown): never {
    process.stdout.write(JSON.stringify(value));
    process.exit(0);
}

const paths: CharacterPaths = {
    sourceDir: resolve(repoRoot, args.source ?? 'characters/linmengyao/source'),
    stDir: resolve(repoRoot, args.out ?? 'characters/linmengyao/st'),
    prefix: args.prefix ?? 'linmengyao',
};
if (!/^[a-z][a-z0-9-]*$/.test(paths.prefix)) fail('--prefix 要以小写字母开头，只能用小写字母、数字和连字符');

const editor = createCharacterEditor(paths);

/** 请求体只认这三个字段：多余的东西不进写入路径 */
function request() {
    let body: unknown;
    try {
        body = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
        return null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const { part, value, token } = body as { part?: unknown; value?: unknown; token?: unknown };
    if (typeof part !== 'string' || !(EDIT_PARTS as readonly string[]).includes(part)) return null;
    if (token !== undefined && typeof token !== 'string') return null;
    return { part: part as EditPart, value, token };
}

const INVALID = { ok: false, problems: [{ part: 'output', field: '请求', kind: 'format', hint: '页面传来的内容不对，请刷新后重试。' }] };

if (command === 'load') reply(editor.load());

if (command === 'preview' || command === 'save') {
    const body = request();
    if (!body) reply(INVALID);
    reply(command === 'save' ? editor.save(body.part, body.value, body.token) : editor.preview(body.part, body.value, body.token));
}

fail(`未知命令：${command ?? '(空)'}；可用 load / preview / save`);
