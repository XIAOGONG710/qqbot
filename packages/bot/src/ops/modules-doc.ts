// node src/ops/modules-doc.ts（ADR 0122）：由 src/modules.ts 重新生成 docs/modules/*.md（README.md + 每个模块一份）
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDocs } from '../modules-doc.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const adrFiles = readdirSync(join(repoRoot, 'docs/adr')).filter(name => name.endsWith('.md'));
const out = join(repoRoot, 'docs/modules');
mkdirSync(out, { recursive: true });
for (const [name, content] of Object.entries(moduleDocs(adrFiles))) writeFileSync(join(out, name), content, 'utf8');
console.log(`写了 ${Object.keys(moduleDocs(adrFiles)).length} 份到 ${out}`);
