// V06 regression diagnostic: synthetic files, two writers, no QQ/network/private assets.
// node docs/reviews/repro/vision-photo-process-race.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const tempRoot = resolve(tmpdir());
const dir = mkdtempSync(join(tempRoot, 'qqbot-vision-race-'));
if (!resolve(dir).startsWith(`${tempRoot}${sep}`)) throw new Error('unexpected temporary directory');
const shelfModule = new URL('../../../packages/bot/src/vision/photos.ts', import.meta.url).href;
const fileModule = new URL('../../../packages/bot/src/memory/json-file.ts', import.meta.url).href;
const lockModule = new URL('../../../packages/bot/src/vision/photo-index-lock.ts', import.meta.url).href;
const worker = join(dir, 'worker.mjs');
writeFileSync(worker, `
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { photoShelf } from ${JSON.stringify(shelfModule)};
import { fileOps } from ${JSON.stringify(fileModule)};
import { PhotoIndexLockError } from ${JSON.stringify(lockModule)};
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
writeFileSync(join(dir, 'started-' + id), 'started');
const deadline = Date.now() + 12000;
for (;;) {
    try { shelf.add(input, 'cat', '合成照片'); break; }
    catch (error) {
        let cause = error; const seen = new Set(); let busy = false;
        while (cause && typeof cause === 'object' && !seen.has(cause)) {
            seen.add(cause);
            if (cause instanceof PhotoIndexLockError && cause.retryable) { busy = true; break; }
            cause = cause.cause;
        }
        if (!busy || Date.now() > deadline) throw error;
        writeFileSync(join(dir, 'busy-' + id), 'busy');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
`);
const children = [1, 2].map(id => spawn(process.execPath, [worker, dir, String(id)], { stdio: 'ignore' }));
const completion = children.map(child => new Promise(resolve => {
    const timer = setTimeout(() => child.kill(), 15000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
    child.once('error', () => { clearTimeout(timer); resolve(-1); });
}));
try {
    const until = Date.now() + 8000;
    const bothStarted = () => [1, 2].every(id => existsSync(join(dir, 'started-' + id)));
    const inside = () => [1, 2].filter(id => existsSync(join(dir, 'ready-' + id))).length;
    const busy = () => [1, 2].some(id => existsSync(join(dir, 'busy-' + id)));
    // Old writers can both enter the publication window; correct writers serialize and report busy.
    while (!(bothStarted() && (inside() === 2 || (inside() === 1 && busy())))) {
        if (Date.now() > until) throw new Error('writers did not reach the diagnostic barrier');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const overlappingWrites = inside() === 2;
    writeFileSync(join(dir, 'go'), 'go');
    const exits = await Promise.all(completion);
    const final = JSON.parse(readFileSync(join(dir, 'shelf', 'index.json'), 'utf8'));
    const result = { exits, acceptedAdds: exits.filter(code => code === 0).length, durableEntries: final.entries.length, overlappingWrites };
    console.log(JSON.stringify(result));
    assert.equal(overlappingWrites, false, 'two writers entered the protected publication window');
    assert.equal(result.acceptedAdds, 2);
    assert.equal(result.durableEntries, 2, 'an acknowledged add was lost');
} finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(completion);
    rmSync(dir, { recursive: true, force: true });
}
