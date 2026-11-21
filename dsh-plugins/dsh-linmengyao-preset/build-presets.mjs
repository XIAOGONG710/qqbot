// 生成 presets.cjs：把 DSH 自带的四个模式（标准 / PTC / 极简 / 创造）的插件表抄下来，
// 只把人格那一条换成林梦瑶的 prefix，让她勾哪个模式都是她自己。
//
// 为什么要抄：内置 preset 的 id 不能重复注册（registry.register 撞 id 直接抛
// Duplicate agent preset），profile patch 只能整表覆盖 config.plugins；
// 而 persona 那条的 prefix 是写死在表里的。DSH 升级后重跑一次本脚本。
//
//   node dsh-plugins/dsh-linmengyao-preset/build-presets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASAR = 'C:/Users/22601/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
const PRESETS_DIR = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets';

// ---- asar 读取（Electron asar：16 字节头 + pickle 长度 + JSON 目录表）----
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerPickleSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const dataOffset = 8 + headerPickleSize;
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const root = JSON.parse(jsonBuf.toString('utf8'));

function readAsar(rel) {
  const segs = rel.split('/');
  let node = root;
  for (const s of segs) {
    node = node.files?.[s];
    if (!node) throw new Error(`asar: not found ${rel}`);
  }
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, dataOffset + parseInt(node.offset));
  return buf.toString('utf8');
}

// ---- YAML：!!js 标成 { __js: 表达式 }，生成时原样写回 JS 源码 ----
const jsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __js: String(data).trim() }),
});
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([jsType]);

const herPatch = yaml.load(fs.readFileSync(path.join(here, 'cordis.patch.yml'), 'utf8'), { schema: SCHEMA });
const herPlugins = herPatch[0].insert[0].config.plugins;
const personaRow = herPlugins.find((r) => r.id === 'persona');
if (!personaRow) throw new Error('她的 preset 里没找到 persona 行');
const HER_PREFIX = personaRow.config.prefix;

const MODES = ['standard', 'ptc', 'minimal', 'cordis'];

function emit(value, ind = '') {
  const pad = '  '.repeat(ind.length / 2 + 1);
  const close = '  '.repeat(ind.length / 2);
  if (value === null || value === undefined) return 'undefined';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '[\n' + value.map((v) => pad + emit(v, ind + '  ') + ',').join('\n') + '\n' + close + ']';
  }
  if (value.__js !== undefined) return '(' + value.__js + ')';
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  return (
    '{\n' +
    keys
      .map((k) => pad + (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)) + ': ' + emit(value[k], ind + '  ') + ',')
      .join('\n') +
    '\n' +
    close +
    '}'
  );
}

const out = [];
out.push('// 由 build-presets.mjs 生成，别手改。');
out.push('// 四个内置模式的插件表照抄 DSH 自带 preset，只把 persona 的 prefix 换成林梦瑶。');
out.push('// 生成时间见 git 提交说明；DSH 升级后重跑：node dsh-plugins/dsh-linmengyao-preset/build-presets.mjs');
out.push('"use strict";');
out.push('');

for (const mode of MODES) {
  const text = readAsar(`dsh/node_modules/@deepseek-ai/dsh-web-app/presets/${mode}.patch.yml`);
  const patch = yaml.load(text, { schema: SCHEMA });
  const def = patch.find((row) => row.insert)?.insert.find((row) => row.config?.plugins);
  if (!def) throw new Error(`${mode}.patch.yml 里没找到 preset 定义`);
  const plugins = def.config.plugins.map((row) => {
    if (row.id === 'persona') {
      return { ...row, config: { ...row.config, prefix: HER_PREFIX } };
    }
    return row;
  });
  const personaCount = plugins.filter((r) => r.id === 'persona').length;
  if (personaCount !== 1) throw new Error(`${mode}: persona 行 ${personaCount} 条，预期 1 条`);
  out.push(`// ${mode}: 原 id ${def.config.id}，order ${def.config.order ?? '(无)'}，${plugins.length} 行`);
  out.push(`exports.${mode} = (ctx, baseUrl) => ${emit(plugins)};`);
  out.push('');
}

fs.writeFileSync(path.join(here, 'presets.cjs'), out.join('\n'), 'utf8');
fs.closeSync(fd);
console.log('wrote presets.cjs:', out.filter((l) => l.startsWith('exports.')).length, 'modes');
