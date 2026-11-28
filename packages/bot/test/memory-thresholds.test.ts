import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    loadMemoryThresholds, MEMORY_THRESHOLD_DEFAULTS, MEMORY_THRESHOLD_KEYS, MEMORY_THRESHOLD_SPECS, memoryThresholdsLogLine, resolveMemoryThresholds,
    SHARED_MEMORY_THRESHOLD_KEYS, type MemoryThresholdKey,
} from '../../../dsh-plugins/dsh-linmengyao-memory/memory-thresholds.mjs';
import { CLEAR_DAYS, RAW_MESSAGES, VAGUE_DAYS } from '../src/memory/fading.ts';
import { CROSS_LINE_CHARS, CROSS_WINDOW_MS, DESKTOP_MAX_TURNS } from '../src/memory/cross-recent.ts';
import { DESKTOP_LOG_KEEP_MS, DESKTOP_LOG_TEXT_CHARS } from '../src/memory/desktop-log.ts';
import {
    DAY_RECALL_TOKENS, MAX_QUERY_CHARS, MAX_RECALLED, PERSON_RECALLED, RECALL_BREAKER_MS, RECALL_BREAKER_TIMEOUTS, RECALL_TOKENS, RECALLED_LINE_CHARS,
    SAME_THING_RECALLED, SHARED_RECALLED, TODAY_OTHERS,
} from '../src/memory/long-term.ts';
import { COARSE_AFTER_DAYS } from '../src/emotion/feeling-ledger.ts';
import { DEFAULTS } from '../src/platform/config.ts';
import { MEMORY_THRESHOLDS, MEMORY_THRESHOLDS_RESULT, memoryThresholdsLine } from '../src/memory/thresholds.ts';

// 记忆阈值（硬编码改造第三批）：QQ 和 DSH 共用一张表。只用临时文件和合成记忆，不碰真实灵魂目录、不连 Hindsight

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-thresholds-')); dirs.push(dir); return dir; };

/** 改造前写死在各处的数（逐个抄下来的，默认值必须和它们一模一样） */
const BEFORE: Record<MemoryThresholdKey, number> = {
    clearDays: 7, vagueDays: 30, crossWindowMs: 6 * 3_600_000, crossLineChars: 200, crossTailBytes: 64 * 1024, desktopKeepMs: 14 * 86_400_000,
    desktopTextChars: 600, inboxMaxAgeMs: 30 * 86_400_000, recallTimeoutMs: 3000, feelingCoarseAfterDays: 90,
    rawMessages: 80, maxRecalled: 12, sharedRecalled: 6, personRecalled: 6, todayOthers: 3, sameThingRecalled: 2, recallTokens: 1000, dayRecallTokens: 2000,
    maxQueryChars: 300, recalledLineChars: 200, recallBreakerTimeouts: 2, recallBreakerMs: 60_000, memoryTimeoutMs: 30_000, desktopMaxTurns: 3,
    notebookMaxAttempts: 80, notebookMaxAgeMs: 30 * 86_400_000,
    desktopPick: 6, desktopMaxChars: 1400, desktopRecallTokens: 1200, bankListTimeoutMs: 2500, qqRecentLines: 10,
};

describe('默认值就是改造前写死的数', () => {
    test('表里每一项的默认值和原来一样；没有多也没有少', () => {
        assert.deepEqual({ ...MEMORY_THRESHOLD_DEFAULTS }, BEFORE);
        assert.deepEqual([...MEMORY_THRESHOLD_KEYS].sort(), Object.keys(BEFORE).sort());
        for (const key of MEMORY_THRESHOLD_KEYS) {
            const spec = MEMORY_THRESHOLD_SPECS[key];
            assert.ok(spec.min <= spec.value && spec.value <= spec.max, `${key} 的默认值在范围里`);
            assert.ok(spec.readers.length > 0 && spec.where && spec.note, `${key} 写了谁读、原来在哪、是什么`);
        }
    });

    test('QQ 各处的常量（没设环境变量时）就是默认值', () => {
        assert.equal(process.env.QQBOT_MEMORY_THRESHOLDS, undefined, '测试进程不设覆盖文件');
        assert.equal(MEMORY_THRESHOLDS_RESULT.issue, undefined);
        assert.equal(MEMORY_THRESHOLDS, MEMORY_THRESHOLD_DEFAULTS);
        assert.equal(memoryThresholdsLine(), '记忆阈值：全部默认');
        assert.deepEqual(
            [CLEAR_DAYS, VAGUE_DAYS, RAW_MESSAGES, CROSS_WINDOW_MS, CROSS_LINE_CHARS, DESKTOP_MAX_TURNS, DESKTOP_LOG_KEEP_MS, DESKTOP_LOG_TEXT_CHARS,
                MAX_RECALLED, SHARED_RECALLED, PERSON_RECALLED, TODAY_OTHERS, SAME_THING_RECALLED, RECALL_TOKENS, DAY_RECALL_TOKENS, MAX_QUERY_CHARS, RECALLED_LINE_CHARS,
                RECALL_BREAKER_TIMEOUTS, RECALL_BREAKER_MS, COARSE_AFTER_DAYS, DEFAULTS.memory.timeoutMs, DEFAULTS.memory.recallTimeoutMs],
            [7, 30, 80, 6 * 3_600_000, 200, 3, 14 * 86_400_000, 600, 12, 6, 6, 3, 2, 1000, 2000, 300, 200, 2, 60_000, 90, 30_000, 3000]);
    });

    test('DSH 插件（没设环境变量时）也是默认值', async () => {
        const plugin = await import(pathToFileURL(join(root, 'dsh-plugins/dsh-linmengyao-memory/index.js')).href) as {
            MEMORY_CLEAR_DAYS: number; MEMORY_VAGUE_DAYS: number; MEMORY_THRESHOLDS_RESULT: { values: unknown; issue?: string };
        };
        assert.equal(plugin.MEMORY_CLEAR_DAYS, 7);
        assert.equal(plugin.MEMORY_VAGUE_DAYS, 30);
        assert.equal(plugin.MEMORY_THRESHOLDS_RESULT.values, MEMORY_THRESHOLD_DEFAULTS);
    });

    test('每一项都真的接上了：QQ 读的在 packages/bot/src 里用到，DSH 读的在插件 index.js 里用到；共用的两边都用到', () => {
        const qqSource = (function walk(dir: string): string {
            return readdirSync(dir, { withFileTypes: true }).map(entry => entry.isDirectory() ? walk(join(dir, entry.name))
                : entry.name.endsWith('.ts') ? readFileSync(join(dir, entry.name), 'utf8') : '').join('\n');
        })(join(here, '..', 'src'));
        const dshSource = readFileSync(join(root, 'dsh-plugins/dsh-linmengyao-memory/index.js'), 'utf8');
        for (const key of MEMORY_THRESHOLD_KEYS) {
            const { readers } = MEMORY_THRESHOLD_SPECS[key];
            assert.equal(qqSource.includes(`MEMORY_THRESHOLDS.${key}`), readers.includes('qq'), `${key}：QQ ${readers.includes('qq') ? '要' : '不该'}读`);
            assert.equal(dshSource.includes(`THRESHOLDS.${key}`), readers.includes('dsh'), `${key}：DSH ${readers.includes('dsh') ? '要' : '不该'}读`);
        }
        assert.deepEqual([...SHARED_MEMORY_THRESHOLD_KEYS], ['clearDays', 'vagueDays', 'crossWindowMs', 'crossLineChars', 'crossTailBytes', 'desktopKeepMs',
            'desktopTextChars', 'inboxMaxAgeMs', 'recallTimeoutMs', 'feelingCoarseAfterDays']);
    });
});

describe('覆盖文件：严格，有一样不对就整个不用', () => {
    test('只写要改的键；其余默认；日志只写键和数', () => {
        const result = resolveMemoryThresholds({ clearDays: 10, desktopPick: 4 });
        assert.equal(result.issue, undefined);
        assert.equal(result.values.clearDays, 10);
        assert.equal(result.values.desktopPick, 4);
        assert.equal(result.values.vagueDays, 30);
        assert.ok(Object.isFrozen(result.values));
        assert.equal(memoryThresholdsLogLine(result), '记忆阈值：调过 clearDays=10，desktopPick=4，其余默认');
        assert.equal(resolveMemoryThresholds({}).issue, undefined);
    });

    test('不认识的键、不是整数、超出范围、clearDays 大于 vagueDays、不是对象：整个不用，退回默认并写原因', () => {
        const cases: Array<[unknown, RegExp]> = [
            [{ clearDays: 10, clearDay: 3 }, /不认识的键/],
            [{ clearDays: 7.5 }, /clearDays 不是整数/],
            [{ clearDays: '7' }, /clearDays 不是整数/],
            [{ vagueDays: 0 }, /vagueDays 超出范围/],
            [{ maxQueryChars: 400 }, /maxQueryChars 超出范围 50–300/],
            [{ clearDays: 40 }, /clearDays 大于 vagueDays/],
            [[1, 2], /不是一个 JSON 对象/],
            [null, /不是一个 JSON 对象/],
            [{ __proto__: { clearDays: 9 }, toString: 1 }, /不认识的键/],
        ];
        for (const [input, reason] of cases) {
            const result = resolveMemoryThresholds(input);
            assert.equal(result.values, MEMORY_THRESHOLD_DEFAULTS, JSON.stringify(input));
            assert.match(result.issue ?? '', reason);
            assert.match(memoryThresholdsLogLine(result), /没用上.*全部用默认值/);
        }
    });

    test('文件：没给 / 读不了 / 不是 JSON；日志不写路径和文件内容', () => {
        assert.equal(loadMemoryThresholds(undefined).values, MEMORY_THRESHOLD_DEFAULTS);
        assert.equal(loadMemoryThresholds('').values, MEMORY_THRESHOLD_DEFAULTS);
        const dir = tmp();
        const missing = loadMemoryThresholds(join(dir, '合成-不存在.json'));
        assert.equal(missing.issue, '文件读不了');
        const bad = join(dir, 'bad.json');
        writeFileSync(bad, '{"clearDays": 合成私密内容');
        const broken = loadMemoryThresholds(bad);
        assert.equal(broken.issue, '不是合法的 JSON');
        for (const line of [memoryThresholdsLogLine(missing), memoryThresholdsLogLine(broken)]) {
            assert.doesNotMatch(line, /qqbot-thresholds|合成私密内容|bad\.json/);
        }
        const good = join(dir, 'good.json');
        writeFileSync(good, JSON.stringify({ crossWindowMs: 3 * 3_600_000 }));
        assert.equal(loadMemoryThresholds(good).values.crossWindowMs, 3 * 3_600_000);
    });
});

describe('QQ 和 DSH 读到同一个数（同一个环境变量、同一个文件）', () => {
    /** 新开一个进程（设好 QQBOT_MEMORY_THRESHOLDS）把两边各读一遍：常量、两边各自的遗忘判断、DSH 写桌面回合截的字数 */
    const probe = (overrides: unknown) => {
        const dir = tmp();
        const file = join(dir, 'memory-thresholds.json');
        writeFileSync(file, JSON.stringify(overrides));
        const script = join(dir, 'probe.mjs');
        const url = (path: string) => pathToFileURL(join(root, path)).href;
        writeFileSync(script, `
            import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
            import { join } from 'node:path';
            const qq = await import(${JSON.stringify(url('packages/bot/src/memory/thresholds.ts'))});
            const fading = await import(${JSON.stringify(url('packages/bot/src/memory/fading.ts'))});
            const cross = await import(${JSON.stringify(url('packages/bot/src/memory/cross-recent.ts'))});
            const log = await import(${JSON.stringify(url('packages/bot/src/memory/desktop-log.ts'))});
            const dsh = await import(${JSON.stringify(url('dsh-plugins/dsh-linmengyao-memory/index.js'))});
            const now = new Date(2026, 10, 20, 12);
            const at = days => new Date(2026, 10, 20 - days, 12).toISOString();
            const items = [3, 9, 12, 25, 40].map(days => ({ days, text: '合成的旧事 ' + days, mentionedAt: at(days) }));
            const clarity = items.map(item => ({
                days: item.days,
                qq: fading.clarity({ id: item.text, text: item.text, mentioned_at: item.mentionedAt }, { now, heard: '', ignore: [] }),
                dsh: dsh.desktopMemoryClarity(item, '', now),
            }));
            // DSH 写一轮桌面回合（只在临时目录），看截到多少字；QQ 收进来按自己的上限认不认
            const memory = join(${JSON.stringify(dir)}, 'bot', 'memory');
            mkdirSync(join(${JSON.stringify(dir)}, 'bot', 'chats'), { recursive: true });
            mkdirSync(memory, { recursive: true });
            const ownerBankFile = join(memory, 'owner-bank.json');
            writeFileSync(ownerBankFile, JSON.stringify({ ownerBank: 'synthetic-0123456789abcdef', desktopFile: join(memory, 'desktop-recent.jsonl') }));
            const long = '合'.repeat(1000);
            const wrote = dsh.recordDesktopTurn({ prefix: 'synthetic', ownerBankFile }, long, long, Date.now());
            const row = JSON.parse(readFileSync(join(memory, 'desktop-recent.jsonl'), 'utf8').trim());
            console.log(JSON.stringify({
                qq: qq.MEMORY_THRESHOLDS, dsh: dsh.MEMORY_THRESHOLDS_RESULT.values, issue: qq.MEMORY_THRESHOLDS_RESULT.issue ?? null, dshIssue: dsh.MEMORY_THRESHOLDS_RESULT.issue ?? null,
                consts: { clear: fading.CLEAR_DAYS, dshClear: dsh.MEMORY_CLEAR_DAYS, window: cross.CROSS_WINDOW_MS, keep: log.DESKTOP_LOG_KEEP_MS, chars: log.DESKTOP_LOG_TEXT_CHARS },
                clarity, wrote, written: [...row.user].length,
            }));
        `);
        const out = execFileSync(process.execPath, ['--import', pathToFileURL(join(here, 'time-zone-setup.ts')).href, script], {
            env: { ...process.env, QQBOT_MEMORY_THRESHOLDS: file, HER_CHANNEL: 'desktop', QQBOT_SOUL_DIR: join(dir, 'soul'), QQBOT_OWNER_BANK_FILE: join(dir, 'none.json'), QQBOT_PERSONA_CARD: join(dir, 'none-card.json') },
            encoding: 'utf8',
        });
        return JSON.parse(out.trim().split('\n').at(-1)!) as {
            qq: Record<string, number>; dsh: Record<string, number>; issue: string | null; dshIssue: string | null;
            consts: Record<string, number>; clarity: { days: number; qq: string; dsh: string }[]; wrote: boolean; written: number;
        };
    };

    test('调过的共用项：两边读到的整张表一样，遗忘判断一样，桌面回合截的字数和 QQ 认的一样', () => {
        const run = probe({ clearDays: 10, vagueDays: 20, crossWindowMs: 3 * 3_600_000, desktopKeepMs: 7 * 86_400_000, desktopTextChars: 300 });
        assert.equal(run.issue, null);
        assert.equal(run.dshIssue, null);
        assert.deepEqual(run.qq, run.dsh, '两边是同一张表');
        for (const key of SHARED_MEMORY_THRESHOLD_KEYS) assert.equal(run.qq[key], run.dsh[key], key);
        assert.deepEqual(run.consts, { clear: 10, dshClear: 10, window: 3 * 3_600_000, keep: 7 * 86_400_000, chars: 300 });
        for (const row of run.clarity) assert.equal(row.qq, row.dsh, `${row.days} 天前`);
        // 默认时 9 天前是「记个大概」；调成 10 天以后两边都是「清楚」，25 天前两边都想不起来
        assert.deepEqual(run.clarity.map(row => row.qq), ['clear', 'clear', 'vague', 'forgotten', 'forgotten']);
        assert.equal(run.wrote, true);
        assert.equal(run.written, 301, 'DSH 截到 300 字加一个省略号，和 QQ 认的上限同一个数');
    });

    test('文件不对：两边一起退回默认（不会一边用新数一边用旧数）', () => {
        const run = probe({ clearDays: 10, unknownKey: 1 });
        assert.match(run.issue ?? '', /不认识的键/);
        assert.equal(run.dshIssue, run.issue);
        assert.deepEqual(run.qq, { ...MEMORY_THRESHOLD_DEFAULTS });
        assert.deepEqual(run.dsh, { ...MEMORY_THRESHOLD_DEFAULTS });
        assert.deepEqual(run.clarity.map(row => row.qq), ['clear', 'vague', 'vague', 'vague', 'forgotten']);
        for (const row of run.clarity) assert.equal(row.qq, row.dsh);
        assert.equal(run.written, 601);
    });
});
