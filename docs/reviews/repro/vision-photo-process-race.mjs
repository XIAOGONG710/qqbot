// V06 diagnostic only: synthetic temp files, two independent writers, no QQ/network/private assets.
// node docs/reviews/repro/vision-photo-process-race.mjs
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const tempRoot = resolve(tmpdir());
const dir = mkdtempSync(join(tempRoot, 'qqbot-vision-race-'));
if (!resolve(dir).startsWith(`${tempRoot}${sep}`)) throw new Error('unexpected temporary directory');
const shelfModule = new URL('../../../packages/bot/src/vision/photos.ts', import.meta.url).href;
const fileModule = new URL('../../../packages/bot/src/memory/json-file.ts', import.meta.url).href;
const worker = join(dir, 'worker.mjs');
writeFileSync(worker, `
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { photoShelf } from ${JSON.stringify(shelfModule)};
import { fileOps } from ${JSON.stringify(fileModule)};
const [dir, id] = process.argv.slice(2);
const original = fileOps.renameSync;
fileOps.renameSync = (from, to) => {
    if (String(to).endsWith('index.json')) {
        writeFileSync(join(dir, 'ready-' + id), 'ready');
        const until = Date.now() + 10000;
        while (!existsSync(join(dir, 'go'))) {
            if (Date.now() > until) throw Error('barrier timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }
    return original(from, to);
};
const shelf = photoShelf({ dir: join(dir, 'shelf'), log: () => {} });
const input = join(dir, id + '.jpg');
writeFileSync(input, 'synthetic-' + id);
shelf.add(input, 'cat', '合成照片');
`);
const children = [1, 2].map(id => spawn(process.execPath, [worker, dir, String(id)], { stdio: 'ignore' }));
const completion = children.map(child => new Promise(resolve => {
    child.once('exit', code => resolve(code));
    child.once('error', () => resolve(-1));
}));
try {
    const until = Date.now() + 8000;
    while (!existsSync(join(dir, 'ready-1')) || !existsSync(join(dir, 'ready-2'))) {
        if (Date.now() > until) throw new Error('writers did not reach the diagnostic barrier');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    writeFileSync(join(dir, 'go'), 'go');
    const exits = await Promise.all(completion);
    const final = JSON.parse(readFileSync(join(dir, 'shelf', 'index.json'), 'utf8'));
    console.log(JSON.stringify({ exits, acceptedAdds: exits.filter(code => code === 0).length, durableEntries: final.entries.length }));
} finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(completion);
    rmSync(dir, { recursive: true, force: true });
}
