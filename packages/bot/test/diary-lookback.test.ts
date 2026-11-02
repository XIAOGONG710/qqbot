import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { journalOn } from '../src/language/self-thread.ts';
import { recapText } from '../src/platform/contact.ts';

// ADR 0217：翻回去看自己的日记。她 11-02 问「日记能翻回去看吗？前天写的今天还能对上」
const root = fileURLToPath(new URL('../../..', import.meta.url));
const JOURNAL = '# 日记\n\n## 2026-11-01\n今天高数小测，感觉要挂。\n\n## 2026-11-01（补记）\n迁移时补的一段。\n\n## 2026-11-02\n水卡丢了，跑了两趟宿管。\n\n## 2026-11-03\n在外套里翻到了水卡。\n';

describe('翻回去看自己的日记：QQ 这边（问到那天）', () => {
    test('那天 JOURNAL.md 的段落 + 她在聊天里写的 <<日记>>；「补记」不算；太长截短；那天没写就没有', () => {
        const self = [{ at: new Date(2026, 10, 1, 21, 0).getTime(), text: '晚上把错题抄了一遍' }, { at: new Date(2026, 10, 2, 9, 0).getTime(), text: '别的那天' }];
        assert.equal(journalOn(JOURNAL, self, '2026-11-01'), '今天高数小测，感觉要挂。 ／ 晚上把错题抄了一遍');
        assert.equal(journalOn(JOURNAL, [], '2026-10-30'), undefined);
        const long = journalOn(`## 2026-11-05\n${'很长的一天。'.repeat(80)}\n`, [], '2026-11-05', 50)!;
        assert.ok([...long].length <= 52 && long.endsWith('……'), long);
    });

    test('流水账那一行：没有日记时和原来一字不差；有日记时带上，说「说法对着它，不用照念」；只有日记没有流水账也行', () => {
        const plain = recapText('11月2日 周一', ['下了雨', '取了快递']);
        assert.equal(plain, '[那天（11月2日 周一）你那边的流水账（你自己过的，都是真的：他问到具体的事——下没下雨、喂没喂猫、快递拿没拿——照这个说，别说错；泛泛问那天干了什么时，先说上面记得住的事，这里的不用一件件报）：下了雨；取了快递]');
        const withDiary = recapText('11月2日 周一', ['下了雨'], '水卡丢了，跑了两趟宿管。');
        assert.ok(withDiary.includes('下了雨；那天你自己写的日记：「水卡丢了，跑了两趟宿管。」') && withDiary.includes('说法对着它') && withDiary.includes('不用照念'), withDiary);
        assert.ok(recapText('11月2日 周一', [], '水卡丢了。').includes('：那天你自己写的日记：「水卡丢了。」'));
    });
});

describe('翻回去看自己的日记：DSH 那边（journal_read）', () => {
    type Tool = { name: string; execute: (args?: Record<string, unknown>) => Promise<Record<string, unknown>> };
    let plugin: { apply: (ctx: unknown, cfg: Record<string, unknown>) => void; journalRead: (text: string, args?: Record<string, unknown>, now?: Date) => string; localDay: (at?: Date) => string };
    before(async () => { plugin = await import(pathToFileURL(join(root, 'dsh-plugins/dsh-linmengyao-memory/index.js')).href) as typeof plugin; });
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    test('默认最近两天（含今天）；给 date 只看那天；「补记」跳过；没有就说没写', () => {
        const now = new Date(2026, 10, 3, 23, 0);
        assert.equal(plugin.journalRead(JOURNAL, {}, now), '## 2026-11-02\n水卡丢了，跑了两趟宿管。\n\n## 2026-11-03\n在外套里翻到了水卡。');
        assert.equal(plugin.journalRead(JOURNAL, { date: '2026-11-01' }, now), '## 2026-11-01\n今天高数小测，感觉要挂。');
        assert.ok(plugin.journalRead(JOURNAL, { days: 7 }, now).startsWith('## 2026-11-01\n今天高数小测'));
        assert.equal(plugin.journalRead('', {}, now), '（最近 2 天没写公开日记）');
        assert.equal(plugin.journalRead(JOURNAL, { date: '2026-10-01' }, now), '（2026-10-01 那天没写公开日记）');
    });

    test('工具注册了、只读：读之前读之后文件一样；写了今天的就读得到', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-journal-'));
        dirs.push(dir);
        const f = (name: string) => join(dir, name);
        const tools: Record<string, Tool> = {};
        const handlers: Record<string, (...args: unknown[]) => unknown> = {};
        const agentCtx = {
            effect: (fn: () => unknown) => fn(),
            on: () => () => undefined,
            get: (key: string) => (key === 'tools' ? { register: (tool: Tool) => { tools[tool.name] = tool; return () => undefined; } } : key === 'systemPrompt' ? { context: () => () => undefined } : undefined),
        };
        const rootCtx = {
            on: (name: string, fn: (...args: unknown[]) => unknown) => { if (name === 'agent/created') handlers.created = fn; },
            get: (key: string) => (key === 'agentPresets' ? { composedPreset: () => 'linmengyao' } : undefined),
        };
        plugin.apply(rootCtx, {
            soulFile: f('SOUL.md'), ledgerFile: f('LEDGER.md'), journalFile: f('JOURNAL.md'), privateFile: f('PRIVATE.dat'), wishesFile: f('WISHES.md'),
            interestsFile: f('INTERESTS.md'), outboxFile: f('OUTBOX.jsonl'), offlineFile: f('OFFLINE.json'), nowFile: f('NOW.md'), storyFile: f('STORY.md'),
            ratingFile: f('RATINGS.json'), insightsFile: f('INSIGHTS.json'), feelingsFile: f('FEELINGS.json'), logFile: f('plugin.log'),
        });
        handlers.created!({ agent: { id: 'a1', ctx: agentCtx } });
        assert.ok(tools.journal_read, '注册了 journal_read');
        writeFileSync(f('JOURNAL.md'), JOURNAL);
        await tools.journal_read!.execute({});
        assert.equal(readFileSync(f('JOURNAL.md'), 'utf8'), JOURNAL, '只读');
        await tools.journal_write!.execute({ content: '今天把小测的错题又看了一遍。' });
        const read = String((await tools.journal_read!.execute({ date: plugin.localDay() })).text);
        assert.match(read, /今天把小测的错题又看了一遍/);
    });

    test('睡前整合：写日记前可以先翻一眼前两天的（不重抄）', () => {
        const resident = readFileSync(join(root, 'scripts/her-resident.mjs'), 'utf8');
        assert.match(resident, /journal_read 翻一眼前两天写的/);
        assert.match(resident, /别重抄前两天的话/);
    });
});
