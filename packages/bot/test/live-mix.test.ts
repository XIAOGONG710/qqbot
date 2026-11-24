// 线上组合盘点（test/inventory/live-mix.ts）的解析和统计；整套两天的跑法约 5 分钟，不放进 npm test，用 npm run inventory:live 跑。
// 不读 exchange/live 里的真实快照（里面有真实联系人；快照还落后于代码时会一直红）：快照里有 DEFAULTS 不认识的键，盘点报告头上会列出来。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventory, liveSwitches, NOT_COPIED, renderReport, withAlsoOn } from './inventory/live-mix.ts';
import type { PromptManifest } from '../src/platform/prompt-manifest.ts';

const YAML = `plugins:
  server:abc:
    port: 5140
  qqbot:xyz:
    contacts:
      - qq: 1
        name: 合成
        tier: boyfriend
    dataDir: runtime/x
    schedule: true
    jokes: false
    proactive: 'on'
    festivals: greet
    identityLedger: true
    deviceControl: 'on'
    notAThing: true
    llm:
      model: m
`;

test('只搬 DEFAULTS 认识、同类型的键；碰真实资料 / 起服务的不搬', () => {
    const live = liveSwitches(YAML, 'x.yaml');
    assert.deepEqual(live.config, { schedule: true, jokes: false, proactive: 'on', festivals: 'greet' });
    assert.deepEqual(live.on, ['festivals', 'proactive', 'schedule']);
    assert.deepEqual(live.unknown, ['notAThing']);
    for (const key of ['contacts', 'dataDir', 'identityLedger', 'deviceControl', 'llm']) assert.ok(live.skipped.includes(key), key);
    assert.ok(NOT_COPIED.identityLedger);
});

test('快照之后补开的开关：布尔开 true、档位开 on；没有的开关报错', () => {
    const live = withAlsoOn(liveSwitches(YAML), ['jokes', 'groupChat']);
    assert.equal(live.config.jokes, true);
    assert.equal(live.config.groupChat, 'on');
    assert.deepEqual(live.alsoOn, ['jokes', 'groupChat']);
    assert.throws(() => withAlsoOn(liveSwitches(YAML), ['noSuchSwitch']), /没有这个开关/);
});

const piece = (slot: string, module: string, chars: number, list: 'main' | 'history' | 'now' = 'now', omitted = false) =>
    ({ slot, module, list, chars, sha256: 'x', ...(omitted ? { omitted: true as const } : {}) });
const manifest = (kind: PromptManifest['kind'], chars: number, pieces: ReturnType<typeof piece>[], extra: Partial<PromptManifest> = {}): PromptManifest =>
    ({ v: 2, qq: 1, at: '2026-12-14T08:00:00.000Z', kind, pieces, chars, messages: { count: 1, sha256: 'x', list: [] }, ...extra });
const NO_EXTRA_KINDS = { group: 0, review: 0, candidate: 0 };

test('统计：槽按出现轮数和总字数，同一轮同槽多段只算一轮；按这一轮是什么分开；模型调用按用途数', () => {
    const inv = inventory([
        manifest('reply', 1000, [piece('time', 'time-block', 60), piece('world', 'her-now', 200), piece('world', 'her-now', 50)]),
        manifest('think', 600, [piece('time', 'time-block', 40), piece('feeling', 'feelings', 30, 'now', true)]),
    ], '@ 12-14 08:00 llm #1 chat model=a\n@ 12-14 08:01 llm #2 background model=a\n@ 12-14 08:02 llm #3 chat model=a\n');
    assert.deepEqual(inv.rounds, { total: 2, reply: 1, initiate: 0, think: 1, ...NO_EXTRA_KINDS, fallback: 0 });
    assert.deepEqual(inv.chars, { avg: 800, max: 1000, min: 600 });
    const world = inv.slots.find(s => s.slot === 'world')!;
    assert.equal(world.rounds, 1);
    assert.equal(world.chars, 250);
    assert.equal(inv.slots[0]!.slot, 'world');
    assert.equal(inv.slots.find(s => s.slot === 'feeling')!.omitted, 1);
    assert.equal(inv.piecesPerRound.now, 2);
    assert.deepEqual(inv.byKind.find(k => k.kind === 'reply'), { kind: 'reply', rounds: 1, avgChars: 1000, avgNow: 3, maxNow: 3 });
    assert.deepEqual(inv.llmPurposes, { chat: 2, background: 1 });
});

test('线上那台：读目录里的指纹清单文件，别的文件和坏行跳过；统计按轮次分', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readManifests } = await import('./inventory/live-mix.ts');
    const dir = mkdtempSync(join(tmpdir(), 'live-mix-'));
    try {
        const a = manifest('reply', 900, [piece('workJudge', 'work-mode', 120)]);
        const b = manifest('think', 500, [piece('workJudge', 'work-mode', 120)]);
        writeFileSync(join(dir, 'prompt-manifest-2026-12-14.jsonl'), `${JSON.stringify(a)}\n{坏行\n${JSON.stringify(b)}\n`);
        writeFileSync(join(dir, 'other.jsonl'), `${JSON.stringify(a)}\n`);
        const rows = readManifests(dir);
        assert.equal(rows.length, 2);
        assert.deepEqual(inventory(rows).slots[0]!.kinds, { reply: 1, initiate: 0, think: 1, ...NO_EXTRA_KINDS });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('不按槽拼的几种（群里开口、审稿重写、挑候选）：另数、按细分统计；不摊进按槽拼的字数、段数和槽的占比', () => {
    const inv = inventory([
        manifest('reply', 1000, [piece('time', 'time-block', 60)]),
        manifest('initiate', 600, [piece('time', 'time-block', 40)]),
        manifest('candidate', 1000, [], { calls: 3 }),
        manifest('review', 1100, [], { stage: 'shape' }),
        manifest('review', 1050, [], { stage: 'exit' }),
        manifest('review', 1080, [], { stage: 'shape' }),
        manifest('group', 2000, [], { qq: 555, reason: 'mentioned' }),
    ]);
    assert.deepEqual(inv.rounds, { total: 2, reply: 1, initiate: 1, think: 0, group: 1, review: 3, candidate: 1, fallback: 0 });
    assert.deepEqual(inv.chars, { avg: 800, max: 1000, min: 600 });
    assert.equal(inv.piecesPerRound.now, 1);
    assert.equal(inv.slots[0]!.rounds, 2);
    assert.deepEqual(inv.slots[0]!.kinds, { reply: 1, initiate: 1, think: 0, group: 0, review: 0, candidate: 0 });
    assert.deepEqual(inv.byKind.map(k => [k.kind, k.rounds, k.avgChars]), [['reply', 1, 1000], ['initiate', 1, 600], ['think', 0, 0], ['group', 1, 2000], ['review', 3, 1077], ['candidate', 1, 1000]]);
    assert.deepEqual(inv.extra, { reviewStages: { shape: 2, exit: 1 }, candidateCalls: 3, groupReasons: { mentioned: 1 } });
    const md = renderReport({ manifests: 'x' }, inv);
    assert.match(md, /不按槽拼的：群里开口 1（mentioned 1）、审稿重写 3（shape 2、exit 1）、挑候选 1 轮共生成 3 个/);
    assert.ok(md.includes('| review | 3 | 1077 | 0 | 0 |'));
});
