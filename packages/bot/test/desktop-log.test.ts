import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    DESKTOP_LOG_KEEP_MS, DESKTOP_LOG_TEXT_CHARS, desktopLogId, desktopLogOps, desktopLogPath, desktopRecentFile, desktopTurns,
    ingestDesktopRecent, readDesktopLog, type DesktopLogOps, type DesktopLogRow,
} from '../src/memory/desktop-log.ts';
import { presenceAt, sessionsFromTurns, TURN_LEAD_MS } from '../src/life/desktop-presence.ts';

// 桌面对话收进 QQ 自己的账（ADR 0347 第 3 层地基，方案 §2.1）：desktop-recent.jsonl（插件整份重写）→ desktop-log.jsonl（QQ 写），按 id 去重。
// 全部在临时目录里，内容都是编的。

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const T = Date.parse('2026-11-22T15:30:00+08:00');
const mins = (n: number) => n * 60_000;
const days = (n: number) => n * 86_400_000;

function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-desktop-log-'));
    dirs.push(dataDir);
    mkdirSync(join(dataDir, 'memory'));
    const recentFile = desktopRecentFile(dataDir);
    const logFile = desktopLogPath(dataDir);
    const logs: string[] = [];
    /** 像插件那样整份重写 desktop-recent.jsonl */
    const writeRecent = (rows: unknown[]) => writeFileSync(recentFile, rows.map(row => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n');
    const ingest = (now = T, ops?: DesktopLogOps) => ingestDesktopRecent({ recentFile, logFile, now, log: message => logs.push(message), ...(ops ? { ops } : {}) });
    const logRows = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as DesktopLogRow);
    return { dataDir, recentFile, logFile, logs, writeRecent, ingest, logRows };
}
const turn = (agoMin: number, user: string, assistant = '嗯', userAgoMin?: number) =>
    ({ at: T - mins(agoMin), user, assistant, ...(userAgoMin !== undefined ? { userAt: T - mins(userAgoMin) } : {}) });

describe('desktop-log：从插件整份重写的 desktop-recent.jsonl 收进 QQ 自己的账', () => {
    test('落盘格式：{ v, id, at ISO, userAt? ISO, user, assistant }；id 是 dk-<at 毫秒>-<sha256(user+assistant) 前 8 位>', () => {
        const h = setup();
        h.writeRecent([turn(10, '帮我看看日程', '下午有课', 11), turn(5, '旧格式没有 userAt', '好')]);
        assert.deepEqual(h.ingest(), { added: 2, kept: 2, pruned: 0, skipped: 0, corrupt: 0 });
        const [first, second] = h.logRows();
        const hash = createHash('sha256').update('帮我看看日程' + '下午有课').digest('hex').slice(0, 8);
        assert.deepEqual(first, { v: 1, id: `dk-${T - mins(10)}-${hash}`, at: new Date(T - mins(10)).toISOString(), userAt: new Date(T - mins(11)).toISOString(), user: '帮我看看日程', assistant: '下午有课' });
        assert.equal(first!.id, desktopLogId(T - mins(10), '帮我看看日程', '下午有课'));
        assert.equal('userAt' in second!, false, '旧格式的行没有 userAt 也收');
        assert.deepEqual(h.logs, ['桌面：收进 2 轮（账本里共 2 轮）']);
    });

    test('按 id 去重：插件整份重写（挤掉最老的、追加新的）以后，已经收过的不再收，行号变了也不影响', () => {
        const h = setup();
        h.writeRecent([turn(30, '第一句'), turn(20, '第二句'), turn(10, '第三句')]);
        assert.equal(h.ingest().added, 3);
        // 插件重写：最老的一行被挤掉、来了两行新的——行号全变了
        h.writeRecent([turn(20, '第二句'), turn(10, '第三句'), turn(5, '第四句'), turn(1, '第五句')]);
        const before = readFileSync(h.logFile, 'utf8');
        assert.equal(h.ingest().added, 2);
        assert.deepEqual(h.logRows().map(row => row.user), ['第一句', '第二句', '第三句', '第四句', '第五句'], '被挤掉的老行留在账里');
        // 原样再收一遍：什么都不变，也不重写
        const after = readFileSync(h.logFile, 'utf8');
        assert.notEqual(after, before);
        assert.deepEqual(h.ingest(), { added: 0, kept: 5, pruned: 0, skipped: 0, corrupt: 0 });
        assert.equal(readFileSync(h.logFile, 'utf8'), after);
        // 来源里同一轮出现两次：只收一次
        h.writeRecent([turn(0.5, '重复的'), turn(0.5, '重复的')]);
        assert.equal(h.ingest().added, 1);
    });

    test('id 稳定：同一时刻、同样的话算出同一个 id；话不一样或时刻不一样就不同', () => {
        const id = desktopLogId(T, '你好', '嗯');
        assert.equal(desktopLogId(T, '你好', '嗯'), id);
        assert.match(id, /^dk-\d+-[0-9a-f]{8}$/);
        assert.notEqual(desktopLogId(T, '你好', '嗯嗯'), id);
        assert.notEqual(desktopLogId(T + 1, '你好', '嗯'), id);
    });

    test('跳过：比现在晚 1 分钟以上、早于 14 天、坏 JSON、字段不对、两边都空；晚 1 分钟以内照收（钟没对齐）', () => {
        const h = setup();
        h.writeRecent([
            turn(-2, '未来两分钟ZQF'),
            turn(-0.5, '晚半分钟照收'),
            { at: T - days(14) - 1, user: '十四天前ZQO', assistant: '嗯' },
            { at: T - days(14) + mins(1), user: '刚好十四天内', assistant: '嗯' },
            '{"at":',
            { at: String(T), user: '时间是字符串', assistant: '嗯' },
            { at: T, user: 1, assistant: '嗯' },
            { at: T, user: '  ', assistant: '' },
            [1, 2],
        ]);
        const result = h.ingest();
        assert.equal(result.added, 2);
        assert.equal(result.skipped, 7);
        const text = readFileSync(h.logFile, 'utf8');
        assert.ok(text.includes('晚半分钟照收') && text.includes('刚好十四天内'));
        assert.ok(!text.includes('ZQF') && !text.includes('ZQO'));
        // 未来那一行到了时间再收
        assert.equal(h.ingest(T + mins(2)).added, 1);
        assert.ok(readFileSync(h.logFile, 'utf8').includes('ZQF'));
    });

    test('userAt 不合理（晚于 at、早于 at 3 小时以上、不是整数）就当没有，这一轮照收', () => {
        const h = setup();
        h.writeRecent([
            { ...turn(10, '晚于 at'), userAt: T - mins(9) },
            { ...turn(9, '太早'), userAt: T - mins(9) - 3 * 3_600_000 - 1 },
            { ...turn(8, '不是整数'), userAt: 'x' },
            turn(7, '正常', '嗯', 8),
        ]);
        assert.equal(h.ingest().added, 4);
        assert.deepEqual(h.logRows().map(row => row.userAt), [undefined, undefined, undefined, new Date(T - mins(8)).toISOString()]);
    });

    test('每边截到 600 字（插件写的是 600 字加省略号）；id 用截过的算，账里的行能重算出同一个 id', () => {
        const h = setup();
        h.writeRecent([turn(1, `${'他'.repeat(600)}…`, `${'她'.repeat(600)}…`)]);
        h.ingest();
        const [row] = h.logRows();
        assert.equal([...row!.user].length, DESKTOP_LOG_TEXT_CHARS);
        assert.equal([...row!.assistant].length, DESKTOP_LOG_TEXT_CHARS);
        assert.equal(row!.id, desktopLogId(Date.parse(row!.at), row!.user, row!.assistant));
        assert.equal(h.ingest().added, 0, '再收一遍不重复');
    });

    test('只留 14 天：过了 14 天的清掉（来源里还在也不会再收回来）', () => {
        const h = setup();
        h.writeRecent([turn(60 * 24 * 13, '十三天前'), turn(10, '刚才')]);
        assert.equal(h.ingest().added, 2);
        const later = T + days(2);
        const result = h.ingest(later);
        assert.deepEqual(result, { added: 0, kept: 1, pruned: 1, skipped: 1, corrupt: 0 });
        assert.deepEqual(h.logRows().map(row => row.user), ['刚才']);
        assert.equal(h.logs.at(-1), '桌面：清掉 14 天前的 1 轮');
        assert.equal(h.ingest(later).added, 0);
    });

    test('账本里的坏行：跳过，日志只记行数不记内容；下一次重写时丢掉', () => {
        const h = setup();
        h.writeRecent([turn(10, '正常的一轮')]);
        h.ingest();
        writeFileSync(h.logFile, `${readFileSync(h.logFile, 'utf8')}{"v":1,"id":"dk-1-zz","user":"坏行里的原话ZQB"\n{"v":2,"id":"dk-1-0000000a"}\n`);
        assert.deepEqual(readDesktopLog(h.logFile, T, { log: message => h.logs.push(message) }).map(t => t.user), ['正常的一轮']);
        const result = h.ingest();
        assert.equal(result.corrupt, 2);
        assert.ok(h.logs.every(line => !line.includes('ZQB')), '日志不带内容');
        assert.ok(h.logs.some(line => line.includes('2 行读不懂')));
        assert.ok(!readFileSync(h.logFile, 'utf8').includes('ZQB'), '重写时丢掉');
    });

    test('原子写：写失败不留临时文件、不动原账本；账本读不了（不是没有）就不写，免得盖掉 14 天的账', () => {
        const h = setup();
        h.writeRecent([turn(10, '第一句')]);
        h.ingest();
        const before = readFileSync(h.logFile, 'utf8');
        h.writeRecent([turn(10, '第一句'), turn(5, '第二句')]);
        const failing: DesktopLogOps = { ...desktopLogOps, rename: () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); } };
        assert.throws(() => h.ingest(T, failing), /busy/);
        assert.equal(readFileSync(h.logFile, 'utf8'), before);
        assert.deepEqual(readdirSync(join(h.dataDir, 'memory')).filter(name => name.includes('.tmp')), []);
        const unreadable: DesktopLogOps = { ...desktopLogOps, readText: path => { if (path === h.logFile) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return desktopLogOps.readText(path); } };
        assert.throws(() => h.ingest(T, unreadable), /locked/);
        assert.equal(readFileSync(h.logFile, 'utf8'), before);
        assert.equal(h.ingest().added, 1, '对照：读得了就照常收');
    });

    test('没有来源 / 没有账本：什么都不写；读出来是空', () => {
        const h = setup();
        assert.deepEqual(h.ingest(), { added: 0, kept: 0, pruned: 0, skipped: 0, corrupt: 0 });
        assert.equal(existsSync(h.logFile), false);
        assert.deepEqual(desktopTurns(h.dataDir, T), []);
    });

    test('来源超过 1 MB：还能导入第一条及最后一条，重读没有新增', () => {
        const h = setup();
        const filler = Array.from({ length: 400 }, (_, i) => JSON.stringify(turn(100 + i, `旧${i}`.padEnd(600, '。'), '。'.repeat(600))));
        h.writeRecent([...filler, turn(1, '最后一句ZQL')]);
        const result = h.ingest();
        assert.equal(result.added, 401);
        assert.equal(h.ingest().added, 0);
        assert.ok(readFileSync(h.logFile, 'utf8').includes('最后一句ZQL'));
    });
});

describe('desktop-log：读出来的回合能直接交给 desktop-presence 切会话、判在不在', () => {
    test('desktopTurns 按时间排、毫秒；14 天外和未来的不给；presenceAt / sessionsFromTurns 用 userAt 定开始', () => {
        const h = setup();
        h.writeRecent([turn(3, '第三轮', '嗯', 4), turn(100, '早一段的', '嗯'), turn(8, '第二轮', '嗯', 9), turn(15, '第一轮', '嗯', 17)]);
        h.ingest();
        const turns = desktopTurns(h.dataDir, T);
        assert.deepEqual(turns.map(t => t.user), ['早一段的', '第一轮', '第二轮', '第三轮']);
        assert.deepEqual(turns[1], { at: T - mins(15), userAt: T - mins(17), user: '第一轮', assistant: '嗯' });
        const sessions = sessionsFromTurns(turns);
        assert.equal(sessions.length, 2, '隔了 45 分钟以上切开');
        assert.equal(sessions[0]!.start, T - mins(100) - TURN_LEAD_MS, '没有 userAt 的往前推 2 分钟');
        assert.deepEqual({ start: sessions[1]!.start, end: sessions[1]!.end }, { start: T - mins(17), end: T - mins(3) });
        assert.deepEqual(presenceAt({ turns, now: T }), { with: true, since: T - mins(17), until: T - mins(4) + mins(10), source: 'turns' });
        assert.equal(presenceAt({ turns, now: T + mins(7) }).with, false, '从最后一次开口算 10 分钟');
        // 14 天以后读：都不给
        assert.deepEqual(desktopTurns(h.dataDir, T + DESKTOP_LOG_KEEP_MS + mins(200)), []);
    });
});
