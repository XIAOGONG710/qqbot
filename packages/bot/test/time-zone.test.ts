import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAppConfig } from '../src/platform/config.ts';
import { applyTimeZone, canonicalTimeZone, claimTimeZone, COMMON_TIME_ZONES, DEFAULT_TIME_ZONE, formatOffset, processTimeZone, restoreTimeZone, timeZoneChoices } from '../src/platform/time-zone.ts';

const base = {
    characterCard: 'missing-{tier}.json',
    llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' },
    contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }],
};
const env = { QQBOT_LLM_API_KEY: 'synthetic-key' };
const configTs = resolve(fileURLToPath(import.meta.url), '../../src/platform/config.ts');

describe('她的时区（ADR 0331）', () => {
    test('测试进程固定在默认时区，不跟机器走', () => {
        assert.equal(DEFAULT_TIME_ZONE, 'Asia/Shanghai');
        assert.equal(processTimeZone(), 'Asia/Shanghai');
        assert.equal(new Date('2026-10-12T00:10:00+08:00').getHours(), 0);
    });

    test('配置：不写就是上海；写了按 IANA 校验并取规范写法；不认识的拒绝', () => {
        assert.equal(parseAppConfig(base, '/repo', env).timeZone, 'Asia/Shanghai');
        assert.equal(parseAppConfig({ ...base, timeZone: 'asia/tokyo' }, '/repo', env).timeZone, 'Asia/Tokyo');
        assert.throws(() => parseAppConfig({ ...base, timeZone: 'Mars/Olympus' }, '/repo', env), /timeZone 不是认识的时区/);
        assert.throws(() => parseAppConfig({ ...base, timeZone: '' }, '/repo', env), /timeZone 应为 IANA 时区名/);
        assert.throws(() => canonicalTimeZone(8), /IANA/);
    });

    test('parseAppConfig 只解析，不改进程时区', () => {
        parseAppConfig({ ...base, timeZone: 'America/New_York' }, '/repo', env);
        assert.equal(processTimeZone(), 'Asia/Shanghai');
    });

    test('applyTimeZone 立即改变本地时间方法的结果，返回原来的 TZ', () => {
        const previous = applyTimeZone('Asia/Tokyo');
        try {
            assert.equal(previous, 'Asia/Shanghai');
            assert.equal(new Date('2026-10-12T00:10:00+08:00').getHours(), 1);
        } finally {
            applyTimeZone('Asia/Shanghai');
        }
        assert.equal(new Date('2026-10-12T00:10:00+08:00').getHours(), 0);
    });

    test('loadConfig：机器是东京，配置没写时区，读完配置进程就是上海', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-tz-'));
        try {
            const path = join(dir, 'config.json');
            writeFileSync(path, JSON.stringify({ ...base, onebot: { url: 'ws://127.0.0.1:1' } }));
            const code = `const { loadConfig } = await import(${JSON.stringify('file:///' + configTs.replace(/\\/g, '/'))});`
                + `const before = new Date('2026-10-12T00:10:00+08:00').getHours();`
                + `loadConfig(${JSON.stringify(dir)});`
                + `console.log(before, new Date('2026-10-12T00:10:00+08:00').getHours(), Intl.DateTimeFormat().resolvedOptions().timeZone);`;
            const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
                env: { ...process.env, TZ: 'Asia/Tokyo', QQBOT_CONFIG: path, QQBOT_LLM_API_KEY: 'synthetic-key' }, encoding: 'utf8',
            });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout.trim(), '1 0 Asia/Shanghai');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('下拉列表：全部 IANA 时区、每项都能被 canonicalTimeZone 接受、不重复；常用的在前，默认的第一', () => {
        const list = timeZoneChoices(new Date('2026-11-06T00:00:00Z'));
        assert.ok(list.length > 300, `只有 ${list.length} 项`);
        assert.equal(new Set(list.map(choice => choice.zone)).size, list.length, '重复');
        const canonicals = list.map(choice => canonicalTimeZone(choice.zone)); // 每项都能被接受（不抛错）
        assert.equal(new Set(canonicals).size, list.length, '别名和它的规范名只能留一项（Asia/Kolkata 与 Asia/Calcutta 不能同时出现）');
        assert.ok(list.some(choice => choice.zone === 'Asia/Kolkata') && !list.some(choice => choice.zone === 'Asia/Calcutta'), '印度只留常用的现代名');
        assert.equal(list[0]!.zone, DEFAULT_TIME_ZONE);
        assert.deepEqual(list.slice(0, COMMON_TIME_ZONES.length).map(choice => choice.zone), [...COMMON_TIME_ZONES]);
        const rest = list.slice(COMMON_TIME_ZONES.length);
        for (let i = 1; i < rest.length; i++) assert.ok(rest[i - 1]!.offsetMinutes <= rest[i]!.offsetMinutes, `${rest[i - 1]!.zone} 排在 ${rest[i]!.zone} 前面，偏移却更大`);
    });

    test('下拉列表的标签：中文名和此刻的 UTC 偏移（半小时、负数、夏令时都对）', () => {
        const winter = new Map(timeZoneChoices(new Date('2026-01-15T12:00:00Z')).map(choice => [choice.zone, choice]));
        const summer = new Map(timeZoneChoices(new Date('2026-07-15T12:00:00Z')).map(choice => [choice.zone, choice]));
        assert.equal(winter.get('Asia/Shanghai')!.label, 'Asia/Shanghai（中国标准时间，UTC+08:00）');
        assert.equal(winter.get('Asia/Kolkata')!.offsetMinutes, 330);
        assert.ok(winter.get('Asia/Kolkata')!.label.endsWith('UTC+05:30）'));
        assert.equal(winter.get('America/St_Johns')!.offsetMinutes, -210);
        assert.equal(winter.get('America/New_York')!.offsetMinutes, -300);
        assert.equal(summer.get('America/New_York')!.offsetMinutes, -240, '夏令时：同一个 IANA 名，偏移随日期变');
        assert.equal(winter.get('UTC')!.label.endsWith('UTC±00:00）'), true);
        assert.equal(formatOffset(0), 'UTC±00:00');
        assert.equal(formatOffset(-570), 'UTC-09:30');
    });

    test('claimTimeZone：设上、释放时还原到第一个占用之前；重载时旧实例的迟到释放不冲掉新实例', () => {
        const env: NodeJS.ProcessEnv = {};
        const releaseA = claimTimeZone('Asia/Tokyo', env);
        assert.equal(env.TZ, 'Asia/Tokyo');
        // 重载：新实例先设时区，旧实例的收尾之后才结束
        const releaseB = claimTimeZone('America/New_York', env);
        releaseA();
        assert.equal(env.TZ, 'America/New_York', '旧实例迟到的释放不能把新实例的时区还原掉');
        releaseB();
        assert.equal(env.TZ, undefined, '最后一个实例释放后回到最初没设 TZ 的状态');
        releaseB();
        assert.equal(env.TZ, undefined, '重复释放没有副作用');

        const original: NodeJS.ProcessEnv = { TZ: 'Europe/Paris' };
        const release = claimTimeZone('Asia/Tokyo', original);
        release();
        assert.equal(original.TZ, 'Europe/Paris', '原来设过 TZ 的，还原成原来的');
        restoreTimeZone({ previous: undefined, effective: undefined }, original);
        assert.equal(original.TZ, undefined);
    });

    // 假的 env 对象测不出真问题：Windows 上的 Node，delete process.env.TZ 不会让进程回到系统时区，
    // 只会停在最后一次设的那个（审查时在真实进程里复现过）。这条在真实的子进程里验证「释放后确实回去了」。
    test('claimTimeZone 在真实进程里：释放后回到占用之前实际在用的时区（TZ 原来没设 / 设过两种）', () => {
        const timeZoneUrl = pathToFileURL(resolve(fileURLToPath(import.meta.url), '../../src/platform/time-zone.ts')).href;
        const run = (initial: string | undefined) => {
            const code = `const { claimTimeZone } = await import(${JSON.stringify(timeZoneUrl)});`
                + `const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;`
                + `const before = zone(); const target = before === 'America/New_York' ? 'Asia/Tokyo' : 'America/New_York';`
                + `const release = claimTimeZone(target); const during = zone(); release(); const after = zone();`
                + `console.log(JSON.stringify({ before, target, during, after }));`;
            const env: NodeJS.ProcessEnv = { ...process.env };
            if (initial === undefined) delete env.TZ; else env.TZ = initial;
            const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            return JSON.parse(result.stdout.trim()) as { before: string; target: string; during: string; after: string };
        };
        for (const initial of [undefined, 'Europe/Paris']) {
            const { before, target, during, after } = run(initial);
            assert.equal(during, target, '占用期间是她的时区');
            assert.equal(after, before, `释放后要回到占用前的时区（TZ 原来${initial === undefined ? '没设' : '设成 ' + initial}）`);
            if (initial) assert.equal(before, initial);
        }
    });
});
