import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dreamDayEvents } from '../src/life/dream-jobs.ts';

// localeCompare 不写语言就跟着机器的系统语言走：中文系统按拼音（打 < 喂），英文系统按码位（喂 < 打）。
// CI（windows-latest，英文）上行为基线一直因此对不上（2026-11-26 查：最近 400 次 CI 没有一次绿）。线上和快照都是中文系统，统一写 'zh-CN'。
const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('src 里的 localeCompare 都写明语言（不跟着机器的系统语言变）', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith('.ts')) files.push(path);
        }
    };
    walk(src);
    const offenders: string[] = [];
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (let at = text.indexOf('localeCompare('); at >= 0; at = text.indexOf('localeCompare(', at + 1)) {
            let depth = 1, i = at + 'localeCompare('.length, comma = false;
            for (; i < text.length && depth > 0; i++) {
                const c = text[i];
                if (c === '(' || c === '[' || c === '{') depth++;
                else if (c === ')' || c === ']' || c === '}') depth--;
                else if (c === ',' && depth === 1) comma = true;
            }
            if (!comma) offenders.push(`${relative(src, file).replace(/\\/g, '/')}:${text.slice(0, at).split('\n').length}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('做梦的白天素材：同一时刻的几件事按拼音排，和机器的系统语言无关', () => {
    const at = new Date('2026-12-08T23:00:00+08:00');
    const world = undefined;
    const ended = '2026-12-08T18:00:00+08:00';
    const events = ['喂过团子饼', '打一会儿游戏'].map((subject, i) => ({
        id: `e${i}`, kind: 'leisure', subject, result: 'succeeded', startedAt: ended, endedAt: ended,
    })) as unknown as Parameters<typeof dreamDayEvents>[0];
    assert.deepEqual(dreamDayEvents(events, world, at, 8), ['打一会儿游戏', '喂过团子饼']);
});
