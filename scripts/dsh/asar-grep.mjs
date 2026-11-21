// Bounded grep inside a directory (works inside app.asar when run through the DSH Electron binary).
// Usage: node asar-grep.mjs <dir> <regex> [maxHits] [ext]
import fs from 'node:fs';
import path from 'node:path';

const [, , dir, pattern, maxHitsArg, extArg] = process.argv;
if (!dir || !pattern) {
  console.error('usage: asar-grep.mjs <dir> <regex> [maxHits] [ext]');
  process.exit(2);
}
const maxHits = Number(maxHitsArg ?? 40);
const ext = extArg ?? '.md';
const re = new RegExp(pattern, 'i');
let hits = 0;
const seen = new Set();

function walk(current, depth) {
  if (hits >= maxHits || depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (hits >= maxHits) return;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full, depth + 1);
      continue;
    }
    if (!entry.name.endsWith(ext)) continue;
    let text;
    try {
      if (fs.statSync(full).size > 1024 * 1024) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i])) {
        const label = seen.has(full) ? '' : `${full}\n`;
        seen.add(full);
        console.log(`${label}  ${i + 1}: ${lines[i].slice(0, 200)}`);
        hits += 1;
        if (hits >= maxHits) return;
      }
    }
  }
}

walk(dir, 0);
if (hits === 0) console.log('(no hits)');
