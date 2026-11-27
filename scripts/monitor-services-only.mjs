// Continuous local status. The production watchdog is only invoked in its read-only probe mode.
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const probe = fileURLToPath(new URL('./services-watchdog.mjs', import.meta.url));
do {
    try {
        const { stdout } = await exec(process.execPath, [probe, '--once', '--local-only'], { timeout: 25_000, windowsHide: true });
        const { napcat, hindsight, koishi, watchdog } = JSON.parse(stdout);
        console.log(JSON.stringify({ at: new Date().toISOString(), mode: 'monitor-only', napcat, hindsight, koishi, watchdog }));
    } catch {
        console.error('Local service probe failed; no recovery action attempted.');
    }
    if (process.argv.includes('--once')) break;
    await sleep(60_000);
} while (true);
