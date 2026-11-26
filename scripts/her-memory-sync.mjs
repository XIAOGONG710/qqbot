#!/usr/bin/env node
// 把她那本账整个拉到本地：runtime/her-memory-dsh/<bank>.jsonl + digest.md + recent.md
// 只读 Hindsight（默认 127.0.0.1:8899），不写回、不改任何 bank。
// 用法：
//   node scripts/her-memory-sync.mjs                # 拉全部默认 bank
//   node scripts/her-memory-sync.mjs --banks b1,b2  # 指定 bank
//   node scripts/her-memory-sync.mjs --days 21      # recent.md 覆盖最近多少天
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'runtime', 'her-memory-dsh');
const BASE = (process.env.HINDSIGHT_URL || 'http://127.0.0.1:8899').replace(/\/+$/, '');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const defaultBanks = () => {
  const banks = ['linmengyao-a5db1eb499a38621', 'linmengyao', 'linmengyao-common'];
  const mapFile = path.join(ROOT, 'runtime', 'bot-shadow', 'memory', 'owner-bank.json');
  try {
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    const fromMap = [map.ownerBank, map.legacyBank, map.commonBank].filter(Boolean);
    return fromMap.length ? fromMap : banks;
  } catch {
    return banks;
  }
};

const banks = (argOf('banks') || defaultBanks().join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const days = Number(argOf('days', '21'));

const getJson = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

const listDocuments = async (bank) => {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const page = await getJson(`${BASE}/v1/default/banks/${encodeURIComponent(bank)}/documents?limit=100&offset=${offset}`);
    const items = page.items || [];
    out.push(...items);
    if (items.length < 100 || out.length >= (page.total || 0)) break;
  }
  return out;
};

const oneLine = (text, n) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
const dayOf = (doc) => (doc.created_at || '').slice(0, 10);

fs.mkdirSync(OUT, { recursive: true });
const summary = [];

for (const bank of banks) {
  process.stderr.write(`拉 ${bank} …\n`);
  const list = await listDocuments(bank);
  const docs = [];
  for (const item of list) {
    const doc = await getJson(`${BASE}/v1/default/banks/${encodeURIComponent(bank)}/documents/${encodeURIComponent(item.id)}`);
    docs.push({
      id: doc.id,
      created_at: doc.created_at,
      tags: doc.tags || [],
      context: doc.retain_params?.context ?? null,
      event_date: doc.retain_params?.event_date ?? null,
      text: doc.original_text || doc.text || '',
    });
  }
  docs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at), 'zh-CN'));
  const jsonl = docs.map((d) => JSON.stringify(d)).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT, `${bank}.jsonl`), jsonl, 'utf8');

  // digest：一行一篇，按时间正序
  const lines = docs.map((d) => {
    const tags = d.tags.length ? ` [${d.tags.join(',')}]` : '';
    return `- ${dayOf(d)}${tags} ${oneLine(d.text, 200)}`;
  });
  fs.writeFileSync(path.join(OUT, `${bank}.digest.md`), `# ${bank}（${docs.length} 篇）\n${lines.join('\n')}\n`, 'utf8');

  // recent：最近 N 天全文
  const since = Date.now() - days * 86400_000;
  const recent = docs.filter((d) => new Date(d.created_at).getTime() >= since);
  const recentText = recent
    .map((d) => `## ${d.created_at}${d.tags.length ? ` [${d.tags.join(',')}]` : ''}\n${d.text}\n`)
    .join('\n');
  fs.writeFileSync(path.join(OUT, `${bank}.recent.md`), `# ${bank} 最近 ${days} 天（${recent.length} 篇）\n\n${recentText}`, 'utf8');

  summary.push({ bank, docs: docs.length, chars: docs.reduce((n, d) => n + d.text.length, 0), recent: recent.length });
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), banks: summary }, null, 2), 'utf8');
console.log(JSON.stringify({ out: OUT, banks: summary }, null, 2));
